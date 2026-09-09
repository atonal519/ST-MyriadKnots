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
  async fire(name, overrides = {}) { for (const handler of this.events[name] || []) await handler({ currentTarget: this, target: this, stopPropagation() {}, preventDefault() {}, ...overrides }); }
  focus(options) { this.focusOptions = options; }
  contains(target) { return target === this || this.descendants().includes(target); }
  get classList() { return { add: c => { if (!this.className.split(' ').includes(c)) this.className = `${this.className ? `${this.className} ` : ''}${c}`; }, remove: c => { this.className = this.className.split(' ').filter(value => value && value !== c).join(' '); }, contains: c => this.className.split(' ').includes(c) }; }
  get textContent() { return this._text || this.children.map(child => child?.textContent ?? '').join(''); }
  set textContent(value) { this._text = String(value); }
  descendants() { return this.children.flatMap(child => child instanceof Node ? [child, ...child.descendants()] : []); }
  find(predicate) { return this.descendants().find(predicate); }
  findAll(predicate) { return this.descendants().filter(predicate); }
}
const documentRef = { createElement: tag => new Node(tag) };
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
  await node.find(n => n.tagName === 'button' && n.textContent === '载入默认再改').fire('click');
  assert.match(textarea.value, /<!-- QQJ-start/); assert.doesNotMatch(textarea.value, /myknots-start/);
  assert.match(node.textContent, /QQJ、SDC 与旧 myknots 格式均可读取/);
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

test('API 模块：编辑目标随来源角色切换，摘要保存、草稿调用与另存均不改分析选择', async () => {
  let main = { id: '', name: '主配置', url: 'https://main.test/v1', key: 'MAIN_KEY', model: 'main-model', excludeParams: [], timeoutSec: 180, stream: false };
  let presets = [{ id: 'fast', name: '摘要快速', url: 'https://fast.test/v1', key: 'FAST_KEY', model: 'fast-model', excludeParams: ['seed'], timeoutSec: 60, stream: true }];
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
  assert.equal(node.find(n => n.tagName === 'button' && n.textContent === '清除 Key'), undefined);
  const analysis = fieldControl(node, '分析API（建议高质模型）');
  const summary = fieldControl(node, '摘要API（建议快速模型）');
  assert.equal(node.find(n => n.tagName === 'select'), undefined, 'API 角色预设不得唤起手机原生选择器');
  const url = fieldControl(node, 'URL'), key = fieldControl(node, 'Key');
  const model = fieldControl(node, '模型').find(n => n.tagName === 'input');
  assert.equal(url.value, 'https://main.test/v1');
  await focusInline(summary);
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
  assert.equal(presets.find(item => item.id === 'fast').url, 'https://fast-draft.test/v1');
  assert.equal(presets.find(item => item.id === 'fast').key, 'FAST_KEY', 'Key 留空必须保留摘要预设原值');
  assert.deepEqual(analysisUpdates, [], '保存摘要配置不得切换分析 API');

  await chooseInline(summary, '');
  assert.equal(utilityUpdates.at(-1), '');
  assert.equal(url.value, 'https://main.test/v1');
  assert.match(node.find(n => n.className === 'settings-hint').textContent, /摘要 API 跟随分析/);
  url.value = 'https://main-through-summary.test/v1'; key.value = '';
  await save.fire('click');
  assert.equal(main.url, 'https://main-through-summary.test/v1');
  assert.equal(main.key, 'MAIN_KEY', '跟随分析时 Key 留空必须保留实际主配置原值');
  assert.deepEqual(analysisUpdates, [], '通过跟随摘要保存共享目标不得改分析选择');

  const saveCountBeforePrompt = saves.length;
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
