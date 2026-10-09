import { createVectorApiClient, resolveVectorConfig } from './src/vector-api.js';
import { createVectorIndex } from './src/v3/vector-index.js';
import { createVectorAutoUpdater } from './src/v3/vector-auto-update.js';
import { readVectorSource } from './src/v3/vector-source-reader.js';
import { user_avatar } from '/scripts/personas.js';
import { power_user } from '/scripts/power-user.js';
import { extension_settings, extensionNames } from '/scripts/extensions.js';
import { is_send_press, saveSettingsDebounced } from '/script.js';
import { is_group_generating } from '/scripts/group-chats.js';
import { loadWorldInfo, selected_world_info, world_info, world_info_case_sensitive, world_info_match_whole_words, world_names } from '/scripts/world-info.js';
import { localforage } from '/lib.js';
import { getCurrentUserHandle } from '/scripts/user.js';
import { version as pluginVersion } from './manifest.json';
import { createBackendClient } from './src/backend-client.js';
import { isTauriTavern } from './src/tauri-backend.js';
import { createPrivateRecallDiagnostics } from './src/private-recall-diagnostics.js';
import { bootstrap } from './src/bootstrap.js';
import { createSettingsStore } from './src/settings.js';
import { createApiResolver, createApiTools, createTaskRouter } from './src/api-routing.js';
import { createCompactApiClient } from './src/compact-api-client.js';
import { createChatSession } from './src/chat-session.js';
import { createChatIdentityCoordinator } from './src/chat-identity.js';
import { createHostChatList } from './src/host-context.js';
import { createChatMemoryManagement } from './src/chat-memory-management.js';
import { createStorageManagement } from './src/storage-management.js';
import { createPluginLifecycle } from './src/plugin-lifecycle.js';
import { createSourcePermissionController } from './src/source-permission.js';
import { createHostAdapter } from './src/v3/host-adapter.js';
import { createFoundationStore } from './src/v3/foundation-store.js';
import { createIndexedDbCoreRecordCache } from './src/v3/indexeddb-core-cache.js';
import { createFoundationRuntime } from './src/v3/foundation-runtime.js';
import { createTimeStore, createTimeRuntime } from './src/v3/time-runtime.js';
import { createV3MemoryRuntime } from './src/v3/memory-runtime.js';
import { runHistoricalRebuildTask } from './src/v3/historical-rebuild-task.js';
import { captureHistoricalRebuildSources as captureRebuildSources } from './src/v3/historical-rebuild-sources.js';
import { persistMessageFloorAnchors } from './src/v3/message-floor-anchor.js';
import { createV3RecallRuntime } from './src/v3/recall-runtime.js';
import { createAutoHideController } from './src/v3/auto-hide.js';
import { createPeopleWorkspaceStore, createPeopleWorkspaceRuntime, projectAnnualPeople } from './src/v3/people-workspace.js';
import { createChatBranchInitializer } from './src/v3/chat-branch-inheritance.js';
import { installPublicMemoryBridge } from './src/v3/public-memory-bridge.js';
import { installPublicQianshiBridge } from './src/v3/public-qianshi-bridge.js';
import { createMyKnotsStoryClockController, createStoryClockStatusProjection, extensionStoryClockState } from './src/story-clock.js';
import { createInlineRenderer } from './src/ui/inline-renderer.js';
import { normalizeStoryCalendar } from './src/v3/calendar-rules.js';

