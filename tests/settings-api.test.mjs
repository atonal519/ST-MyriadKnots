import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSettingsStore } from '../src/settings.js';
import { createApiResolver, createApiTools, createPeopleTaskRouter } from '../src/api-routing.js';
import { generateTask as hostGenerateTask } from '../../../../generate-task.js';

const configured = (name, id, key = 'TEST_KEY') => ({ id, name, url: 'https://api.example.test/v1', key, model: 'test-model', excludeParams: [], timeoutSec: 30, stream: false });
const setup = extensionSettings => {
  let saves = 0;
  const settings = createSettingsStore({ extensionSettings, save: () => { saves += 1; }, now: () => 1, random: () => 0.5 });
  return { settings, saves: () => saves };
};

test('旧本地 API 只做一次幂等非破坏迁移，共享段既有值优先', () => {
  const extensionSettings = { qianqianjie: { pluginEnabled: false, apiMode: 'local', apiUrl: 'legacy-url', apiKey: 'LEGACY_KEY', apiModel: 'legacy-model', apiPresets: [configured('旧预设', 'legacy')], apiPresetActiveId: 'legacy' }, 'schedule-planner': { apiKey: 'SHARED_KEY', unknownTop: { keep: true } } };
  const { settings, saves } = setup(extensionSettings); const current = settings.get();
  assert.equal(settings.migrateLegacyApiSettings(), true); assert.equal(settings.migrateLegacyApiSettings(), false);
  assert.equal(extensionSettings['schedule-planner'].apiKey, 'SHARED_KEY'); assert.equal(extensionSettings['schedule-planner'].apiUrl, 'legacy-url'); assert.deepEqual(extensionSettings['schedule-planner'].unknownTop, { keep: true });
  assert.equal(settings.sharedPresets()[0].id, 'legacy'); assert.equal(current.apiMode, 'seven-preset'); assert.equal(current.selectedSevenDaysPresetId, 'legacy'); assert.equal(saves(), 1);
});

test('主配置与显式预设都从共享真源即时解析；失效预设不回退主配置', async () => {
  const utility = configured('机械', 'utility'), selected = configured('人物', 'people'), unavailable = configured('不可用', 'unavailable', '');
  selected.excludeParams = ['temperature']; selected.timeoutSec = 45; selected.stream = true;
  const extensionSettings = { 'schedule-planner': { utilityPresetId: utility.id, apiPresets: [utility, selected, unavailable], apiUrl: 'https://main.example.test/v1', apiKey: 'MAIN_KEY', apiModel: 'main-model', apiExcludeParams: ['seed'], apiTimeoutSec: 60, apiStream: true } };
  const { settings } = setup(extensionSettings), resolver = createApiResolver({ settings });
  assert.deepEqual(resolver.resolve().config, { id: '', name: '主配置', url: 'https://main.example.test/v1', key: 'MAIN_KEY', model: 'main-model', excludeParams: ['seed'], timeoutSec: 60, stream: true });
  assert.deepEqual(resolver.describeSevenDaysPresets().find(item => item.id === 'people'), selected);
  settings.update({ apiMode: 'seven-preset', selectedSevenDaysPresetId: selected.id });
  const exact = resolver.resolve(); assert.equal(exact.source, 'shared-preset'); assert.equal(exact.config.model, 'test-model'); assert.deepEqual(exact.config.excludeParams, ['temperature']); assert.equal(exact.config.stream, true);
  assert.equal(settings.get().selectedSevenDaysPresetId, selected.id); assert.equal(settings.get().apiKey, '');
  extensionSettings['schedule-planner'].apiPresets = extensionSettings['schedule-planner'].apiPresets.filter(item => item.id !== selected.id);
  assert.equal(resolver.resolve().kind, 'unavailable'); assert.equal(resolver.resolve().reason, 'preset_missing');
  let calls = 0; const client = { generateTask: async () => { calls += 1; }, testConnection: async () => { calls += 1; }, fetchModels: async () => { calls += 1; } };
  const router = createPeopleTaskRouter({ resolver, compactClient: client }), tools = createApiTools({ resolver, compactClient: client });
  await assert.rejects(router.generatePeopleTask({}), error => error.code === 'QQJ_PRESET_INVALID'); await assert.rejects(tools.testConnection(), error => error.code === 'QQJ_PRESET_INVALID'); await assert.rejects(tools.fetchModels(), error => error.code === 'QQJ_PRESET_INVALID');
  assert.equal(calls, 0); assert.equal(settings.get().selectedSevenDaysPresetId, selected.id);
});

