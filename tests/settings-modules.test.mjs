import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptsSettings } from '../src/ui/settings/prompts-settings.js';
import { createAppearanceSettings } from '../src/ui/settings/appearance-settings.js';
import { createApiSettings } from '../src/ui/settings/api-settings.js';
import { DEFAULT_EXTRACTOR_GUIDANCE } from '../src/v3/extractor.js';
import { DEFAULT_CSE_GUIDANCE } from '../src/v3/cse-engine.js';
import { DEFAULT_PROFILE_GUIDANCE } from '../src/v3/people-workspace.js';

class Node {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.events = {}; this.className = ''; this.id = '';
    this.open = false; this.checked = false; this.disabled = false; this.value = ''; this.type = '';
    this.placeholder = ''; this.min = ''; this.max = ''; this.step = ''; this.attributes = {}; this._text = '';
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  async fire(name) { for (const handler of this.events[name] || []) await handler({ currentTarget: this, target: this, stopPropagation() {} }); }
  get classList() { return { add: c => { this.className = `${this.className ? `${this.className} ` : ''}${c}`; }, contains: c => this.className.split(' ').includes(c) }; }
  get textContent() { return this._text || this.children.map(child => child?.textContent ?? '').join(''); }
  set textContent(value) { this._text = String(value); }
  descendants() { return this.children.flatMap(child => child instanceof Node ? [child, ...child.descendants()] : []); }
  find(predicate) { return this.descendants().find(predicate); }
  findAll(predicate) { return this.descendants().filter(predicate); }
}
const documentRef = { createElement: tag => new Node(tag) };
const flush = () => new Promise(resolve => setImmediate(resolve));
const fieldControl = (node, label) => node.find(n => n.tagName === 'label' && n.children[0]?.textContent === label)?.children[1];

test('提示词模块字段 change 即持久化', () => {
  const patches = [];
  const settings = { get: () => ({ sourceKeepTags: 'content', sourceExtraTags: '' }), update: patch => { patches.push(patch); return patch; } };
  const { node } = createPromptsSettings({ settings, documentRef });
  const keep = fieldControl(node, '保留正文的包裹符');
  keep.value = 'content,summary'; keep.fire('change');
  assert.deepEqual(patches.at(-1), { sourceKeepTags: 'content,summary' });
  assert.equal(fieldControl(node, '通用附加提示词'), undefined, '退役入口不得继续显示');
});

test('提示词模块提供时间戳开关、原样自定义、恢复默认与协调状态', async () => {
  const current = { sourceKeepTags: 'content', sourceExtraTags: '', storyClockEnabled: true, storyClockPrompt: '' };
  const patches = [], refreshes = [];
  const settings = { get: () => ({ ...current }), update: patch => { Object.assign(current, patch); patches.push(patch); return { ...current }; } };
  const { node } = createPromptsSettings({ settings, documentRef, onStoryClockChange: options => { refreshes.push(options ?? {}); return { label: current.storyClockPrompt ? '使用自定义时间戳提示词' : '已调用千千结时间戳' }; } });
  assert.equal(node.find(n => n.id === 'qqj-story-clock-status').textContent, '已调用千千结时间戳');
  const textarea = node.find(n => n.tagName === 'textarea' && /千千结/.test(n.placeholder));
  textarea.value = '  自定义\n'; await textarea.fire('change');
  assert.deepEqual(patches.at(-1), { storyClockPrompt: '  自定义\n' });
  assert.equal(node.find(n => n.id === 'qqj-story-clock-status').textContent, '使用自定义时间戳提示词');
  await node.find(n => n.tagName === 'button' && n.textContent === '恢复默认').fire('click');
  assert.deepEqual(patches.at(-1), { storyClockPrompt: '' }); assert.equal(textarea.value, '');
  assert.equal(refreshes[0].readOnly, true); assert.ok(refreshes.length >= 3);
});

