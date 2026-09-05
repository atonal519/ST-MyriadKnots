import { createSettingsKit } from './kit.js';

function apiErrorCopy(error) {
  return {
    QQJ_DISABLED: '千千结当前已关闭。',
    QQJ_CONFIG: '主 API 配置不完整。',
    QQJ_PRESET_INVALID: '所选 API 预设已失效。',
    QQJ_TIMEOUT: 'API 请求超时。',
  }[error?.code] ?? 'API 操作没有完成。';
}

// API 配置：分析/摘要角色选择（change 即存）＋预设编辑区（手动 保存/另存/测试/拉取模型）＋高级设置子抽屉。
export function createApiSettings({
  settings,
  apiTools,
  documentRef = globalThis.document,
  open = false,
  onToggle,
  advancedOpen = false,
  onAdvancedToggle,
  rerender,
} = {}) {
  const { element, button, field, appendOption, subDrawer } = createSettingsKit(documentRef);
  const { drawer, body } = subDrawer({ title: 'API 配置', id: 'qqj-settings-api', open, onToggle });

  const current = settings.get();
  const sharedMain = settings.sharedMainConfig();
  const presets = settings.sharedPresets();

  const analysisSelect = element('select', 'settings-input');
  appendOption(analysisSelect, '', '主配置');
  for (const preset of presets) appendOption(analysisSelect, preset.id, preset.name);
  analysisSelect.value = current.apiMode === 'seven-preset' ? current.selectedSevenDaysPresetId : '';

  const summarySelect = element('select', 'settings-input');
  appendOption(summarySelect, '', '跟随分析API');
  for (const preset of presets) appendOption(summarySelect, preset.id, preset.name);
  summarySelect.value = presets.some(item => item.id === settings.sharedUtilityPresetId()) ? settings.sharedUtilityPresetId() : '';

  const selectedConfig = () => presets.find(item => item.id === analysisSelect.value) ?? sharedMain;

  const url = element('input', 'settings-input'); url.placeholder = 'API URL';
  const key = element('input', 'settings-input'); key.type = 'password'; key.placeholder = '留空保持原 Key';
  const model = element('input', 'settings-input'); model.placeholder = '模型名称';
  const modelList = element('datalist'); modelList.id = 'qqj-model-options'; model.setAttribute('list', modelList.id);
  const exclude = element('textarea', 'settings-input'); exclude.placeholder = '排除参数，每行一个';
  const timeout = element('input', 'settings-input'); timeout.type = 'number'; timeout.min = '5'; timeout.max = '600';
  const stream = element('input'); stream.type = 'checkbox';

  const fill = () => {
    const config = selectedConfig();
    url.value = config.url ?? '';
    key.value = '';
    key.placeholder = config.key ? '已保存，留空保持不变' : '输入 API Key';
    model.value = config.model ?? '';
    exclude.value = (config.excludeParams ?? []).join('\n');
    timeout.value = String(config.timeoutSec ?? 180);
    stream.checked = config.stream === true;
  };
  fill();

  // 分析/摘要角色选择：change 即存。
  analysisSelect.addEventListener('change', () => {
    settings.update({ apiMode: analysisSelect.value ? 'seven-preset' : 'auto', selectedSevenDaysPresetId: analysisSelect.value });
    fill();
  });
  summarySelect.addEventListener('change', () => settings.setSharedUtilityPresetId(summarySelect.value));

  const draft = () => ({
    url: url.value.trim(),
    key: key.value.trim() || selectedConfig().key || '',
    model: model.value.trim(),
    excludeParams: exclude.value,
    timeoutSec: Number(timeout.value),
    stream: stream.checked,
  });

  const result = element('p', 'settings-result');
  const selection = () => ({ apiMode: analysisSelect.value ? 'seven-preset' : 'auto', selectedSevenDaysPresetId: analysisSelect.value });

  const fetchBtn = button('拉取模型', 'secondary-action', async () => {
    result.textContent = '正在拉取模型…'; result.className = 'settings-result';
    fetchBtn.disabled = true;
    try {
      const models = await apiTools.fetchModels(selection());
      modelList.replaceChildren(...models.map(name => { const option = element('option'); option.value = name; return option; }));
      if (!model.value.trim() && models[0]) model.value = models[0];
      result.textContent = `已拉取 ${models.length} 个模型`; result.className = 'settings-result success';
    } catch (error) {
      result.textContent = apiErrorCopy(error); result.className = 'settings-result error';
    } finally {
      fetchBtn.disabled = false;
    }
  });

  const save = button('保存设置', 'primary-action', () => {
    if (analysisSelect.value) {
      const selected = presets.find(item => item.id === analysisSelect.value);
      if (selected) settings.upsertSharedPreset(selected.name, draft(), selected.id);
      settings.update({ apiMode: 'seven-preset', selectedSevenDaysPresetId: analysisSelect.value });
    } else {
      settings.saveSharedMainConfig(draft());
      settings.update({ apiMode: 'auto', selectedSevenDaysPresetId: '' });
    }
    settings.setSharedUtilityPresetId(summarySelect.value);
    result.textContent = 'API 设置已保存。'; result.className = 'settings-result success';
  });
  const create = button('另存为预设', 'secondary-action', () => {
    const name = globalThis.prompt?.('新预设名称', '千千结预设')?.trim();
    if (!name) return;
    const id = settings.upsertSharedPreset(name, draft());
    settings.update({ apiMode: 'seven-preset', selectedSevenDaysPresetId: id });
    rerender?.();
  });
  const test = button('测试连接', 'secondary-action', async () => {
    result.textContent = '正在测试…'; result.className = 'settings-result';
    try {
      const response = await apiTools.testConnection(selection());
      result.textContent = `连接成功 · ${response?.model || '当前模型'}`; result.className = 'settings-result success';
    } catch (error) {
      result.textContent = apiErrorCopy(error); result.className = 'settings-result error';
    }
  });

  const modelRow = element('div', 'settings-inline');
  modelRow.append(model, fetchBtn);
  const actions = element('div', 'settings-actions');
  actions.append(save, create, test);

  const { drawer: advanced, body: advancedBody } = subDrawer({ title: '高级设置', id: 'qqj-settings-api-advanced', open: advancedOpen, onToggle: onAdvancedToggle });
  advanced.classList.add('sub-advanced');
  const streamLabel = element('label', 'setting-switch'); streamLabel.append(stream, element('span', '', '流式请求'));
  advancedBody.append(field('排除参数', exclude), streamLabel, field('超时秒数', timeout));

  body.append(
    field('分析API（建议高质模型）', analysisSelect),
    field('摘要API（建议快速模型）', summarySelect),
    element('div', 'settings-divider'),
    field('URL', url),
    field('Key', key),
    field('模型', modelRow),
    modelList,
    actions,
    result,
    advanced,
  );
  return { node: drawer };
}
