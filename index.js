import { user_avatar } from '/scripts/personas.js';
import { extension_settings, extensionNames } from '/scripts/extensions.js';
import { isGenerating, saveSettingsDebounced } from '/script.js';
import { createBackendClient } from './src/backend-client.js';
import { bootstrap } from './src/bootstrap.js';
import { createSettingsStore } from './src/settings.js';
import { createApiResolver, createApiTools, createTaskRouter } from './src/api-routing.js';
import { createCompactApiClient } from './src/compact-api-client.js';
import { createChatSession } from './src/chat-session.js';
import { createChatIdentityCoordinator } from './src/chat-identity.js';
import { createPluginLifecycle } from './src/plugin-lifecycle.js';
import { createSourcePermissionController } from './src/source-permission.js';
import { createHostAdapter } from './src/v3/host-adapter.js';
import { createFoundationStore } from './src/v3/foundation-store.js';
import { createFoundationRuntime } from './src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from './src/v3/memory-runtime.js';
import { createV3RecallRuntime } from './src/v3/recall-runtime.js';
import { createPeopleWorkspaceStore, createPeopleWorkspaceRuntime } from './src/v3/people-workspace.js';
import { installPublicMemoryBridge } from './src/v3/public-memory-bridge.js';
import { createMyKnotsStoryClockController, createStoryClockStatusProjection, extensionStoryClockState } from './src/story-clock.js';

const hostAdapter = createHostAdapter();
const hostContext = () => hostAdapter.getContext();
const contextProvider = () => ({ ...hostContext(), userAvatar: user_avatar });
const settings = createSettingsStore({ extensionSettings: extension_settings, save: saveSettingsDebounced });
settings.migrateLegacyApiSettings();
const sevenDaysClockState = () => extensionStoryClockState({ extensionNames, disabledExtensions: extension_settings.disabledExtensions, extensionSuffix: '/ST-SevenDaysCal', peerSettings: extension_settings['schedule-planner'] });
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
const compactClient = createCompactApiClient({ headers: () => hostContext()?.getRequestHeaders?.() ?? {} });
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
const foundationStore = createFoundationStore({ client: backendClient, contextProvider: () => session.identity(), isEnabled: settings.isEnabled });
const foundationRuntime = createFoundationRuntime({
  hostAdapter,
  store: foundationStore,
  contextProvider,
  prepareSession: () => session.prepare(),
  isEnabled: settings.isEnabled,
  sanitizerOptions,
});
let v3RecallRuntime;
const v3MemoryRuntime = createV3MemoryRuntime({
  foundationRuntime,
  store: foundationStore,
  hostAdapter,
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
  filterWorldInfoSources: sourcePermissions.filterWorldInfoSources,
  sanitizerOptions,
});
v3RecallRuntime = createV3RecallRuntime({
  store: foundationStore,
  hostAdapter,
  isEnabled: settings.isEnabled,
  automationSettings: () => ({ enabled: settings.isEnabled() }),
  memoryStatus: () => v3MemoryRuntime.getState(),
  historicalMaintenance: () => v3MemoryRuntime.shouldBlockMainGeneration(),
  realtimeOrigin: () => v3MemoryRuntime.allowsRealtimeTailFromEmpty(),
  notifyUser: notification => globalThis.toastr?.[notification?.kind]?.(notification?.text),
  sanitizerOptions,
});
const peopleWorkspaceStore = createPeopleWorkspaceStore({ client: backendClient });
const peopleWorkspaceRuntime = createPeopleWorkspaceRuntime({
  store: peopleWorkspaceStore,
  session,
  foundationRuntime,
  memoryRuntime: v3MemoryRuntime,
  generateUtilityTask: taskRouter.generateUtilityTask,
  sourcePermissions,
  contextProvider,
  sanitizerOptions,
  profilePromptGuidance: profilePrompt,
  isEnabled: settings.isEnabled,
});
const publicMemoryBridgeMount = installPublicMemoryBridge({
  session,
  store: foundationStore,
  hostAdapter,
  isEnabled: settings.isEnabled,
  sanitizerOptions,
});
globalThis.addEventListener?.('beforeunload', publicMemoryBridgeMount.cleanup, { once: true });
globalThis.qqj_v3_recall_interceptor = (coreChat, contextSize, abort, type) => v3RecallRuntime.intercept(coreChat, contextSize, abort, type);
let ui;
let lifecycle;
const setAllEnabled = async enabled => {
  refreshStoryClock({ announce: true });
  if (!enabled) {
    await peopleWorkspaceRuntime.setEnabled(false);
    await v3RecallRuntime.setEnabled(false);
    const v3Result = await v3MemoryRuntime.setEnabled(false);
    const lifecycleResult = await lifecycle?.setEnabled(false);
    return v3Result ?? lifecycleResult;
  }
  const lifecycleResult = await lifecycle?.setEnabled(enabled);
  const v3Result = await v3MemoryRuntime.setEnabled(enabled);
  await v3RecallRuntime.setEnabled(enabled);
  await peopleWorkspaceRuntime.setEnabled(enabled);
  return v3Result ?? lifecycleResult;
};
ui = bootstrap({
  settings,
  apiTools,
  onPluginEnabledChange: setAllEnabled,
  onStoryClockChange: options => refreshStoryClock({ ...options, announce: options?.readOnly !== true }),
  sourcePermissions,
  v3FoundationRuntime: v3MemoryRuntime,
  v3RecallRuntime,
  peopleWorkspaceRuntime,
});
lifecycle = createPluginLifecycle({
  session,
  aborters: [taskRouter, apiTools, peopleWorkspaceRuntime],
  isEnabled: settings.isEnabled,
  getUi: () => ui,
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
  await lifecycle.start();
  await v3MemoryRuntime.start();
  await peopleWorkspaceRuntime.start();
})().catch(error => console.warn('[qianqianjie] 身份或 V3 地基准备失败', error));
