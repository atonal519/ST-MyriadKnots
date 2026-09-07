import { createSettingsKit } from './kit.js';
import { createInlineSelect } from '../inline-select.js';

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
  confirmImpl = options => globalThis.confirm?.(typeof options === 'string' ? options : `${options?.title ?? '请确认'}\n\n${options?.body ?? ''}`) === true,
  promptImpl = options => globalThis.prompt?.(typeof options === 'string' ? options : options?.title, typeof options === 'string' ? '' : options?.initialValue) ?? null,
  isSevenDaysAvailable = () => false,
} = {}) {
  const { element, button, field, subDrawer } = createSettingsKit(documentRef);
  const { drawer, body } = subDrawer({ title: 'API 配置', id: 'qqj-settings-api', open, onToggle });

  const current = settings.get();
  const presets = settings.sharedPresets();

  let editingRole = 'analysis';
  const presetOptions = first => [{ value: '', label: first }, ...presets.map(preset => ({ value: preset.id, label: preset.name }))];
  const analysisPicker = createInlineSelect({
    documentRef, options: presetOptions('主配置'), value: current.apiMode === 'seven-preset' ? current.selectedSevenDaysPresetId : '', ariaLabel: '分析 API',
    onFocus: () => setEditingRole('analysis'), onChange: value => changeAnalysis(value),
  });
  const summaryPicker = createInlineSelect({
    documentRef, options: presetOptions('跟随分析API'), value: presets.some(item => item.id === settings.sharedUtilityPresetId()) ? settings.sharedUtilityPresetId() : '', ariaLabel: '摘要 API',
    onFocus: () => setEditingRole('summary'), onChange: value => changeSummary(value),
  });
  const analysisSelect = analysisPicker.node, summarySelect = summaryPicker.node;
  const presetById = id => settings.sharedPresets().find(item => item.id === id) ?? null;
  const editingTarget = () => {
    const followsAnalysis = editingRole === 'summary' && !summarySelect.value;
    const presetId = followsAnalysis || editingRole === 'analysis' ? analysisSelect.value : summarySelect.value;
    const config = presetId ? presetById(presetId) : settings.sharedMainConfig();
    return Object.freeze({ sourceRole: editingRole, followsAnalysis, presetId, config, label: presetId ? (config?.name || '已失效预设') : '主配置' });
  };

  const url = element('input', 'settings-input'); url.placeholder = 'API URL';
  const key = element('input', 'settings-input'); key.type = 'password'; key.placeholder = '留空保持原 Key';
  const model = element('input', 'settings-input'); model.placeholder = '模型名称';
  const modelSection = element('details', 'qqj-model-list-section'); modelSection.hidden = true;
  const modelSummary = element('summary', 'qqj-model-list-summary');
  const modelChevron = element('span', 'qqj-model-list-chevron', '›');
  const modelCount = element('span', '', '已加载 0 个模型');
  const modelBody = element('div', 'qqj-model-list-body');
  const modelSearch = element('input', 'settings-input qqj-model-list-search'); modelSearch.type = 'search'; modelSearch.placeholder = '搜索模型…'; modelSearch.setAttribute('autocomplete', 'off');
  const modelItems = element('div', 'qqj-model-list-items');
  modelSummary.append(modelChevron, modelCount); modelBody.append(modelSearch, modelItems); modelSection.append(modelSummary, modelBody);
  const exclude = element('textarea', 'settings-input'); exclude.placeholder = '排除参数，每行一个';
  const timeout = element('input', 'settings-input'); timeout.type = 'number'; timeout.min = '5'; timeout.max = '600';
  const stream = element('input'); stream.type = 'checkbox';
  const editingHint = element('p', 'settings-hint');
  let remove;
  let cachedModels = [];
  let modelListEpoch = 0;
  const renderModels = (filter = modelSearch.value) => {
    modelCount.textContent = `已加载 ${cachedModels.length} 个模型`;
    const query = String(filter ?? '').trim().toLocaleLowerCase();
    const shown = query ? cachedModels.filter(name => name.toLocaleLowerCase().includes(query)) : cachedModels;
    if (!shown.length) {
      modelItems.replaceChildren(element('div', 'qqj-model-list-empty', query ? '无匹配项' : '暂无模型'));
      return;
    }
    modelItems.replaceChildren(...shown.map(name => {
      const item = button(name, `qqj-model-list-item${name === model.value.trim() ? ' active' : ''}`, () => {
        model.value = name;
        renderModels();
      });
      item.setAttribute('data-model', name);
      return item;
    }));
  };
  const clearModels = () => {
    modelListEpoch += 1;
    cachedModels = [];
    modelSearch.value = '';
    modelSection.open = false;
    modelSection.hidden = true;
    renderModels('');
  };

  const fill = () => {
    clearModels();
    const target = editingTarget();
    const config = target.config ?? {};
    url.value = config.url ?? '';
    key.value = '';
    key.placeholder = config.key ? '已保存，留空保持不变' : '输入 API Key';
    model.value = config.model ?? '';
    exclude.value = (config.excludeParams ?? []).join('\n');
    timeout.value = String(config.timeoutSec ?? 180);
    stream.checked = config.stream === true;
    editingHint.textContent = target.followsAnalysis
      ? `正在编辑：摘要 API 跟随分析 · ${target.label}。直接保存会更新共享配置；另存可建立摘要专用预设。`
      : `正在编辑：${target.sourceRole === 'summary' ? '摘要' : '分析'} API · ${target.label}`;
    if (remove) remove.disabled = !target.presetId || !target.config;
  };

  // 分析/摘要角色选择：内联选中即存，打开时切换当前编辑目标。
  function changeAnalysis(value) {
    settings.update({ apiMode: value ? 'seven-preset' : 'auto', selectedSevenDaysPresetId: value });
    editingRole = 'analysis';
    result.textContent = ''; result.className = 'settings-result';
    fill();
  }
  function changeSummary(value) {
    settings.setSharedUtilityPresetId(value);
    editingRole = 'summary';
    result.textContent = ''; result.className = 'settings-result';
    fill();
  }
  function setEditingRole(role) { editingRole = role; result.textContent = ''; result.className = 'settings-result'; fill(); }

  const draft = () => ({
    url: url.value.trim(),
    key: key.value.trim() || editingTarget().config?.key || '',
    model: model.value.trim(),
    excludeParams: exclude.value,
    timeoutSec: Number(timeout.value),
    stream: stream.checked,
  });

  const result = element('p', 'settings-result');
  const selection = () => {
    const target = editingTarget();
    return { apiMode: target.presetId ? 'seven-preset' : 'auto', selectedSevenDaysPresetId: target.presetId, config: draft() };
  };

  const fetchBtn = button('拉取模型', 'secondary-action', async () => {
    result.textContent = '正在拉取模型…'; result.className = 'settings-result';
    fetchBtn.disabled = true;
    const requestEpoch = modelListEpoch;
    const requestSelection = selection();
    try {
      const models = await apiTools.fetchModels(requestSelection);
      if (requestEpoch !== modelListEpoch) return;
      cachedModels = [...models];
      if (!model.value.trim() && models[0]) model.value = models[0];
      modelSection.hidden = false;
      modelSection.open = true;
      renderModels('');
      result.textContent = `已拉取 ${models.length} 个模型`; result.className = 'settings-result success';
    } catch (error) {
      if (requestEpoch !== modelListEpoch) return;
      result.textContent = apiErrorCopy(error); result.className = 'settings-result error';
    } finally {
      fetchBtn.disabled = false;
    }
  });
  modelSearch.addEventListener('input', () => renderModels());
  model.addEventListener('input', () => { if (!modelSection.hidden) renderModels(); });

  const save = button('保存设置', 'primary-action', () => {
    const target = editingTarget();
    if (target.presetId) {
      if (target.config) settings.upsertSharedPreset(target.config.name, draft(), target.presetId);
    } else {
      settings.saveSharedMainConfig(draft());
    }
    if (target.sourceRole === 'analysis') settings.update({ apiMode: target.presetId ? 'seven-preset' : 'auto', selectedSevenDaysPresetId: target.presetId });
    result.textContent = 'API 设置已保存。'; result.className = 'settings-result success';
    fill();
  });
  const create = button('另存为预设', 'secondary-action', async () => {
    const name = String(await Promise.resolve(promptImpl({ title: '另存为预设', body: '为当前 API 配置输入一个名称。', initialValue: '千千结预设', placeholder: '预设名称', confirmText: '保存', validate: value => String(value ?? '').trim() ? '' : '请输入预设名称。' })) ?? '').trim();
    if (!name) return;
    const id = settings.upsertSharedPreset(name, draft());
    if (editingRole === 'summary') settings.setSharedUtilityPresetId(id);
    else settings.update({ apiMode: 'seven-preset', selectedSevenDaysPresetId: id });
    rerender?.();
  });
  remove = button('删除当前预设', 'secondary-action', async () => {
    const target = editingTarget();
    if (!target.presetId) {
      result.textContent = '主配置不能删除。'; result.className = 'settings-result error';
      return;
    }
    if (!target.config) {
      result.textContent = '这个预设已不存在，未更改当前选择。'; result.className = 'settings-result error';
      return;
    }
    const currentSelection = settings.get();
    const analysisUsesTarget = currentSelection.apiMode === 'seven-preset' && currentSelection.selectedSevenDaysPresetId === target.presetId;
    const summaryUsesTarget = settings.sharedUtilityPresetId() === target.presetId;
    const summaryFollowsAnalysis = !settings.sharedUtilityPresetId();
    const effects = [];
    if (analysisUsesTarget) effects.push('分析 API 将回退到主配置。');
    if (summaryUsesTarget) effects.push('摘要 API 将改为跟随分析。');
    else if (analysisUsesTarget && summaryFollowsAnalysis) effects.push('摘要 API 当前跟随分析，也将随分析回退到主配置。');
    if (!effects.length) effects.push('当前分析和摘要 API 不会切换。');
    const sevenDaysAvailable = typeof isSevenDaysAvailable === 'function' ? isSevenDaysAvailable() : isSevenDaysAvailable === true;
    if (sevenDaysAvailable) effects.push('构画中也会移除这个共享预设。');
    const confirmed = await Promise.resolve(confirmImpl({ title: '删除 API 预设', body: `删除预设「${target.config.name}」？`, note: effects.join('\n'), confirmText: '删除', cancelText: '取消' }));
    if (!confirmed) {
      result.textContent = '已取消删除。'; result.className = 'settings-result';
      return;
    }
    if (!settings.deleteSharedPreset(target.presetId)) {
      result.textContent = '这个预设已不存在，未更改当前选择。'; result.className = 'settings-result error';
      return;
    }
    const latest = settings.get();
    if (latest.apiMode === 'seven-preset' && latest.selectedSevenDaysPresetId === target.presetId) {
      settings.update({ apiMode: 'auto', selectedSevenDaysPresetId: '' });
    }
    result.textContent = `已删除预设「${target.config.name}」。`; result.className = 'settings-result success';
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
  actions.append(save, create, remove, test);
  fill();

  const { drawer: advanced, body: advancedBody } = subDrawer({ title: '高级设置', id: 'qqj-settings-api-advanced', open: advancedOpen, onToggle: onAdvancedToggle });
  advanced.classList.add('sub-advanced');
  const streamLabel = element('label', 'setting-switch'); streamLabel.append(stream, element('span', '', '流式请求'));
  advancedBody.append(field('排除参数', exclude), streamLabel, field('超时秒数', timeout));

  body.append(
    field('分析API（建议高质模型）', analysisSelect),
    field('摘要API（建议快速模型）', summarySelect),
    editingHint,
    element('div', 'settings-divider'),
    field('URL', url),
    field('Key', key),
    field('模型', modelRow),
    modelSection,
    actions,
    result,
    advanced,
  );
  return { node: drawer };
}
