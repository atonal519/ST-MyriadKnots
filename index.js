import { user_avatar } from '/scripts/personas.js';
import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';
import { createBackendClient } from './src/backend-client.js';
import { bootstrap } from './src/bootstrap.js';
import { createSettingsStore } from './src/settings.js';
import { createApiResolver, createApiTools, createArchiveV2TaskRouter } from './src/api-routing.js';
import { createCompactApiClient } from './src/compact-api-client.js';
import { createArchiveV2Session } from './src/archive-v2-session.js';
import { createArchiveV2Lifecycle } from './src/archive-v2-lifecycle.js';
import { createArchiveV2Composition } from './src/archive-v2-composition.js';
import { createArchiveV2MemoryComposition } from './src/archive-v2-memory-composition.js';
import { createArchiveV2FollowedProfileComposition } from './src/archive-v2-followed-profile-composition.js';
import { createArchiveV2DossierComposition } from './src/archive-v2-dossier-composition.js';
import { createArchiveV2BondComposition } from './src/archive-v2-bond-composition.js';
import { createArchiveV2SourcePermissionController } from './src/archive-v2-source-permission.js';

const hostContext = () => globalThis.Luker?.getContext?.();
const contextProvider = () => ({ ...hostContext(), userAvatar: user_avatar });
const settings = createSettingsStore({ extensionSettings: extension_settings, save: saveSettingsDebounced });
settings.migrateLegacyApiSettings();

const backendClient = createBackendClient({ headers: () => hostContext()?.getRequestHeaders?.() ?? {} });
const compactClient = createCompactApiClient({ headers: () => hostContext()?.getRequestHeaders?.() ?? {} });
const apiResolver = createApiResolver({ settings });
const taskRouter = createArchiveV2TaskRouter({
  resolver: apiResolver,
  compactClient,
  isEnabled: settings.isEnabled,
});
const apiTools = createApiTools({ resolver: apiResolver, compactClient, isEnabled: settings.isEnabled });
const session = createArchiveV2Session({ contextProvider, isEnabled: settings.isEnabled });
const archiveV2 = createArchiveV2Composition({ client: backendClient, contextProvider, isEnabled: settings.isEnabled });
const sourcePermissions = createArchiveV2SourcePermissionController({ settings, contextProvider });
const sourceSettings = () => settings.sourcePermissionSnapshot();
const sanitizerOptions = () => ({ keepTags: settings.get().sourceKeepTags, extraTags: settings.get().sourceExtraTags });
const generalPrompt = () => settings.get().generalPrompt;
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
ui = bootstrap({
  settings,
  apiTools,
  prepareSession: () => session.prepare(),
  onPluginEnabledChange: enabled => lifecycle?.setEnabled(enabled),
  archiveV2Composition: archiveV2,
  archiveV2Memory,
  archiveV2FollowedProfiles,
  archiveV2Dossier,
  archiveV2Bonds,
  sourcePermissions,
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
void lifecycle.start().catch(error => console.warn('[qianqianjie] V2 身份准备失败', error));