test('双向共享真实 schedule-planner 形状，按 id 写入保留未知字段和其他预设', async () => {
  const keep = { ...configured('保留', 'keep'), vendor: { nested: true } };
  const target = { ...configured('待改', 'target'), targetUnknown: 'KEEP_ME' };
  const extensionSettings = { 'schedule-planner': { apiUrl: 'https://main.old/v1', apiKey: 'OLD', apiModel: 'old', apiPresets: [keep, target], unknownTop: { keep: true } } };
  const { settings } = setup(extensionSettings);
  settings.saveSharedMainConfig({ url: 'https://main.new/v1', key: 'NEW_KEY', model: 'new-model', excludeParams: ['temperature'], timeoutSec: 75, stream: true });
  settings.upsertSharedPreset('待改', { url: 'https://target.new/v1', key: 'TARGET_KEY', model: 'target-model', excludeParams: ['seed'], timeoutSec: 55, stream: true }, 'target');
  assert.deepEqual(extensionSettings['schedule-planner'].unknownTop, { keep: true }); assert.deepEqual(extensionSettings['schedule-planner'].apiPresets[0], keep); assert.equal(extensionSettings['schedule-planner'].apiPresets[1].targetUnknown, 'KEEP_ME');

  const source = await readFile(new URL('../../ST-SevenDaysCal/runtime/settings.js', import.meta.url), 'utf8');
  globalThis.__QQJ_SEVEN_TEST_SETTINGS__ = extensionSettings; globalThis.__QQJ_SEVEN_TEST_SAVES__ = 0;
  const executable = source
    .replace("import { extension_settings } from '../../../../extensions.js';", 'const extension_settings = globalThis.__QQJ_SEVEN_TEST_SETTINGS__;')
    .replace("import { saveSettingsDebounced } from '../../../../../script.js';", 'const saveSettingsDebounced = () => { globalThis.__QQJ_SEVEN_TEST_SAVES__ += 1; };');
  const seven = await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);
  assert.deepEqual(seven.loadCfg(), { url: 'https://main.new/v1', key: 'NEW_KEY', model: 'new-model', excludeParams: ['temperature'], timeoutSec: 75, stream: true });
  assert.deepEqual(seven.loadApiPresets().find(item => item.id === 'target'), extensionSettings['schedule-planner'].apiPresets[1]);
  seven.upsertApiPreset('构画侧已改', { url: 'https://seven.changed/v1', key: 'SEVEN_KEY', model: 'seven-model', excludeParams: ['top_p'], timeoutSec: 88, stream: false }, 'target');
  assert.deepEqual(settings.sharedPresets().find(item => item.id === 'target'), { id: 'target', name: '构画侧已改', url: 'https://seven.changed/v1', key: 'SEVEN_KEY', model: 'seven-model', excludeParams: ['top_p'], timeoutSec: 88, stream: false, targetUnknown: 'KEEP_ME' });
  settings.renameSharedPreset('target', '千千结改名'); assert.equal(seven.loadApiPresets().find(item => item.id === 'target').name, '千千结改名');
  settings.deleteSharedPreset('target'); assert.equal(seven.loadApiPresets().some(item => item.id === 'target'), false); assert.deepEqual(seven.loadApiPresets()[0], keep);
  delete globalThis.__QQJ_SEVEN_TEST_SETTINGS__; delete globalThis.__QQJ_SEVEN_TEST_SAVES__;
});

