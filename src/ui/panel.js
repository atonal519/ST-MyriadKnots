import html from './panel.html?raw';
import css from './panel.css?inline';
import { createPanelGeometryController } from './layout.js';
import { applyArchiveV2Appearance } from './archive-v2-appearance.js';
import { createSettingsDrawer, createSettingsDrawerState } from './settings-drawer.js';

const shellCss = ':host{position:fixed;inset:0;z-index:4000;width:100dvw;height:100dvh;pointer-events:none;background:transparent;text-shadow:none!important;isolation:isolate}:host([hidden]){display:none!important}.panel{position:fixed;top:80px;right:20px;width:360px;height:min(600px,85dvh);max-width:calc(100dvw - 40px);max-height:85dvh;display:grid;grid-template-rows:auto auto minmax(0,1fr) 24px;pointer-events:auto}.body{min-height:0;overflow-y:auto;scrollbar-gutter:stable}.tabs{overflow-x:auto;flex-wrap:nowrap}.tab{flex:0 0 auto}@media(max-width:640px){.panel{top:calc(20px + env(safe-area-inset-top,0px));left:50%;right:auto;transform:translateX(-50%);width:calc(100dvw - 20px);max-width:calc(100dvw - 20px);height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));max-height:none;grid-template-rows:auto auto minmax(0,1fr)}.panel-resize-handle{display:none}.tabs{scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}}';

const PLACEHOLDERS = Object.freeze({
  events: ['千事', '时间轴与审核游标将在后续版本接入。'],
  next: ['下一步', '行动建议与人工保留项将在后续版本接入。'],
});

