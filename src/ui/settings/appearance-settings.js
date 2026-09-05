import { createSettingsKit } from './kit.js';

// 外观：主题 / 界面缩放 / 自定义字体 CSS URL（无 family 字段，字体名自动解析）。change 即存并即时应用。
export function createAppearanceSettings({ settings, documentRef = globalThis.document, open = false, onToggle, applyAppearance } = {}) {
  const { element, field, appendOption, subDrawer } = createSettingsKit(documentRef);
  const { drawer, body } = subDrawer({ title: '外观', id: 'qqj-settings-appearance', open, onToggle });
  const current = settings.get();
  const apply = () => applyAppearance?.();

  const theme = element('select', 'settings-input');
  for (const [value, copy] of [['auto', '自动'], ['day', '日间'], ['night', '夜间']]) appendOption(theme, value, copy);
  theme.value = current.appearanceTheme ?? 'auto';
  theme.addEventListener('change', () => { settings.update({ appearanceTheme: theme.value }); apply(); });

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
  return { node: drawer };
}
