import { createSettingsKit } from './kit.js';
import { createInlineSelect } from '../inline-select.js';

// 外观设置 change 即存并即时应用；楼层卡片开关只控制显示。
export function createAppearanceSettings({ settings, documentRef = globalThis.document, open = false, onToggle, applyAppearance } = {}) {
  const { element, field, subDrawer } = createSettingsKit(documentRef);
  const { drawer, body } = subDrawer({ title: '外观', id: 'qqj-settings-appearance', open, onToggle });
  const current = settings.get();
  const apply = () => applyAppearance?.();

  const theme = createInlineSelect({
    documentRef,
    options: [['auto', '跟随酒馆'], ['day', '日间'], ['night', '夜间']].map(([value, label]) => ({ value, label })),
    value: current.appearanceTheme ?? 'auto',
    ariaLabel: '主题',
    onChange: value => { settings.update({ appearanceTheme: value }); apply(); },
  }).node;
  theme.id = 'qqj-appearance-theme';

  const scaleWrap = element('div', 'settings-scale');
  const scale = element('input', 'settings-input'); scale.type = 'range'; scale.min = '0.75'; scale.max = '1.5'; scale.step = '0.05';
  scale.value = String(current.appearanceScale ?? 1);
  const scaleOut = element('output', '', `${Math.round(Number(scale.value) * 100)}%`);
  scale.addEventListener('input', () => { scaleOut.textContent = `${Math.round(Number(scale.value) * 100)}%`; });
  scale.addEventListener('change', () => { settings.update({ appearanceScale: Number(scale.value) }); apply(); });
  scaleWrap.append(scale, scaleOut);

  const fontCssUrl = element('input', 'settings-input'); fontCssUrl.value = current.appearanceFontCssUrl ?? ''; fontCssUrl.placeholder = 'https://…/font.css';
  // URL 改变时清掉缓存的 family，让下一次应用从新 CSS 重新解析。
  fontCssUrl.addEventListener('change', () => { settings.update({ appearanceFontCssUrl: fontCssUrl.value, appearanceFontFamily: '' }); apply(); });

  body.append(field('主题', theme), field('界面缩放', scaleWrap), field('自定义字体 CSS URL', fontCssUrl));
  body.append(element('p', 'settings-subhead', '楼层卡片'));
  for (const [key, title] of [['inlineRecallVisible', '显示楼层召回卡片'], ['inlineMemoryVisible', '显示楼层记忆卡片']]) {
    const row = element('label', 'setting-switch');
    const input = element('input'); input.type = 'checkbox'; input.checked = current[key] !== false;
    input.setAttribute('aria-label', title);
    input.addEventListener('change', () => { settings.update({ [key]: input.checked }); apply(); });
    row.append(input, element('span', '', title)); body.append(row);
  }
  body.append(element('p', 'settings-hint', '分别控制“本轮召回”和“第几个结”，对所有聊天立即生效。隐藏仅影响显示，摘要、人物分析和召回注入照常运行。'));
  return { node: drawer };
}
