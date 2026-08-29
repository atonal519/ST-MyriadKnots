import { normalizePreset } from './settings.js';

const validConfig = config => Boolean(config?.url && config?.key);
const sevenDaysPresets = value => Array.isArray(value?.apiPresets) ? value.apiPresets.map(normalizePreset).filter(item => item.id) : [];
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
const disabledError = () => { const error = new Error('千千结已关闭'); error.code = 'QQJ_DISABLED'; return error; };

export function createApiResolver({ settings } = {}) {
  if (!settings?.get || !settings?.localConfig || !settings?.sevenDaysSettings) throw new Error('API 配置解析器依赖不可用');
  const describeSevenDaysPresets = () => sevenDaysPresets(settings.sevenDaysSettings()).map(({ id, name, url, model }) => ({ id, name, url, model, configured: true }));
  const healDanglingPreset = current => {
    if (current.apiMode !== 'seven-preset') return;
    settings.update({ apiMode: 'auto', selectedSevenDaysPresetId: '' });
  };
  const resolveAuto = () => {
    const seven = settings.sevenDaysSettings(), presets = sevenDaysPresets(seven);
    const utility = presets.find(item => item.id === String(seven?.utilityPresetId || ''));
    if (validConfig(utility)) return { kind: 'independent', source: 'seven-utility', sourceLabel: `构画机械预设 · ${utility.name}`, config: { ...utility } };
    const main = normalizePreset({
      name: '构画主 API', url: seven?.apiUrl, key: seven?.apiKey, model: seven?.apiModel,
      excludeParams: seven?.apiExcludeParams, timeoutSec: seven?.apiTimeoutSec, stream: seven?.apiStream,
    });
    if (validConfig(main)) return { kind: 'independent', source: 'seven-main', sourceLabel: '构画主 API', config: main };
    const localPresets = settings.presets(), active = localPresets.find(item => item.id === settings.get().apiPresetActiveId);
    if (validConfig(active)) return { kind: 'independent', source: 'local-preset', sourceLabel: `千千结预设 · ${active.name}`, config: { ...active } };
    const local = settings.localConfig();
    if (validConfig(local)) return { kind: 'independent', source: 'local', sourceLabel: '千千结本地 API', config: local };
    return { kind: 'tavern', source: 'tavern', sourceLabel: '酒馆当前模型（会占用当前创作预设）', config: null };
  };
  const resolve = (override = null, { heal = true } = {}) => {
    const current = settings.get();
    const mode = override?.apiMode || current.apiMode;
    const selectedSevenDaysPresetId = override?.selectedSevenDaysPresetId ?? current.selectedSevenDaysPresetId;
    if (mode === 'seven-preset') {
      const preset = sevenDaysPresets(settings.sevenDaysSettings()).find(item => item.id === selectedSevenDaysPresetId);
      if (validConfig(preset)) return { kind: 'independent', source: 'seven-preset', sourceLabel: `构画预设 · ${preset.name}`, config: { ...preset } };
      if (heal && !override) healDanglingPreset(current);
      return resolveAuto();
    }
    if (mode === 'local') {
      const config = override?.localConfig ? normalizePreset(override.localConfig) : settings.localConfig();
      if (validConfig(config)) return { kind: 'independent', source: 'local', sourceLabel: '千千结本地 API', config };
      return { kind: 'tavern', source: 'tavern', sourceLabel: '酒馆当前模型（本地 API 尚未配置）', config: null };
    }
    if (mode === 'tavern') return { kind: 'tavern', source: 'tavern', sourceLabel: '酒馆当前模型（会占用当前创作预设）', config: null };
    return resolveAuto();
  };
  const describe = () => {
    const resolved = resolve();
    return { kind: resolved.kind, source: resolved.source, sourceLabel: resolved.sourceLabel, configured: resolved.kind === 'independent', sevenDaysPresets: describeSevenDaysPresets() };
  };
  return { resolve, describe, describeSevenDaysPresets };
}

export function createPeopleTaskRouter({ resolver, compactClient, fallbackGenerateTask, isEnabled = () => true } = {}) {
  if (!resolver?.resolve || !compactClient?.generateTask) throw new Error('人物识别路由依赖不可用');
  const active = new Set(); let epoch = 0;
  const abortAll = () => { epoch += 1; for (const controller of active) controller.abort(); active.clear(); };
  const generatePeopleTask = async options => {
    if (!isEnabled()) throw disabledError();
    const mine = epoch, route = resolver.resolve();
    if (!isEnabled() || mine !== epoch) throw abortError();
    const controller = new AbortController(); active.add(controller);
    try {
      if (route.kind === 'tavern') {
        if (typeof fallbackGenerateTask !== 'function') throw new Error('酒馆当前模型不可用');
        const result = await fallbackGenerateTask({ ...options, abortSignal: controller.signal });
        if (!isEnabled() || mine !== epoch) throw abortError();
        return result;
      }
      const result = await compactClient.generateTask({ ...options, config: { ...route.config }, signal: controller.signal });
      if (!isEnabled() || mine !== epoch) throw abortError();
      return result;
    }
    catch (error) {
      if (controller.signal.aborted || !isEnabled() || mine !== epoch) throw abortError();
      throw error;
    }
    finally { active.delete(controller); }
  };
  return { generatePeopleTask, abortAll, getActiveCount: () => active.size };
}

export function createApiTools({ resolver, compactClient, isEnabled = () => true } = {}) {
  const active = new Set(); let epoch = 0;
  const abortAll = () => { epoch += 1; for (const controller of active) controller.abort(); active.clear(); };
  const independent = (selection = null) => {
    const route = resolver.resolve(selection, { heal: false });
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
