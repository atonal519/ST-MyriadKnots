import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptsSettings } from '../src/ui/settings/prompts-settings.js';
import { createMemorySettings } from '../src/ui/settings/memory-settings.js';
import { createAppearanceSettings } from '../src/ui/settings/appearance-settings.js';
import { createApiSettings } from '../src/ui/settings/api-settings.js';

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
  const settings = { get: () => ({ sourceKeepTags: 'content', sourceExtraTags: '', generalPrompt: '' }), update: patch => { patches.push(patch); return patch; } };
  const { node } = createPromptsSettings({ settings, documentRef });
  const keep = fieldControl(node, '保留正文的包裹符');
  keep.value = 'content,summary'; keep.fire('change');
  assert.deepEqual(patches.at(-1), { sourceKeepTags: 'content,summary' });
});

test('记忆模块只存周期数并触发自动化刷新', async () => {
  const patches = []; let refreshed = 0;
  const store = { autoMemoryBatchSize: 2 };
  const settings = { get: () => ({ ...store }), update: patch => { Object.assign(store, patch); patches.push(patch); return { ...store }; } };
  const { node } = createMemorySettings({ settings, documentRef, onAutomationChange: async () => { refreshed += 1; } });
  const batch = fieldControl(node, '每 N 楼提取一次记忆');
  assert.equal(batch.value, '2');
  batch.value = '5'; await batch.fire('change'); await flush();
  assert.deepEqual(patches.at(-1), { autoMemoryBatchSize: 5 });
  assert.equal(refreshed, 1);
  assert.equal(node.find(n => n.type === 'checkbox'), undefined);
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

test('API 模块：拉取模型接线、无清除Key、保存写预设', async () => {
  const settings = {
    get: () => ({ apiMode: 'auto', selectedSevenDaysPresetId: '' }),
    sharedMainConfig: () => ({ url: 'https://a.test/v1', key: 'K', model: 'm', excludeParams: [], timeoutSec: 180, stream: false }),
    sharedPresets: () => [],
    sharedUtilityPresetId: () => '',
    setSharedUtilityPresetId: () => {},
    saveSharedMainConfig: config => { settings._saved = config; },
    upsertSharedPreset: () => 'pid',
    update: () => {},
  };
  const fetched = [];
  const apiTools = { fetchModels: async selection => { fetched.push(selection); return ['gpt-x', 'gpt-y']; }, testConnection: async () => ({ model: 'm' }) };
  const { node } = createApiSettings({ settings, apiTools, documentRef });
  assert.equal(node.find(n => n.tagName === 'button' && n.textContent === '清除 Key'), undefined);
  assert.ok(node.find(n => n.tagName === 'label' && n.children[0]?.textContent === '分析API（建议高质模型）'));
  assert.ok(node.find(n => n.tagName === 'label' && n.children[0]?.textContent === '摘要API（建议快速模型）'));
  const fetchBtn = node.find(n => n.tagName === 'button' && n.textContent === '拉取模型');
  await fetchBtn.fire('click'); await flush();
  assert.equal(fetched.length, 1);
  const datalist = node.find(n => n.tagName === 'datalist');
  assert.deepEqual(datalist.children.map(option => option.value), ['gpt-x', 'gpt-y']);
  const save = node.find(n => n.tagName === 'button' && n.textContent === '保存设置');
  await save.fire('click');
  assert.ok(settings._saved);
});
