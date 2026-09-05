import { user_avatar } from '/scripts/personas.js';
import { extension_settings } from '/scripts/extensions.js';
import { isGenerating, saveSettingsDebounced } from '/script.js';
import { createBackendClient } from './src/backend-client.js';
import { bootstrap } from './src/bootstrap.js';
import { createSettingsStore } from './src/settings.js';
import { createApiResolver, createApiTools, createArchiveV2TaskRouter } from './src/api-routing.js';
import { createCompactApiClient } from './src/compact-api-client.js';
import { createArchiveV2Session } from './src/archive-v2-session.js';
import { createChatIdentityCoordinator } from './src/chat-identity.js';
import { createArchiveV2Lifecycle } from './src/archive-v2-lifecycle.js';
import { createArchiveV2Composition } from './src/archive-v2-composition.js';
import { createArchiveV2MemoryComposition } from './src/archive-v2-memory-composition.js';
import { createArchiveV2FollowedProfileComposition } from './src/archive-v2-followed-profile-composition.js';
import { createArchiveV2DossierComposition } from './src/archive-v2-dossier-composition.js';
import { createArchiveV2BondComposition } from './src/archive-v2-bond-composition.js';
import { createArchiveV2SourcePermissionController } from './src/archive-v2-source-permission.js';
import { createHostAdapter } from './src/v3/host-adapter.js';
import { createFoundationStore } from './src/v3/foundation-store.js';
import { createFoundationRuntime } from './src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from './src/v3/memory-runtime.js';
import { createV3RecallRuntime } from './src/v3/recall-runtime.js';

const hostAdapter = createHostAdapter();
const hostContext = () => hostAdapter.getContext();
const contextProvider = () => ({ ...hostContext(), userAvatar: user_avatar });
const settings = createSettingsStore({ extensionSettings: extension_settings, save: saveSettingsDebounced });
settings.migrateLegacyApiSettings();
const sanitizerOptions = () => ({ keepTags: settings.get().sourceKeepTags, extraTags: settings.get().sourceExtraTags });

