import html from './panel.html?raw';
import css from './panel.css?inline';
import { createPanelGeometryController } from './layout.js';
import { createAppearanceController } from './appearance.js';
import { createSettingsDrawer, createSettingsDrawerState } from './settings-drawer.js';
import { createApiSettings } from './settings/api-settings.js';
import { createPromptsSettings } from './settings/prompts-settings.js';
import { createAppearanceSettings } from './settings/appearance-settings.js';
import { createScrollDiagnostics } from './scroll-diagnostics.js';
import { applyPluginEnabledImmediately } from '../settings.js';

const shellCss = ':host{position:fixed;inset:0;z-index:4000;width:100dvw;height:100dvh;pointer-events:none;background:transparent;text-shadow:none!important;isolation:isolate}:host([hidden]){display:none!important}.panel{position:fixed;top:80px;right:20px;width:360px;height:min(600px,85dvh);max-width:calc(100dvw - 40px);max-height:85dvh;display:grid;grid-template-rows:auto auto minmax(0,1fr) 24px;pointer-events:auto}.body{min-height:0;overflow-y:auto;scrollbar-gutter:stable;touch-action:pan-y}.tabs{overflow-x:auto;flex-wrap:nowrap}.tab{flex:0 0 auto}@media(max-width:640px){.panel{top:calc(20px + env(safe-area-inset-top,0px));left:50%;right:auto;transform:translateX(-50%);width:calc(100dvw - 20px);max-width:calc(100dvw - 20px);height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));max-height:none;grid-template-rows:auto auto minmax(0,1fr)}.panel-resize-handle{display:none}.tabs{scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}}';