test('摘要、CSE 与人物资料指导各自 change 即存，可载入内置文本并恢复默认', async () => {
  const current = { sourceKeepTags: 'content', sourceExtraTags: '', storyClockEnabled: true, storyClockPrompt: '', summaryPrompt: '', csePrompt: '', profilePrompt: '' };
  const patches = [];
  const settings = { get: () => ({ ...current }), update: patch => { Object.assign(current, patch); patches.push(patch); return { ...current }; } };
  const { node } = createPromptsSettings({ settings, documentRef });
  const summaryDrawer = node.find(n => n.id === 'qqj-settings-summary-prompt');
  const cseDrawer = node.find(n => n.id === 'qqj-settings-cse-prompt');
  const profileDrawer = node.find(n => n.id === 'qqj-settings-profile-prompt');
  const summary = fieldControl(summaryDrawer, '摘要内容要求');
  const cse = fieldControl(cseDrawer, 'CSE 推演要求');
  const profile = fieldControl(profileDrawer, '人物资料整理要求');

  summary.value = '  用户摘要要求\n'; await summary.fire('change');
  cse.value = '  用户 CSE 要求\n'; await cse.fire('change');
  profile.value = '  用户人物资料要求\n'; await profile.fire('change');
  assert.deepEqual(patches.slice(-3), [{ summaryPrompt: '  用户摘要要求\n' }, { csePrompt: '  用户 CSE 要求\n' }, { profilePrompt: '  用户人物资料要求\n' }]);

  await summaryDrawer.find(n => n.tagName === 'button' && n.textContent === '载入默认再改').fire('click');
  await cseDrawer.find(n => n.tagName === 'button' && n.textContent === '载入默认再改').fire('click');
  await profileDrawer.find(n => n.tagName === 'button' && n.textContent === '载入默认再改').fire('click');
  assert.equal(summary.value, DEFAULT_EXTRACTOR_GUIDANCE); assert.equal(cse.value, DEFAULT_CSE_GUIDANCE); assert.equal(profile.value, DEFAULT_PROFILE_GUIDANCE);
  await summaryDrawer.find(n => n.tagName === 'button' && n.textContent === '恢复默认').fire('click');
  await cseDrawer.find(n => n.tagName === 'button' && n.textContent === '恢复默认').fire('click');
  await profileDrawer.find(n => n.tagName === 'button' && n.textContent === '恢复默认').fire('click');
  assert.deepEqual(patches.slice(-3), [{ summaryPrompt: '' }, { csePrompt: '' }, { profilePrompt: '' }]);
  assert.equal(summary.value, ''); assert.equal(cse.value, ''); assert.equal(profile.value, '');
});

test('外观模块 change 即存并即时应用；改 URL 时清空缓存 family', () => {
  const patches = []; let applied = 0;
  const settings = { get: () => ({ appearanceTheme: 'auto', appearanceScale: 1, appearanceFontCssUrl: '' }), update: patch => { patches.push(patch); return patch; } };
  const { node } = createAppearanceSettings({ settings, documentRef, applyAppearance: () => { applied += 1; } });
  const theme = fieldControl(node, '主题');
  theme.value = 'night'; theme.fire('change');
  assert.deepEqual(patches.at(-1), { appearanceTheme: 'night' });
  const url = fieldControl(node, '自定义字体 CSS URL');
  url.value = 'https://f.test/a.css'; url.fire('change');
  assert.deepEqual(patches.at(-1), { appearanceFontCssUrl: 'https://f.test/a.css', appearanceFontFamily: '' });
  assert.equal(applied, 2);
  assert.equal(node.find(n => n.tagName === 'label' && n.children[0]?.textContent === '字体 family'), undefined);
});

