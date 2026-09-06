import html from './panel.html?raw';
import css from './panel.css?inline';
import { createPanelGeometryController } from './layout.js';
import { applyAppearance } from './appearance.js';
import { createSettingsDrawer, createSettingsDrawerState } from './settings-drawer.js';
import { createApiSettings } from './settings/api-settings.js';
import { createPromptsSettings } from './settings/prompts-settings.js';
import { createAppearanceSettings } from './settings/appearance-settings.js';
import { applyPluginEnabledImmediately } from '../settings.js';

const shellCss = ':host{position:fixed;inset:0;z-index:4000;width:100dvw;height:100dvh;pointer-events:none;background:transparent;text-shadow:none!important;isolation:isolate}:host([hidden]){display:none!important}.panel{position:fixed;top:80px;right:20px;width:360px;height:min(600px,85dvh);max-width:calc(100dvw - 40px);max-height:85dvh;display:grid;grid-template-rows:auto auto minmax(0,1fr) 24px;pointer-events:auto}.body{min-height:0;overflow-y:auto;scrollbar-gutter:stable}.tabs{overflow-x:auto;flex-wrap:nowrap}.tab{flex:0 0 auto}@media(max-width:640px){.panel{top:calc(20px + env(safe-area-inset-top,0px));left:50%;right:auto;transform:translateX(-50%);width:calc(100dvw - 20px);max-width:calc(100dvw - 20px);height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));max-height:none;grid-template-rows:auto auto minmax(0,1fr)}.panel-resize-handle{display:none}.tabs{scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}}';

export function createPanel({
  settings,
  apiTools,
  v3FoundationView,
  peopleProfilesView,
  sourcePermissionView,
  onPluginEnabledChange,
  onStoryClockChange,
  isSevenDaysAvailable,
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
  const label = root.querySelector('.status-label');
  const tabs = [...root.querySelectorAll('.tab')];
  const geometry = createPanelGeometryController({
    panel,
    dragHandle: root.querySelector('.topbar'),
    resizeHandle: root.querySelector('.panel-resize-handle'),
    viewport: documentRef.defaultView ?? globalThis,
  });
  applyAppearance({ host, root, settings, documentRef });
  let activeTab = 'profiles';
  let screen = 'content';
  let mountedContentView = null;
  let enabled = settings?.isEnabled?.() !== false;
  let trigger = null;
  let activationEpoch = 0;
  const settingsDrawerState = createSettingsDrawerState();
  const scrollPositions = new Map();

  const element = (tag, className = '', text = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    return node;
  };
  const unmountContent = () => {
    v3FoundationView.deactivate();
    peopleProfilesView.deactivate();
    view.replaceChildren();
    mountedContentView = null;
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
    const mine = ++activationEpoch;
    const pageName = activeTab === 'profiles' ? '千人' : activeTab === 'people' ? '双丝网' : '千结';
    label.textContent = `正在读取${pageName}`;
    if (activeTab === 'profiles') {
      if (mountedContentView !== 'profiles') {
        unmountContent(); peopleProfilesView.mount(view); mountedContentView = 'profiles';
      }
      restoreScroll(activeTab);
      const result = await peopleProfilesView.activate();
      if (mine === activationEpoch && !host.hidden) label.textContent = result?.status === 'ready' ? pageName : `${pageName}状态`;
      return result;
    }
    v3FoundationView.setPage?.(activeTab === 'people' ? 'people' : 'memories');
    if (mountedContentView !== 'foundation') {
      unmountContent(); v3FoundationView.mount(view); mountedContentView = 'foundation';
    }
    restoreScroll(activeTab);
    const result = await v3FoundationView.activate();
    if (mine === activationEpoch && !host.hidden) label.textContent = result?.status === 'ready' ? pageName : `${pageName}状态`;
    return result;
  }

  function selectTab(tab) {
    rememberScroll();
    activationEpoch += 1;
    screen = 'content';
    activeTab = tab;
    tabs.forEach(node => {
      const active = node.dataset.tab === tab;
      node.classList.toggle('active', active);
      node.setAttribute('aria-selected', String(active));
    });
    void activateFoundation().catch(() => showStatus('当前聊天暂时无法读取千千结记忆。'));
  }

  function renderSettings({ focusSources = false } = {}) {
    rememberScroll();
    activationEpoch += 1;
    screen = 'settings';
    unmountContent();
    label.textContent = '千千结设置';
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
    });
    const worldbook = sourcePermissionView?.renderSettings?.({
      open: subOpen('worldbook'), onDrawerToggle: subToggle('worldbook'),
    });
    const prompts = createPromptsSettings({ settings, documentRef, open: subOpen('prompts'), onToggle: subToggle('prompts'), onStoryClockChange });
    const appearance = createAppearanceSettings({
      settings, documentRef, open: subOpen('appearance'), onToggle: subToggle('appearance'),
      applyAppearance: () => applyAppearance({ host, root, settings, documentRef }),
    });
    generalBody.append(api.node);
    if (worldbook) generalBody.append(worldbook);
    generalBody.append(prompts.node, appearance.node);
    page.append(general);

    // 当前聊天的记忆操作紧跟通用设置，避免与总开关混成同一层级。
    page.append(managementMount);

    v3FoundationView.mount(managementMount);
    mountedContentView = 'foundation-settings';
    v3FoundationView.setPage?.('management');
    view.append(page);
    if (enabled) void v3FoundationView.activate().catch(() => { label.textContent = '记忆管理暂时无法读取'; });
    restoreScroll('settings');
    if (focusSources) worldbook?.scrollIntoView?.({ block: 'start' });
  }

  function show(nextTrigger) {
    trigger = nextTrigger ?? trigger;
    host.hidden = false;
    host.setAttribute('aria-hidden', 'false');
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
    else if (!host.hidden && screen === 'settings') void v3FoundationView.activate().catch(() => { label.textContent = '记忆管理暂时无法读取'; });
  }

  root.querySelector('.close')?.addEventListener('click', close);
  root.querySelector('.settings-btn')?.addEventListener('click', () => {
    if (screen === 'settings') selectTab(activeTab);
    else renderSettings();
  });
  tabs.forEach(tab => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));
  documentRef.addEventListener?.('keydown', event => { if (event.key === 'Escape' && !host.hidden) close(); });

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
    async refresh() {
      if (host.hidden || screen !== 'content') return { status: 'closed' };
      v3FoundationView.deactivate();
      return activateFoundation();
    },
    getState: () => ({ enabled, activeTab, screen, open: !host.hidden }),
  });
}
