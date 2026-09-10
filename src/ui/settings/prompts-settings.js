import { createSettingsKit } from './kit.js';
import { DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT } from '../../story-clock.js';
import { DEFAULT_EXTRACTOR_GUIDANCE } from '../../v3/extractor.js';
import { DEFAULT_CSE_GUIDANCE } from '../../v3/cse-engine.js';
import { DEFAULT_PROFILE_GUIDANCE } from '../../v3/people-workspace.js';
import { BASE_PROCESSING_PROMPT } from '../../internal-processing-prompt.js';

// 提示词与包裹符：字段 change 即存；业务指导可编辑，机器合同由运行时固定维护。
export function createPromptsSettings({ settings, documentRef = globalThis.document, open = false, onToggle, onStoryClockChange } = {}) {
  const { element, button, field, subDrawer } = createSettingsKit(documentRef);
  const { drawer, body } = subDrawer({ title: '提示词与包裹符', id: 'qqj-settings-prompts', open, onToggle });
  const current = settings.get();

  const keepTags = element('input', 'settings-input'); keepTags.value = current.sourceKeepTags ?? 'content'; keepTags.placeholder = 'content';
  const extraTags = element('input', 'settings-input'); extraTags.value = current.sourceExtraTags ?? ''; extraTags.placeholder = '示例（不会自动生效）：think, reasoning, [[...]]';
  const storyClockEnabled = element('input'); storyClockEnabled.type = 'checkbox'; storyClockEnabled.checked = current.storyClockEnabled !== false;
  const storyClockPrompt = element('textarea', 'settings-input'); storyClockPrompt.value = current.storyClockPrompt ?? ''; storyClockPrompt.placeholder = '留空＝使用千千结内置默认时间戳提示词';
  const storyClockStatus = element('p', 'settings-result', onStoryClockChange?.({ readOnly: true })?.label ?? '时间戳状态会在下一次正文生成前刷新。');
  storyClockStatus.id = 'qqj-story-clock-status';
  const { drawer: storyClockDrawer, body: storyClockBody } = subDrawer({ title: '时间戳提示词', id: 'qqj-settings-story-clock' });
  const summaryPrompt = element('textarea', 'settings-input'); summaryPrompt.value = current.summaryPrompt ?? ''; summaryPrompt.placeholder = '留空＝使用千千结内置默认摘要指导';
  const csePrompt = element('textarea', 'settings-input'); csePrompt.value = current.csePrompt ?? ''; csePrompt.placeholder = '留空＝使用千千结内置默认 CSE 指导';
  const profilePrompt = element('textarea', 'settings-input'); profilePrompt.value = current.profilePrompt ?? ''; profilePrompt.placeholder = '留空＝使用千千结内置默认人物资料指导';
  const processingPrompt = element('textarea', 'settings-input'); processingPrompt.value = current.processingPrompt ?? ''; processingPrompt.placeholder = '留空＝使用千千结内置默认破限提示词';
  const { drawer: processingDrawer, body: processingBody } = subDrawer({ title: '破限提示词', id: 'qqj-settings-processing-prompt' });
  const { drawer: summaryDrawer, body: summaryBody } = subDrawer({ title: '摘要内容指导', id: 'qqj-settings-summary-prompt' });
  const { drawer: cseDrawer, body: cseBody } = subDrawer({ title: 'CSE 内容指导', id: 'qqj-settings-cse-prompt' });
  const { drawer: profileDrawer, body: profileBody } = subDrawer({ title: '人物资料内容指导', id: 'qqj-settings-profile-prompt' });

  keepTags.addEventListener('change', () => settings.update({ sourceKeepTags: keepTags.value }));
  extraTags.addEventListener('change', () => settings.update({ sourceExtraTags: extraTags.value }));
  const refreshClock = () => {
    const result = onStoryClockChange?.() ?? null;
    storyClockStatus.textContent = result?.label ?? '时间戳状态会在下一次正文生成前刷新。';
  };
  storyClockEnabled.addEventListener('change', () => { settings.update({ storyClockEnabled: storyClockEnabled.checked }); refreshClock(); });
  storyClockPrompt.addEventListener('change', () => { settings.update({ storyClockPrompt: storyClockPrompt.value }); refreshClock(); });
  const loadDefault = button('载入默认再改', 'secondary-action', () => { storyClockPrompt.value = DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT; settings.update({ storyClockPrompt: storyClockPrompt.value }); refreshClock(); });
  const restoreDefault = button('恢复默认', 'secondary-action', () => { storyClockPrompt.value = ''; settings.update({ storyClockPrompt: '' }); refreshClock(); });
  const clockActions = element('div', 'v3-foundation-actions'); clockActions.append(loadDefault, restoreDefault);
  const clockToggle = element('label', 'setting-switch'); clockToggle.append(storyClockEnabled, element('span', '', '启用正文时间戳'));
  storyClockBody.append(clockToggle, storyClockStatus, element('p', 'settings-hint', '默认使用 QQJ-start/end。自定义内容会原样发送；QQJ、SDC 与旧 myknots 格式均可读取，但必须保留成对的 start/end 及 date、weekday、time 字段。'), field('完整自定义提示词', storyClockPrompt), clockActions);

  const promptEditor = ({ body: editorBody, control, key, defaultText, label, hint = '这里只编辑内容要求；字段结构、人物绑定、事实来源和隐私边界由程序固定维护。恢复默认后会使用千千结内置文本。' }) => {
    control.addEventListener('change', () => settings.update({ [key]: control.value }));
    const load = button('载入默认再改', 'secondary-action', () => { control.value = defaultText; settings.update({ [key]: control.value }); });
    const restore = button('恢复默认', 'secondary-action', () => { control.value = ''; settings.update({ [key]: '' }); });
    const actions = element('div', 'v3-foundation-actions'); actions.append(load, restore);
    editorBody.append(
      element('p', 'settings-hint', hint),
      field(label, control),
      actions,
    );
  };
  promptEditor({ body: processingBody, control: processingPrompt, key: 'processingPrompt', defaultText: BASE_PROCESSING_PROMPT, label: '破限提示词', hint: '用于摘要、CSE 与人物资料整理。留空时使用千千结内置默认文本；自定义内容会原样发送，并替换内置默认。' });
  promptEditor({ body: summaryBody, control: summaryPrompt, key: 'summaryPrompt', defaultText: DEFAULT_EXTRACTOR_GUIDANCE, label: '摘要内容要求' });
  promptEditor({ body: cseBody, control: csePrompt, key: 'csePrompt', defaultText: DEFAULT_CSE_GUIDANCE, label: 'CSE 推演要求' });
  promptEditor({ body: profileBody, control: profilePrompt, key: 'profilePrompt', defaultText: DEFAULT_PROFILE_GUIDANCE, label: '人物资料整理要求' });

  body.append(
    field('保留正文的包裹符', keepTags),
    field('连同内容剔除的包裹符', extraTags),
    storyClockDrawer,
    processingDrawer,
    summaryDrawer,
    cseDrawer,
    profileDrawer,
  );
  return { node: drawer };
}
