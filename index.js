import { user_avatar } from '/scripts/personas.js';
import { power_user } from '/scripts/power-user.js';
import { extension_settings, extensionNames } from '/scripts/extensions.js';
import { is_send_press, saveSettingsDebounced } from '/script.js';
import { is_group_generating } from '/scripts/group-chats.js';
import { loadWorldInfo, selected_world_info, world_info, world_info_case_sensitive, world_info_match_whole_words, world_names } from '/scripts/world-info.js';
import { version as pluginVersion } from './manifest.json';
import { createBackendClient } from './src/backend-client.js';
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
import { createFoundationRuntime } from './src/v3/foundation-runtime.js';
import { createTimeStore, createTimeRuntime } from './src/v3/time-runtime.js';
import { isIdentityDeleted, resolveIdentityEntityId } from './src/v3/entity-identity.js';
import { createV3MemoryRuntime } from './src/v3/memory-runtime.js';
import { persistMessageFloorAnchors } from './src/v3/message-floor-anchor.js';
import { createV3RecallRuntime } from './src/v3/recall-runtime.js';
import { createAutoHideController } from './src/v3/auto-hide.js';
import { createPeopleWorkspaceStore, createPeopleWorkspaceRuntime } from './src/v3/people-workspace.js';
import { createChatBranchInitializer } from './src/v3/chat-branch-inheritance.js';
import { installPublicMemoryBridge } from './src/v3/public-memory-bridge.js';
import { installPublicQianshiBridge } from './src/v3/public-qianshi-bridge.js';
import { createMyKnotsStoryClockController, createStoryClockStatusProjection, extensionStoryClockState } from './src/story-clock.js';
import { createInlineRenderer } from './src/ui/inline-renderer.js';

