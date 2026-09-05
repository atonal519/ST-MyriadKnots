import { normalizePreset } from './settings.js';

const validConfig = config => Boolean(config?.url && config?.key);
const sevenDaysPresets = value => Array.isArray(value?.apiPresets) ? value.apiPresets.map(item => item && typeof item === 'object' ? { ...item, ...normalizePreset(item) } : null).filter(item => item?.id) : [];
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
const disabledError = () => { const error = new Error('千千结已关闭'); error.code = 'QQJ_DISABLED'; return error; };
const unavailableError = route => {
  const error = new Error(route?.reason === 'preset_missing' ? '所选 API 预设已失效，请重新选择或保存' : '共享 API 主配置不完整，请先保存 URL 和 Key');
  error.code = route?.reason === 'preset_missing' ? 'QQJ_PRESET_INVALID' : 'QQJ_CONFIG';
  return error;
};
const bounded = (value, length, fallback = '') => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length) || fallback;
const taskMetadata = (route, finishReason = '', transportAttempts = null) => ({
  source: bounded(route?.source, 80, 'unknown'),
  sourceLabel: bounded(route?.sourceLabel, 160, '未命名 API'),
  model: bounded(route?.config?.model, 160, 'unknown'),
  ...(finishReason ? { finishReason: bounded(finishReason, 32) } : {}),
  ...(Number.isSafeInteger(transportAttempts) ? { transportAttempts } : {}),
});
const withTaskMetadata = (result, route) => {
  const finishReason = result?.taskMetadata?.finishReason || result?.finishReason;
  const metadata = taskMetadata(route, finishReason, result?.taskMetadata?.transportAttempts);
  if (result && typeof result === 'object' && !Array.isArray(result) && (Object.hasOwn(result, 'jsonData') || Object.hasOwn(result, 'textData'))) return { ...result, taskMetadata: metadata };
  return { jsonData: result, taskMetadata: metadata };
};

export function createApiResolver({ settings } = {}) {
  if (!settings?.get || !settings?.sevenDaysSettings) throw new Error('API 配置解析器依赖不可用');
  const describeSevenDaysPresets = () => sevenDaysPresets(settings.sevenDaysSettings()).map(({ id, name, url, key, model, excludeParams, timeoutSec, stream }) => ({ id, name, url, key, model, excludeParams, timeoutSec, stream }));
  const resolveAuto = () => {
    const seven = settings.sevenDaysSettings();
    const main = normalizePreset({
      name: '主配置', url: seven?.apiUrl, key: seven?.apiKey, model: seven?.apiModel,
      excludeParams: seven?.apiExcludeParams, timeoutSec: seven?.apiTimeoutSec, stream: seven?.apiStream,
    });
    if (validConfig(main)) return { kind: 'independent', source: 'shared-main', sourceLabel: '主配置', config: main };
    return { kind: 'unavailable', source: 'shared-main', sourceLabel: '主配置', config: null, reason: 'main_incomplete' };
  };
  const resolve = (override = null) => {
    const current = settings.get();
    const mode = override?.apiMode || current.apiMode;
    const selectedSevenDaysPresetId = override?.selectedSevenDaysPresetId ?? current.selectedSevenDaysPresetId;
    if (mode === 'seven-preset') {
      const preset = sevenDaysPresets(settings.sevenDaysSettings()).find(item => item.id === selectedSevenDaysPresetId);
      if (preset && validConfig(preset)) return { kind: 'independent', source: 'shared-preset', sourceLabel: preset.name, config: { ...preset } };
      return { kind: 'unavailable', source: 'shared-preset', sourceLabel: preset?.name || '失效预设', config: null, reason: 'preset_missing', selectedPresetId: selectedSevenDaysPresetId };
    }
    return resolveAuto();
  };
  const resolveUtility = () => {
    const utilityPresetId = typeof settings.sharedUtilityPresetId === 'function'
      ? settings.sharedUtilityPresetId()
      : String(settings.sevenDaysSettings()?.utilityPresetId ?? '').trim();
    const preset = utilityPresetId
      ? sevenDaysPresets(settings.sevenDaysSettings()).find(item => item.id === utilityPresetId)
      : null;
    if (preset && validConfig(preset)) {
      const config = Object.freeze({ ...preset, excludeParams: Object.freeze([...preset.excludeParams]) });
      return Object.freeze({ kind: 'independent', source: 'shared-utility', sourceLabel: preset.name, config });
    }
    return resolve();
  };
  const describe = () => {
    const resolved = resolve();
    return { kind: resolved.kind, source: resolved.source, sourceLabel: resolved.sourceLabel, configured: resolved.kind === 'independent', sevenDaysPresets: describeSevenDaysPresets() };
  };
  return { resolve, resolveUtility, describe, describeSevenDaysPresets };
}

