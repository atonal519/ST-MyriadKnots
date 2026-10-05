import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptsSettings } from '../src/ui/settings/prompts-settings.js';
import { createAppearanceSettings } from '../src/ui/settings/appearance-settings.js';
import { resolveVectorConfig, VECTOR_DEFAULT_URL, VECTOR_DEFAULT_MODEL } from '../src/vector-api.js';
import { createApiSettings } from '../src/ui/settings/api-settings.js';
import { createVectorApiSettings } from '../src/ui/settings/vector-api-settings.js';
import { createSettingsStore } from '../src/settings.js';
import { createApiResolver, createTaskRouter } from '../src/api-routing.js';
import { DEFAULT_EXTRACTOR_GUIDANCE } from '../src/v3/extractor.js';
import { DEFAULT_CSE_GUIDANCE } from '../src/v3/cse-engine.js';
import { DEFAULT_PROFILE_GUIDANCE } from '../src/v3/people-workspace.js';

class Node {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.events = {}; this.className = ''; this.id = '';
    this.open = false; this.checked = false; this.disabled = false; this.value = ''; this.type = '';
    this.placeholder = ''; this.min = ''; this.max = ''; this.step = ''; this.attributes = {}; this._text = '';
  }
  append(...nodes) { for (const node of nodes) { this.children.push(node); if (node instanceof Node) node.parentNode = this; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  async fire(name, overrides = {}) { for (const handler of this.events[name] || []) await handler({ currentTarget: this, target: this, stopPropagation() {}, preventDefault() {}, ...overrides }); }
  focus(options) { this.focusOptions = options; documentRef.activeElement = this; }
  getRootNode() { return documentRef; }
  contains(target) { return target === this || this.descendants().includes(target); }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (selector.startsWith('.') && node.className.split(' ').includes(selector.slice(1))) return node; return null; }
  getBoundingClientRect() { return this.rect ?? { top: 0, bottom: 100, height: 100 }; }
  get classList() { return { add: c => { if (!this.className.split(' ').includes(c)) this.className = `${this.className ? `${this.className} ` : ''}${c}`; }, remove: c => { this.className = this.className.split(' ').filter(value => value && value !== c).join(' '); }, contains: c => this.className.split(' ').includes(c) }; }
  get textContent() { return this._text || this.children.map(child => child?.textContent ?? '').join(''); }
  set textContent(value) { this._text = String(value); }
  descendants() { return this.children.flatMap(child => child instanceof Node ? [child, ...child.descendants()] : []); }
  find(predicate) { return this.descendants().find(predicate); }
  findAll(predicate) { return this.descendants().filter(predicate); }
}
const documentRef = { activeElement: null, createElement: tag => new Node(tag) };
const flush = () => new Promise(resolve => setImmediate(resolve));
const fieldControl = (node, label) => node.find(n => n.tagName === 'label' && n.children[0]?.textContent === label)?.children[1];
const inlineTrigger = control => control.find(n => n.className.split(' ').includes('qqj-inline-select-trigger'));
const chooseInline = async (control, value) => {
  await inlineTrigger(control).fire('click');
  const option = control.find(n => n.attributes['data-value'] === value);
  assert.ok(option, `缺少内联选项 ${value}`);
  await option.fire('click');
};
const focusInline = control => inlineTrigger(control).fire('focus');

test('附加参数随 API 角色回填，非法 JSON 阻止保存、另存和测试，清空恢复默认', async () => {
  let saves = 0, calls = 0, prompts = 0;
  const settings = createSettingsStore({ extensionSettings: {}, save() { saves++; } });
  settings.saveMainConfig({ url: 'https://main.test/v1', key: 'KEY', model: 'glm-5.2' });
  const disabled = '{"thinking":{"type":"disabled"}}';
  settings.upsertSharedPreset('召回', { url: 'https://recall.test/v1', key: 'RECALL_KEY', model: 'glm-5.2', qqjAdditionalParams: disabled }, 'recall');
  settings.update({ recallPresetId: 'recall' });
  const { node } = createApiSettings({ settings, documentRef, apiTools: { testConnection: async () => { calls++; return {}; } }, promptImpl: async () => { prompts++; return 'new'; } });
  const field = fieldControl(node, '附加参数（JSON）');
  assert.equal(field.value, '');
  field.value = '{bad}';
  const before = saves;
  for (const text of ['保存设置', '另存为预设', '测试连接']) await node.find(n => n.tagName === 'button' && n.textContent === text).fire('click');
  assert.equal(saves, before); assert.equal(calls, 0); assert.equal(prompts, 0);
  assert.match(node.find(n => n.className.includes('settings-result')).textContent, /JSON 对象/u);
  field.value = disabled;
  await node.find(n => n.tagName === 'button' && n.textContent === '保存设置').fire('click');
  assert.equal(settings.mainConfig().qqjAdditionalParams, disabled);
  assert.equal(field.value, disabled);
  await focusInline(fieldControl(node, '召回API（默认跟随摘要）'));
  assert.equal(field.value, disabled);
  field.value = '';
  await node.find(n => n.tagName === 'button' && n.textContent === '保存设置').fire('click');
  assert.equal(settings.sharedPresets()[0].qqjAdditionalParams, undefined);
  assert.equal(settings.mainConfig().qqjAdditionalParams, disabled, '独立召回保存不影响主配置');
  await focusInline(fieldControl(node, '分析API（建议高质模型）'));
  assert.equal(field.value, disabled);
});

test('提示词模块字段 change 即持久化', () => {
  const patches = [];
  const settings = { get: () => ({ sourceKeepTags: 'content', sourceExtraTags: '' }), update: patch => { patches.push(patch); return patch; } };
  const { node } = createPromptsSettings({ settings, documentRef });
  const wrappers = node.find(n => n.id === 'qqj-settings-wrappers');
  assert.ok(wrappers); assert.equal(wrappers.open, false);
  assert.equal(wrappers.children[0].textContent, '包裹符');
  assert.match(node.children[1].className, /settings-drawer-list/);
  const keep = fieldControl(wrappers, '保留包裹符');
  keep.value = 'content,summary'; keep.fire('change');
  assert.deepEqual(patches.at(-1), { sourceKeepTags: 'content,summary' });
  const clean = fieldControl(wrappers, '清洗包裹符');
  clean.value = 'think,reasoning'; clean.fire('change');
  assert.deepEqual(patches.at(-1), { sourceExtraTags: 'think,reasoning' });
  assert.equal(fieldControl(node, '通用附加提示词'), undefined, '退役入口不得继续显示');
});