test('人物任务路由冻结本次配置，下一次才读取变化且在途可中止', async () => {
  let current = configured('一', 'one', 'KEY_ONE'), release; const calls = [];
  const resolver = { resolve: () => ({ kind: 'independent', source: 'local', config: { ...current } }) };
  const compactClient = { generateTask: async options => { calls.push(options); await new Promise(resolve => { release = resolve; }); if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError'); return { jsonData: {} }; } };
  const router = createPeopleTaskRouter({ resolver, compactClient });
  const pending = router.generatePeopleTask({ taskMessages: [{ role: 'user', content: 'frozen' }] });
  await new Promise(resolve => setImmediate(resolve)); current = configured('二', 'two', 'KEY_TWO');
  assert.equal(calls[0].config.key, 'KEY_ONE'); router.abortAll(); release(); await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(router.getActiveCount(), 0);
  compactClient.generateTask = async options => { calls.push(options); return { jsonData: {} }; };
  await router.generatePeopleTask({}); assert.equal(calls[1].config.key, 'KEY_TWO');
});

test('test、models 与人物任务从同一共享预设解析同一套完整配置', async () => {
  const preset = { ...configured('共同预设', 'shared'), excludeParams: ['temperature'], timeoutSec: 77, stream: true };
  const extensionSettings = { qianqianjie: { apiMode: 'seven-preset', selectedSevenDaysPresetId: 'shared' }, 'schedule-planner': { apiPresets: [preset] } };
  const { settings } = setup(extensionSettings), resolver = createApiResolver({ settings }), seen = [];
  const compactClient = {
    generateTask: async ({ config }) => { seen.push(['task', config]); return { jsonData: { ok: true } }; },
    testConnection: async ({ config }) => { seen.push(['test', config]); return { ok: true }; },
    fetchModels: async ({ config }) => { seen.push(['models', config]); return ['test-model']; },
  };
  const router = createPeopleTaskRouter({ resolver, compactClient }), tools = createApiTools({ resolver, compactClient });
  await router.generatePeopleTask({}); await tools.testConnection(); await tools.fetchModels();
  assert.deepEqual(seen.map(([kind, config]) => [kind, config]), [['task', preset], ['test', preset], ['models', preset]]);
});

test('兼容酒馆 fallback 仍使用真实 abortSignal；共享 API 工具描述与调用读取同一完整对象', async () => {
  let seenSignal; const injected = {
    profileResolver: () => ({ requestApi: 'openai', apiSettingsOverride: null }), worldInfoResolver: async () => ({ worldInfoBeforeEntries: [], worldInfoAfterEntries: [] }),
    builder: ({ messages }) => messages, rawPromptBuilder: messages => messages.map(item => item.content).join('\n'), substituteParams: value => value,
    senders: { sendOpenAIRequest: async (_type, _payload, abortSignal) => { seenSignal = abortSignal; await new Promise((_, reject) => abortSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); } },
  };
  const router = createPeopleTaskRouter({ resolver: { resolve: () => ({ kind: 'tavern' }) }, compactClient: { generateTask() {} }, fallbackGenerateTask: options => hostGenerateTask(options, { _injected: injected }) });
  const fallback = router.generatePeopleTask({ taskMessages: [] }); await new Promise(resolve => setImmediate(resolve)); assert.equal(seenSignal instanceof AbortSignal, true); router.abortAll(); assert.equal(seenSignal.aborted, true); await assert.rejects(fallback, error => error.name === 'AbortError');
  const extensionSettings = { 'schedule-planner': { apiUrl: 'https://main.example.test/v1', apiKey: 'INHERITED_KEY', apiModel: 'model' } };
  const { settings } = setup(extensionSettings), resolver = createApiResolver({ settings }); let testedKey = '';
  const tools = createApiTools({ resolver, compactClient: { testConnection: async ({ config }) => { testedKey = config.key; return { ok: true }; }, fetchModels: async () => ['model'] } });
  const description = tools.describe(); assert.equal(description.source, 'shared-main'); assert.equal(Object.hasOwn(description, 'config'), false);
  await tools.testConnection({ apiMode: 'auto' }); assert.equal(testedKey, 'INHERITED_KEY'); assert.equal(settings.get().apiKey, '');
});

test('调用方 external signal 可中止统一人物/关系任务路由', async () => {
  let seenSignal; const compactClient = { generateTask: async options => { seenSignal = options.signal; await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); } };
  const router = createPeopleTaskRouter({ resolver: { resolve: () => ({ kind: 'independent', config: { url: 'x', key: 'y' } }) }, compactClient });
  const controller = new AbortController(), pending = router.generatePeopleTask({ signal: controller.signal, systemPrompt: 'relation' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(seenSignal instanceof AbortSignal, true); controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(router.getActiveCount(), 0);
});

test('人物任务结果与错误只附带有界 API 来源/模型元数据，tavern 不伪造模型', async () => {
  const independent = createPeopleTaskRouter({
    resolver: { resolve: () => ({ kind: 'independent', source: 'seven-utility', sourceLabel: '构画机械预设 · G3.5F', config: { url: 'https://SECRET.example', key: 'SECRET_KEY', model: 'gemini-3-flash-preview' } }) },
    compactClient: { generateTask: async () => ({ jsonData: { ok: true }, taskMetadata: { finishReason: 'stop' } }) },
  });
  const result = await independent.generatePeopleTask({});
  assert.deepEqual(result.taskMetadata, { source: 'seven-utility', sourceLabel: '构画机械预设 · G3.5F', model: 'gemini-3-flash-preview', finishReason: 'stop' });
  assert.doesNotMatch(JSON.stringify(result.taskMetadata), /SECRET|https?:\/\//i);
  const failed = createPeopleTaskRouter({
    resolver: { resolve: () => ({ kind: 'independent', source: 'local', sourceLabel: '本地', config: { url: 'SECRET_URL', key: 'SECRET_KEY', model: 'safe-model' } }) },
    compactClient: { generateTask: async () => { const error = new Error('安全失败'); error.code = 'QQJ_COMPLETION_JSON'; error.formatStage = 'completion_json'; throw error; } },
  });
  await assert.rejects(failed.generatePeopleTask({}), error => error.taskMetadata?.source === 'local' && error.taskMetadata?.model === 'safe-model' && !JSON.stringify(error.taskMetadata).includes('SECRET'));
  const tavern = createPeopleTaskRouter({ resolver: { resolve: () => ({ kind: 'tavern', source: 'tavern', sourceLabel: '酒馆当前模型', config: null }) }, compactClient: { generateTask() {} }, fallbackGenerateTask: async () => ({ schemaVersion: 1, patches: [] }) });
  const fallback = await tavern.generatePeopleTask({});
  assert.equal(fallback.taskMetadata.source, 'tavern'); assert.equal(fallback.taskMetadata.model, 'current'); assert.deepEqual(fallback.jsonData, { schemaVersion: 1, patches: [] });
});

test('关闭态测试/模型列表零启动，在途两类工具统一 abortAll 且迟到结果不可成功', async () => {
  let enabled = false, testCalls = 0, modelCalls = 0, testRelease, modelRelease;
  const resolver = { resolve: () => ({ kind: 'independent', config: configured('x', 'x') }), describe: () => ({}) };
  const compactClient = {
    testConnection: async ({ signal }) => { testCalls += 1; await new Promise(resolve => { testRelease = resolve; }); if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); return { ok: true }; },
    fetchModels: async ({ signal }) => { modelCalls += 1; await new Promise(resolve => { modelRelease = resolve; }); if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); return ['x']; },
  };
  const tools = createApiTools({ resolver, compactClient, isEnabled: () => enabled });
  await assert.rejects(tools.testConnection(), error => error.code === 'QQJ_DISABLED'); await assert.rejects(tools.fetchModels(), error => error.code === 'QQJ_DISABLED'); assert.equal(testCalls + modelCalls, 0);
  enabled = true; const testing = tools.testConnection(), listing = tools.fetchModels(); await new Promise(resolve => setImmediate(resolve)); assert.equal(tools.getActiveCount(), 2);
  enabled = false; tools.abortAll(); testRelease(); modelRelease(); await assert.rejects(testing, error => error.name === 'AbortError'); await assert.rejects(listing, error => error.name === 'AbortError'); assert.equal(tools.getActiveCount(), 0);
});

test('副 API getter/setter 即时读写共享字段，snapshot、删除清悬空与未知字段均保留', () => {
  const utility = { ...configured('机械', 'utility'), vendor: { keep: true } };
  const keep = { ...configured('保留', 'keep'), custom: 'KEEP' };
  const extensionSettings = { 'schedule-planner': { utilityPresetId: '  utility  ', apiPresets: [utility, keep], unknownTop: { nested: true } } };
  const { settings, saves } = setup(extensionSettings);
  assert.equal(settings.sharedUtilityPresetId(), 'utility');
  assert.equal(saves(), 0);
  const before = settings.sharedSnapshotKey();
  settings.setSharedUtilityPresetId(' keep ');
  assert.equal(settings.sharedUtilityPresetId(), 'keep');
  assert.notEqual(settings.sharedSnapshotKey(), before);
  assert.equal(JSON.parse(settings.sharedSnapshotKey()).utilityPresetId, 'keep');
  assert.deepEqual(extensionSettings['schedule-planner'].unknownTop, { nested: true });
  assert.deepEqual(extensionSettings['schedule-planner'].apiPresets[0].vendor, { keep: true });
  assert.equal(saves(), 1);
  settings.deleteSharedPreset('keep');
  assert.equal(settings.sharedUtilityPresetId(), '');
  assert.deepEqual(extensionSettings['schedule-planner'].apiPresets[0], utility);
  assert.deepEqual(extensionSettings['schedule-planner'].unknownTop, { nested: true });

  const rawUtility = { ...configured('原始机械', 'raw-utility'), vendor: { untouched: true } };
  const rawKeep = { ...configured('原始保留', 'raw-keep'), extra: { untouched: true } };
  const rawExtensionSettings = { 'schedule-planner': {
    utilityPresetId: '  raw-utility  ', apiPresets: [rawUtility, rawKeep], unknownTop: { untouched: true },
  } };
  const raw = setup(rawExtensionSettings);
  assert.equal(raw.settings.deleteSharedPreset('raw-utility'), true);
  assert.equal(rawExtensionSettings['schedule-planner'].utilityPresetId, '');
  assert.deepEqual(rawExtensionSettings['schedule-planner'].apiPresets, [rawKeep]);
  assert.deepEqual(rawExtensionSettings['schedule-planner'].unknownTop, { untouched: true });
  assert.equal(raw.saves(), 1);
});

test('有效副 API 精确走机械预设，人物任务仍走当前人物预设且元数据不泄密', async () => {
  const utility = { ...configured('机械预设', 'utility', 'UTILITY_SECRET'), model: 'utility-model' };
  const people = { ...configured('人物预设', 'people', 'PEOPLE_SECRET'), model: 'people-model' };
  const extensionSettings = {
    qianqianjie: { apiMode: 'seven-preset', selectedSevenDaysPresetId: 'people' },
    'schedule-planner': { utilityPresetId: 'utility', apiPresets: [utility, people] },
  };
  const { settings } = setup(extensionSettings);
  const resolver = createApiResolver({ settings });
  const seen = [];
  const router = createPeopleTaskRouter({
    resolver,
    compactClient: { generateTask: async options => { seen.push(options); return { jsonData: { ok: true } }; } },
  });
  const utilityResult = await router.generateUtilityTask({ taskMessages: [] });
  const peopleResult = await router.generatePeopleTask({ taskMessages: [] });
  assert.equal(seen[0].config.key, 'UTILITY_SECRET');
  assert.equal(seen[1].config.key, 'PEOPLE_SECRET');
  assert.equal(Object.isFrozen(seen[0].config), true);
  assert.deepEqual(utilityResult.taskMetadata, { source: 'shared-utility', sourceLabel: '机械预设', model: 'utility-model' });
  assert.equal(peopleResult.taskMetadata.source, 'shared-preset');
  assert.doesNotMatch(JSON.stringify([utilityResult.taskMetadata, peopleResult.taskMetadata]), /SECRET|https?:\/\//);
});

test('副 API 空、悬空或缺 Key 均即时回退当前主路由且不修复共享设置', async () => {
  for (const utilityPresetId of ['', 'gone', 'incomplete']) {
    const incomplete = configured('缺 Key', 'incomplete', '');
    const extensionSettings = { 'schedule-planner': {
      utilityPresetId,
      apiPresets: [incomplete],
      apiUrl: 'https://main.example.test/v1', apiKey: 'MAIN_SECRET', apiModel: 'main-model',
    } };
    const { settings, saves } = setup(extensionSettings);
    const seen = [];
    const router = createPeopleTaskRouter({
      resolver: createApiResolver({ settings }),
      compactClient: { generateTask: async options => { seen.push(options); return { jsonData: {} }; } },
    });
    const result = await router.generateUtilityTask({});
    assert.equal(seen[0].config.key, 'MAIN_SECRET');
    assert.equal(result.taskMetadata.source, 'shared-main');
    assert.equal(extensionSettings['schedule-planner'].utilityPresetId, utilityPresetId);
    assert.equal(saves(), 0);
  }

  const people = configured('人物预设', 'people', 'PEOPLE_FALLBACK_KEY');
  const selectedSettings = {
    qianqianjie: { apiMode: 'seven-preset', selectedSevenDaysPresetId: 'people' },
    'schedule-planner': { utilityPresetId: 'gone', apiPresets: [people], unknownTop: { keep: true } },
  };
  const selected = setup(selectedSettings);
  const seen = [];
  const router = createPeopleTaskRouter({
    resolver: createApiResolver({ settings: selected.settings }),
    compactClient: { generateTask: async options => { seen.push(options); return { jsonData: {} }; } },
  });
  const result = await router.generateUtilityTask({});
  assert.equal(seen[0].config.key, 'PEOPLE_FALLBACK_KEY');
  assert.equal(result.taskMetadata.source, 'shared-preset');
  assert.equal(selectedSettings['schedule-planner'].utilityPresetId, 'gone');
  assert.deepEqual(selectedSettings['schedule-planner'].unknownTop, { keep: true });
  assert.equal(selected.saves(), 0);
});

test('副 API 与主路由都不可用时零 client；人物与副任务共享 active/epoch/abortAll 且配置按调用冻结', async () => {
  const invalidSettings = setup({ 'schedule-planner': { utilityPresetId: 'bad', apiPresets: [configured('坏机械', 'bad', '')] } }).settings;
  let invalidCalls = 0;
  const invalidRouter = createPeopleTaskRouter({
    resolver: createApiResolver({ settings: invalidSettings }),
    compactClient: { generateTask: async () => { invalidCalls += 1; } },
  });
  await assert.rejects(invalidRouter.generateUtilityTask({}), error => error.code === 'QQJ_CONFIG');
  assert.equal(invalidCalls, 0);

  const utility = configured('机械', 'utility', 'UTILITY_ONE');
  const people = configured('人物', 'people', 'PEOPLE_ONE');
  const extensionSettings = {
    qianqianjie: { apiMode: 'seven-preset', selectedSevenDaysPresetId: 'people' },
    'schedule-planner': { utilityPresetId: 'utility', apiPresets: [utility, people] },
  };
  const { settings } = setup(extensionSettings);
  const calls = [];
  const releases = [];
  const router = createPeopleTaskRouter({
    resolver: createApiResolver({ settings }),
    compactClient: { generateTask: options => new Promise((resolve, reject) => {
      calls.push(options);
      releases.push(() => options.signal.aborted ? reject(new DOMException('Aborted', 'AbortError')) : resolve({ jsonData: {} }));
    }) },
  });
  const utilityPending = router.generateUtilityTask({});
  const peoplePending = router.generatePeopleTask({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(router.getActiveCount(), 2);
  extensionSettings['schedule-planner'].apiPresets[0].key = 'UTILITY_TWO';
  assert.equal(calls[0].config.key, 'UTILITY_ONE');
  assert.equal(Object.isFrozen(calls[0].config), true);
  router.abortAll();
  releases.forEach(release => release());
  await assert.rejects(utilityPending, error => error.name === 'AbortError');
  await assert.rejects(peoplePending, error => error.name === 'AbortError');
  assert.equal(router.getActiveCount(), 0);
  const next = [];
  const nextRouter = createPeopleTaskRouter({
    resolver: createApiResolver({ settings }),
    compactClient: { generateTask: async options => { next.push(options.config.key); return { jsonData: {} }; } },
  });
  await nextRouter.generateUtilityTask({});
  assert.deepEqual(next, ['UTILITY_TWO']);
});

test('副任务沿用统一 disabled 与 external signal 守卫', async () => {
  let enabled = false;
  let calls = 0;
  let seenSignal;
  const router = createPeopleTaskRouter({
    resolver: {
      resolve: () => ({ kind: 'independent', source: 'shared-main', config: configured('主', 'main') }),
      resolveUtility: () => ({ kind: 'independent', source: 'shared-utility', config: configured('机械', 'utility') }),
    },
    compactClient: { generateTask: async options => {
      calls += 1;
      seenSignal = options.signal;
      await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    } },
    isEnabled: () => enabled,
  });
  await assert.rejects(router.generateUtilityTask({}), error => error.code === 'QQJ_DISABLED');
  assert.equal(calls, 0);
  enabled = true;
  const controller = new AbortController();
  const pending = router.generateUtilityTask({ signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seenSignal instanceof AbortSignal, true);
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(calls, 1);
  assert.equal(router.getActiveCount(), 0);
});