export function createArchiveV2TaskRouter({ resolver, compactClient, isEnabled = () => true } = {}) {
  if (!resolver?.resolve || !compactClient?.generateTask) throw new Error('V2 API 路由依赖不可用');
  const active = new Set(); let epoch = 0;
  const abortAll = () => { epoch += 1; for (const controller of active) controller.abort(); active.clear(); };
  const run = async (options, resolveRoute) => {
    if (!isEnabled()) throw disabledError();
    const mine = epoch, resolved = resolveRoute();
    const route = resolved?.config
      ? { ...resolved, config: Object.freeze({ ...resolved.config, excludeParams: Object.freeze([...(resolved.config.excludeParams || [])]) }) }
      : resolved;
    if (route.kind === 'unavailable') throw unavailableError(route);
    if (route.kind !== 'independent') throw new Error('V2 API 路由类型不受支持');
    if (!isEnabled() || mine !== epoch) throw abortError();
    const controller = new AbortController(); active.add(controller);
    const externalSignal = options?.signal;
    const onExternalAbort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort(); else externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
    try {
      const result = await compactClient.generateTask({ ...options, config: route.config, signal: controller.signal });
      if (!isEnabled() || mine !== epoch) throw abortError();
      return withTaskMetadata(result, route);
    }
    catch (error) {
      if (controller.signal.aborted || !isEnabled() || mine !== epoch) throw abortError();
      if (error && (typeof error === 'object' || typeof error === 'function')) {
        try { error.taskMetadata = taskMetadata(route, error?.finishReason || error?.taskMetadata?.finishReason, error?.transportAttempts ?? error?.taskMetadata?.transportAttempts); } catch { /* a frozen foreign error remains safe but cannot be annotated */ }
      }
      throw error;
    }
    finally { externalSignal?.removeEventListener?.('abort', onExternalAbort); active.delete(controller); }
  };
  const generatePrimaryTask = options => run(options, () => resolver.resolve());
  const generateUtilityTask = options => run(options, () => {
    if (typeof resolver.resolveUtility !== 'function') throw new Error('副 API 配置解析器不可用');
    return resolver.resolveUtility();
  });
  return { generatePrimaryTask, generateUtilityTask, abortAll, getActiveCount: () => active.size };
}

export function createApiTools({ resolver, compactClient, isEnabled = () => true } = {}) {
  const active = new Set(); let epoch = 0;
  const abortAll = () => { epoch += 1; for (const controller of active) controller.abort(); active.clear(); };
  const independent = (selection = null) => {
    const route = resolver.resolve(selection);
    if (route.kind === 'unavailable') throw unavailableError(route);
    if (route.kind !== 'independent') { const error = new Error('当前没有可测试的独立 API'); error.code = 'QQJ_TAVERN'; throw error; }
    return route.config;
  };
  const run = async (method, selection) => {
    if (!isEnabled()) throw disabledError();
    const mine = epoch, config = independent(selection);
    if (!isEnabled() || mine !== epoch) throw abortError();
    const controller = new AbortController(); active.add(controller);
    try {
      const result = await compactClient[method]({ config, signal: controller.signal });
      if (!isEnabled() || mine !== epoch) throw abortError();
      return result;
    } finally { active.delete(controller); }
  };
  return {
    describe: () => resolver.describe(),
    testConnection: selection => run('testConnection', selection),
    fetchModels: selection => run('fetchModels', selection),
    abortAll,
    getActiveCount: () => active.size,
  };
}