const isGenerating = () => Boolean(is_send_press || is_group_generating);
const hostAdapter = createHostAdapter({ personaIdentifierProvider: () => user_avatar, worldInfoBindings: {
  loadWorldInfo,
  getSelectedWorldInfo: () => selected_world_info,
  getWorldInfoSettings: () => world_info,
  getWorldInfoNames: () => world_names,
  getDefaultCaseSensitive: () => world_info_case_sensitive,
  getDefaultMatchWholeWords: () => world_info_match_whole_words,
} });
const hostContext = () => hostAdapter.getContext();
const newUuid = () => hostContext().uuidv4();
const contextProvider = () => ({ ...hostContext(), userAvatar: user_avatar });
const settings = createSettingsStore({ extensionSettings: extension_settings, save: saveSettingsDebounced });
settings.migrateLegacyApiSettings();
const sevenDaysClockState = () => extensionStoryClockState({ extensionNames, disabledExtensions: extension_settings.disabledExtensions, extensionSuffix: '/ST-SevenDaysCal', peerSettings: extension_settings['schedule-planner'] });
const isSevenDaysAvailable = () => {
  const extensionId = extensionNames.find(name => String(name).endsWith('/ST-SevenDaysCal'));
  return Boolean(extensionId && !extension_settings.disabledExtensions?.includes(extensionId));
};
const isSevenDaysLedgerInjectionEnabled = () => {
  if (!isSevenDaysAvailable()) return false;
  const peer = extension_settings['schedule-planner'];
  if (peer?.pluginEnabled === false || peer?.injectEnabled === false || peer?.ledgerInject !== true) return false;
  const current = hostContext();
  const avatar = current.characters?.[current.characterId]?.avatar;
  return current.groupId != null || !(typeof avatar === 'string' && avatar !== '' && Array.isArray(peer.characterExcludeAvatars) && peer.characterExcludeAvatars.includes(avatar));
};
const storyClockController = createMyKnotsStoryClockController({ context: hostContext, settings: () => settings.get(), peerState: sevenDaysClockState });
const STORY_CLOCK_COORDINATION_EVENT = 'qqj-sdc-story-clock-settings-changed';
const storyClockLabel = state => ({
  custom: '使用自定义时间戳提示词',
  'adapted-sdc': '已适配构画时间戳',
  'adapted-peer-custom': '已适配构画的自定义时间戳',
  'primary-default': '已调用千千结时间戳',
  'standalone-default': '已调用千千结时间戳',
  closed: '正文时间戳已关闭',
  unavailable: '宿主暂不支持时间戳注入',
})[state?.status] ?? '时间戳状态会在下一次正文生成前刷新。';
const projectStoryClockStatus = createStoryClockStatusProjection({ controller: storyClockController, labelFor: storyClockLabel });
const announceStoryClockChange = () => {
  try { if (typeof globalThis.CustomEvent === 'function') globalThis.dispatchEvent?.(new globalThis.CustomEvent(STORY_CLOCK_COORDINATION_EVENT, { detail: { owner: 'myknots' } })); } catch { /* 宿主无 CustomEvent 时保持单插件行为 */ }
};
const refreshStoryClock = ({ readOnly = false, announce = false } = {}) => {
  const result = projectStoryClockStatus({ readOnly });
  if (announce) announceStoryClockChange();
  return result;
};
globalThis.addEventListener?.(STORY_CLOCK_COORDINATION_EVENT, event => { if (event?.detail?.owner !== 'myknots') refreshStoryClock(); });
const sanitizerOptions = () => ({ keepTags: settings.get().sourceKeepTags, extraTags: settings.get().sourceExtraTags });