export function createPanel({
  settings,
  apiTools,
  v3FoundationView,
  peopleProfilesView,
  sourcePermissionView,
  onPluginEnabledChange,
  onStoryClockChange,
  onAutoHideChange,
  isSevenDaysAvailable,
  dialog,
  onFabShowChange,
  onAppearanceChange,
  documentRef = globalThis.document,
} = {}) {
  if (!documentRef?.createElement) throw new TypeError('panel documentRef 无效');
  if (!v3FoundationView || ['mount', 'activate', 'deactivate'].some(name => typeof v3FoundationView[name] !== 'function')) {
    throw new TypeError('v3FoundationView 无效');
  }
  if (!peopleProfilesView || ['mount', 'activate', 'deactivate'].some(name => typeof peopleProfilesView[name] !== 'function')) {
    throw new TypeError('peopleProfilesView 无效');
  }
  const host = documentRef.createElement('div');
  host.id = 'qqj-panel-host';
  host.hidden = true;
  host.setAttribute('aria-hidden', 'true');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${shellCss}\n${css}</style>${html}`;
  const panel = root.querySelector('.panel');
  const body = root.querySelector('.body');
  const view = root.querySelector('.view');
  const tabs = [...root.querySelectorAll('.tab')];
  const geometry = createPanelGeometryController({
    panel,
    dragHandle: root.querySelector('.topbar'),
    resizeHandle: root.querySelector('.panel-resize-handle'),
    viewport: documentRef.defaultView ?? globalThis,
  });
  let activeTab = 'profiles';
  let screen = 'content';
  let mountedContentView = null;
  let enabled = settings?.isEnabled?.() !== false;
  let trigger = null;
  let activationEpoch = 0;
  const settingsDrawerState = createSettingsDrawerState();
  const scrollPositions = new Map();
  const themeButton = root.querySelector('.theme-btn');
  const fabToggleButton = root.querySelector('.fab-toggle-btn');
  let swipeGesture = null;
  let settingsManagementError = null;
  const scrollDiagnostics = createScrollDiagnostics({
    target: body,
    getPage: () => screen === 'settings' ? 'settings' : activeTab,
    windowRef: documentRef.defaultView ?? globalThis,
    navigatorRef: documentRef.defaultView?.navigator ?? globalThis.navigator,
  });

  const syncHeader = appearance => {
    const mode = settings?.get?.().appearanceTheme ?? 'auto';
    const next = mode === 'auto' ? '日间' : mode === 'day' ? '夜间' : '跟随酒馆';
    const labelCopy = mode === 'auto' ? '跟随酒馆' : mode === 'day' ? '日间' : '夜间';
    if (themeButton) {
      themeButton.dataset.themeMode = mode;
      themeButton.title = `主题：${labelCopy}（点击切换到${next}）`;
      themeButton.setAttribute('aria-label', `主题：${labelCopy}`);
      const icon = themeButton.querySelector?.('svg');
      if (icon) icon.innerHTML = mode === 'day'
        ? '<circle cx="12" cy="12" r="4"></circle><path d="M12 3v2M12 19v2M5.64 5.64l1.42 1.42M16.94 16.94l1.42 1.42M3 12h2M19 12h2M5.64 18.36l1.42-1.42M16.94 7.06l1.42-1.42"></path>'
        : mode === 'night' ? '<path d="M21 15.5A9 9 0 0 1 8.5 3 9 9 0 1 0 21 15.5Z"></path>'
          : '<path d="M12 3a9 9 0 1 0 0 18V3Z"></path><circle cx="12" cy="12" r="9"></circle>';
    }
    const showFab = settings?.get?.().fabShow !== false;
    if (fabToggleButton) {
      fabToggleButton.classList.toggle('active', showFab);
      fabToggleButton.title = `悬浮球：${showFab ? '显示' : '隐藏'}`;
      fabToggleButton.setAttribute('aria-label', showFab ? '隐藏悬浮球' : '显示悬浮球');
      fabToggleButton.setAttribute('aria-pressed', String(showFab));
    }
    dialog?.setAppearance?.(appearance);
    onAppearanceChange?.(appearance);
  };
  const appearance = createAppearanceController({ host, root, settings, documentRef, onChange: syncHeader });

  const element = (tag, className = '', text = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    return node;
  };
  const activateManagement = async () => {
    const mine = activationEpoch, errorNode = settingsManagementError;
    if (errorNode) { errorNode.hidden = true; errorNode.textContent = ''; }
    try { return await v3FoundationView.activate(); }
    catch (error) {
      if (mine !== activationEpoch || screen !== 'settings' || !errorNode || settingsManagementError !== errorNode) return { status: 'stale' };
      errorNode.textContent = `记忆管理暂时无法读取：${error?.message || '未知错误'}`;
      errorNode.hidden = false;
      return { status: 'error', error };
    }
  };
  const unmountContent = () => {
    v3FoundationView.deactivate();
    peopleProfilesView.deactivate();
    view.replaceChildren();
    mountedContentView = null;
    settingsManagementError = null;
  };
  const scrollKey = () => screen === 'settings' ? 'settings' : activeTab;
  const rememberScroll = () => { if (body) scrollPositions.set(scrollKey(), body.scrollTop || 0); };
  const restoreScroll = key => { if (body) body.scrollTop = scrollPositions.get(key) || 0; };
  const showStatus = text => {
    activationEpoch += 1;
    unmountContent();
    const box = element('section', 'empty-state');
    box.append(element('h2', '', '千千结'), element('p', '', text));
    view.append(box);
  };
  async function activateFoundation() {
    if (host.hidden || screen !== 'content') return { status: 'closed' };
    if (!enabled) { showStatus('千千结当前已关闭。记忆不会读取后端或写入数据。'); return { status: 'disabled' }; }
    activationEpoch += 1;
    if (activeTab === 'profiles') {
      if (mountedContentView !== 'profiles') {
        unmountContent(); peopleProfilesView.mount(view); mountedContentView = 'profiles';
      }
      restoreScroll(activeTab);
      const result = await peopleProfilesView.activate();
      return result;
    }
    v3FoundationView.setPage?.(activeTab === 'people' ? 'people' : 'memories');
    if (mountedContentView !== 'foundation') {
      unmountContent(); v3FoundationView.mount(view); mountedContentView = 'foundation';
    }
    restoreScroll(activeTab);
    const result = await v3FoundationView.activate();
    return result;
  }

  function selectTab(tab) {
    if (tab === 'settings') { if (screen !== 'settings') renderSettings(); return; }
    rememberScroll();
    activationEpoch += 1;
    screen = 'content';
    activeTab = tab;
    tabs.forEach(node => {
      const active = node.dataset.tab === activeTab;
      node.classList.toggle('active', active);
      node.setAttribute('aria-selected', String(active));
    });
    swipeGesture = null;
    void activateFoundation().catch(() => showStatus('当前聊天暂时无法读取千千结记忆。'));
  }

  function renderSettings({ focusSources = false } = {}) {
    rememberScroll();
    activationEpoch += 1;
    screen = 'settings';
    tabs.forEach(node => { const active = node.dataset.tab === 'settings'; node.classList.toggle('active', active); node.setAttribute('aria-selected', String(active)); });
    unmountContent();
    if (focusSources) { settingsDrawerState.open('general'); settingsDrawerState.open('worldbook'); }

    const page = element('section', 'settings-page');
    page.append(element('h2', '', '千千结设置'));

    // 总开关：standalone 主控，统管整个插件（含记忆自动提取）。
    const master = element('div', 'master-switch');
    const toggle = element('label', 'setting-switch');
    const enabledInput = element('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = settings.get().pluginEnabled !== false;
    toggle.append(enabledInput, element('span', '', '启用千千结'));
    const enabledResult = element('p', 'settings-result');
    enabledInput.addEventListener('change', async () => {
      const previous = settings.isEnabled();
      const desired = enabledInput.checked;
      enabledInput.disabled = true;
      enabledResult.textContent = desired ? '正在开启并保存…' : '正在关闭并保存…';
      enabledResult.className = 'settings-result';
      try {
        const applied = await applyPluginEnabledImmediately({ settings, enabled: desired, onChange: onPluginEnabledChange });
        if (applied.stale) return;
        enabled = applied.enabled;
        setEnabled(desired);
        enabledResult.textContent = desired ? '千千结已开启；酒馆正在后台保存设置。' : '千千结已关闭，后台读取、AI 与召回注入均已停止；已有档案保留，酒馆正在后台保存设置。';
        enabledResult.className = 'settings-result success';
      } catch (error) {
        enabled = previous;
        enabledInput.checked = previous;
        setEnabled(previous);
        enabledResult.textContent = `切换失败，已恢复原状态：${error?.message || '未知错误'}`;
        enabledResult.className = 'settings-result error';
      } finally {
        enabledInput.disabled = false;
      }
    });
    master.append(toggle, enabledResult);
    page.append(master);

    const managementMount = element('div', 'qqj-settings-management');
    settingsManagementError = element('p', 'v3-foundation-feedback error');
    settingsManagementError.hidden = true;

    const groupOf = (key, title) => createSettingsDrawer({
      documentRef, title, level: 'group', id: `qqj-settings-group-${key}`,
      open: settingsDrawerState.isOpen(key, false),
      onToggle: open => settingsDrawerState.set(key, open),
    });
    const subOpen = key => settingsDrawerState.isOpen(key, false);
    const subToggle = key => open => settingsDrawerState.set(key, open);

    // 通用设置：API / 世界书排除 / 提示词 / 外观（各子项 change 即存，API 预设区保留手动保存）。
    const { drawer: general, body: generalBody } = groupOf('general', '通用设置');
    const api = createApiSettings({
      settings, apiTools, documentRef,
      open: subOpen('api'), onToggle: subToggle('api'),
      advancedOpen: subOpen('api-advanced'), onAdvancedToggle: subToggle('api-advanced'),
      rerender: () => renderSettings(),
      isSevenDaysAvailable,
      confirmImpl: options => dialog?.confirm?.(options) ?? false,
      promptImpl: options => dialog?.prompt?.(options) ?? null,
    });
    const worldbook = sourcePermissionView?.renderSettings?.({
      open: subOpen('worldbook'), onDrawerToggle: subToggle('worldbook'),
    });
    const prompts = createPromptsSettings({ settings, documentRef, open: subOpen('prompts'), onToggle: subToggle('prompts'), onStoryClockChange });
    const appearanceSettings = createAppearanceSettings({
      settings, documentRef, open: subOpen('appearance'), onToggle: subToggle('appearance'),
      applyAppearance: () => appearance.apply(),
    });
    generalBody.append(api.node);
    if (worldbook) generalBody.append(worldbook);
    generalBody.append(prompts.node, appearanceSettings.node);
    page.append(general);

    const { drawer: memoryGroup, body: memoryBody } = groupOf('memory', '记忆设置');
    const autoHideToggle = element('label', 'setting-switch');
    const autoHideInput = element('input'); autoHideInput.type = 'checkbox'; autoHideInput.checked = settings.get().autoHideEnabled === true;
    autoHideToggle.append(autoHideInput, element('span', '', '自动隐藏已记忆旧楼'));
    const keepRow = element('label', 'qqj-auto-hide-row');
    keepRow.append(element('span', '', '隐藏 AI 楼层数'));
    const keepInput = element('input', 'settings-input settings-num'); keepInput.type = 'number'; keepInput.min = '1'; keepInput.max = '50'; keepInput.step = '1'; keepInput.value = String(settings.get().autoHideKeepAiCount ?? 3);
    keepRow.append(keepInput);
    const autoHideResult = element('p', 'settings-result');
    const applyAutoHide = async patch => {
      autoHideInput.disabled = true; keepInput.disabled = true; autoHideResult.className = 'settings-result'; autoHideResult.textContent = '正在保存并整理当前聊天…';
      try {
        settings.update(patch);
        const current = settings.get();
        autoHideInput.checked = current.autoHideEnabled === true; keepInput.value = String(current.autoHideKeepAiCount);
        const applied = await onAutoHideChange?.({ enabled: current.autoHideEnabled, keepAiCount: current.autoHideKeepAiCount });
        if (applied?.status === 'disabled') {
          autoHideResult.textContent = '设置已保存；重新启用千千结后生效。';
          autoHideResult.className = 'settings-result success';
          return;
        }
        autoHideResult.textContent = current.autoHideEnabled ? `已开启；保留最近 ${current.autoHideKeepAiCount} 个 AI 楼。` : '已关闭；千千结拥有的隐藏楼已恢复。';
        autoHideResult.className = 'settings-result success';
      } catch (error) {
        autoHideResult.textContent = `设置已保存，但当前聊天整理未完成：${error?.message || '未知错误'} 请再次调整设置重试。`;
        autoHideResult.className = 'settings-result error';
      } finally { autoHideInput.disabled = false; keepInput.disabled = false; }
    };
    autoHideInput.addEventListener('change', () => { void applyAutoHide({ autoHideEnabled: autoHideInput.checked }); });
    keepInput.addEventListener('change', () => { void applyAutoHide({ autoHideKeepAiCount: Number(keepInput.value) }); });
    memoryBody.append(autoHideToggle, keepRow, element('p', 'settings-hint', '保留最近 N 个 AI 楼及其用户上下文，隐藏更早且已完成记忆的楼。'), autoHideResult);
    page.append(memoryGroup);

    // 当前聊天的记忆操作紧跟通用设置，避免与总开关混成同一层级。
    page.append(managementMount, settingsManagementError);

    v3FoundationView.mount(managementMount);
    mountedContentView = 'foundation-settings';
    v3FoundationView.setPage?.('management');
    view.append(page);
    if (enabled) void activateManagement();
    restoreScroll('settings');
    if (focusSources) worldbook?.scrollIntoView?.({ block: 'start' });
  }

  function show(nextTrigger) {
    trigger = nextTrigger ?? trigger;
    host.hidden = false;
    host.setAttribute('aria-hidden', 'false');
    scrollDiagnostics.start();
    geometry.restore();
    let result = { status: 'ready' };
    if (screen === 'settings') renderSettings();
    else result = activateFoundation();
    root.querySelector('.close')?.focus?.();
    return result;
  }

  function close() {
    rememberScroll();
    activationEpoch += 1;
    v3FoundationView.deactivate();
    geometry.cancelGesture();
    swipeGesture = null;
    scrollDiagnostics.stop();
    dialog?.closeAll?.();
    host.hidden = true;
    host.setAttribute('aria-hidden', 'true');
    const previous = trigger;
    trigger = null;
    previous?.focus?.();
  }

  function setEnabled(value) {
    enabled = value === true;
    if (!enabled) {
      activationEpoch += 1;
      v3FoundationView.deactivate();
      if (!host.hidden && screen === 'content') showStatus('千千结当前已关闭。设置仍可打开。');
    } else if (!host.hidden && screen === 'content') void activateFoundation().catch(() => showStatus('当前聊天暂时无法读取千结记忆。'));
    else if (!host.hidden && screen === 'settings') void activateManagement();
  }

  const mobile = () => Number(documentRef.defaultView?.innerWidth) <= 640 || documentRef.defaultView?.matchMedia?.('(max-width: 640px)')?.matches === true;
  const blocksSwipe = target => Boolean(target?.closest?.('input,textarea,select,[contenteditable="true"],.qqj-inline-select,.qqj-profile-switcher,.qqj-relation-switcher,.qqj-model-list-items,.source-permission-list,.v3-memory-json,.v3-recall-injection,.qqj-dialog-overlay'));
  const point = event => event.touches?.[0] ?? event.changedTouches?.[0] ?? null;
  body?.addEventListener?.('touchstart', event => {
    const touch = point(event);
    if (!mobile() || !touch || event.touches?.length !== 1 || blocksSwipe(event.target)) { swipeGesture = null; return; }
    swipeGesture = { x: touch.clientX, y: touch.clientY, dx: 0, dy: 0, horizontal: false };
  }, { passive: true });
  body?.addEventListener?.('touchmove', event => {
    if (!swipeGesture) return; const touch = point(event); if (!touch) return;
    swipeGesture.dx = touch.clientX - swipeGesture.x; swipeGesture.dy = touch.clientY - swipeGesture.y;
    if (!swipeGesture.horizontal && Math.abs(swipeGesture.dy) > Math.abs(swipeGesture.dx)) { swipeGesture = null; return; }
    if (Math.abs(swipeGesture.dx) >= 12 && Math.abs(swipeGesture.dx) > Math.abs(swipeGesture.dy) * 1.35) { swipeGesture.horizontal = true; event.preventDefault?.(); scrollDiagnostics.markQqjSwipeIntercepted(); }
  }, { passive: false });
  body?.addEventListener?.('touchend', event => {
    if (!swipeGesture) return; const touch = point(event); if (touch) { swipeGesture.dx = touch.clientX - swipeGesture.x; swipeGesture.dy = touch.clientY - swipeGesture.y; }
    const gesture = swipeGesture; swipeGesture = null;
    if (Math.abs(gesture.dx) < 60 || Math.abs(gesture.dx) <= Math.abs(gesture.dy) * 1.35) return;
    event.preventDefault?.();
    scrollDiagnostics.markQqjSwipeIntercepted();
    const swipeTabs = ['profiles', 'events', 'people', 'settings'], current = screen === 'settings' ? 'settings' : activeTab, index = swipeTabs.indexOf(current), next = index + (gesture.dx < 0 ? 1 : -1);
    if (next >= 0 && next < swipeTabs.length) selectTab(swipeTabs[next]);
  }, { passive: false });
  body?.addEventListener?.('touchcancel', () => { swipeGesture = null; }, { passive: true });

  root.querySelector('.close')?.addEventListener('click', close);
  themeButton?.addEventListener('click', () => {
    const current = settings.get().appearanceTheme ?? 'auto';
    settings.update({ appearanceTheme: current === 'auto' ? 'day' : current === 'day' ? 'night' : 'auto' });
    appearance.apply();
    const select = root.querySelector('#qqj-appearance-theme'); if (select) select.value = settings.get().appearanceTheme;
  });
  fabToggleButton?.addEventListener('click', () => {
    const showFab = settings.get().fabShow === false;
    settings.update({ fabShow: showFab }); syncHeader(appearance.getState()); onFabShowChange?.(showFab);
  });
  tabs.forEach(tab => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));
  documentRef.addEventListener?.('keydown', event => { if (event.key !== 'Escape' || host.hidden) return; if (dialog?.hasActive?.()) { dialog.cancelTop(); event.preventDefault?.(); return; } close(); });

  return Object.freeze({
    host,
    root,
    show,
    openMemory(nextTrigger) { selectTab('events'); return show(nextTrigger); },
    close,
    setEnabled,
    showStatus,
    openSourceSettings: () => renderSettings({ focusSources: true }),
    activateFoundation,
    syncAppearance: () => appearance.apply(),
    async refresh() {
      if (host.hidden || screen !== 'content') return { status: 'closed' };
      v3FoundationView.deactivate();
      return activateFoundation();
    },
    getUiDiagnostic: () => JSON.stringify(scrollDiagnostics.snapshot(), null, 2),
    getState: () => ({ enabled, activeTab, screen, open: !host.hidden }),
  });
}