export function createPanel({
  settings,
  apiTools,
  archiveV2InitializationView,
  archiveV2BondView,
  sourcePermissionView,
  onPluginEnabledChange,
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
  const appendOption = (select, value, text) => {
    const option = element('option', '', text);
    option.value = value;
    select.append(option);
    return option;
  };
  const unmountArchive = () => {
    archiveV2InitializationView.deactivate();
    archiveV2BondView.deactivate();
    view.replaceChildren();
    mounted = false;
    bondsMounted = false;
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
      view.replaceChildren();
      archiveV2InitializationView.mount(view);
      mounted = true;
      bondsMounted = false;
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
      view.replaceChildren();
      archiveV2BondView.mount(view);
      bondsMounted = true;
      mounted = false;
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
    else if (tab === 'bonds') void openBonds().catch(() => showStatus('当前聊天暂时无法读取双丝网。'));
    else renderPlaceholder(tab);
  }

  function apiCopy(error) {
    return {
      QQJ_DISABLED: '千千结当前已关闭。',
      QQJ_CONFIG: '主 API 配置不完整。',
      QQJ_PRESET_INVALID: '所选 API 预设已失效。',
      QQJ_TIMEOUT: 'API 请求超时。',
    }[error?.code] ?? 'API 操作没有完成。';
  }

  function renderSettings({ focusSources = false } = {}) {
    activationEpoch += 1;
    screen = 'settings';
    archiveV2InitializationView.deactivate();
    archiveV2BondView.deactivate();
    view.replaceChildren();
    mounted = false;
    bondsMounted = false;
    label.textContent = 'V2 设置';
    const current = settings.get();
    const sharedMain = settings.sharedMainConfig();
    const presets = settings.sharedPresets();
    const page = element('section', 'settings-page');
    const field = (title, control) => { const labelNode = element('label', 'settings-field'); labelNode.append(element('span', '', title), control); return labelNode; };
    const drawer = (key, title, defaultOpen = false, className = '') => {
      const result = createSettingsDrawer({
        documentRef,
        title,
        className,
        id: `qqj-settings-${key}`,
        open: settingsDrawerState.isOpen(key, defaultOpen),
        onToggle: open => settingsDrawerState.set(key, open),
      });
      return result;
    };
    if (focusSources) settingsDrawerState.open('worldbook');
    page.append(element('h2', '', '千千结设置'));

    const { drawer: general, body: generalBody } = drawer('general', '总开关', true);
    const toggle = element('label', 'setting-switch');
    const enabledInput = element('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = current.pluginEnabled !== false;
    toggle.append(enabledInput, element('span', '', '启用千千结 V2'));
    generalBody.append(toggle, element('p', 'settings-hint', '关闭后不读取后端、不调用 AI；已有记录保持原样。'));
    page.append(general);

    const source = sourcePermissionView?.renderSettings?.({
      open: settingsDrawerState.isOpen('worldbook'),
      onDrawerToggle: open => settingsDrawerState.set('worldbook', open),
    });
    if (source) page.append(source);

    const { drawer: prompts, body: promptsBody } = drawer('prompts', '提示词与包裹符');
    const keepTags = element('input', 'settings-input'); keepTags.value = current.sourceKeepTags ?? 'content'; keepTags.placeholder = 'content';
    const extraTags = element('input', 'settings-input'); extraTags.value = current.sourceExtraTags ?? ''; extraTags.placeholder = 'think, reasoning';
    const generalPrompt = element('textarea', 'settings-input'); generalPrompt.value = current.generalPrompt ?? ''; generalPrompt.placeholder = '留空则不追加通用提示词';
    promptsBody.append(field('保留正文的包裹符', keepTags), field('连同内容剔除的包裹符', extraTags), field('通用附加提示词', generalPrompt));
    promptsBody.append(element('p', 'settings-hint', '机器 JSON 合同始终最后生效；正文只在进入 AI 前经过一次共享净化。'));
    page.append(prompts);

    const { drawer: appearance, body: appearanceBody } = drawer('appearance', '千千结外观');
    const theme = element('select', 'settings-input');
    for (const [value, copy] of [['auto', '自动'], ['day', '日间'], ['night', '夜间']]) appendOption(theme, value, copy);
    theme.value = current.appearanceTheme ?? 'auto';
    const scale = element('input', 'settings-input'); scale.type = 'range'; scale.min = '0.75'; scale.max = '1.5'; scale.step = '0.05'; scale.value = String(current.appearanceScale ?? 1);
    const fontCssUrl = element('input', 'settings-input'); fontCssUrl.value = current.appearanceFontCssUrl ?? ''; fontCssUrl.placeholder = 'https://…/font.css';
    const fontFamily = element('input', 'settings-input'); fontFamily.value = current.appearanceFontFamily ?? ''; fontFamily.placeholder = '例如 LXGW WenKai';
    appearanceBody.append(field('主题', theme), field('界面缩放', scale), field('自定义字体 CSS URL', fontCssUrl), field('字体 family', fontFamily));
    page.append(appearance);

    const { drawer: api, body: apiBody } = drawer('api', '主 API 与副 API', true);
    const mainSelect = element('select', 'settings-input');
    appendOption(mainSelect, '', '主配置');
    for (const preset of presets) appendOption(mainSelect, preset.id, preset.name);
    mainSelect.value = current.apiMode === 'seven-preset' ? current.selectedSevenDaysPresetId : '';
    const utilitySelect = element('select', 'settings-input');
    appendOption(utilitySelect, '', '跟随主 API');
    for (const preset of presets) appendOption(utilitySelect, preset.id, preset.name);
    utilitySelect.value = presets.some(item => item.id === settings.sharedUtilityPresetId()) ? settings.sharedUtilityPresetId() : '';
    const selectedConfig = () => presets.find(item => item.id === mainSelect.value) ?? sharedMain;
    const url = element('input', 'settings-input'); url.placeholder = 'API URL';
    const key = element('input', 'settings-input'); key.type = 'password'; key.placeholder = '留空保持原 Key';
    const model = element('input', 'settings-input'); model.placeholder = '模型名称';
    const exclude = element('textarea', 'settings-input'); exclude.placeholder = '排除参数，每行一个';
    const timeout = element('input', 'settings-input'); timeout.type = 'number'; timeout.min = '5'; timeout.max = '600';
    const stream = element('input'); stream.type = 'checkbox';
    let clearKey = false;
    const fill = () => {
      const config = selectedConfig();
      url.value = config.url ?? '';
      key.value = '';
      key.placeholder = config.key ? '已保存，留空保持不变' : '输入 API Key';
      model.value = config.model ?? '';
      exclude.value = (config.excludeParams ?? []).join('\n');
      timeout.value = String(config.timeoutSec ?? 180);
      stream.checked = config.stream === true;
      clearKey = false;
    };
    mainSelect.addEventListener('change', fill);
    fill();
    const keyClear = button('清除 Key', 'secondary-action', () => { clearKey = true; key.value = ''; key.placeholder = '保存后清除'; });
    const result = element('p', 'settings-result');
    const draft = () => ({
      url: url.value.trim(),
      key: clearKey ? '' : (key.value.trim() || selectedConfig().key || ''),
      model: model.value.trim(),
      excludeParams: exclude.value,
      timeoutSec: Number(timeout.value),
      stream: stream.checked,
    });
    apiBody.append(field('人物整理使用', mainSelect), field('历史扫描／人设补全使用', utilitySelect), field('URL', url), field('Key', key), keyClear, field('模型', model), field('排除参数', exclude), field('超时秒数', timeout));
    const streamLabel = element('label', 'setting-switch'); streamLabel.append(stream, element('span', '', '流式请求')); apiBody.append(streamLabel);
    const actions = element('div', 'settings-actions');
    const save = button('保存设置', 'primary-action', async () => {
      const wasEnabled = settings.isEnabled();
      if (mainSelect.value) {
        const selected = presets.find(item => item.id === mainSelect.value);
        if (selected) settings.upsertSharedPreset(selected.name, draft(), selected.id);
        settings.update({ apiMode: 'seven-preset', selectedSevenDaysPresetId: mainSelect.value, pluginEnabled: enabledInput.checked });
      } else {
        settings.saveSharedMainConfig(draft());
        settings.update({ apiMode: 'auto', selectedSevenDaysPresetId: '', pluginEnabled: enabledInput.checked });
      }
      settings.setSharedUtilityPresetId(utilitySelect.value);
      settings.update({
        sourceKeepTags: keepTags.value,
        sourceExtraTags: extraTags.value,
        generalPrompt: generalPrompt.value,
        appearanceTheme: theme.value,
        appearanceScale: Number(scale.value),
        appearanceFontCssUrl: fontCssUrl.value,
        appearanceFontFamily: fontFamily.value,
      });
      applyArchiveV2Appearance({ host, root, settings, documentRef });
      enabled = settings.isEnabled();
      if (wasEnabled !== enabled) await onPluginEnabledChange?.(enabled);
      result.textContent = '设置已保存。'; result.className = 'settings-result success';
    });
    const create = button('另存为预设', 'secondary-action', () => {
      const name = globalThis.prompt?.('新预设名称', '千千结预设')?.trim();
      if (!name) return;
      const id = settings.upsertSharedPreset(name, draft());
      settings.update({ apiMode: 'seven-preset', selectedSevenDaysPresetId: id });
      renderSettings();
    });
    const test = button('测试连接', 'secondary-action', async () => {
      result.textContent = '正在测试…';
      try { const response = await apiTools.testConnection({ apiMode: mainSelect.value ? 'seven-preset' : 'auto', selectedSevenDaysPresetId: mainSelect.value }); result.textContent = `连接成功 · ${response?.model || '当前模型'}`; result.className = 'settings-result success'; }
      catch (error) { result.textContent = apiCopy(error); result.className = 'settings-result error'; }
    });
    actions.append(save, create, test);
    apiBody.append(actions, result);
    page.append(api);
    view.append(page);
    if (focusSources) source?.scrollIntoView?.({ block: 'start' });
  }

  function show(nextTrigger) {
    trigger = nextTrigger ?? trigger;
    host.hidden = false;
    host.setAttribute('aria-hidden', 'false');
    geometry.restore();
    let result = { status: 'ready' };
    if (screen === 'settings') renderSettings();
    else if (activeTab === 'people') result = openPeople();
    else if (activeTab === 'bonds') result = openBonds();
    else renderPlaceholder(activeTab);
    root.querySelector('.close')?.focus?.();
    return result;
  }

  function close() {
    activationEpoch += 1;
    archiveV2InitializationView.deactivate();
    archiveV2BondView.deactivate();
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
      if (!host.hidden && screen === 'content') showStatus('千千结当前已关闭。设置仍可打开，旧档案不会被修改。');
    } else if (!host.hidden && screen === 'content' && activeTab === 'people') void openPeople().catch(() => showStatus('当前聊天暂时无法建立稳定身份。'));
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
    close,
    setEnabled,
    showStatus,
    openSourceSettings: () => renderSettings({ focusSources: true }),
    activatePeople,
    activateBonds,
    async refresh() {
      if (host.hidden || screen !== 'content' || !['people', 'bonds'].includes(activeTab)) return { status: 'closed' };
      archiveV2InitializationView.deactivate();
      archiveV2BondView.deactivate();
      return activeTab === 'people' ? openPeople() : openBonds();
    },
    getState: () => ({ enabled, activeTab, screen, open: !host.hidden }),
  });
}
