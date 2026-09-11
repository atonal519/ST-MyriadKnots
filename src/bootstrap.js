import { createPanel } from './ui/panel.js';
import { createFab } from './ui/fab.js';
import { installWandEntry } from './ui/wand-entry.js';
import { createSourcePermissionView } from './ui/source-permission-view.js';
import { createV3FoundationView } from './ui/v3-foundation-view.js';
import { createPeopleProfilesView } from './ui/people-profiles-view.js';
import { createDialogManager } from './ui/dialog.js';

export function bootstrap({
  settings,
  apiTools,
  onPluginEnabledChange,
  onStoryClockChange,
  onAutoHideChange,
  subscribeDialogContextChange,
  isSevenDaysAvailable,
  sourcePermissions,
  v3FoundationRuntime,
  v3RecallRuntime,
  peopleWorkspaceRuntime,
  chatMemoryManagement,
  sessionStateProvider,
  pluginVersion,
  inlineRenderer,
  sourcePermissionViewFactory = createSourcePermissionView,
  v3FoundationViewFactory = createV3FoundationView,
  peopleProfilesViewFactory = createPeopleProfilesView,
  documentRef = globalThis.document,
  panelFactory = createPanel,
  fabFactory = createFab,
  wandInstaller = installWandEntry,
  dialogFactory = createDialogManager,
  enableFab = false,
} = {}) {
  if (!documentRef) return { show() {}, refresh() {}, setEnabled() {} };
  const existing = documentRef.getElementById?.('qqj-panel-host');
  if (existing?.__qqjInstance) return existing.__qqjInstance;
  const sourcePermissionView = sourcePermissions
    ? sourcePermissionViewFactory({ permissions: sourcePermissions, documentRef })
    : null;
  let panel, fab;
  const dialog = dialogFactory({ documentRef, $: globalThis.jQuery ?? globalThis.$, subscribeContextChange: subscribeDialogContextChange });
  if (dialog?.host) (documentRef.documentElement ?? documentRef.body).append(dialog.host);
  const foundationView = v3FoundationViewFactory({ runtime: v3FoundationRuntime, recallRuntime: v3RecallRuntime, peopleRuntime: peopleWorkspaceRuntime, memoryManagement: chatMemoryManagement, sessionStateProvider, pluginVersion, uiDiagnosticProvider: () => panel?.getUiDiagnostic?.() ?? '{}', documentRef, confirmImpl: options => dialog.confirm(options), infoImpl: options => dialog.info(options) });
  const peopleProfilesView = peopleProfilesViewFactory({ runtime: peopleWorkspaceRuntime, documentRef, dialog });
  const syncAppearance = value => { fab?.setAppearance?.(value); inlineRenderer?.setAppearance?.(value); };
  let pluginEnabled = settings?.isEnabled?.() !== false;
  const enabled = () => pluginEnabled;
  const open = async event => {
    if (!enabled()) {
      panel.show(event?.currentTarget || event?.target || documentRef.activeElement);
      return panel.setEnabled(false);
    }
    try {
      const result = await panel.show(event?.currentTarget || event?.target || documentRef.activeElement);
      if (result?.status === 'disabled') panel.showStatus('千千结已关闭');
    } catch {
      panel.showStatus('当前聊天暂时无法建立稳定身份。');
    }
  };
  panel = panelFactory({
    settings,
    apiTools,
    v3FoundationView: foundationView,
    peopleProfilesView,
    sourcePermissionView,
    onPluginEnabledChange,
    onStoryClockChange,
    onAutoHideChange,
    isSevenDaysAvailable,
    dialog,
    onFabShowChange: () => syncFabVisibility(),
    onAppearanceChange: syncAppearance,
    documentRef,
  });
  panel.host.hidden = true;
  documentRef.body.append(panel.host);
  const toggle = event => panel.host.hidden ? open(event) : panel.close();
  fab = (enableFab || typeof documentRef.createElement !== 'function')
    ? fabFactory({ onClick: toggle, documentRef, windowRef: documentRef.defaultView ?? globalThis })
    : { host: null };
  const fabShown = () => settings?.get?.().fabShow !== false;
  const syncFabVisibility = () => { if (fab?.host?.style) fab.host.style.display = enabled() && fabShown() ? '' : 'none'; };
  if (fab.host) {
    fab.host.style ||= {};
    syncFabVisibility();
    documentRef.body.append(fab.host);
  }
  syncAppearance(panel.syncAppearance?.());
  wandInstaller(open);
  const instance = {
    ...panel,
    fab,
    dialog,
    show: open,
    setEnabled(value) {
      pluginEnabled = value === true;
      panel.setEnabled(pluginEnabled);
      syncFabVisibility();
    },
    async refresh() {
      if (panel.host.hidden || !enabled()) return { status: enabled() ? 'closed' : 'disabled' };
      return panel.refresh();
    },
  };
  panel.host.__qqjInstance = instance;
  return instance;
}