const backendClient = createBackendClient({ headers: () => hostContext()?.getRequestHeaders?.() ?? {} });
const compactClient = createCompactApiClient({ headers: () => hostContext()?.getRequestHeaders?.() ?? {} });
const apiResolver = createApiResolver({ settings });
const taskRouter = createArchiveV2TaskRouter({
  resolver: apiResolver,
  compactClient,
  isEnabled: settings.isEnabled,
});
const apiTools = createApiTools({ resolver: apiResolver, compactClient, isEnabled: settings.isEnabled });
const identityCoordinator = createChatIdentityCoordinator({ client: backendClient });
const session = createArchiveV2Session({ contextProvider, isEnabled: settings.isEnabled, identityCoordinator });
const archiveV2 = createArchiveV2Composition({ client: backendClient, contextProvider, isEnabled: settings.isEnabled });
const sourcePermissions = createArchiveV2SourcePermissionController({ settings, contextProvider });
const sourceSettings = () => settings.sourcePermissionSnapshot();
const generalPrompt = () => settings.get().generalPrompt;
const foundationStore = createFoundationStore({ client: backendClient, contextProvider: () => session.identity(), isEnabled: settings.isEnabled });
const foundationRuntime = createFoundationRuntime({
  hostAdapter,
  store: foundationStore,
  contextProvider,
  prepareSession: () => session.prepare(),
  isEnabled: settings.isEnabled,
  sanitizerOptions,
});
const v3MemoryRuntime = createV3MemoryRuntime({
  foundationRuntime,
  store: foundationStore,
  hostAdapter,
  generateUtilityTask: taskRouter.generateUtilityTask,
  isEnabled: settings.isEnabled,
  automationSettings: () => ({
    enabled: settings.get().autoMemoryEnabled === true,
    batchSize: settings.get().autoMemoryBatchSize,
  }),
  notifyUser: notification => globalThis.toastr?.[notification?.kind]?.(notification?.text),
  isMainGenerationActive: isGenerating,
  customGuidance: generalPrompt,
  sanitizerOptions,
});
const v3RecallRuntime = createV3RecallRuntime({
  store: foundationStore,
  hostAdapter,
  isEnabled: settings.isEnabled,
  automationSettings: () => ({ enabled: settings.get().autoMemoryEnabled === true }),
  memoryStatus: () => v3MemoryRuntime.getState(),
  historicalMaintenance: () => v3MemoryRuntime.shouldBlockMainGeneration(),
  realtimeOrigin: () => v3MemoryRuntime.allowsRealtimeTailFromEmpty(),
  notifyUser: notification => globalThis.toastr?.[notification?.kind]?.(notification?.text),
  sanitizerOptions,
});
globalThis.qqj_v3_recall_interceptor = (coreChat, contextSize, abort, type) => v3RecallRuntime.intercept(coreChat, contextSize, abort, type);
const archiveV2Memory = createArchiveV2MemoryComposition({
  client: backendClient,
  contextProvider,
  generatePrimaryTask: taskRouter.generatePrimaryTask,
  generateUtilityTask: taskRouter.generateUtilityTask,
  isEnabled: settings.isEnabled,
  sanitizerOptions,
  generalPrompt,
});
const archiveV2FollowedProfiles = createArchiveV2FollowedProfileComposition({
  client: backendClient,
  contextProvider,
  generateUtilityTask: taskRouter.generateUtilityTask,
  isEnabled: settings.isEnabled,
  permissionSettings: sourceSettings,
  sanitizerOptions,
  generalPrompt,
});
const archiveV2Dossier = createArchiveV2DossierComposition({
  client: backendClient,
  contextProvider,
  isEnabled: settings.isEnabled,
});
const archiveV2Bonds = createArchiveV2BondComposition({
  client: backendClient,
  contextProvider,
  generateUtilityTask: taskRouter.generateUtilityTask,
  isEnabled: settings.isEnabled,
  permissionSettings: sourceSettings,
  sanitizerOptions,
  generalPrompt,
});

let ui;
let lifecycle;
const setAllEnabled = async enabled => {
  if (!enabled) {
    await v3RecallRuntime.setEnabled(false);
    const v3Result = await v3MemoryRuntime.setEnabled(false);
    const v2Result = await lifecycle?.setEnabled(false);
    return v3Result ?? v2Result;
  }
  const v2Result = await lifecycle?.setEnabled(enabled);
  const v3Result = await v3MemoryRuntime.setEnabled(enabled);
  await v3RecallRuntime.setEnabled(enabled);
  return v3Result ?? v2Result;
};
ui = bootstrap({
  settings,
  apiTools,
  prepareSession: () => session.prepare(),
  onPluginEnabledChange: setAllEnabled,
  onAutomationSettingsChange: () => v3MemoryRuntime.refreshAutomation(),
  archiveV2Composition: archiveV2,
  archiveV2Memory,
  archiveV2FollowedProfiles,
  archiveV2Dossier,
  archiveV2Bonds,
  sourcePermissions,
  v3FoundationRuntime: v3MemoryRuntime,
  v3RecallRuntime,
});
lifecycle = createArchiveV2Lifecycle({
  session,
  compositions: [archiveV2, archiveV2Memory, archiveV2FollowedProfiles, archiveV2Dossier, archiveV2Bonds],
  aborters: [taskRouter, apiTools],
  isEnabled: settings.isEnabled,
  getUi: () => ui,
});
const host = hostContext();
lifecycle.bind({ eventSource: host?.eventSource, eventTypes: host?.eventTypes });
v3MemoryRuntime.bind({ eventSource: host?.eventSource, eventTypes: host?.eventTypes });
v3RecallRuntime.bind({ eventSource: host?.eventSource, eventTypes: host?.eventTypes });
void (async () => {
  await lifecycle.start();
  await v3MemoryRuntime.start();
})().catch(error => console.warn('[qianqianjie] 身份或 V3 地基准备失败', error));