test('API 模块：编辑目标随来源角色切换，摘要保存、草稿调用与另存均不改分析选择', async () => {
  let main = { id: '', name: '主配置', url: 'https://main.test/v1', key: 'MAIN_KEY', model: 'main-model', excludeParams: [], timeoutSec: 180, stream: false };
  let presets = [{ id: 'fast', name: '摘要快速', url: 'https://fast.test/v1', key: 'FAST_KEY', model: 'fast-model', excludeParams: ['seed'], timeoutSec: 60, stream: true }];
  let utilityPresetId = 'fast';
  const analysisUpdates = [], utilityUpdates = [], saves = [], toolCalls = [];
  const settings = {
    get: () => ({ apiMode: 'auto', selectedSevenDaysPresetId: '' }),
    sharedMainConfig: () => ({ ...main }),
    sharedPresets: () => presets.map(item => ({ ...item })),
    sharedUtilityPresetId: () => utilityPresetId,
    setSharedUtilityPresetId: id => { utilityPresetId = id; utilityUpdates.push(id); },
    saveSharedMainConfig: config => { main = { ...main, ...config, excludeParams: String(config.excludeParams ?? '').split(/[\n,]/).map(item => item.trim()).filter(Boolean) }; saves.push(['main', config]); },
    upsertSharedPreset: (name, config, id = '') => {
      const targetId = id || 'summary-new';
      const next = { id: targetId, name, ...config, excludeParams: String(config.excludeParams ?? '').split(/[\n,]/).map(item => item.trim()).filter(Boolean) };
      presets = [...presets.filter(item => item.id !== targetId), next];
      saves.push(['preset', targetId, config]);
      return targetId;
    },
    update: patch => { analysisUpdates.push(patch); },
  };
  const apiTools = {
    fetchModels: async selection => { toolCalls.push(['models', structuredClone(selection)]); return ['gpt-x', 'gpt-y']; },
    testConnection: async selection => { toolCalls.push(['test', structuredClone(selection)]); return { model: selection.config.model }; },
  };
  let rerenders = 0;
  const { node } = createApiSettings({ settings, apiTools, documentRef, rerender: () => { rerenders += 1; } });
  assert.equal(node.find(n => n.tagName === 'button' && n.textContent === '清除 Key'), undefined);
  const analysis = fieldControl(node, '分析API（建议高质模型）');
  const summary = fieldControl(node, '摘要API（建议快速模型）');
  const url = fieldControl(node, 'URL'), key = fieldControl(node, 'Key');
  const model = fieldControl(node, '模型').find(n => n.tagName === 'input');
  assert.equal(url.value, 'https://main.test/v1');
  await summary.fire('focus');
  assert.equal(url.value, 'https://fast.test/v1');
  assert.equal(model.value, 'fast-model');
  assert.match(node.find(n => n.className === 'settings-hint').textContent, /摘要 API · 摘要快速/);

  url.value = 'https://fast-draft.test/v1'; model.value = 'fast-draft-model'; key.value = '';
  const fetchBtn = node.find(n => n.tagName === 'button' && n.textContent === '拉取模型');
  await fetchBtn.fire('click'); await flush();
  await node.find(n => n.tagName === 'button' && n.textContent === '测试连接').fire('click'); await flush();
  assert.deepEqual(toolCalls.map(([kind, selection]) => [kind, selection.config.url, selection.config.key, selection.config.model]), [
    ['models', 'https://fast-draft.test/v1', 'FAST_KEY', 'fast-draft-model'],
    ['test', 'https://fast-draft.test/v1', 'FAST_KEY', 'fast-draft-model'],
  ]);
  const datalist = node.find(n => n.tagName === 'datalist');
  assert.deepEqual(datalist.children.map(option => option.value), ['gpt-x', 'gpt-y']);
  const save = node.find(n => n.tagName === 'button' && n.textContent === '保存设置');
  await save.fire('click');
  assert.equal(presets.find(item => item.id === 'fast').url, 'https://fast-draft.test/v1');
  assert.equal(presets.find(item => item.id === 'fast').key, 'FAST_KEY', 'Key 留空必须保留摘要预设原值');
  assert.deepEqual(analysisUpdates, [], '保存摘要配置不得切换分析 API');

  summary.value = ''; await summary.fire('change');
  assert.equal(utilityUpdates.at(-1), '');
  assert.equal(url.value, 'https://main.test/v1');
  assert.match(node.find(n => n.className === 'settings-hint').textContent, /摘要 API 跟随分析/);
  url.value = 'https://main-through-summary.test/v1'; key.value = '';
  await save.fire('click');
  assert.equal(main.url, 'https://main-through-summary.test/v1');
  assert.equal(main.key, 'MAIN_KEY', '跟随分析时 Key 留空必须保留实际主配置原值');
  assert.deepEqual(analysisUpdates, [], '通过跟随摘要保存共享目标不得改分析选择');

  const originalPrompt = globalThis.prompt;
  globalThis.prompt = () => '摘要专用新预设';
  try {
    await node.find(n => n.tagName === 'button' && n.textContent === '另存为预设').fire('click');
  } finally { globalThis.prompt = originalPrompt; }
  assert.equal(utilityPresetId, 'summary-new');
  assert.equal(presets.find(item => item.id === 'summary-new').name, '摘要专用新预设');
  assert.deepEqual(analysisUpdates, [], '摘要另存只能切摘要角色');
  assert.equal(analysis.value, '');
  assert.equal(rerenders, 1);
});
