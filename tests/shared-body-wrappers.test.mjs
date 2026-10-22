import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemoryTagList, sanitizeMemoryContent } from '../src/memory-content-sanitizer.js';
import { createSettingsStore } from '../src/settings.js';

test('共用正文保XML内层，明确字面清洗块整块删除且保留优先', () => {
  for (const [raw, options, expected] of [
    ['前<!--draft-->草稿<content>不应救回</content><!--/draft-->后', { extraTags: '<!--draft-->...<!--/draft-->' }, '前后'],
    ['前<!--<content>注释</content>-->后', {}, '前后'],
    ['前<br>后', {}, '前后'],
    ['<think>噪音<content>正文</content></think>', { extraTags: 'think' }, '正文'],
    ['前[[草稿<content>不应救回</content>]]后', { extraTags: '[[...]]' }, '前后'],
    ['前[DRAFT]草稿<content>不应救回</content>[/draft]后', { extraTags: '[DRAFT]...[/DRAFT]' }, '前后'],
    ['前开始草稿<content>不应救回</content>结束后', { extraTags: '开始...结束' }, '前后'],
    ['前[DRAFT]正文[/draft]后', { keepTags: '[DRAFT]...[/DRAFT]', extraTags: '[draft]...[/draft]' }, '前正文后'],
    ['<think>前开始正文结束后</think>', { keepTags: '开始...结束', extraTags: '开始...结束,think' }, '正文'],
    ['前<正文 属性="值">内容</正文>后', { keepTags: '<正文>' }, '前内容后'],
    ['<段~甲>正文</段~甲>', { keepTags: '段~甲' }, '正文'],
    ['<e\u0301tage>正文</e\u0301tage>', { keepTags: 'e\u0301tage' }, '正文'],
    ['前[DRAFT]未闭合<content>正文</content>', { extraTags: '[draft]...[/draft]' }, '前[DRAFT]未闭合正文'],
  ]) assert.equal(sanitizeMemoryContent(raw, options), expected, raw);
  assert.deepEqual(normalizeMemoryTagList('CONTENT，<正文>\n段~甲,[DRAFT]...[/draft],开始...结束,content'), ['content','正文','段~甲','[draft]...[/draft]','开始...结束']);
});

test('首次共享归并在默认补齐前读own字段，后续空值和删项不回灌旧值', () => {
  const ext = { qianqianjie: { sourceKeepTags: '', sourceExtraTags: 'think,开始...结束' }, 'schedule-planner': { extraTags: '[DRAFT]...[/DRAFT],think', apiPresets: [{ id: 'keep-api' }] } };
  const settings = createSettingsStore({ extensionSettings: ext, save() {} });
  assert.deepEqual(settings.wrappers?.(), { keepTags: '', extraTags: 'think,开始...结束,[draft]...[/draft]' });
  settings.updateWrappers({ extraTags: '' });
  ext.qianqianjie.sourceKeepTags = '不得回灌'; ext['schedule-planner'].extraTags = '不得回灌';
  assert.deepEqual(settings.wrappers(), { keepTags: '', extraTags: '' });
  settings.updateWrappers({ keepTags: 'content' });
  assert.deepEqual(settings.wrappers(), { keepTags: 'content', extraTags: '' });
  assert.equal(ext['schedule-planner'].apiPresets[0].id, 'keep-api');
  const empty = createSettingsStore({ extensionSettings: {}, save() {} });
  assert.deepEqual(empty.wrappers(), { keepTags: 'content', extraTags: '' });
});
