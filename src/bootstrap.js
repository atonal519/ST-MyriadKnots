import { createPanel } from './ui/panel.js';
import { createFab } from './ui/fab.js';
import { installWandEntry } from './ui/wand-entry.js';
import { createSourcePermissionView } from './ui/source-permission-view.js';
import { createV3FoundationView } from './ui/v3-foundation-view.js';
import { createPeopleProfilesView } from './ui/people-profiles-view.js';

export function bootstrap({
  settings,
  apiTools,
  onPluginEnabledChange,
  onStoryClockChange,
  isSevenDaysAvailable,
  sourcePermissions,
  v3FoundationRuntime,
  v3RecallRuntime,
  peopleWorkspaceRuntime,
  sourcePermissionViewFactory = createSourcePermissionView,
  v3FoundationViewFactory = createV3FoundationView,
  peopleProfilesViewFactory = createPeopleProfilesView,
  documentRef = globalThis.document,
  panelFactory = createPanel,
  fabFactory = createFab,
  wandInstaller = installWandEntry,
  enableFab = false,
} = {}) {
  if (!documentRef) return { show() {}, refresh() {}, setEnabled() {} };
  const existing = documentRef.getElementById?.('qqj-panel-host');
  if (existing?.__qqjInstance) return existing.__qqjInstance;
  const sourcePermissionView = sourcePermissions
    ? sourcePermissionViewFactory({ permissions: sourcePermissions, documentRef })
    : null;
  let panel;
  const foundationView = v3FoundationViewFactory({ runtime: v3FoundationRuntime, recallRuntime: v3RecallRuntime, peopleRuntime: peopleWorkspaceRuntime, documentRef });
  const peopleProfilesView = peopleProfilesViewFactory({ runtime: peopleWorkspaceRuntime, documentRef });
  const enabled = () => settings?.isEnabled?.() !== false;
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
    isSevenDaysAvailable,
    documentRef,
  });
  panel.host.hidden = true;
  documentRef.body.append(panel.host);
  const toggle = event => panel.host.hidden ? open(event) : panel.close();
  const fab = (enableFab || typeof documentRef.createElement !== 'function')
    ? fabFactory({ onClick: toggle, documentRef, windowRef: documentRef.defaultView ?? globalThis })
    : { host: null };
  if (fab.host) {
    fab.host.style ||= {};
    fab.host.style.display = enabled() ? '' : 'none';
    documentRef.body.append(fab.host);
  }
  wandInstaller(open);
  const instance = {
    ...panel,
    fab,
    show: open,
    setEnabled(value) {
      panel.setEnabled(value);
      if (fab.host?.style) fab.host.style.display = value ? '' : 'none';
    },
    async refresh() {
      if (panel.host.hidden || !enabled()) return { status: enabled() ? 'closed' : 'disabled' };
      return panel.refresh();
    },
  };
  panel.host.__qqjInstance = instance;
  return instance;
}