const backendClient = createBackendClient({ headers: () => hostContext()?.getRequestHeaders?.() ?? {} });
let ui;
let lifecycle;
const compactClient = createCompactApiClient({
  headers: () => hostContext()?.getRequestHeaders?.() ?? {},
  onBusyChange: busy => ui?.fab?.setBusy?.(busy),
});
const apiResolver = createApiResolver({ settings });
const taskRouter = createTaskRouter({
  resolver: apiResolver,
  compactClient,
  isEnabled: settings.isEnabled,
});
const apiTools = createApiTools({ resolver: apiResolver, compactClient, isEnabled: settings.isEnabled });
const listHostChats = createHostChatList({ headers: () => hostContext()?.getRequestHeaders?.() ?? {} });
const initializeChatBranch = createChatBranchInitializer({ client: backendClient, hostAdapter, sanitizerOptions });
const identityCoordinator = createChatIdentityCoordinator({ client: backendClient, freshUuid: newUuid, listHostChats, initializeBranch: initializeChatBranch });
const session = createChatSession({ contextProvider, isEnabled: settings.isEnabled, identityCoordinator });
// 设置页在禁用、未选聊天及身份准备期间仍须可打开；此时不读写聊天历法，保存仍走严格身份校验。
const calendarContextProvider = () => {
  let owner;
  try { owner = session.identity(); }
  catch { return { chatId: null, calendar: null }; }
  return { chatId: owner.chatId, calendar: settings.get().storyCalendars[owner.chatId] ?? null };
};
// 历法设置按 QQJ 聊天身份保存；读取计算规则不依赖时间推演开关。
const storyCalendarProvider = () => calendarContextProvider().calendar;
const sourcePermissions = createSourcePermissionController({ settings, contextProvider });
const summaryPrompt = () => settings.get().summaryPrompt;
const csePrompt = () => settings.get().csePrompt;
const profilePrompt = () => settings.get().profilePrompt;
const processingPrompt = () => settings.get().processingPrompt;
const coreRecordCache = isTauriTavern() ? null : createIndexedDbCoreRecordCache({ localForage: localforage, accountHandleProvider: getCurrentUserHandle });
const foundationStore = createFoundationStore({ client: backendClient, contextProvider: () => session.identity(), isEnabled: settings.isEnabled, coreRecordCache });
const targetFoundationStore = identity => foundationStore.forIdentity(identity);
const foundationRuntime = createFoundationRuntime({
  hostAdapter,
  store: foundationStore,
  contextProvider,
  prepareSession: () => session.prepare(),
  deferChatChangeRefreshUntilPrepared: true,
  isEnabled: settings.isEnabled,
  sanitizerOptions,
  newUuid,
});
const peopleWorkspaceStore = createPeopleWorkspaceStore({ client: backendClient });
let peopleWorkspaceRuntime;
const identityProjectionProvider = async identityValue => {
  const identity = identityValue ?? session.identity();
  const state = peopleWorkspaceRuntime?.getState?.();
  if (state?.chatId === identity.chatId) return peopleWorkspaceRuntime.getIdentityProjection();
  return (await peopleWorkspaceStore.read(identity)).data ?? {};
};
const vectorApi = createVectorApiClient({ headers: () => hostContext()?.getRequestHeaders?.() ?? {} });
const vectorIndex = createVectorIndex({
  client: backendClient, api: vectorApi, configProvider: () => resolveVectorConfig(settings),
  identityProvider: () => session.identity(),
  isEnabled: settings.isEnabled,
  sourceProvider: ({ targetIdentity }) => readVectorSource({
    store: createFoundationStore({ client: backendClient, contextProvider: () => targetIdentity, isEnabled: settings.isEnabled, coreRecordCache }),
    targetIdentity, cachedReachable: foundationRuntime.getReachable(),
  }),
});
let v3RecallRuntime;
const timeStore = createTimeStore({ client: backendClient });
const timeRuntime = createTimeRuntime({
  storyCalendarProvider,
  newUuid,
  store: timeStore, foundationStore, hostAdapter, session,
  getReachable: () => foundationRuntime.getReachable(),
  getMemoryState: () => v3MemoryRuntime.getState(),
  generateTimeTask: taskRouter.generateUtilityTask,
  annualSettingsProvider: () => {
    const reachable = foundationRuntime.getReachable(), state = peopleWorkspaceRuntime?.getState?.();
    if (!reachable?.baseline?.userPersona?.entityId || state?.status !== 'ready' || state.chatId !== session.identity().chatId) return { ready: false };
    return { ready: true, people: projectAnnualPeople(reachable, state), userPersona: { entityId: reachable.baseline.userPersona.entityId,
      name: reachable.baseline.userPersona.name, description: power_user.persona_description ?? '' } };
  },
  sanitizerOptions,
  storyClockReferenceTags: () => settings.get().storyClockReferenceTags,
  isEnabled: () => settings.isEnabled() && settings.get().timeEvolutionEnabled === true,
});
const v3MemoryRuntime = createV3MemoryRuntime({
  storyCalendarProvider,
  foundationRuntime,
  store: foundationStore,
  hostAdapter,
  generateAnalysisTask: taskRouter.generateAnalysisTask,
  generateUtilityTask: taskRouter.generateUtilityTask,
  isEnabled: settings.isEnabled,
  automationSettings: () => ({
    enabled: settings.isEnabled(),
    batchSize: 1,
  }),
  notifyUser: notification => notification?.action === 'openMemory'
    ? globalThis.toastr?.warning?.(notification.text, undefined, { timeOut: 12000, closeButton: true, onclick: () => ui?.openMemory?.() })
    : globalThis.toastr?.[notification?.kind]?.(notification?.text),
  isMainGenerationActive: isGenerating,
  extractorPromptGuidance: summaryPrompt,
  csePromptGuidance: csePrompt,
  processingPrompt,
  storyClockReferenceTags: () => settings.get().storyClockReferenceTags,
  filterWorldInfoSources: sourcePermissions.filterWorldInfoSources,
  sanitizerOptions,
  persistAnchors: persistMessageFloorAnchors,
  identityProjectionProvider,
  captureBusinessIdentity: () => session.identity(),
  storeForIdentity: targetFoundationStore,
  onQianshiEventDeleted: () => v3RecallRuntime?.invalidate('qianshiManuallyDeleted'),
  qianshiExternalReferenceProvider: (targetChatId, targetReachable) => {
    if (!settings.get().timeEvolutionEnabled) return [];
    return targetChatId ? timeRuntime.getQianshiReferencesForChat(targetChatId, targetReachable) : timeRuntime.getQianshiReferences();
  },
  newUuid,
});
const vectorAutoUpdater = createVectorAutoUpdater({ memoryRuntime: v3MemoryRuntime, vectorRuntime: vectorIndex,
  configProvider: () => resolveVectorConfig(settings), isEnabled: settings.isEnabled, isMainGenerationActive: isGenerating });
