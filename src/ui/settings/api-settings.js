import { createSettingsKit } from './kit.js';
import { createInlineSelect } from '../inline-select.js';
import { openApiPresetEditor } from './api-preset-editor.js';

// 用途选择即时保存；连接表单只存在于独立草稿弹窗。
export function createApiSettings({ settings, apiTools, vectorIndex, documentRef = globalThis.document, open = false, onToggle, customImpl, onEditingRoleChange } = {}) {
  const { element, button, subDrawer } = createSettingsKit(documentRef);
  const { drawer, body } = subDrawer({ title: 'API 配置', id: 'qqj-settings-api', open, onToggle });
  drawer.classList.add('qqj-api-editor');
  const labels = { analysis: '分析 API', summary: '摘要 API', recall: '召回 API' };
  let editor = null;
  const targetFor = role => {
    const value = settings.get(), analysis = value.apiMode === 'seven-preset' ? value.selectedSevenDaysPresetId : '', summary = settings.summaryPresetId(), recall = value.recallPresetId ?? '';
    const followsSummary = role === 'recall' && !recall, followsAnalysis = (role === 'summary' || followsSummary) && !summary;
    const presetId = role === 'analysis' || followsAnalysis ? analysis : role === 'summary' || followsSummary ? summary : recall;
    const config = presetId ? settings.sharedPresets().find(preset => preset.id === presetId) : settings.mainConfig();
    return { sourceRole: role, followsSummary, followsAnalysis, presetId, config, label: presetId ? config?.name || '已失效预设' : '主配置' };
  };
  function launch(role, isNew = false) {
    if (typeof customImpl !== 'function') return;
    const target = isNew ? null : targetFor(role);
    if (!isNew && !target.config) return;
    if (role) onEditingRoleChange?.(role);
    editor = openApiPresetEditor({ settings, apiTools, vectorIndex, documentRef, target, isNew, customImpl, onSaved: render });
  }
  function render() {
    body.replaceChildren();
    const values = settings.get(), presets = settings.sharedPresets();
    for (const role of Object.keys(labels)) {
      const id = role === 'analysis' ? values.apiMode === 'seven-preset' ? values.selectedSevenDaysPresetId : '' : role === 'summary' ? settings.summaryPresetId() : values.recallPresetId ?? '';
      const options = [{ value: '', label: role === 'analysis' ? '主配置' : role === 'summary' ? '跟随分析 API' : '跟随摘要 API' }, ...presets.map(preset => ({ value: preset.id, label: preset.name }))];
      if (id && !presets.some(preset => preset.id === id)) options.push({ value: id, label: '失效预设（'+id+'）' });
      const picker = createInlineSelect({ documentRef, options, value: id, ariaLabel: labels[role], onChange: next => {
        if (role === 'analysis') settings.update({ apiMode: next ? 'seven-preset' : 'auto', selectedSevenDaysPresetId: next });
        else if (role === 'summary') settings.setSummaryPresetId(next);
        else settings.update({ recallPresetId: next });
        render();
      } });
      const row = element('div', 'qqj-api-purpose-row'), edit = button('编辑', 'secondary-action', () => launch(role)); edit.setAttribute('aria-label', '编辑'+labels[role]); edit.disabled = !targetFor(role).config;
      row.append(picker.node, edit);
      const purpose = element('div', 'qqj-api-purpose'); purpose.append(element('span', '', labels[role]), row); body.append(purpose);
    }
    const actions = element('div', 'settings-actions'); actions.append(button('新增 API', 'secondary-action', () => launch(null, true))); body.append(actions, element('p', 'settings-hint', '新增连接后，可在各用途中选择。'));
  }
  render();
  return { node: drawer, dispose: () => editor?.dispose() };
}
