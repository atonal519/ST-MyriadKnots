import { createPanel } from './ui/panel.js';
import { createFab } from './ui/fab.js';
import { installWandEntry } from './ui/wand-entry.js';
import { mapPeopleError } from './c-registry.js';

export function bootstrap({ formal, people, settings, apiTools, loadState, initialRelations, reviewActions, onPluginEnabledChange, documentRef = globalThis.document, panelFactory = createPanel, fabFactory = createFab, wandInstaller = installWandEntry, enableFab = false } = {}) {
  if (!documentRef) return { setState() {}, show() {} };
  const existing = documentRef.getElementById('qqj-panel-host');
  if (existing) return existing.__qqjInstance;
  const enabled = () => settings?.isEnabled?.() !== false;
  let uiEpoch = 0;
  const invalidState = () => enabled() ? { status: 'stale' } : { status: 'disabled' };
  const readPeople = async (result, mine) => {
    const currentRun = () => enabled() && mine === uiEpoch;
    if (!currentRun() || typeof people?.getPeople !== 'function') return currentRun() ? result : invalidState();
    const current = await people.getPeople();
    if (!currentRun()) return invalidState();
    if (!['uninitialized', 'preparing', 'deleting', 'restoring', 'renaming', 'conflict', 'stale'].includes(current?.status) || typeof people.identify !== 'function') return { ...result, people: current };
    try {
      const refreshed = await people.identify({ onPhase: phase => { if (currentRun()) setState({ ...result, status: phase }); } });
      if (!currentRun()) return invalidState();
      const value = refreshed?.status === 'people_error' ? refreshed : await people.getPeople();
      if (!currentRun()) return invalidState();
      return { ...result, people: { ...value, warnings: [...new Map([...(value?.warnings || []), ...(refreshed?.warnings || [])].map(item => [item.code || JSON.stringify(item), item])).values()].slice(0, 80) }, ...(refreshed?.status === 'conflict' ? { peopleError: '人物改名恢复发生冲突，请稍后重试' } : {}), ...(refreshed?.peopleError ? { peopleError: refreshed.peopleError } : {}), peopleRecognitionFailed: refreshed?.status === 'people_error' || Boolean(refreshed?.peopleError) };
    } catch (error) {
      if (!currentRun()) return invalidState();
      return { ...result, status: ['ready', 'route_ready'].includes(result?.status) ? result.status : 'people_error', people: current, peopleError: mapPeopleError(error), peopleRecognitionFailed: true };
    }
  };
  let panel;
  const reload = async ({ announceLoading = false } = {}) => {
    const mine = ++uiEpoch;
    if (!enabled()) { const value = { status: 'disabled' }; if (mine === uiEpoch) panel?.setState(value); return value; }
    if (announceLoading) panel?.setState({ status: 'loading' });
    try {
      const result = typeof loadState === 'function'
        ? await loadState()
        : await readPeople(typeof formal?.getFormalState === 'function' ? await formal.getFormalState() : { status: 'error' }, mine);
      const value = enabled() && mine === uiEpoch ? result : invalidState();
      if (mine === uiEpoch) setState(value);
      return value;
    } catch {
      const value = enabled() ? { status: 'error' } : { status: 'disabled' };
      if (mine === uiEpoch) setState(value);
      return value;
    }
  };
  const open = event => {
    panel.host.style.display = 'block'; panel.show(event?.currentTarget || event?.target || documentRef.activeElement);
    void reload({ announceLoading: true });
  };
  panel = panelFactory({ formal, people, settings, apiTools, loadState: typeof loadState === 'function' ? reload : undefined, initialRelations, reviewActions, onPluginEnabledChange, onClose: () => { uiEpoch += 1; panel.host.style.display = 'none'; } });
  const setState = state => { panel.setState(state); if (state?.status === 'people_error') { const view = panel.root?.querySelector?.('.view'); const message = documentRef.createElement?.('p'); if (message) { message.className = 'error'; message.textContent = state.peopleError || '人物识别失败：暂时无法读取人物结果，请稍后重试。'; view?.append?.(message); } } };
  panel.host.style.display = 'none';
  documentRef.body.append(panel.host);
  const fab = (enableFab || typeof documentRef.createElement !== 'function') ? fabFactory({ onClick: open }) : { host: null };
  if (fab.host) { fab.host.style ||= {}; fab.host.style.display = enabled() ? '' : 'none'; documentRef.body.append(fab.host); }
  wandInstaller(open);
  documentRef.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.host.hidden) panel.close(); });
  const setEnabled = value => { uiEpoch += 1; if (fab.host?.style) fab.host.style.display = value ? '' : 'none'; if (!value) setState({ status: 'disabled' }); };
  const instance = { ...panel, fab, setState, setEnabled, show: open };
  panel.host.__qqjInstance = instance;
  return instance;
}