const vectorWakeListeners = [];
const vectorWakeHost = hostContext();
let vectorWakeTimer = null, vectorWakeDisposed = false;
for (const name of ['GENERATION_STOPPED', 'GENERATION_ENDED', 'GROUP_WRAPPER_FINISHED']) {
  const eventName = vectorWakeHost?.eventTypes?.[name];
  const eventSource = vectorWakeHost?.eventSource;
  if (!eventName || !eventSource?.on) continue;
  // Some host paths unblock generation after awaiting STOPPED handlers; defer one tick and coalesce both terminal events.
  const handler = () => {
    if (vectorWakeDisposed || vectorWakeTimer !== null) return;
    vectorWakeTimer = globalThis.setTimeout(() => {
      vectorWakeTimer = null;
      if (!vectorWakeDisposed) {
        vectorAutoUpdater.refresh();
        peopleWorkspaceRuntime?.wakeAutomaticMaintenance?.();
      }
    }, 0);
  };
  eventSource.on(eventName, handler);
  vectorWakeListeners.push({ eventSource, eventName, handler });
}
globalThis.addEventListener?.('beforeunload', () => {
  vectorWakeDisposed = true;
  if (vectorWakeTimer !== null) globalThis.clearTimeout(vectorWakeTimer);
  vectorWakeTimer = null;
  for (const { eventSource, eventName, handler } of vectorWakeListeners) {
    if (eventSource.removeListener) eventSource.removeListener(eventName, handler);
    else eventSource.off?.(eventName, handler);
  }
  vectorAutoUpdater.dispose();
}, { once: true });
v3RecallRuntime = createV3RecallRuntime({
  store: foundationStore,
  hostAdapter,
  generateUtilityTask: taskRouter.generateRecallTask,
  semanticProvider: options => vectorIndex.query(options),
  isEnabled: settings.isEnabled,
  memoryStatus: () => v3MemoryRuntime.getState(),
  prepareMemory: options => v3MemoryRuntime.prepareCurrent(options),
  realtimeOrigin: () => v3MemoryRuntime.allowsRealtimeTailFromEmpty(),
  recentBodyFloorLimit: () => settings.get().autoHideKeepAiCount,
  notifyUser: notification => globalThis.toastr?.[notification?.kind]?.(notification?.text),
  sanitizerOptions,
  identityProjectionProvider,
  timeProjectionProvider: source => timeRuntime.recallProjection(source),
  qianshiProgressProvider: async (source, context) => {
    // Selected Qianshi receipts replay saved IDs and do not consume current story time.
    const selectedOnly = Array.isArray(context?.selectedEventIds) || Array.isArray(context?.selectedMatterIds);
    const storyContext = selectedOnly ? null : await timeRuntime.currentStoryContext(source);
    return v3MemoryRuntime.getQianshiRecall({ ...context, ...(storyContext ?? {}) });
  },
  qianshiDeletionProvider: () => v3MemoryRuntime.getQianshiDeletions(),
  pluginVersion,
});
// 本机私有开关启用后独立留存临时诊断；专用客户端不混入记忆存储计数，也不等待诊断写入。
const privateRecallDiagnostics = createPrivateRecallDiagnostics({
  client: createBackendClient({ headers: () => hostContext()?.getRequestHeaders?.() ?? {}, timeoutMs: 5000 }),
  recallRuntime: v3RecallRuntime, vectorRuntime: vectorIndex, isEnabled: settings.isEnabled,
});
if (globalThis.location?.origin) void privateRecallDiagnostics.start();
globalThis.addEventListener?.('beforeunload', privateRecallDiagnostics.dispose, { once: true });
peopleWorkspaceRuntime = createPeopleWorkspaceRuntime({
  store: peopleWorkspaceStore,
  session,
  foundationRuntime,
  foundationStore,
  hostAdapter,
  memoryRuntime: v3MemoryRuntime,
  generateUtilityTask: taskRouter.generateUtilityTask,
  sourcePermissions,
  contextProvider,
  profilePromptGuidance: profilePrompt,
  processingPrompt,
  isEnabled: settings.isEnabled,
  isMainGenerationActive: isGenerating,
});
peopleWorkspaceRuntime.subscribe?.(state => { if (state?.status === 'ready' && state.chatId === session.identity().chatId) void timeRuntime.runBatch({ chatId: state.chatId }); });
const autoHideController = createAutoHideController({
  hostAdapter,
  memoryRuntime: v3MemoryRuntime,
  settings,
  notifyUser: notification => globalThis.toastr?.[notification?.kind]?.(notification?.text),
});
const captureHistoricalRebuildSources = snapshot => captureRebuildSources(snapshot, {
  worldInfoBindings: hostAdapter.getWorldInfoBindings(),
  getCharacterLorebooks: () => globalThis.TavernHelper?.getCharLorebooks?.(),
  getGlobalSelection: () => globalThis.TavernHelper?.getLorebookSettings?.()?.selected_global_lorebooks,
  loadWorldInfo,
  calendarForChat: chatId => settings.get().storyCalendars?.[chatId] ?? null,
});
const createHistoricalRebuild = options => runHistoricalRebuildTask({
  ...options,
  client: backendClient,
  coreRecordCache,
  isEnabled: settings.isEnabled,
  newUuid,
  sanitizerOptions,
  generateAnalysisTask: taskRouter.generateAnalysisTask,
  generateUtilityTask: taskRouter.generateUtilityTask,
  automationSettings: () => ({ enabled: false, batchSize: 1 }),
  extractorPromptGuidance: summaryPrompt,
  csePromptGuidance: csePrompt,
  processingPrompt,
  storyClockReferenceTags: () => settings.get().storyClockReferenceTags,
  storyCalendarForChat: chatId => settings.get().storyCalendars?.[chatId] ?? null,
  generateTimeTask: taskRouter.generateTimeTask,
  isTimeEvolutionEnabled: () => settings.isEnabled() && settings.get().timeEvolutionEnabled === true,
  filterWorldInfoSources: sourcePermissions.filterWorldInfoSources,
  identityProjectionProvider,
  qianshiExternalReferenceProvider: (chatId, reachable) => settings.get().timeEvolutionEnabled ? timeRuntime.getQianshiReferencesForChat(chatId, reachable) : [],
  persistAnchors: persistMessageFloorAnchors,
  fetchImpl: globalThis.fetch,
});
const inlineRenderer = createInlineRenderer({ memoryRuntime: v3MemoryRuntime, recallRuntime: v3RecallRuntime, hostAdapter });
const chatMemoryManagement = createChatMemoryManagement({
  contextProvider,
  client: backendClient,
  session,
  hostAdapter,
  foundationRuntime,
  memoryRuntime: v3MemoryRuntime,
  recallRuntime: v3RecallRuntime,
  peopleRuntime: peopleWorkspaceRuntime,
  vectorRuntime: vectorIndex,
  timeRuntime,
  autoHideController,
  coreRecordCache,
  captureHistoricalRebuildSources,
  freshUuid: newUuid,
  createHistoricalRebuild,
  isMainGenerationActive: isGenerating,
});
const storageManagement = createStorageManagement({
  client: backendClient,
  store: foundationStore,
  session,
  hostAdapter,
  settings,
  memoryRuntime: v3MemoryRuntime,
  foundationRuntime,
  activitySources: [vectorIndex, foundationRuntime, v3RecallRuntime, peopleWorkspaceRuntime, timeRuntime, chatMemoryManagement],
  isBusy: () => {
    const memory = v3MemoryRuntime.getState(), management = chatMemoryManagement.getState();
    return Boolean(vectorIndex.getState().active || management.workBusy || management.status === 'deleting' || timeRuntime.getState().active || memory.qianshiHistoryActive);
  },
});
const publicMemoryBridgeMount = installPublicMemoryBridge({
  session,
  store: foundationStore,
  hostAdapter,
  foundationRuntime,
  memoryRuntime: v3MemoryRuntime,
  peopleRuntime: peopleWorkspaceRuntime,
  recallRuntime: v3RecallRuntime,
  isEnabled: settings.isEnabled,
  sanitizerOptions,
  identityProjectionProvider,
});
const publicQianshiBridgeMount = installPublicQianshiBridge({ memoryRuntime: v3MemoryRuntime });
globalThis.addEventListener?.('beforeunload', publicMemoryBridgeMount.cleanup, { once: true });
globalThis.addEventListener?.('beforeunload', publicQianshiBridgeMount.cleanup, { once: true });
globalThis.addEventListener?.('beforeunload', autoHideController.dispose, { once: true });
globalThis.addEventListener?.('beforeunload', inlineRenderer.destroy, { once: true });
globalThis.addEventListener?.('beforeunload', storageManagement.dispose, { once: true });
globalThis.qqj_v3_recall_interceptor = (coreChat, contextSize, abort, type) => v3RecallRuntime.intercept(coreChat, contextSize, abort, type);
const setAllEnabled = async enabled => {
  refreshStoryClock({ announce: true });
  if (!enabled) {
    inlineRenderer.setEnabled(false);
    autoHideController.stop();
    await timeRuntime.stop();
    await peopleWorkspaceRuntime.setEnabled(false);
    await v3RecallRuntime.setEnabled(false);
    const v3Result = await v3MemoryRuntime.setEnabled(false);
    const lifecycleResult = await lifecycle?.setEnabled(false);
    return v3Result ?? lifecycleResult;
  }
  inlineRenderer.setEnabled(true);
  if (globalThis.location?.origin) void privateRecallDiagnostics.start();
  const lifecycleResult = await lifecycle?.setEnabled(enabled);
  await v3RecallRuntime.setEnabled(enabled);
  return lifecycleResult;
};
ui = bootstrap({
  settings,
  apiTools,
  vectorApi,
  vectorIndex,
  onPluginEnabledChange: setAllEnabled,
  onStoryClockChange: options => refreshStoryClock({ ...options, announce: options?.readOnly !== true }),
  onAutoHideChange: options => autoHideController.applySettings(options),
  onTimeEvolutionChange: async () => { await timeRuntime.stop(); await timeRuntime.runBatch(); },
  calendarContextProvider,
  onCalendarChange: async ({ chatId, calendar }) => {
    const normalized = normalizeStoryCalendar(calendar);
    if (!normalized) throw new Error('特殊年请填写不含数字的纪年名称，例如启航。');
    const owner = session.identity();
    if (!chatId || owner?.chatId !== chatId || owner.hostChatId && owner.hostChatId !== hostAdapter.snapshot().chatId) throw new Error('当前聊天已变化，请重新设置历法。');
    const state = v3MemoryRuntime.getState();
    if (state.memoryWorkBusy || state.activeExtraction || state.activeCse || state.qianshiHistoryActive || timeRuntime.getState().active) throw new Error('请等当前记忆任务完成后再设置历法。');
    const previous = settings.get().storyCalendars;
    try { settings.update({ storyCalendars: { ...previous, [chatId]: normalized } }, { observeSaveFailure: true }); }
    catch (error) { settings.update({ storyCalendars: previous }); throw error; }
    // 更新本地计算缓存，不启动旧楼提取或时间 API。
    timeRuntime.invalidate();
    await timeRuntime.refreshStatus({ force: true });
  },
  timeRuntime,
  subscribeDialogContextChange: handler => {
    const currentHost = hostContext();
    const eventName = currentHost?.eventTypes?.CHAT_CHANGED;
    if (!eventName || !currentHost?.eventSource?.on) return () => {};
    currentHost.eventSource.on(eventName, handler);
    return () => currentHost.eventSource.removeListener?.(eventName, handler);
  },
  isSevenDaysAvailable,
  isSevenDaysLedgerInjectionEnabled,
  sourcePermissions,
  v3FoundationRuntime: v3MemoryRuntime,
  v3RecallRuntime,
  peopleWorkspaceRuntime,
  chatMemoryManagement,
  storageManagement,
  sessionStateProvider: () => session.getState(),
  prepareSession: () => session.prepare(),
  backendDiagnosticProvider: () => ({ ...backendClient.getDiagnosticSnapshot(), coreCache: coreRecordCache?.getStats?.() ?? { available: false } }),
  pluginVersion,
  inlineRenderer,
  enableFab: true,
});
lifecycle = createPluginLifecycle({
  session,
  aborters: [taskRouter, apiTools, peopleWorkspaceRuntime, vectorIndex, vectorApi],
  isEnabled: settings.isEnabled,
  getUi: () => ui,
  onPrepared: async ({ isCurrent }) => {
    if (!isCurrent()) return;
    await v3MemoryRuntime.start();
    if (!isCurrent()) return;
    await peopleWorkspaceRuntime.refresh({ refreshMemory: false });
  },
});
const host = hostContext();
refreshStoryClock({ announce: true });
lifecycle.bind({ eventSource: host?.eventSource, eventTypes: host?.eventTypes });
v3MemoryRuntime.bind({ eventSource: host?.eventSource, eventTypes: host?.eventTypes });
v3RecallRuntime.bind({ eventSource: host?.eventSource, eventTypes: host?.eventTypes });
timeRuntime.bind({ eventSource: host?.eventSource, eventTypes: host?.eventTypes, foundationRuntime });
for (const name of ['CHAT_CHANGED', 'GENERATION_STARTED']) {
  const eventName = host?.eventTypes?.[name];
  if (eventName) host?.eventSource?.on?.(eventName, () => refreshStoryClock());
}
void (async () => {
  inlineRenderer.setEnabled(settings.isEnabled());
  await lifecycle.start();
})().catch(error => console.warn('[qianqianjie] 身份或后端数据准备失败', error));
