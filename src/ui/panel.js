import html from './panel.html?raw';
import css from './panel.css?inline';
import { createPanelGeometryController } from './layout.js';
import { applyArchiveV2Appearance } from './archive-v2-appearance.js';
import { createSettingsDrawer, createSettingsDrawerState } from './settings-drawer.js';
import { createApiSettings } from './settings/api-settings.js';
import { createPromptsSettings } from './settings/prompts-settings.js';
import { createAppearanceSettings } from './settings/appearance-settings.js';
import { createMemorySettings } from './settings/memory-settings.js';
import { applyPluginEnabledImmediately } from '../settings.js';

const shellCss = ':host{position:fixed;inset:0;z-index:4000;width:100dvw;height:100dvh;pointer-events:none;background:transparent;text-shadow:none!important;isolation:isolate}:host([hidden]){display:none!important}.panel{position:fixed;top:80px;right:20px;width:360px;height:min(600px,85dvh);max-width:calc(100dvw - 40px);max-height:85dvh;display:grid;grid-template-rows:auto auto minmax(0,1fr) 24px;pointer-events:auto}.body{min-height:0;overflow-y:auto;scrollbar-gutter:stable}.tabs{overflow-x:auto;flex-wrap:nowrap}.tab{flex:0 0 auto}@media(max-width:640px){.panel{top:calc(20px + env(safe-area-inset-top,0px));left:50%;right:auto;transform:translateX(-50%);width:calc(100dvw - 20px);max-width:calc(100dvw - 20px);height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));max-height:none;grid-template-rows:auto auto minmax(0,1fr)}.panel-resize-handle{display:none}.tabs{scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}}';

const PLACEHOLDERS = Object.freeze({
  next: ['下一步', '行动建议与人工保留项将在后续版本接入。'],
});

