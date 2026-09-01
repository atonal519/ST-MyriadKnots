import { createPanel } from './ui/panel.js';
import { createFab } from './ui/fab.js';
import { installWandEntry } from './ui/wand-entry.js';
import { createArchiveV2InitializationView } from './ui/archive-v2-initialization-view.js';
import { createArchiveV2BondView } from './ui/archive-v2-bond-view.js';
import { createArchiveV2SourcePermissionView } from './ui/archive-v2-source-permission-view.js';

export function bootstrap({
  settings,
  apiTools,
  prepareSession,
  onPluginEnabledChange,
  archiveV2Composition,
  archiveV2Memory,
  archiveV2FollowedProfiles,
  archiveV2Dossier,
  archiveV2Bonds,
  sourcePermissions,
  archiveV2ViewFactory = createArchiveV2InitializationView,
  archiveV2BondViewFactory = createArchiveV2BondView,
  sourcePermissionViewFactory = createArchiveV2SourcePermissionView,
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
  const openSourceSettings = () => panel?.openSourceSettings?.();
  const archiveView = archiveV2ViewFactory({
    composition: archiveV2Composition,
    memory: archiveV2Memory,
    followedProfiles: archiveV2FollowedProfiles,
    dossier: archiveV2Dossier,
    documentRef,
    sourcePermissions,
    sourcePermissionView,
    onOpenSourceSettings: openSourceSettings,
  });
  const bondView = archiveV2BondViewFactory({ composition: archiveV2Bonds, documentRef, sourcePermissions, sourcePermissionView, onOpenSourceSettings: openSourceSettings });
  const enabled = () => settings?.isEnabled?.() !== false;
  const ensureReady = async () => {
    if (!enabled()) return { status: 'disabled' };
    return typeof prepareSession === 'function' ? prepareSession() : { status: 'ready' };
  };
  const open = async event => {
    if (!enabled()) {
      panel.show(event?.currentTarget || event?.target || documentRef.activeElement);
      return panel.setEnabled(false);
    }
    try {
      const result = await panel.show(event?.currentTarget || event?.target || documentRef.activeElement);
      if (['disabled', 'stale'].includes(result?.status)) {
        panel.showStatus(result.status === 'disabled' ? '千千结已关闭' : '当前聊天身份已变化，请重新打开。');
      }
    } catch {
      panel.showStatus('当前聊天暂时无法建立稳定身份。');
    }
  };
  panel = panelFactory({
    settings,
    apiTools,
    archiveV2InitializationView: archiveView,
    archiveV2BondView: bondView,
    sourcePermissionView,
    onPluginEnabledChange,
    onOpenPeople: ensureReady,
    onOpenBonds: ensureReady,
    documentRef,
  });
  panel.host.hidden = true;
  documentRef.body.append(panel.host);
  const fab = (enableFab || typeof documentRef.createElement !== 'function') ? fabFactory({ onClick: open }) : { host: null };
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
