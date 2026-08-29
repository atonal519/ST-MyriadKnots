export const SETTINGS_ID = 'qianqianjie';

export const DEFAULT_SETTINGS = Object.freeze({
  pluginEnabled: true,
  apiMode: 'auto',
  selectedSevenDaysPresetId: '',
  apiUrl: '',
  apiKey: '',
  apiModel: '',
  apiExcludeParams: [],
  apiTimeoutSec: 180,
  apiStream: false,
  apiPresets: [],
  apiPresetActiveId: '',
});

const API_MODES = new Set(['auto', 'seven-preset', 'local', 'tavern']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const text = value => typeof value === 'string' ? value : '';

export function normalizeTimeout(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 5 && number <= 600 ? number : 180;
}

export function parseExcludeParams(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(/[\n,，]/);
  return [...new Set(values.map(item => String(item).trim()).filter(Boolean))];
}

export function normalizePreset(value = {}) {
  return {
    id: text(value.id).trim(),
    name: text(value.name).trim() || '未命名',
    url: text(value.url).trim(),
    key: text(value.key).trim(),
    model: text(value.model).trim(),
    excludeParams: parseExcludeParams(value.excludeParams),
    timeoutSec: normalizeTimeout(value.timeoutSec),
    stream: value.stream === true,
  };
}

export function createPresetId(now = Date.now, random = Math.random) {
  return `q${now().toString(36)}${random().toString(36).slice(2, 7)}`;
}

export function createSettingsStore({ extensionSettings, save = () => {}, now, random } = {}) {
  if (!extensionSettings || typeof extensionSettings !== 'object') throw new Error('千千结设置存储不可用');
  const get = () => {
    const settings = extensionSettings[SETTINGS_ID] ??= { ...DEFAULT_SETTINGS, apiExcludeParams: [], apiPresets: [] };
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) if (!own(settings, key)) settings[key] = Array.isArray(value) ? [] : value;
    if (!API_MODES.has(settings.apiMode)) settings.apiMode = 'auto';
    if (!Array.isArray(settings.apiExcludeParams)) settings.apiExcludeParams = [];
    if (!Array.isArray(settings.apiPresets)) settings.apiPresets = [];
    settings.apiTimeoutSec = normalizeTimeout(settings.apiTimeoutSec);
    return settings;
  };
  const notify = () => { try { save(); } catch { /* host save failures surface on its own UI */ } };
  const update = patch => {
    const settings = get();
    if (own(patch, 'pluginEnabled')) settings.pluginEnabled = patch.pluginEnabled !== false;
    if (own(patch, 'apiMode')) settings.apiMode = API_MODES.has(patch.apiMode) ? patch.apiMode : 'auto';
    if (own(patch, 'selectedSevenDaysPresetId')) settings.selectedSevenDaysPresetId = text(patch.selectedSevenDaysPresetId).trim();
    if (own(patch, 'apiUrl')) settings.apiUrl = text(patch.apiUrl).trim();
    if (own(patch, 'apiKey')) settings.apiKey = text(patch.apiKey).trim();
    if (own(patch, 'apiModel')) settings.apiModel = text(patch.apiModel).trim();
    if (own(patch, 'apiExcludeParams')) settings.apiExcludeParams = parseExcludeParams(patch.apiExcludeParams);
    if (own(patch, 'apiTimeoutSec')) settings.apiTimeoutSec = normalizeTimeout(patch.apiTimeoutSec);
    if (own(patch, 'apiStream')) settings.apiStream = patch.apiStream === true;
    if (own(patch, 'apiPresetActiveId')) settings.apiPresetActiveId = text(patch.apiPresetActiveId).trim();
    notify();
    return settings;
  };
  const localConfig = () => {
    const settings = get();
    return normalizePreset({
      url: settings.apiUrl,
      key: settings.apiKey,
      model: settings.apiModel,
      excludeParams: settings.apiExcludeParams,
      timeoutSec: settings.apiTimeoutSec,
      stream: settings.apiStream,
    });
  };
  const presets = () => get().apiPresets.map(normalizePreset).filter(item => item.id);
  const upsertPreset = (name, config, id = '') => {
    const settings = get();
    const list = presets();
    const existingId = text(id).trim();
    const preset = normalizePreset({ ...config, id: existingId || createPresetId(now, random), name });
    const index = list.findIndex(item => item.id === preset.id);
    if (index >= 0) list[index] = preset; else list.push(preset);
    settings.apiPresets = list;
    settings.apiPresetActiveId = preset.id;
    notify();
    return preset.id;
  };
  const renamePreset = (id, name) => {
    const settings = get(), list = presets(), preset = list.find(item => item.id === id), nextName = text(name).trim();
    if (!preset || !nextName) return false;
    preset.name = nextName; settings.apiPresets = list; notify(); return true;
  };
  const deletePreset = id => {
    const settings = get(), list = presets(), next = list.filter(item => item.id !== id);
    if (next.length === list.length) return false;
    settings.apiPresets = next;
    if (settings.apiPresetActiveId === id) settings.apiPresetActiveId = '';
    notify(); return true;
  };
  const sevenDaysSettings = () => {
    const value = extensionSettings['schedule-planner'];
    return value && typeof value === 'object' ? value : null;
  };
  return {
    get,
    update,
    localConfig,
    presets,
    upsertPreset,
    renamePreset,
    deletePreset,
    sevenDaysSettings,
    isEnabled: () => get().pluginEnabled !== false,
  };
}