export function createPanel({
  settings,
  apiTools,
  archiveV2InitializationView,
  archiveV2BondView,
  v3FoundationView,
  sourcePermissionView,
  onPluginEnabledChange,
  onAutomationSettingsChange,
  onOpenPeople,
  onOpenBonds,
  documentRef = globalThis.document,
} = {}) {
  if (!documentRef?.createElement) throw new TypeError('panel documentRef 无效');
  if (!archiveV2InitializationView || ['mount', 'activate', 'deactivate'].some(name => typeof archiveV2InitializationView[name] !== 'function')) {
    throw new TypeError('archiveV2InitializationView 无效');
  }
  if (!archiveV2BondView || ['mount', 'activate', 'deactivate'].some(name => typeof archiveV2BondView[name] !== 'function')) {
    throw new TypeError('archiveV2BondView 无效');
  }
  if (!v3FoundationView || ['mount', 'activate', 'deactivate'].some(name => typeof v3FoundationView[name] !== 'function')) {
    throw new TypeError('v3FoundationView 无效');
  }
  const host = documentRef.createElement('div');
  host.id = 'qqj-panel-host';
  host.hidden = true;
  host.setAttribute('aria-hidden', 'true');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${shellCss}\n${css}</style>${html}`;
  const panel = root.querySelector('.panel');
  const view = root.querySelector('.view');
  const label = root.querySelector('.status-label');
  const tabs = [...root.querySelectorAll('.tab')];
  const geometry = createPanelGeometryController({
    panel,
    dragHandle: root.querySelector('.topbar'),
    resizeHandle: root.querySelector('.panel-resize-handle'),
    viewport: documentRef.defaultView ?? globalThis,
  });
  applyArchiveV2Appearance({ host, root, settings, documentRef });
  let activeTab = 'people';
  let screen = 'content';
  let mounted = false;
  let bondsMounted = false;
  let foundationMounted = false;
  let enabled = settings?.isEnabled?.() !== false;
  let trigger = null;
  let activationEpoch = 0;
  const settingsDrawerState = createSettingsDrawerState();

  const element = (tag, className = '', text = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    return node;
  };
  const button = (text, className, action) => {
    const node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };
  const unmountArchive = () => {
    archiveV2InitializationView.deactivate();
    archiveV2BondView.deactivate();
    v3FoundationView.deactivate();
    view.replaceChildren();
    mounted = false;
    bondsMounted = false;
    foundationMounted = false;
  };
  const showStatus = text => {
    activationEpoch += 1;
    unmountArchive();
    const box = element('section', 'empty-state');
    box.append(element('h2', '', '千千结'), element('p', '', text));
    view.append(box);
  };
  const renderPlaceholder = tab => {
    unmountArchive();
    const [title, copy] = PLACEHOLDERS[tab] ?? ['千千结', '该模块尚未实现。'];
    const box = element('section', 'empty-state qqj-v2-placeholder');
    box.append(element('h2', '', title), element('p', '', copy));
    view.append(box);
    label.textContent = `${title} · 延期项`;
  };

  async function activatePeople() {
    if (host.hidden || activeTab !== 'people' || screen !== 'content') return { status: 'closed' };
    if (!enabled) { showStatus('千千结当前已关闭。设置仍可打开，旧档案不会被修改。'); return { status: 'disabled' }; }
    const mine = ++activationEpoch;
    label.textContent = '正在读取 V2 档案';
    if (!mounted) {
      archiveV2BondView.deactivate();
      v3FoundationView.deactivate();
      view.replaceChildren();
      archiveV2InitializationView.mount(view);
      mounted = true;
      bondsMounted = false;
      foundationMounted = false;
    }
    const result = await archiveV2InitializationView.activate();
    if (mine === activationEpoch && !host.hidden) label.textContent = result?.status === 'ready' ? '千人档案' : 'V2 历史初始化';
    return result;
  }

  async function openPeople() {
    if (!enabled) return activatePeople();
    const prepared = typeof onOpenPeople === 'function' ? await onOpenPeople() : { status: 'ready' };
    if (prepared?.status !== 'ready') {
      showStatus(prepared?.status === 'disabled' ? '千千结当前已关闭。' : '当前聊天身份已经变化，请重试。');
      return prepared;
    }
    return activatePeople();
  }

  async function activateBonds() {
    if (host.hidden || activeTab !== 'bonds' || screen !== 'content') return { status: 'closed' };
    if (!enabled) { showStatus('千千结当前已关闭。设置仍可打开，旧档案不会被修改。'); return { status: 'disabled' }; }
    const mine = ++activationEpoch;
    label.textContent = '正在读取双丝网';
    if (!bondsMounted) {
      archiveV2InitializationView.deactivate();
      v3FoundationView.deactivate();
      view.replaceChildren();
      archiveV2BondView.mount(view);
      bondsMounted = true;
      mounted = false;
      foundationMounted = false;
    }
    const result = await archiveV2BondView.activate();
    if (mine === activationEpoch && !host.hidden) label.textContent = '双丝网';
    return result;
  }

  async function openBonds() {
    if (!enabled) return activateBonds();
    const prepared = typeof onOpenBonds === 'function' ? await onOpenBonds() : { status: 'ready' };
    if (prepared?.status !== 'ready') {
      showStatus(prepared?.status === 'disabled' ? '千千结当前已关闭。' : '当前聊天身份已经变化，请重试。');
      return prepared;
    }
    return activateBonds();
  }

  async function activateFoundation() {
    if (host.hidden || activeTab !== 'events' || screen !== 'content') return { status: 'closed' };
    if (!enabled) { showStatus('千千结当前已关闭。V3 地基不会读取后端或写入数据。'); return { status: 'disabled' }; }
    const mine = ++activationEpoch;
    label.textContent = 'V3 地基诊断';
    if (!foundationMounted) {
      archiveV2InitializationView.deactivate();
      archiveV2BondView.deactivate();
      view.replaceChildren();
      v3FoundationView.mount(view);
      foundationMounted = true;
      mounted = false;
      bondsMounted = false;
    }
    const result = await v3FoundationView.activate();
    if (mine === activationEpoch && !host.hidden) label.textContent = result?.status === 'ready' ? 'V3 地基可用' : 'V3 地基诊断';
    return result;
  }

  function selectTab(tab) {
    activationEpoch += 1;
    screen = 'content';
    activeTab = tab;
    tabs.forEach(node => {
      const active = node.dataset.tab === tab;
      node.classList.toggle('active', active);
      node.setAttribute('aria-selected', String(active));
    });
    if (tab === 'people') void openPeople().catch(() => showStatus('当前聊天暂时无法建立稳定身份。'));
    else if (tab === 'events') void activateFoundation().catch(() => showStatus('当前聊天暂时无法读取 V3 地基。'));
    else if (tab === 'bonds') void openBonds().catch(() => showStatus('当前聊天暂时无法读取双丝网。'));
    else renderPlaceholder(tab);
  }

  function renderSettings({ focusSources = false } = {}) {
    activationEpoch += 1;
    screen = 'settings';
    archiveV2InitializationView.deactivate();
    archiveV2BondView.deactivate();
    v3FoundationView.deactivate();
    view.replaceChildren();
    mounted = false;
    bondsMounted = false;
    foundationMounted = false;
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
    });
    const worldbook = sourcePermissionView?.renderSettings?.({
      open: subOpen('worldbook'), onDrawerToggle: subToggle('worldbook'),
    });
    const prompts = createPromptsSettings({ settings, documentRef, open: subOpen('prompts'), onToggle: subToggle('prompts') });
    const appearance = createAppearanceSettings({
      settings, documentRef, open: subOpen('appearance'), onToggle: subToggle('appearance'),
      applyAppearance: () => applyArchiveV2Appearance({ host, root, settings, documentRef }),
    });
    generalBody.append(api.node);
    if (worldbook) generalBody.append(worldbook);
    generalBody.append(prompts.node, appearance.node);
    page.append(general);

    // 记忆设置：记忆提取周期（每 N 楼提取一次），为后续记忆项预留。
    const { drawer: memoryGroup, body: memoryBody } = groupOf('memory', '记忆设置');
    const memory = createMemorySettings({
      settings, documentRef, open: subOpen('memory-period'), onToggle: subToggle('memory-period'),
      onAutomationChange: onAutomationSettingsChange,
    });
    memoryBody.append(memory.node);
    page.append(memoryGroup);

    view.append(page);
    if (focusSources) worldbook?.scrollIntoView?.({ block: 'start' });
  }

  function show(nextTrigger) {
    trigger = nextTrigger ?? trigger;
    host.hidden = false;
    host.setAttribute('aria-hidden', 'false');
    geometry.restore();
    let result = { status: 'ready' };
    if (screen === 'settings') renderSettings();
    else if (activeTab === 'people') result = openPeople();
    else if (activeTab === 'events') result = activateFoundation();
    else if (activeTab === 'bonds') result = openBonds();
    else renderPlaceholder(activeTab);
    root.querySelector('.close')?.focus?.();
    return result;
  }

  function close() {
    activationEpoch += 1;
    archiveV2InitializationView.deactivate();
    archiveV2BondView.deactivate();
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
      archiveV2InitializationView.deactivate();
      archiveV2BondView.deactivate();
      v3FoundationView.deactivate();
      if (!host.hidden && screen === 'content') showStatus('千千结当前已关闭。设置仍可打开，旧档案不会被修改。');
    } else if (!host.hidden && screen === 'content' && activeTab === 'people') void openPeople().catch(() => showStatus('当前聊天暂时无法建立稳定身份。'));
    else if (!host.hidden && screen === 'content' && activeTab === 'events') void activateFoundation().catch(() => showStatus('当前聊天暂时无法读取 V3 地基。'));
    else if (!host.hidden && screen === 'content' && activeTab === 'bonds') void openBonds().catch(() => showStatus('当前聊天暂时无法读取双丝网。'));
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
    activatePeople,
    activateBonds,
    activateFoundation,
    async refresh() {
      if (host.hidden || screen !== 'content' || !['people', 'events', 'bonds'].includes(activeTab)) return { status: 'closed' };
      archiveV2InitializationView.deactivate();
      archiveV2BondView.deactivate();
      v3FoundationView.deactivate();
      if (activeTab === 'people') return openPeople();
      if (activeTab === 'events') return activateFoundation();
      return openBonds();
    },
    getState: () => ({ enabled, activeTab, screen, open: !host.hidden }),
  });
}
