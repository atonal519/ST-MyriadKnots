import { user_avatar } from '/scripts/personas.js';
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
import { createChatMemoryManagement } from './src/chat-memory-management.js';
import { createPluginLifecycle } from './src/plugin-lifecycle.js';
import { createSourcePermissionController } from './src/source-permission.js';
import { createHostAdapter } from './src/v3/host-adapter.js';
import { createFoundationStore } from './src/v3/foundation-store.js';
import { createFoundationRuntime } from './src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from './src/v3/memory-runtime.js';
import { persistMessageFloorAnchors } from './src/v3/message-floor-anchor.js';
import { createV3RecallRuntime } from './src/v3/recall-runtime.js';
import { createAutoHideController } from './src/v3/auto-hide.js';
import { createPeopleWorkspaceStore, createPeopleWorkspaceRuntime } from './src/v3/people-workspace.js';
import { installPublicMemoryBridge } from './src/v3/public-memory-bridge.js';
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
const contextProvider = () => ({ ...hostContext(), userAvatar: user_avatar });
const settings = createSettingsStore({ extensionSettings: extension_settings, save: saveSettingsDebounced });
settings.migrateLegacyApiSettings();
const sevenDaysClockState = () => extensionStoryClockState({ extensionNames, disabledExtensions: extension_settings.disabledExtensions, extensionSuffix: '/ST-SevenDaysCal', peerSettings: extension_settings['schedule-planner'] });
const isSevenDaysAvailable = () => {
  const extensionId = extensionNames.find(name => String(name).endsWith('/ST-SevenDaysCal'));
  return Boolean(extensionId && !extension_settings.disabledExtensions?.includes(extensionId));
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
const identityCoordinator = createChatIdentityCoordinator({ client: backendClient });
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
  isEnabled: settings.isEnabled,
  sanitizerOptions,
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
  onFullRebuildCommitted: () => v3RecallRuntime?.invalidate('fullRebuild'),
  extractorPromptGuidance: summaryPrompt,
  csePromptGuidance: csePrompt,
  processingPrompt,
  filterWorldInfoSources: sourcePermissions.filterWorldInfoSources,
  sanitizerOptions,
  persistAnchors: persistMessageFloorAnchors,
  identityProjectionProvider,
});
v3RecallRuntime = createV3RecallRuntime({
  store: foundationStore,
  hostAdapter,
  generateUtilityTask: taskRouter.generateUtilityTask,
  isEnabled: settings.isEnabled,
  memoryStatus: () => v3MemoryRuntime.getState(),
  prepareMemory: options => v3MemoryRuntime.prepareCurrent(options),
  realtimeOrigin: () => v3MemoryRuntime.allowsRealtimeTailFromEmpty(),
  notifyUser: notification => globalThis.toastr?.[notification?.kind]?.(notification?.text),
  sanitizerOptions,
  identityProjectionProvider,
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
const autoHideController = createAutoHideController({
  hostAdapter,
  memoryRuntime: v3MemoryRuntime,
  settings,
  notifyUser: notification => globalThis.toastr?.[notification?.kind]?.(notification?.text),
});
const inlineRenderer = createInlineRenderer({ memoryRuntime: v3MemoryRuntime, recallRuntime: v3RecallRuntime, hostAdapter });
const chatMemoryManagement = createChatMemoryManagement({
  client: backendClient,
  session,
  hostAdapter,
  foundationRuntime,
  memoryRuntime: v3MemoryRuntime,
  recallRuntime: v3RecallRuntime,
  peopleRuntime: peopleWorkspaceRuntime,
  autoHideController,
  isMainGenerationActive: isGenerating,
});
const publicMemoryBridgeMount = installPublicMemoryBridge({
  session,
  store: foundationStore,
  hostAdapter,
  foundationRuntime,
  memoryRuntime: v3MemoryRuntime,
  peopleRuntime: peopleWorkspaceRuntime,
  isEnabled: settings.isEnabled,
  sanitizerOptions,
  identityProjectionProvider,
});
globalThis.addEventListener?.('beforeunload', publicMemoryBridgeMount.cleanup, { once: true });
globalThis.addEventListener?.('beforeunload', autoHideController.dispose, { once: true });
globalThis.addEventListener?.('beforeunload', inlineRenderer.destroy, { once: true });
globalThis.qqj_v3_recall_interceptor = (coreChat, contextSize, abort, type) => v3RecallRuntime.intercept(coreChat, contextSize, abort, type);
const setAllEnabled = async enabled => {
  refreshStoryClock({ announce: true });
  if (!enabled) {
    inlineRenderer.setEnabled(false);
    autoHideController.stop();
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
  subscribeDialogContextChange: handler => {
    const currentHost = hostContext();
    const eventName = currentHost?.eventTypes?.CHAT_CHANGED;
    if (!eventName || !currentHost?.eventSource?.on) return () => {};
    currentHost.eventSource.on(eventName, handler);
    return () => currentHost.eventSource.removeListener?.(eventName, handler);
  },
  isSevenDaysAvailable,
  sourcePermissions,
  v3FoundationRuntime: v3MemoryRuntime,
  v3RecallRuntime,
  peopleWorkspaceRuntime,
  chatMemoryManagement,
  sessionStateProvider: () => session.getState(),
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
for (const name of ['CHAT_CHANGED', 'GENERATION_STARTED']) {
  const eventName = host?.eventTypes?.[name];
  if (eventName) host?.eventSource?.on?.(eventName, () => refreshStoryClock());
}
void (async () => {
  inlineRenderer.setEnabled(settings.isEnabled());
  await lifecycle.start();
})().catch(error => console.warn('[qianqianjie] 身份或 V3 地基准备失败', error));