test('提示词模块提供时间戳开关、独立参考标签、原样自定义、恢复默认与协调状态', async () => {
  const current = { sourceKeepTags: 'content', sourceExtraTags: '', storyClockEnabled: true, storyClockPrompt: '', storyClockReferenceTags: '' };
  const patches = [], refreshes = [];
  const settings = { get: () => ({ ...current }), update: patch => { Object.assign(current, patch); patches.push(patch); return { ...current }; } };
  const { node } = createPromptsSettings({ settings, documentRef, onStoryClockChange: options => { refreshes.push(options ?? {}); return { label: current.storyClockPrompt ? '使用自定义时间戳提示词' : '已调用千千结时间戳' }; } });
  assert.equal(node.find(n => n.id === 'qqj-story-clock-status').textContent, '已调用千千结时间戳');
  const referenceTags = fieldControl(node, '正文时间参考标签');
  assert.equal(referenceTags.value, '');
  assert.doesNotMatch(referenceTags.placeholder, /Ti/u);
  referenceTags.value = 'Ti,时标'; await referenceTags.fire('change');
  assert.deepEqual(patches.at(-1), { storyClockReferenceTags: 'Ti,时标' });
  assert.match(node.textContent, /不改变正文清洗/);
  const textarea = node.find(n => n.tagName === 'textarea' && /千千结/.test(n.placeholder));
  textarea.value = '  自定义\n'; await textarea.fire('change');
  assert.deepEqual(patches.at(-1), { storyClockPrompt: '  自定义\n' });
  assert.equal(node.find(n => n.id === 'qqj-story-clock-status').textContent, '使用自定义时间戳提示词');
  await node.find(n => n.tagName === 'button' && n.textContent === '载入默认再改').fire('click');
  assert.match(textarea.value, /<!-- QQJ-start/); assert.doesNotMatch(textarea.value, /myknots-start/);
  assert.match(node.textContent, /QQJ-start\/end.*兼容 SDC 和旧 myknots 格式/);
  await node.find(n => n.tagName === 'button' && n.textContent === '恢复默认').fire('click');
  assert.deepEqual(patches.at(-1), { storyClockPrompt: '' }); assert.equal(textarea.value, '');
  assert.equal(refreshes[0].readOnly, true); assert.ok(refreshes.length >= 3);
});

test('破限、摘要、CSE 与人物资料提示词各自 change 即存，可载入内置文本并恢复默认', async () => {
  const current = { sourceKeepTags: 'content', sourceExtraTags: '', storyClockEnabled: true, storyClockPrompt: '', processingPrompt: '', summaryPrompt: '', csePrompt: '', profilePrompt: '' };
  const patches = [];
  const settings = { get: () => ({ ...current }), update: patch => { Object.assign(current, patch); patches.push(patch); return { ...current }; } };
  const { node } = createPromptsSettings({ settings, documentRef });
  const processingDrawer = node.find(n => n.id === 'qqj-settings-processing-prompt');
  const summaryDrawer = node.find(n => n.id === 'qqj-settings-summary-prompt');
  const cseDrawer = node.find(n => n.id === 'qqj-settings-cse-prompt');
  const profileDrawer = node.find(n => n.id === 'qqj-settings-profile-prompt');
  const processing = fieldControl(processingDrawer, '破限提示词');
  const summary = fieldControl(summaryDrawer, '摘要内容要求');
  const cse = fieldControl(cseDrawer, 'CSE 推演要求');
  const profile = fieldControl(profileDrawer, '人物资料整理要求');

  processing.value = '  用户破限文本\n'; await processing.fire('change');
  summary.value = '  用户摘要要求\n'; await summary.fire('change');
  cse.value = '  用户 CSE 要求\n'; await cse.fire('change');
  profile.value = '  用户人物资料要求\n'; await profile.fire('change');
  assert.deepEqual(patches.slice(-4), [{ processingPrompt: '  用户破限文本\n' }, { summaryPrompt: '  用户摘要要求\n' }, { csePrompt: '  用户 CSE 要求\n' }, { profilePrompt: '  用户人物资料要求\n' }]);

  await processingDrawer.find(n => n.tagName === 'button' && n.textContent === '载入默认再改').fire('click');
  await summaryDrawer.find(n => n.tagName === 'button' && n.textContent === '载入默认再改').fire('click');
  await cseDrawer.find(n => n.tagName === 'button' && n.textContent === '载入默认再改').fire('click');
  await profileDrawer.find(n => n.tagName === 'button' && n.textContent === '载入默认再改').fire('click');
  assert.match(processing.value, /fictional_content_processing_protocol/); assert.equal(summary.value, DEFAULT_EXTRACTOR_GUIDANCE); assert.equal(cse.value, DEFAULT_CSE_GUIDANCE); assert.equal(profile.value, DEFAULT_PROFILE_GUIDANCE);
  await processingDrawer.find(n => n.tagName === 'button' && n.textContent === '恢复默认').fire('click');
  await summaryDrawer.find(n => n.tagName === 'button' && n.textContent === '恢复默认').fire('click');
  await cseDrawer.find(n => n.tagName === 'button' && n.textContent === '恢复默认').fire('click');
  await profileDrawer.find(n => n.tagName === 'button' && n.textContent === '恢复默认').fire('click');
  assert.deepEqual(patches.slice(-4), [{ processingPrompt: '' }, { summaryPrompt: '' }, { csePrompt: '' }, { profilePrompt: '' }]);
  assert.equal(processing.value, ''); assert.equal(summary.value, ''); assert.equal(cse.value, ''); assert.equal(profile.value, '');
});

test('外观模块内联选择即存并即时应用；程序设置同步标签，改 URL 清空缓存 family', async () => {
  const patches = []; let applied = 0;
  const settings = { get: () => ({ appearanceTheme: 'auto', appearanceScale: 1, appearanceFontCssUrl: '' }), update: patch => { patches.push(patch); return patch; } };
  const { node } = createAppearanceSettings({ settings, documentRef, applyAppearance: () => { applied += 1; } });
  assert.equal(node.find(n => n.tagName === 'select'), undefined, '外观设置不得唤起手机原生选择器');
  const theme = fieldControl(node, '主题');
  await chooseInline(theme, 'night');
  assert.deepEqual(patches.at(-1), { appearanceTheme: 'night' });
  assert.equal(theme.find(n => n.className === 'qqj-inline-select-value').textContent, '夜间');
  theme.value = 'day';
  assert.equal(theme.find(n => n.className === 'qqj-inline-select-value').textContent, '日间', '顶栏程序化切换应同步内联标签');
  const url = fieldControl(node, '自定义字体 CSS URL');
  url.value = 'https://f.test/a.css'; url.fire('change');
  assert.deepEqual(patches.at(-1), { appearanceFontCssUrl: 'https://f.test/a.css', appearanceFontFamily: '' });
  assert.equal(applied, 2);
  assert.equal(node.find(n => n.tagName === 'label' && n.children[0]?.textContent === '字体 family'), undefined);
});