const isGenerating = () => Boolean(is_send_press || is_group_generating);
const hostAdapter = createHostAdapter({ worldInfoBindings: {
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
const sourcePermissions = createSourcePermissionController({ settings, contextProvider });
const summaryPrompt = () => settings.get().summaryPrompt;
const csePrompt = () => settings.get().csePrompt;
const profilePrompt = () => settings.get().profilePrompt;
const processingPrompt = () => settings.get().processingPrompt;
const foundationStore = createFoundationStore({ client: backendClient, contextProvider: () => session.identity(), isEnabled: settings.isEnabled });
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
const identityProjectionProvider = async () => {
  const identity = session.identity();
  const state = peopleWorkspaceRuntime?.getState?.();
  if (state?.chatId === identity.chatId) return peopleWorkspaceRuntime.getIdentityProjection();
  return (await peopleWorkspaceStore.read(identity)).data ?? {};
};
let v3RecallRuntime;
const timeRuntime = createTimeRuntime({
  newUuid,
  store: createTimeStore({ client: backendClient }), foundationStore, hostAdapter, session,
  getReachable: () => foundationRuntime.getReachable(),
  getMemoryState: () => v3MemoryRuntime.getState(),
  generateTimeTask: taskRouter.generateUtilityTask,
  annualSettingsProvider: () => {
    const reachable = foundationRuntime.getReachable(), state = peopleWorkspaceRuntime?.getState?.();
    if (!reachable?.baseline?.userPersona?.entityId || state?.status !== 'ready' || state.chatId !== session.identity().chatId) return { ready: false };
    const projection = { identityRedirectsByEntityId: state.identityRedirectsByEntityId, deletedEntityIds: state.deletedEntityIds };
    const entityNames = new Map((reachable.entities ?? []).map(entity => [resolveIdentityEntityId(entity.id, projection), entity.displayName]));
    const profiles = new Map();
    for (const [sourceId, profile] of Object.entries(state.profilesByEntityId ?? {})) {
      const entityId = resolveIdentityEntityId(sourceId, projection);
      if (!entityId || isIdentityDeleted(entityId, projection) || profiles.has(entityId) && sourceId !== entityId) continue;
      profiles.set(entityId, { entityId, displayName: profile?.name || entityNames.get(entityId), profile });
    }
    return { ready: true, people: [...profiles.values()], userPersona: { entityId: reachable.baseline.userPersona.entityId,
      name: reachable.baseline.userPersona.name, description: power_user.persona_description ?? '' } };
  },
  sanitizerOptions,
  storyClockReferenceTags: () => settings.get().storyClockReferenceTags,
  isEnabled: () => settings.isEnabled() && settings.get().timeEvolutionEnabled === true,
});
const v3MemoryRuntime = createV3MemoryRuntime({
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
  notifyUser: notification => globalThis.toastr?.[notification?.kind]?.(notification?.text),
  isMainGenerationActive: isGenerating,
  onAutomaticSummaryCommitted: receipt => peopleWorkspaceRuntime?.requestAutomaticMaintenance(receipt),
  extractorPromptGuidance: summaryPrompt,
  csePromptGuidance: csePrompt,
  processingPrompt,
  storyClockReferenceTags: () => settings.get().storyClockReferenceTags,
  filterWorldInfoSources: sourcePermissions.filterWorldInfoSources,
  sanitizerOptions,
  persistAnchors: persistMessageFloorAnchors,
  identityProjectionProvider,
  newUuid,
});
v3RecallRuntime = createV3RecallRuntime({
  store: foundationStore,
  hostAdapter,
  generateUtilityTask: taskRouter.generateRecallTask,
  isEnabled: settings.isEnabled,
  memoryStatus: () => v3MemoryRuntime.getState(),
  prepareMemory: options => v3MemoryRuntime.prepareCurrent(options),
  realtimeOrigin: () => v3MemoryRuntime.allowsRealtimeTailFromEmpty(),
  notifyUser: notification => globalThis.toastr?.[notification?.kind]?.(notification?.text),
  sanitizerOptions,
  identityProjectionProvider,
  timeProjectionProvider: source => timeRuntime.recallProjection(source),
  qianshiProgressProvider: async (source, context) => v3MemoryRuntime.getQianshiRecall({ ...context, ...(await timeRuntime.currentStoryContext(source) ?? {}) }),
  pluginVersion,
});
peopleWorkspaceRuntime = createPeopleWorkspaceRuntime({
  store: peopleWorkspaceStore,
  session,
  foundationRuntime,
  memoryRuntime: v3MemoryRuntime,
  generateUtilityTask: taskRouter.generateUtilityTask,
  sourcePermissions,
  contextProvider,
  sanitizerOptions,
  profilePromptGuidance: profilePrompt,
  processingPrompt,
  isEnabled: settings.isEnabled,
});
peopleWorkspaceRuntime.subscribe?.(state => { if (state?.status === 'ready' && state.chatId === session.identity().chatId) void timeRuntime.runBatch({ chatId: state.chatId }); });
const autoHideController = createAutoHideController({
  hostAdapter,
  memoryRuntime: v3MemoryRuntime,
  settings,
  notifyUser: notification => globalThis.toastr?.[notification?.kind]?.(notification?.text),
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
  timeRuntime,
  autoHideController,
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
  activitySources: [foundationRuntime, v3RecallRuntime, peopleWorkspaceRuntime, timeRuntime, chatMemoryManagement],
  isBusy: () => {
    const memory = v3MemoryRuntime.getState(), management = chatMemoryManagement.getState();
    return Boolean(management.workBusy || management.status === 'deleting' || timeRuntime.getState().active || memory.qianshiHistoryActive);
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
  const lifecycleResult = await lifecycle?.setEnabled(enabled);
  await v3RecallRuntime.setEnabled(enabled);
  return lifecycleResult;
};
ui = bootstrap({
  settings,
  apiTools,
  onPluginEnabledChange: setAllEnabled,
  onStoryClockChange: options => refreshStoryClock({ ...options, announce: options?.readOnly !== true }),
  onAutoHideChange: options => autoHideController.applySettings(options),
  onTimeEvolutionChange: async () => { await timeRuntime.stop(); await timeRuntime.runBatch(); },
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
  backendDiagnosticProvider: () => backendClient.getDiagnosticSnapshot(),
  pluginVersion,
  inlineRenderer,
  enableFab: true,
});
lifecycle = createPluginLifecycle({
  session,
  aborters: [taskRouter, apiTools, peopleWorkspaceRuntime],
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
