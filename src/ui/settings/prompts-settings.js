import { createSettingsKit } from './kit.js';

// 提示词与包裹符：三字段，change 即存（无“机器 JSON”说明句）。
export function createPromptsSettings({ settings, documentRef = globalThis.document, open = false, onToggle } = {}) {
  const { element, field, subDrawer } = createSettingsKit(documentRef);
  const { drawer, body } = subDrawer({ title: '提示词与包裹符', id: 'qqj-settings-prompts', open, onToggle });
  const current = settings.get();

  const keepTags = element('input', 'settings-input'); keepTags.value = current.sourceKeepTags ?? 'content'; keepTags.placeholder = 'content';
  const extraTags = element('input', 'settings-input'); extraTags.value = current.sourceExtraTags ?? ''; extraTags.placeholder = '示例（不会自动生效）：think, reasoning, [[...]]';
  const generalPrompt = element('textarea', 'settings-input'); generalPrompt.value = current.generalPrompt ?? ''; generalPrompt.placeholder = '留空则不追加通用提示词';

  keepTags.addEventListener('change', () => settings.update({ sourceKeepTags: keepTags.value }));
  extraTags.addEventListener('change', () => settings.update({ sourceExtraTags: extraTags.value }));
  generalPrompt.addEventListener('change', () => settings.update({ generalPrompt: generalPrompt.value }));

  body.append(
    field('保留正文的包裹符', keepTags),
    field('连同内容剔除的包裹符', extraTags),
    field('通用附加提示词', generalPrompt),
  );
  return { node: drawer };
}
