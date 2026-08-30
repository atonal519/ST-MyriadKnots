import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore } from '../src/settings.js';
import { createApiResolver, createApiTools, createPeopleTaskRouter } from '../src/api-routing.js';
import { generateTask as hostGenerateTask } from '../../../../generate-task.js';

const configured = (name, id, key = 'TEST_KEY') => ({ id, name, url: 'https://api.example.test/v1', key, model: 'test-model', excludeParams: [], timeoutSec: 30, stream: false });
const setup = extensionSettings => {
  let saves = 0;
  const settings = createSettingsStore({ extensionSettings, save: () => { saves += 1; }, now: () => 1, random: () => 0.5 });
  return { settings, saves: () => saves };
};

test('旧设置只补缺省且构画配置永不复制到千千结段', () => {
  const extensionSettings = { qianqianjie: { pluginEnabled: false, apiMode: 'auto', apiUrl: 'local-url' }, 'schedule-planner': { apiKey: 'INHERITED_KEY' } };
  const { settings } = setup(extensionSettings); const current = settings.get();
  assert.equal(current.pluginEnabled, false); assert.equal(current.apiUrl, 'local-url'); assert.equal(current.apiKey, '');
  settings.sevenDaysSettings(); assert.equal(extensionSettings.qianqianjie.apiKey, ''); assert.equal(JSON.stringify(extensionSettings.qianqianjie).includes('INHERITED_KEY'), false);
});

test('千千结直接使用 schedule-planner 主 API 与共享预设池', () => {
  const utility = configured('机械', 'utility'), selected = configured('人物', 'people');
  const extensionSettings = { 'schedule-planner': { utilityPresetId: utility.id, apiPresets: [utility, selected], apiUrl: 'https://main.example.test/v1', apiKey: 'MAIN_KEY', apiModel: 'main-model' } };
  const { settings } = setup(extensionSettings), resolver = createApiResolver({ settings });
  assert.equal(resolver.resolve().source, 'shared-api'); assert.equal(resolver.resolve().config.model, 'main-model');
  assert.deepEqual(settings.presets().map(item => item.id), ['utility', 'people']);
  settings.update({ apiModel: 'shared-model' }); assert.equal(extensionSettings['schedule-planner'].apiModel, 'shared-model');
  settings.upsertPreset('人物更新', { ...selected, model: 'shared-preset-model' }, selected.id);
  assert.equal(extensionSettings['schedule-planner'].apiPresets.find(item => item.id === selected.id).model, 'shared-preset-model');
  assert.equal(settings.get().apiKey, '');
});

test('构画未安装时仍创建共享 API 池，填写后构画可直接读取', () => {
  const extensionSettings = {}; const { settings, saves } = setup(extensionSettings), resolver = createApiResolver({ settings });
  assert.equal(resolver.resolve().source, 'tavern');
  settings.update({ apiUrl: 'https://shared.example.test/v1', apiKey: 'SHARED_KEY', apiModel: 'shared-model' });
  const id = settings.upsertPreset('共享', configured('共享', 'ignored', 'SHARED_KEY'));
  assert.equal(resolver.resolve().source, 'shared-api'); assert.equal(extensionSettings['schedule-planner'].apiKey, 'SHARED_KEY');
  assert.equal(extensionSettings['schedule-planner'].apiPresets[0].id, id); assert.ok(saves() >= 2);
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

test('酒馆 fallback 使用真实 abortSignal 合同，API 工具使用共享配置但不暴露 key 描述', async () => {
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
  const description = tools.describe(); assert.equal(description.source, 'shared-api'); assert.equal(Object.hasOwn(description, 'config'), false); assert.equal(JSON.stringify(description).includes('INHERITED_KEY'), false);
  await tools.testConnection(); assert.equal(testedKey, 'INHERITED_KEY'); assert.equal(settings.get().apiKey, '');
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
