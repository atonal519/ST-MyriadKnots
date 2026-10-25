import { createSettingsKit } from './kit.js';
import { DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT } from '../../story-clock.js';
import { DEFAULT_EXTRACTOR_GUIDANCE } from '../../v3/extractor.js';
import { DEFAULT_CSE_GUIDANCE } from '../../v3/cse-engine.js';
import { DEFAULT_PROFILE_GUIDANCE } from '../../v3/people-workspace.js';
import { BASE_PROCESSING_PROMPT } from '../../internal-processing-prompt.js';
import { DEFAULT_AVATAR_PROMPT } from '../../avatar-generation.js';

// 长提示词在草稿弹窗内编辑，保存时一次写入；短设置仍即时生效。
export function createPromptsSettings({ settings, documentRef = globalThis.document, open = false, onToggle, onStoryClockChange, customImpl = null, subscribeSettingsChange = null } = {}) {
  const { element, button, field, subDrawer } = createSettingsKit(documentRef);
  const { drawer, body } = subDrawer({ title: '提示词与包裹符', id: 'qqj-settings-prompts', open, onToggle });
  body.className += ' settings-drawer-list';
  const { drawer: wrapperDrawer, body: wrapperBody } = subDrawer({ title: '包裹符', id: 'qqj-settings-wrappers' });
  const current = settings.get();

  const wrappers = settings.wrappers();
  const keepTags = element('input', 'settings-input'); keepTags.value = wrappers.keepTags; keepTags.placeholder = 'content';
  const extraTags = element('input', 'settings-input'); extraTags.value = wrappers.extraTags; extraTags.placeholder = '如：think, reasoning, [[...]]';
  const storyClockEnabled = element('input'); storyClockEnabled.type = 'checkbox'; storyClockEnabled.checked = current.storyClockEnabled !== false;
  const storyClockReferenceTags = element('input', 'settings-input'); storyClockReferenceTags.value = current.storyClockReferenceTags ?? ''; storyClockReferenceTags.placeholder = '填写成对标签名（可选）';
  const storyClockStatus = element('p', 'settings-result', onStoryClockChange?.({ readOnly: true })?.label ?? '时间戳状态会在下一次正文生成前刷新。');
  storyClockStatus.id = 'qqj-story-clock-status';
  const { drawer: storyClockDrawer, body: storyClockBody } = subDrawer({ title: '时间戳提示词', id: 'qqj-settings-story-clock' });
  const { drawer: processingDrawer, body: processingBody } = subDrawer({ title: '破限提示词', id: 'qqj-settings-processing-prompt' });
  const { drawer: summaryDrawer, body: summaryBody } = subDrawer({ title: '摘要内容指导', id: 'qqj-settings-summary-prompt' });
  const { drawer: cseDrawer, body: cseBody } = subDrawer({ title: 'CSE 内容指导', id: 'qqj-settings-cse-prompt' });
  const { drawer: profileDrawer, body: profileBody } = subDrawer({ title: '人物资料内容指导', id: 'qqj-settings-profile-prompt' });
  const { drawer: avatarDrawer, body: avatarBody } = subDrawer({ title: '头像生图提示词', id: 'qqj-settings-avatar-prompt' });

  keepTags.addEventListener('change', () => settings.updateWrappers({ keepTags: keepTags.value }));
  extraTags.addEventListener('change', () => settings.updateWrappers({ extraTags: extraTags.value }));
  const refreshWrappers = () => {
    const value = settings.wrappers();
    for (const [input, key] of [[keepTags, 'keepTags'], [extraTags, 'extraTags']]) {
      if (documentRef.activeElement !== input && !input.matches?.(':focus')) input.value = value[key];
    }
  };
  keepTags.addEventListener('blur', refreshWrappers); extraTags.addEventListener('blur', refreshWrappers);
  const releaseSettings = subscribeSettingsChange?.(refreshWrappers);
  const refreshClock = () => {
    const result = onStoryClockChange?.() ?? null;
    storyClockStatus.textContent = result?.label ?? '时间戳状态会在下一次正文生成前刷新。';
  };
  storyClockEnabled.addEventListener('change', () => { settings.update({ storyClockEnabled: storyClockEnabled.checked }); refreshClock(); });
  storyClockReferenceTags.addEventListener('change', () => settings.update({ storyClockReferenceTags: storyClockReferenceTags.value }));
  const promptDialog = (title, value, defaultText, onSave) => {
    if (typeof customImpl !== 'function') return;
    const panel = element('section', 'qqj-editor-dialog');
    panel.append(element('p', 'qqj-editor-intro', '修改内容仅在保存后生效，取消不会更改当前提示词。'));
    const group = element('section', 'qqj-editor-group'); group.append(element('h3', '', title));
    const input = element('textarea', 'settings-input qqj-editor-textarea'); input.value = value; input.placeholder = '留空使用内置默认'; input.rows = 12;
    const actions = element('div', 'qqj-editor-inline-actions');
    actions.append(button('载入内置默认', 'secondary-action', () => { input.value = defaultText; }), button('恢复默认', 'secondary-action', () => { input.value = ''; }));
    group.append(input, actions); panel.append(group);
    void customImpl({ title: `编辑${title}`, content: panel, confirmText: '保存', cancelText: '取消', submit: async () => { await onSave(input.value); return true; } });
  };
  const promptButton = (bodyNode, title, key, defaultText, onSave) => {
    bodyNode.append(button(`编辑${title}`, 'secondary-action', () => promptDialog(title, key === 'processingPrompt' ? settings.processingPrompt() : settings.get()[key] ?? '', defaultText, onSave)));
  };
  const clockToggle = element('label', 'setting-switch'); clockToggle.append(storyClockEnabled, element('span', '', '启用正文时间戳'));
  storyClockBody.append(
    clockToggle,
    storyClockStatus,
    element('p', 'settings-hint', '默认 QQJ-start/end，也兼容 SDC 和旧 myknots 格式。自定义文本原样发送，请保留成对 start/end 及 date、weekday、time 字段。'),
    field('正文时间参考标签', storyClockReferenceTags),
    element('p', 'settings-hint', '额外时间标签名用逗号或换行分隔，留空关闭。标准时间戳优先；补读故事时间，不改变正文清洗，也不受生成开关影响。'),
    element('p', 'settings-hint', '完整提示词在弹窗中编辑；保存后生效。'),
    button('编辑时间戳提示词', 'secondary-action', () => promptDialog('时间戳提示词', settings.get().storyClockPrompt ?? '', DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT, async value => { settings.update({ storyClockPrompt: value }); refreshClock(); })),
  );

  const promptEditor = ({ body: editorBody, key, defaultText, label, hint = '这里只改内容要求；输出结构、人物绑定和信息范围由程序维护。恢复默认会使用内置文本。' }) => {
    editorBody.append(element('p', 'settings-hint', hint));
    promptButton(editorBody, label, key, defaultText, async text => settings.update({ [key]: text }));
  };
  promptEditor({ body: processingBody, key: 'processingPrompt', defaultText: BASE_PROCESSING_PROMPT, label: '破限提示词', hint: '白鳥系列文字模型请求共用，保存后供下一次请求使用；留空使用内置默认；恢复默认清空草稿，保存后生效。' });
  promptEditor({ body: summaryBody, key: 'summaryPrompt', defaultText: DEFAULT_EXTRACTOR_GUIDANCE, label: '摘要内容指导' });
  promptEditor({ body: cseBody, key: 'csePrompt', defaultText: DEFAULT_CSE_GUIDANCE, label: 'CSE 内容指导' });
  promptEditor({ body: profileBody, key: 'profilePrompt', defaultText: DEFAULT_PROFILE_GUIDANCE, label: '人物资料内容指导' });
  promptEditor({ body: avatarBody, key: 'avatarPrompt', defaultText: DEFAULT_AVATAR_PROMPT, label: '头像生图提示词', hint: '单人头像构图，人物外貌来自柏宝绘角色库。保存后供后续生成使用；留空使用默认。' });

  wrapperBody.append(element('p', 'settings-hint', '白鳥系列插件全部共享'), field('保留包裹符', keepTags), field('清洗包裹符', extraTags));
  body.append(
    wrapperDrawer,
    storyClockDrawer,
    processingDrawer,
    summaryDrawer,
    cseDrawer,
    profileDrawer,
    avatarDrawer,
  );
  return { node: drawer, dispose: () => releaseSettings?.() };
}
