import { createSettingsKit } from './kit.js';
import { normalizeRetryCount, parseAdditionalParams } from '../../settings.js';
import { publicErrorMessage } from '../../public-error.js';

export function openApiPresetEditor({ settings, apiTools, vectorIndex, target, isNew = false, customImpl, documentRef, onSaved } = {}) {
  const { element, button } = createSettingsKit(documentRef);
  const form = element('form', 'qqj-editor-dialog qqj-api-editor-dialog');
  const field = (text, control) => { const label = element('label', 'qqj-editor-field'); label.append(element('span', '', text), control); return label; };
  const input = (value = '', type = 'text') => { const node = element('input', 'settings-input'); node.type = type; node.value = String(value ?? ''); return node; };
  const initial = isNew ? {} : target.config;
  let alive = true, deleted = false, copyBase = initial;
  const name = input(isNew ? '' : target.presetId ? initial.name : '主配置'); name.disabled = !isNew && !target.presetId;
  const url = input(initial.url); url.type = 'url'; url.placeholder = 'https://example.invalid/v1';
  const key = input('', 'password'); key.placeholder = initial.key ? '已保存，留空保持不变' : '输入 API Key';
  const model = input(initial.model); model.placeholder = '模型名称';
  const exclude = element('textarea', 'settings-input'); exclude.value = (initial.excludeParams ?? []).join('\n'); exclude.rows = 2;
  const additional = element('textarea', 'settings-input'); additional.value = initial.qqjAdditionalParams ?? ''; additional.rows = 3; additional.placeholder = '{}';
  const timeout = input(initial.timeoutSec ?? 180, 'number'); timeout.min = '5'; timeout.max = '600';
  const retryCount = input(initial.qqjRetryCount ?? 2, 'number'); retryCount.min = '0'; retryCount.step = '1';
  const temperature = input(initial.qqjTemperature ?? '', 'number'); temperature.min = '0'; temperature.max = '2'; temperature.step = '0.01'; temperature.placeholder = '留空使用任务默认值';
  const stream = input('', 'checkbox'); stream.checked = initial.stream === true;
  const initialValues = { url: url.value, model: model.value, excludeParams: exclude.value, qqjAdditionalParams: additional.value, timeoutSec: timeout.value, qqjRetryCount: retryCount.value, qqjTemperature: temperature.value, stream: stream.checked };
  const controls = { url, model, excludeParams: exclude, qqjAdditionalParams: additional, timeoutSec: timeout, qqjRetryCount: retryCount, qqjTemperature: temperature, stream };
  const current = (copy = false) => {
    if (copy && deleted) return copyBase;
    if (isNew) return {};
    const value = target.presetId ? settings.sharedPresets().find(preset => preset.id === target.presetId) : settings.mainConfig();
    if (!value) throw new Error('这个 API 预设已不存在，请关闭后重新选择。');
    return value;
  };
  const draft = (copy = false) => {
    const config = { ...current(copy) };
    for (const [fieldName, control] of Object.entries(controls)) {
      const value = fieldName === 'stream' ? control.checked : control.value;
      if (!isNew && value === initialValues[fieldName]) continue;
      config[fieldName] = fieldName === 'stream' ? value : ['timeoutSec', 'qqjRetryCount'].includes(fieldName) ? Number(value) : fieldName === 'qqjTemperature' ? value.trim() === '' ? null : Number(value) : value.trim();
    }
    config.key = key.value.trim() || config.key || '';
    parseAdditionalParams(config.qqjAdditionalParams);
    const rawTemp = temperature.value.trim(), value = Number(rawTemp);
    if (rawTemp && (!Number.isFinite(value) || value < 0 || value > 2 || Math.abs(value * 100 - Math.round(value * 100)) >= 1e-8)) throw new Error('温度须在 0–2 之间，并按 0.01 递增。');
    if (!Number.isInteger(Number(timeout.value)) || Number(timeout.value) < 5 || Number(timeout.value) > 600) throw new Error('超时秒数须为 5–600 的整数。');
    if (normalizeRetryCount(retryCount.value) === null) throw new Error('失败重试次数请填 0 或正整数。');
    return config;
  };
  const feedback = element('p', 'qqj-api-result'); feedback.setAttribute('aria-live', 'polite');
  const message = (text, tone = '') => { if (alive) { feedback.textContent = text; feedback.className = `qqj-api-result${tone ? ` ${tone}` : ''}`; } };
  const tool = (label, action, disabledWhen = () => false) => {
    const node = button(label, 'secondary-action', async () => {
      if (node.disabled) return; node.disabled = true;
      try { await action(); }
      catch (error) { message(publicErrorMessage(error, { fallback: '操作未完成，请检查配置。' }), 'error'); }
      finally { node.disabled = !alive || disabledWhen(); }
    });
    return node;
  };
  let models = [];
  const modelSection = element('details', 'qqj-model-list-section'); modelSection.hidden = true;
  const modelSummary = element('summary', 'qqj-model-list-summary', '已加载 0 个模型');
  const search = input(); search.type = 'search'; search.placeholder = '搜索模型…'; search.setAttribute('aria-label', '搜索模型');
  const list = element('div', 'qqj-model-list-items');
  const renderModels = () => {
    const query = search.value.trim().toLocaleLowerCase(), shown = models.filter(value => value.toLocaleLowerCase().includes(query));
    list.replaceChildren(...(shown.length ? shown.map(value => { const item = button(value, `qqj-model-list-item${value === model.value.trim() ? ' active' : ''}`, () => { model.value = value; renderModels(); }); item.setAttribute('data-model', value); return item; }) : [element('p', 'settings-hint', query ? '无匹配项' : '暂无模型')]));
  };
  search.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); } });
  search.addEventListener('input', renderModels); model.addEventListener('input', renderModels);
  const selection = () => ({ apiMode: target?.presetId ? 'seven-preset' : 'auto', selectedSevenDaysPresetId: target?.presetId ?? '', config: draft() });
  const fetch = tool('拉取模型', async () => {
    const values = await apiTools.fetchModels(selection()); if (!alive) return;
    models = [...values]; if (!model.value.trim() && models[0]) model.value = models[0];
    modelSummary.textContent = `已加载 ${models.length} 个模型`; modelSection.hidden = false; modelSection.open = true; renderModels(); message(`已拉取 ${models.length} 个模型`, 'success');
  });
  const modelRow = element('div', 'qqj-api-model-row'); modelRow.append(model, fetch); modelSection.append(modelSummary, search, list);
  const advanced = element('details', 'qqj-editor-group qqj-editor-collapsible'); advanced.open = false;
  advanced.append(element('summary', 'qqj-editor-group-summary', '高级参数'));
  const advancedBody = element('div', 'qqj-editor-group qqj-api-advanced');
  const streamLabel = element('label', 'qqj-editor-check'); streamLabel.append(stream, element('span', '', '流式请求'));
  advancedBody.append(field('排除参数', exclude), field('附加参数（JSON）', additional), field('超时秒数', timeout), field('失败重试次数', retryCount), element('p', 'settings-hint', '文字请求失败后的额外次数；0 不重试，2 最多尝试 3 次。'), field('千千结温度（0–2）', temperature), streamLabel); advanced.append(advancedBody);
  if (!isNew && (target.followsSummary || target.followsAnalysis)) form.append(element('p', 'qqj-api-target-note', `${target.sourceRole === 'recall' ? '召回 API 跟随摘要' : '摘要 API 跟随分析'}${target.followsSummary && target.followsAnalysis ? '，摘要跟随分析' : ''} · ${target.label}`));
  form.append(field('预设名称', name), field('URL', url), field('Key', key), field('模型', modelRow), modelSection, advanced);
  const validateConnection = (config, selectedName, creating) => {
    if (!selectedName) throw new Error('请输入预设名称。');
    if (creating && (!config.url || !/^https?:\/\//iu.test(config.url))) throw new Error('请输入 API URL。');
    if (creating && !config.key) throw new Error('请输入 API Key。');
    if (creating && !config.model) throw new Error('请输入模型名称。');
  };
  const save = async (copy = false, selectedName = name.value.trim()) => {
    const config = draft(copy); validateConnection(config, selectedName, isNew || copy);
    const previous = !isNew && !copy ? current() : null;
    let id;
    if (!isNew && !target.presetId && !copy) await settings.saveMainConfig(config, { observeSaveFailure: true });
    else id = await settings.upsertSharedPreset(selectedName, config, isNew || copy ? '' : target.presetId, { observeSaveFailure: true, requireExisting: !isNew && !copy });
    if (!copy && !isNew && target.presetId && settings.get().vectorPresetId === target.presetId && ['url', 'key', 'model'].some(fieldName => config[fieldName] !== previous[fieldName])) vectorIndex?.abortAll();
    if (alive) onSaved?.();
    return id ?? true;
  };
  const actions = element('div', 'qqj-editor-actions');
  let submit = () => save(false);
  actions.append(tool('测试', async () => { const response = await apiTools.testConnection(selection()); message(`连接成功 · ${response?.model || model.value || '当前模型'}`, 'success'); }));
  if (!isNew) {
    const copySection = element('div', 'qqj-api-delete-confirm'); copySection.hidden = true;
    const copyName = input();
    submit = () => copySection.hidden ? save(false) : save(true, copyName.value.trim());
    const saveCopy = tool('保存副本', async () => { await save(true, copyName.value.trim()); copySection.hidden = true; message('已另存为共享预设，当前用途保持不变。', 'success'); }); saveCopy.className = 'primary-action';
    copyName.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); saveCopy.click(); } });
    copySection.append(field('副本名称', copyName), saveCopy, button('取消另存', 'secondary-action', () => { copySection.hidden = true; }));
    actions.append(tool('另存为', async () => { copyName.value = target.presetId ? name.value : ''; copySection.hidden = false; copyName.focus?.(); }));
    const confirmation = element('div', 'qqj-api-delete-confirm'); confirmation.hidden = true;
    const remove = tool('删除', async () => {
      current(); confirmation.hidden = false;
      confirmation.replaceChildren(element('p', 'qqj-api-target-note', `删除「${current().name}」？使用此预设的分析将回退主配置，摘要和召回将跟随上游；使用此预设的向量召回将关闭。其它插件也将无法再使用此连接。`), tool('确认删除', async () => {
        const vectorUsesTarget = settings.get().vectorPresetId === target.presetId; copyBase = current();
        if (!await settings.deleteSharedPreset(target.presetId, { observeSaveFailure: true })) throw new Error('这个预设已不存在。');
        deleted = true; if (vectorUsesTarget) vectorIndex?.abortAll();
        confirmation.hidden = true; remove.disabled = true; if (alive) onSaved?.(); message('预设已删除；原输入仍保留，可另存为新的连接。', 'success');
      }), button('返回编辑', 'secondary-action', () => { confirmation.hidden = true; }));
    }, () => deleted || !target.presetId);
    remove.disabled = !target.presetId; remove.className += ' qqj-api-remove'; actions.append(remove); form.append(actions, copySection, confirmation);
  } else form.append(actions);
  form.append(feedback);
  const result = customImpl({ title: isNew ? '新增 API' : `编辑${{ analysis: '分析', summary: '摘要', recall: '召回' }[target.sourceRole]} API`, content: form, confirmText: '保存', cancelText: '取消', submit, onClose: () => { alive = false; } });
  Promise.resolve(result).catch(error => message(publicErrorMessage(error, { fallback: 'API 编辑窗口未能打开。' }), 'error'));
  return { content: form, dispose: () => { alive = false; } };
}