test('外观设置的两个楼层卡片开关分别保存并立即应用', async () => {
  const current = { appearanceTheme: 'auto', appearanceScale: 1, appearanceFontCssUrl: '', inlineRecallVisible: true, inlineMemoryVisible: true };
  const patches = []; let applied = 0;
  const settings = { get: () => ({ ...current }), update: patch => { Object.assign(current, patch); patches.push(patch); return { ...current }; } };
  const { node } = createAppearanceSettings({ settings, documentRef, applyAppearance: () => { applied += 1; } });
  const recall = node.find(n => n.tagName === 'input' && n.attributes['aria-label'] === '显示楼层召回卡片');
  const memory = node.find(n => n.tagName === 'input' && n.attributes['aria-label'] === '显示楼层记忆卡片');
  assert.equal(recall.checked, true); assert.equal(memory.checked, true);
  recall.checked = false; await recall.fire('change');
  assert.deepEqual(patches.at(-1), { inlineRecallVisible: false });
  assert.equal(current.inlineMemoryVisible, true);
  memory.checked = false; await memory.fire('change');
  assert.deepEqual(patches.at(-1), { inlineMemoryVisible: false });
  assert.equal(applied, 2);
});

test('API 模块：编辑目标随来源角色切换，摘要保存、草稿调用与另存均不改分析选择', async () => {
  let main = { id: '', name: '主配置', url: 'https://main.test/v1', key: 'MAIN_KEY', model: 'main-model', excludeParams: [], timeoutSec: 180, stream: false };
  let presets = [{ id: 'fast', name: '摘要快速', url: 'https://fast.test/v1', key: 'FAST_KEY', model: 'fast-model', excludeParams: ['seed'], timeoutSec: 60, stream: true, qqjTemperature: 0.42 }];
  let utilityPresetId = 'fast';
  const analysisUpdates = [], utilityUpdates = [], saves = [], toolCalls = [];
  const settings = {
    get: () => ({ apiMode: 'auto', selectedSevenDaysPresetId: '' }),
    mainConfig: () => ({ ...main }),
    sharedPresets: () => presets.map(item => ({ ...item })),
    summaryPresetId: () => utilityPresetId,
    setSummaryPresetId: id => { utilityPresetId = id; utilityUpdates.push(id); },
    saveMainConfig: config => { main = { ...main, ...config, excludeParams: String(config.excludeParams ?? '').split(/[\n,]/).map(item => item.trim()).filter(Boolean) }; saves.push(['main', config]); },
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
  const promptCalls = []; let promptResponse = null;
  const { node } = createApiSettings({ settings, apiTools, documentRef, promptImpl: options => { promptCalls.push(options); return promptResponse; }, rerender: () => { rerenders += 1; } });
  const scroller = new Node('div'); scroller.className = 'body'; scroller.scrollTop = 30; scroller.rect = { top: 10, bottom: 410, height: 400 }; node.rect = { top: 100, bottom: 500, height: 400 }; scroller.append(node);
  const editorBody = node.find(n => n.className.includes('settings-sub-body') && n.className.includes('qqj-manual-editor'));
  assert.ok(editorBody); assert.ok(editorBody.children.at(-2).className.includes('qqj-manual-save-bar'), '聊天 API 操作栏在独立向量区之前');
  assert.equal(node.find(n => n.tagName === 'button' && n.textContent === '清除 Key'), undefined);
  const analysis = fieldControl(node, '分析API（建议高质模型）');
  const summary = fieldControl(node, '摘要API（建议快速模型）');
  assert.equal(node.find(n => n.tagName === 'select'), undefined, 'API 角色预设不得唤起手机原生选择器');
  const url = fieldControl(node, 'URL'), key = fieldControl(node, 'Key');
  const model = fieldControl(node, '模型').find(n => n.tagName === 'input');
  const temperature = fieldControl(node, '千千结温度（0–2）');
  assert.equal(url.value, 'https://main.test/v1');
  await focusInline(summary);
  assert.equal(url.value, 'https://fast.test/v1');
  assert.equal(model.value, 'fast-model');
  assert.equal(temperature.value, '0.42', '角色切换应回显所选配置温度');
  assert.match(node.find(n => n.className === 'settings-hint').textContent, /摘要 API · 摘要快速/);

  url.value = 'https://fast-draft.test/v1'; model.value = 'fast-draft-model'; key.value = ''; temperature.value = '0.31';
  const fetchBtn = node.find(n => n.tagName === 'button' && n.textContent === '拉取模型');
  await fetchBtn.fire('click'); await flush();
  await node.find(n => n.tagName === 'button' && n.textContent === '测试连接').fire('click'); await flush();
  assert.deepEqual(toolCalls.map(([kind, selection]) => [kind, selection.config.url, selection.config.key, selection.config.model]), [
    ['models', 'https://fast-draft.test/v1', 'FAST_KEY', 'fast-draft-model'],
    ['test', 'https://fast-draft.test/v1', 'FAST_KEY', 'fast-draft-model'],
  ]);
  assert.equal(toolCalls.find(([kind]) => kind === 'test')[1].config.qqjTemperature, 0.31, '连接测试使用当前编辑温度');
  const modelSection = node.find(n => n.tagName === 'details' && n.className === 'qqj-model-list-section');
  assert.equal(modelSection.hidden, false); assert.equal(modelSection.open, true);
  assert.match(modelSection.textContent, /已加载 2 个模型/);
  const search = modelSection.find(n => n.className.includes('qqj-model-list-search'));
  search.value = 'Y'; await search.fire('input');
  assert.deepEqual(modelSection.findAll(n => n.tagName === 'button' && n.className.includes('qqj-model-list-item')).map(item => item.textContent), ['gpt-y']);
  await modelSection.find(n => n.tagName === 'button' && n.className.includes('qqj-model-list-item')).fire('click');
  assert.equal(model.value, 'gpt-y'); assert.match(modelSection.find(n => n.tagName === 'button' && n.className.includes('qqj-model-list-item')).className, /active/);
  model.value = 'fast-draft-model'; await model.fire('input');
  const save = node.find(n => n.tagName === 'button' && n.textContent === '保存设置');
  await save.fire('click');
  assert.equal(scroller.scrollTop, 120, 'API 保存并刷新字段后回到配置抽屉顶部');
  assert.equal(presets.find(item => item.id === 'fast').url, 'https://fast-draft.test/v1');
  assert.equal(presets.find(item => item.id === 'fast').key, 'FAST_KEY', 'Key 留空必须保留摘要预设原值');
  assert.equal(presets.find(item => item.id === 'fast').qqjTemperature, 0.31, '共享预设保存温度');
  assert.deepEqual(analysisUpdates, [], '保存摘要配置不得切换分析 API');

  await chooseInline(summary, '');
  assert.equal(utilityUpdates.at(-1), '');
  assert.equal(url.value, 'https://main.test/v1');
  assert.match(node.find(n => n.className === 'settings-hint').textContent, /摘要 API 跟随分析/);
  url.value = 'https://main-through-summary.test/v1'; key.value = '';
  temperature.value = '2.01';
  await save.fire('click');
  assert.equal(main.url, 'https://main.test/v1', '越界温度阻止保存');
  assert.match(node.find(n => n.className.includes('settings-result')).textContent, /温度须在 0–2/u);
  temperature.value = '0';
  await save.fire('click');
  assert.equal(main.url, 'https://main-through-summary.test/v1');
  assert.equal(main.key, 'MAIN_KEY', '跟随分析时 Key 留空必须保留实际主配置原值');
  assert.equal(main.qqjTemperature, 0, '0 是有效的温度设置');
  assert.deepEqual(analysisUpdates, [], '通过跟随摘要保存共享目标不得改分析选择');

  const saveCountBeforePrompt = saves.length;
  temperature.value = '2.001';
  await node.find(n => n.tagName === 'button' && n.textContent === '另存为预设').fire('click');
  assert.equal(promptCalls.length, 0, '非法温度不得打开另存预设流程');
  assert.equal(saves.length, saveCountBeforePrompt, '非法温度不得写入共享预设');
  assert.match(node.find(n => n.className.includes('settings-result')).textContent, /温度须在 0–2/u);
  temperature.value = '0';
  await node.find(n => n.tagName === 'button' && n.textContent === '另存为预设').fire('click');
  assert.equal(saves.length, saveCountBeforePrompt, '取消另存输入不得创建预设'); assert.equal(rerenders, 0);
  promptResponse = '摘要专用新预设';
  await node.find(n => n.tagName === 'button' && n.textContent === '另存为预设').fire('click');
  assert.equal(promptCalls[1].title, '另存为预设');
  assert.equal(utilityPresetId, 'summary-new');
  assert.equal(presets.find(item => item.id === 'summary-new').name, '摘要专用新预设');
  assert.deepEqual(analysisUpdates, [], '摘要另存只能切摘要角色');
  assert.equal(analysis.value, '');
  assert.equal(rerenders, 1);
});

test('无构画设置可从 UI 点击已存预设，并让后续分析与摘要路由使用该配置', async () => {
  const extensionSettings = {};
  const settings = createSettingsStore({ extensionSettings, save() {}, now: () => 1, random: () => 0.5 });
  const presetId = settings.upsertSharedPreset('预设 A', { url: 'https://preset-a.test/v1', key: 'KEY_A', model: 'model-a', excludeParams: ['seed'], timeoutSec: 45, stream: true, qqjTemperature: 0.73 }, 'preset-a');
  assert.equal(presetId, 'preset-a');
  assert.equal(settings.sharedPresets().length, 1, '没有构画初始记录时仍能建立共享预设池');
  assert.equal(settings.sharedPresets()[0].qqjTemperature, 0.73, '共享预设保留千千结专属温度');

  const routed = [];
  const resolver = createApiResolver({ settings });
  const router = createTaskRouter({ resolver, compactClient: { generateTask: async ({ config }) => { routed.push(config); return { jsonData: { ok: true } }; } } });
  const { node } = createApiSettings({ settings, apiTools: { fetchModels: async () => [], testConnection: async () => ({ ok: true }) }, documentRef });
  const analysis = fieldControl(node, '分析API（建议高质模型）');
  const trigger = inlineTrigger(analysis);
  await trigger.fire('click');
  const optionA = analysis.find(n => n.attributes['data-value'] === 'preset-a');
  documentRef.activeElement = null;
  const focusout = analysis.fire('focusout', { relatedTarget: null });
  await focusout; await Promise.resolve();
  assert.equal(analysis.find(n => n.className === 'qqj-inline-select-options').hidden, false, '焦点清理微任务结束时仍不能提前隐藏菜单');
  optionA.focus();
  await optionA.fire('click');
  await new Promise(resolve => setTimeout(resolve, 0));
  await trigger.fire('focus');

  assert.equal(analysis.find(n => n.className === 'qqj-inline-select-options').hidden, true);
  assert.equal(analysis.find(n => n.className === 'qqj-inline-select-value').textContent, '预设 A');
  assert.equal(settings.get().apiMode, 'seven-preset');
  assert.equal(settings.get().selectedSevenDaysPresetId, 'preset-a');
  assert.equal(fieldControl(node, 'URL').value, 'https://preset-a.test/v1');

  await router.generateAnalysisTask({});
  assert.equal(routed.at(-1).qqjTemperature, 0.73, '路由后的实际配置包含预设温度');
  await router.generateUtilityTask({});
  assert.deepEqual(routed.map(config => [config.url, config.key, config.model]), [
    ['https://preset-a.test/v1', 'KEY_A', 'model-a'],
    ['https://preset-a.test/v1', 'KEY_A', 'model-a'],
  ]);
});

test('共享预设更新保留宿主未知字段，清空温度后回显未设置', () => {
  const extensionSettings = { 'schedule-planner': { apiPresets: [{ id: 'shared', name: '旧名', url: 'https://old.test/v1', key: 'OLD_KEY', model: 'old', timeoutSec: 30, stream: false, qqjTemperature: 0.44, hostField: 'keep' }] } };
  const settings = createSettingsStore({ extensionSettings, save() {} });
  settings.upsertSharedPreset('更新后', { url: 'https://new.test/v1', key: 'NEW_KEY', model: 'new', timeoutSec: 45, stream: true, qqjTemperature: 0.91 }, 'shared');
  assert.equal(extensionSettings['schedule-planner'].apiPresets[0].qqjTemperature, 0.91);
  assert.equal(extensionSettings['schedule-planner'].apiPresets[0].hostField, 'keep');
  settings.upsertSharedPreset('更新后', { url: 'https://new.test/v1', key: 'NEW_KEY', model: 'new', timeoutSec: 45, stream: true, qqjTemperature: null }, 'shared');
  assert.equal(Object.hasOwn(extensionSettings['schedule-planner'].apiPresets[0], 'qqjTemperature'), false, '清空时删除旧值');
  assert.equal(settings.sharedPresets()[0].qqjTemperature, undefined, '清空后回显为空');
});

test('召回跟随链编辑真实目标，另存与删除只切召回角色', async () => {
  const extensionSettings = {};
  const settings = createSettingsStore({ extensionSettings, save() {}, now: () => 2, random: () => 0.5 });
  settings.saveMainConfig({ url: 'https://main.test/v1', key: 'M', model: 'main' });
  settings.upsertSharedPreset('摘要', { url: 'https://summary.test/v1', key: 'S', model: 'summary' }, 'summary');
  settings.setSummaryPresetId('summary');
  const confirmations = [];
  const mount = () => createApiSettings({ settings, apiTools: { fetchModels: async () => [], testConnection: async () => ({}) }, documentRef, promptImpl: () => '召回专用', confirmImpl: options => { confirmations.push(options); return true; } }).node;
  let node = mount();
  await focusInline(fieldControl(node, '召回API（默认跟随摘要）'));
  assert.equal(fieldControl(node, 'URL').value, 'https://summary.test/v1');
  assert.match(node.textContent, /召回 API 跟随摘要.*保存会更新当前摘要配置/u);
  fieldControl(node, 'URL').value = 'https://summary-edited.test/v1';
  await node.find(n => n.textContent === '保存设置').fire('click');
  assert.equal(settings.sharedPresets().find(item => item.id === 'summary').url, 'https://summary-edited.test/v1');
  assert.equal(settings.mainConfig().url, 'https://main.test/v1');
  await chooseInline(fieldControl(node, '摘要API（建议快速模型）'), '');
  await focusInline(fieldControl(node, '召回API（默认跟随摘要）'));
  assert.match(node.textContent, /召回 API 跟随摘要，摘要跟随分析/u);
  assert.equal(fieldControl(node, 'URL').value, 'https://main.test/v1');
  await chooseInline(fieldControl(node, '摘要API（建议快速模型）'), 'summary');
  await focusInline(fieldControl(node, '召回API（默认跟随摘要）'));
  fieldControl(node, 'URL').value = 'https://recall.test/v1';
  await node.find(n => n.textContent === '另存为预设').fire('click');
  const recallId = settings.get().recallPresetId;
  assert.ok(recallId);
  assert.equal(settings.summaryPresetId(), 'summary');
  assert.equal(settings.get().apiMode, 'auto');
  node = mount();
  await focusInline(fieldControl(node, '召回API（默认跟随摘要）'));
  assert.equal(fieldControl(node, 'URL').value, 'https://recall.test/v1');
  await node.find(n => n.textContent === '删除当前预设').fire('click');
  assert.equal(settings.get().recallPresetId, '');
  assert.equal(settings.summaryPresetId(), 'summary');
  assert.match(confirmations[0].note, /召回 API 将改为跟随摘要/u);
});

test('API 预设删除按当前编辑角色清理引用，取消/主配置/失效竞态均不误改', async () => {
  const mount = ({ analysisId = 'target', utilityId = 'keep', role = 'analysis', sevenDays = false, confirmImpl = () => true } = {}) => {
    const current = { apiMode: analysisId ? 'seven-preset' : 'auto', selectedSevenDaysPresetId: analysisId };
    let utility = utilityId;
    let presets = [
      { id: 'target', name: '待删预设', url: 'https://SECRET.example/v1', key: 'SECRET_KEY', model: 'target-model' },
      { id: 'keep', name: '保留预设', url: 'https://keep.test/v1', key: 'KEEP_KEY', model: 'keep-model' },
    ];
    const updates = [], confirmations = [];
    const settings = {
      get: () => ({ ...current }),
      mainConfig: () => ({ id: '', name: '主配置', url: 'https://main.test/v1', key: 'MAIN', model: 'main' }),
      sharedPresets: () => presets.map(item => ({ ...item })),
      summaryPresetId: () => utility,
      setSummaryPresetId: id => { utility = id; },
      update: patch => { Object.assign(current, patch); updates.push(patch); },
      deleteSharedPreset: id => {
        const next = presets.filter(item => item.id !== id);
        if (next.length === presets.length) return false;
        presets = next;
        if (utility === id) utility = '';
        return true;
      },
      saveMainConfig() {}, upsertSharedPreset() {},
    };
    let rerenders = 0;
    const view = createApiSettings({
      settings, apiTools: { fetchModels: async () => [], testConnection: async () => ({}) }, documentRef,
      isSevenDaysAvailable: () => sevenDays,
      confirmImpl: options => { confirmations.push(options); return confirmImpl({ message: `${options.title}\n${options.body}\n${options.note}`, presets, current, setPresets: value => { presets = value; } }); },
      rerender: () => { rerenders += 1; },
    }).node;
    if (role === 'summary') focusInline(fieldControl(view, '摘要API（建议快速模型）'));
    return { view, current, get utility() { return utility; }, get presets() { return presets; }, updates, confirmations, get rerenders() { return rerenders; } };
  };
  const remove = state => state.view.find(n => n.tagName === 'button' && n.textContent === '删除当前预设').fire('click');

  const main = mount({ analysisId: '', utilityId: '' });
  assert.equal(main.view.find(n => n.textContent === '删除当前预设').disabled, true);
  await remove(main); assert.equal(main.confirmations.length, 0); assert.equal(main.presets.length, 2);

  const cancelled = mount({ confirmImpl: () => false });
  await remove(cancelled); assert.equal(cancelled.presets.length, 2); assert.deepEqual(cancelled.updates, []); assert.match(`${cancelled.confirmations[0].body}\n${cancelled.confirmations[0].note}`, /删除预设「待删预设」/);

  const analysisOnly = mount();
  await remove(analysisOnly);
  assert.deepEqual(analysisOnly.current, { apiMode: 'auto', selectedSevenDaysPresetId: '' });
  assert.equal(analysisOnly.utility, 'keep'); assert.deepEqual(analysisOnly.presets.map(item => item.id), ['keep']); assert.equal(analysisOnly.rerenders, 1);
  assert.match(analysisOnly.confirmations[0].note, /分析 API 将回退到主配置/); assert.doesNotMatch(analysisOnly.confirmations[0].note, /摘要 API 将改为跟随分析|构画/);
  assert.doesNotMatch(JSON.stringify(analysisOnly.confirmations[0]), /SECRET|https?:/);

  const summaryOnly = mount({ analysisId: 'keep', utilityId: 'target', role: 'summary' });
  await remove(summaryOnly);
  assert.deepEqual(summaryOnly.current, { apiMode: 'seven-preset', selectedSevenDaysPresetId: 'keep' }); assert.equal(summaryOnly.utility, '');
  assert.match(summaryOnly.confirmations[0].note, /摘要 API 将改为跟随分析/); assert.doesNotMatch(summaryOnly.confirmations[0].note, /分析 API 将回退/);

  const shared = mount({ analysisId: 'target', utilityId: 'target', sevenDays: true });
  await remove(shared);
  assert.deepEqual(shared.current, { apiMode: 'auto', selectedSevenDaysPresetId: '' }); assert.equal(shared.utility, '');
  assert.match(shared.confirmations[0].note, /分析 API 将回退到主配置/); assert.match(shared.confirmations[0].note, /摘要 API 将改为跟随分析/); assert.match(shared.confirmations[0].note, /构画中也会移除/);

  const follows = mount({ analysisId: 'target', utilityId: '', role: 'summary' });
  await remove(follows); assert.match(follows.confirmations[0].note, /摘要 API 当前跟随分析，也将随分析回退到主配置/);

  const raced = mount({ analysisId: 'target', utilityId: 'keep', confirmImpl: ({ current, setPresets }) => { setPresets([{ id: 'keep', name: '保留预设' }]); current.selectedSevenDaysPresetId = 'keep'; return true; } });
  await remove(raced); assert.deepEqual(raced.current, { apiMode: 'seven-preset', selectedSevenDaysPresetId: 'keep' }); assert.deepEqual(raced.updates, []); assert.equal(raced.rerenders, 0);
});

test('API 显式失效预设保存时不谎报成功，也不写入任何配置', async () => {
  const current = { apiMode: 'seven-preset', selectedSevenDaysPresetId: 'missing' };
  const writes = [];
  const settings = {
    get: () => ({ ...current }),
    mainConfig: () => ({ id: '', name: '主配置', url: 'https://main.test/v1', key: 'MAIN', model: 'main' }),
    sharedPresets: () => [],
    summaryPresetId: () => '',
    setSummaryPresetId: id => writes.push(['summary', id]),
    update: patch => writes.push(['analysis', patch]),
    saveMainConfig: config => writes.push(['main', config]),
    upsertSharedPreset: (...args) => writes.push(['preset', ...args]),
    deleteSharedPreset: () => false,
  };
  const { node } = createApiSettings({ settings, apiTools: { fetchModels: async () => [], testConnection: async () => ({}) }, documentRef });
  assert.equal(fieldControl(node, '分析API（建议高质模型）').value, 'missing');
  await node.find(n => n.tagName === 'button' && n.textContent === '保存设置').fire('click');
  const result = node.find(n => n.className.includes('settings-result'));
  assert.match(result.textContent, /预设已失效.*重新选择或另存/);
  assert.match(result.className, /error/);
  assert.deepEqual(writes, []);
});

test('模型内联列表搜索、空匹配与点击回填生效，旧目标迟到结果不污染新目标', async () => {
  const current = { apiMode: 'seven-preset', selectedSevenDaysPresetId: 'analysis' };
  let utility = 'summary';
  const presets = [
    { id: 'analysis', name: '分析', url: 'https://a.test/v1', key: 'A', model: 'analysis-model' },
    { id: 'summary', name: '摘要', url: 'https://s.test/v1', key: 'S', model: 'summary-model' },
  ];
  let resolveModels;
  const pendingModels = new Promise(resolve => { resolveModels = resolve; });
  const settings = {
    get: () => ({ ...current }), mainConfig: () => ({}), sharedPresets: () => presets.map(item => ({ ...item })),
    summaryPresetId: () => utility, setSummaryPresetId: id => { utility = id; }, update: patch => Object.assign(current, patch),
    saveMainConfig() {}, upsertSharedPreset() {}, deleteSharedPreset() { return false; },
  };
  const { node } = createApiSettings({ settings, apiTools: { fetchModels: () => pendingModels, testConnection: async () => ({}) }, documentRef });
  const analysis = fieldControl(node, '分析API（建议高质模型）');
  const summary = fieldControl(node, '摘要API（建议快速模型）');
  const model = fieldControl(node, '模型').find(n => n.tagName === 'input');
  const section = node.find(n => n.className === 'qqj-model-list-section');
  const fetching = node.find(n => n.textContent === '拉取模型').fire('click');
  await flush();
  await focusInline(summary);
  assert.equal(model.value, 'summary-model'); assert.equal(section.hidden, true);
  resolveModels(['analysis-only', 'another-analysis']); await fetching;
  assert.equal(model.value, 'summary-model'); assert.equal(section.hidden, true); assert.doesNotMatch(section.textContent, /analysis-only/);

  await chooseInline(analysis, 'analysis');
  const emptyTools = { fetchModels: async () => ['Alpha', 'Beta'], testConnection: async () => ({}) };
  const second = createApiSettings({ settings, apiTools: emptyTools, documentRef }).node;
  await second.find(n => n.tagName === 'button' && n.textContent === '拉取模型').fire('click');
  const secondSection = second.find(n => n.className === 'qqj-model-list-section');
  const search = secondSection.find(n => n.className.includes('qqj-model-list-search'));
  search.value = 'zzz'; await search.fire('input'); assert.match(secondSection.textContent, /无匹配项/);
  search.value = 'alp'; await search.fire('input');
  const alpha = secondSection.find(n => n.tagName === 'button' && n.className.includes('qqj-model-list-item'));
  await alpha.fire('click');
  assert.equal(fieldControl(second, '模型').find(n => n.tagName === 'input').value, 'Alpha');
  assert.match(secondSection.find(n => n.tagName === 'button' && n.textContent === 'Alpha').className, /active/);

  current.apiMode = 'seven-preset'; current.selectedSevenDaysPresetId = 'analysis'; utility = 'summary';
  let rejectOld;
  const failedLater = new Promise((_resolve, reject) => { rejectOld = reject; });
  const third = createApiSettings({ settings, apiTools: { fetchModels: () => failedLater, testConnection: async () => ({}) }, documentRef }).node;
  const staleFailure = third.find(n => n.tagName === 'button' && n.textContent === '拉取模型').fire('click'); await flush();
  await focusInline(fieldControl(third, '摘要API（建议快速模型）'));
  rejectOld(Object.assign(new Error('旧目标失败'), { code: 'QQJ_TIMEOUT' })); await staleFailure;
  assert.equal(third.find(n => n.className === 'settings-result').textContent, '');
});


test('独立向量区开关靠右，默认地址模型直接回填，只保存向量配置且仅手动建立', async () => {
  const settings = createSettingsStore({ extensionSettings: {}, save: () => {} });
  settings.saveMainConfig({ url: 'https://analysis.invalid/v1', key: 'analysis-key', model: 'analysis' });
  let builds = 0, aborts = 0;
  const vectorIndex = { getState: () => ({ status: 'idle' }), subscribe: () => () => {}, build: async () => { builds++; return { status: 'ready' }; }, abortAll: () => { aborts++; } };
  const calls = [];
  const apiTools = { fetchModels: async () => { calls.push(['models']); return []; }, testConnection: async () => { calls.push(['chat']); } };
  const vectorApi = { embed: async (config, input) => { calls.push(['embedding', config, input]); return [new Float32Array([1, 0])]; } };
  const { node, dispose } = createApiSettings({ settings, apiTools, vectorApi, vectorIndex, documentRef, vectorOpen: true });
  const vector = node.find(n => n.id === 'qqj-settings-vector-api');
  assert.equal(vector.open, true);
  const editor = node.find(n => n.className.includes('qqj-manual-editor'));
  assert.equal(editor.children.at(-1), vector, '向量区放在聊天 API 编辑区之后');
  assert.equal(fieldControl(node, '向量API'), undefined, '向量不再混入聊天 API 的角色预设');
  assert.equal(vector.find(n => n.className.includes('qqj-inline-select')), undefined);
  assert.equal(vector.find(n => n.tagName === 'button' && n.textContent === '另存为预设'), undefined);
  const enabled = vector.find(n => n.attributes['aria-label'] === '开启向量召回');
  assert.equal(enabled.checked, false);
  assert.deepEqual(enabled.parentNode.children.map(n => n.tagName), ['span', 'input']);
  assert.match(enabled.parentNode.className, /setting-switch qqj-vector-enable/);
  assert.equal(enabled.parentNode.className.includes('settings-field'), false, '开关不套用输入框宽度与内边距');
  assert.equal(fieldControl(vector, 'URL').value, VECTOR_DEFAULT_URL);
  assert.equal(fieldControl(vector, '模型').value, VECTOR_DEFAULT_MODEL);
  assert.equal(vector.find(n => n.className.includes('qqj-vector-xfyun-hint')).hidden, true);
  fieldControl(vector, 'URL').value = 'https://maas-api.cn-huabei-1.xf-yun.com/v2/embeddings';
  await fieldControl(vector, 'URL').fire('input');
  assert.equal(vector.find(n => n.className.includes('qqj-vector-xfyun-hint')).hidden, false);
  fieldControl(vector, 'URL').value = 'https://maas-api.cn-huabei-1.xf-yun.com.evil.test/v2';
  await fieldControl(vector, 'URL').fire('input');
  assert.equal(vector.find(n => n.className.includes('qqj-vector-xfyun-hint')).hidden, true);
  assert.equal(fieldControl(vector, 'Key').placeholder, '输入向量 API Key');
  fieldControl(vector, 'URL').value = VECTOR_DEFAULT_URL;
  await fieldControl(vector, 'URL').fire('input');
  const build = vector.find(n => n.tagName === 'button' && n.textContent === '建立索引');
  const testConnection = vector.find(n => n.tagName === 'button' && n.textContent === '测试连接');
  assert.equal(build.disabled, true); assert.equal(testConnection.disabled, true);
  await build.fire('click'); await testConnection.fire('click'); assert.deepEqual(calls, []); assert.equal(builds, 0);
  enabled.checked = true; await enabled.fire('change');
  assert.equal(settings.get().vectorEnabled, true); assert.equal(build.disabled, false); assert.equal(builds, 0);
  fieldControl(vector, 'Key').value = 'vector-key';
  await vector.find(n => n.tagName === 'button' && n.textContent === '保存').fire('click');
  assert.equal(builds, 0); assert.equal(settings.get().apiKey, 'analysis-key');
  assert.equal(settings.get().vectorPresetId, '');
  assert.deepEqual(resolveVectorConfig(settings), { url: VECTOR_DEFAULT_URL, model: VECTOR_DEFAULT_MODEL, key: 'vector-key', dimensions: 1024 });
  await testConnection.fire('click');
  assert.deepEqual(calls, [['embedding', resolveVectorConfig(settings), ['连接测试']]], '向量测试不调用聊天接口');
  const abortsBeforeBuild = aborts;
  await build.fire('click'); assert.equal(builds, 1); assert.equal(aborts, abortsBeforeBuild, '相同配置重建不能清空可复用向量');
  assert.equal(settings.get().apiModel, 'analysis');
  enabled.checked = false; await enabled.fire('change');
  assert.equal(settings.get().vectorEnabled, false); assert.equal(settings.get().vectorKey, 'vector-key');
  assert.equal(fieldControl(node, 'URL').value, 'https://analysis.invalid/v1');
  assert.equal(fieldControl(node, '模型').find(n => n.tagName === 'input').value, 'analysis');
  dispose();
});

test('已选向量预设回填但不自动改设置；保存复制凭证解除共享引用，不改其他 API 或原预设', async () => {
  let writes = 0;
  const settings = createSettingsStore({ extensionSettings: {}, save: () => { writes++; } });
  settings.saveMainConfig({ url: 'https://main.invalid/v1', key: 'main-key', model: 'chat-model' });
  const sharedId = settings.upsertSharedPreset('旧向量预设', { url: 'https://vector.invalid/v1', key: 'vector-key', model: 'embed', excludeParams: ['seed'], timeoutSec: 73, stream: true, qqjTemperature: 0.42 });
  settings.update({ vectorEnabled: true, vectorPresetId: sharedId });
  const initialWrites = writes;
  const { node, dispose } = createVectorApiSettings({ settings, documentRef });
  assert.equal(writes, initialWrites, '打开设置不自动迁移或保存');
  assert.equal(settings.get().vectorPresetId, sharedId);
  assert.equal(fieldControl(node, 'URL').value, 'https://vector.invalid/v1');
  assert.equal(fieldControl(node, '模型').value, 'embed');
  assert.equal(fieldControl(node, 'Key').value, ''); assert.match(fieldControl(node, 'Key').placeholder, /已保存/);
  fieldControl(node, '模型').value = 'embed-v2';
  await node.find(n => n.tagName === 'button' && n.textContent === '保存').fire('click');
  assert.equal(settings.get().vectorPresetId, ''); assert.equal(settings.get().vectorKey, 'vector-key');
  assert.equal(settings.get().vectorModel, 'embed-v2');
  const shared = settings.sharedPresets().find(item => item.id === sharedId);
  assert.equal(shared.model, 'embed'); assert.equal(shared.key, 'vector-key');
  assert.deepEqual(shared.excludeParams, ['seed']); assert.equal(shared.timeoutSec, 73); assert.equal(shared.stream, true); assert.equal(shared.qqjTemperature, 0.42);
  settings.deleteSharedPreset(sharedId);
  assert.equal(settings.get().vectorEnabled, true, '删除已脱离的共享预设不影响独立向量');
  assert.equal(resolveVectorConfig(settings).model, 'embed-v2');
  assert.equal(settings.get().apiMode, 'auto'); assert.equal(settings.summaryPresetId(), ''); assert.equal(settings.get().recallPresetId, '');
  assert.equal(settings.mainConfig().model, 'chat-model'); dispose();
});

test('向量区显示小字进度与取消，编辑其他 API 时进度保留，连接结果互不覆盖', async () => {
  const settings = createSettingsStore({ extensionSettings: {}, save: () => {} });
  settings.update({ vectorEnabled: true, vectorKey: 'vector-key' });
  let state = { status: 'idle' }, listener, endBuild, endTest;
  const vectorIndex = {
    getState: () => state,
    subscribe: fn => { listener = fn; return () => { listener = null; }; },
    build: () => { state = { status: 'building', active: true, completed: 3, total: 7 }; listener?.(); return new Promise(resolve => { endBuild = resolve; }); },
    abortAll: () => { state = { status: 'idle', active: false }; listener?.(); endBuild?.(); },
  };
  const vectorApi = { embed: () => new Promise(resolve => { endTest = resolve; }) };
  const apiTools = { testConnection: async () => ({ model: 'chat-model' }) };
  const { node, dispose } = createApiSettings({ settings, apiTools, vectorIndex, vectorApi, documentRef });
  const vector = node.find(n => n.id === 'qqj-settings-vector-api');
  const build = vector.find(n => n.tagName === 'button' && n.textContent === '建立索引');
  const cancel = vector.find(n => n.tagName === 'button' && n.textContent === '取消');
  const building = build.fire('click'); await flush();
  assert.equal(build.disabled, true); assert.equal(cancel.hidden, false);
  const progress = vector.find(n => n.className.includes('qqj-vector-progress'));
  assert.equal(progress.textContent, '建立中 3/7');
  await focusInline(fieldControl(node, '分析API（建议高质模型）'));
  assert.equal(cancel.hidden, false); assert.equal(progress.hidden, false); listener?.();
  assert.equal(node.find(n => n.className === 'settings-result').textContent, '');
  await cancel.fire('click'); await building;
  assert.equal(build.disabled, false); assert.equal(cancel.hidden, true); assert.equal(typeof listener, 'function');
  const testing = vector.find(n => n.tagName === 'button' && n.textContent === '测试连接').fire('click'); await flush();
  await focusInline(fieldControl(node, '摘要API（建议快速模型）'));
  await node.find(n => n.tagName === 'button' && n.textContent === '测试连接').fire('click');
  const mainResult = node.find(n => n.className === 'settings-result success');
  assert.equal(mainResult.textContent, '连接成功 · chat-model');
  endTest([]); await testing;
  assert.equal(mainResult.textContent, '连接成功 · chat-model');
  assert.equal(vector.find(n => n.className === 'settings-result success').textContent, '连接成功');
  dispose(); assert.equal(listener, null);
});

test('索引切页后重新订阅进行中的任务，恢复完成/失败结果，不重复建索引或中止任务', async () => {
  const settings = createSettingsStore({ extensionSettings: {}, save: () => {} });
  settings.update({ vectorEnabled: true, vectorKey: 'vector-key' });
  let state = { status: 'idle', active: false, completed: 0, total: 0 }, builds = 0, aborts = 0;
  const listeners = new Set();
  const publish = next => { state = next; for (const listener of listeners) listener(state); };
  const vectorIndex = { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, build: async () => { builds++; }, abortAll: () => { aborts++; } };
  const mount = () => createVectorApiSettings({ settings, vectorIndex, documentRef });
  const idle = mount();
  const idleBuild = idle.node.find(n => n.tagName === 'button' && n.textContent === '建立索引');
  assert.equal(idleBuild.disabled, false, '无已建索引时首次手动建立入口保持可用');
  assert.doesNotMatch(idle.node.textContent, /正在读取|建立中/);
  idle.dispose();
  publish({ status: 'building', active: true, completed: 3, total: 7 });
  const first = mount(); assert.match(first.node.textContent, /3\/7/);
  publish({ ...state, completed: 5 }); assert.match(first.node.textContent, /5\/7/);
  assert.equal(listeners.size, 1);
  first.dispose(); assert.equal(listeners.size, 0); assert.equal(aborts, 0);
  const second = mount(); assert.match(second.node.textContent, /5\/7/);
  publish({ status: 'ready', active: false, completed: 7, total: 7 });
  assert.match(second.node.textContent, /已索引 7 个片段/);
  assert.doesNotMatch(first.node.textContent, /已索引 7/);
  second.dispose();
  const complete = mount(); assert.match(complete.node.textContent, /已索引 7 个片段/); complete.dispose();
  publish({ status: 'error', active: false, completed: 5, total: 7, error: '向量请求超时。' });
  const failed = mount(); assert.match(failed.node.textContent, /向量请求超时/); failed.dispose();
  publish({ status: 'building', active: true, completed: 0, total: 0 });
  const preparing = mount(); assert.match(preparing.node.textContent, /正在读取原文/); assert.doesNotMatch(preparing.node.textContent, /0\/0/); preparing.dispose();
  publish({ status: 'ready', active: false, completed: 0, total: 0 });
  const empty = mount(); assert.match(empty.node.textContent, /当前没有可索引的原文/); empty.dispose();
  assert.equal(builds, 0); assert.equal(aborts, 0); assert.equal(listeners.size, 0);
});
