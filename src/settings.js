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
  sharedApiMigrationVersion: 0,
});

const API_MODES = new Set(['auto', 'seven-preset']);
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
  const ensureSevenDaysSettings = () => {
    const current = sevenDaysSettings();
    if (current) return current;
    const created = {};
    extensionSettings['schedule-planner'] = created;
    return created;
  };
  const sharedUtilityPresetId = () => text(sevenDaysSettings()?.utilityPresetId).trim();
  const setSharedUtilityPresetId = id => {
    const shared = ensureSevenDaysSettings();
    shared.utilityPresetId = text(id).trim();
    notify();
    return shared.utilityPresetId;
  };
  const sharedMainConfig = () => {
    const shared = sevenDaysSettings() || {};
    return normalizePreset({
      name: '主配置',
      url: shared.apiUrl,
      key: shared.apiKey,
      model: shared.apiModel,
      excludeParams: shared.apiExcludeParams,
      timeoutSec: shared.apiTimeoutSec,
      stream: shared.apiStream,
    });
  };
  const sharedPresets = () => {
    const list = sevenDaysSettings()?.apiPresets;
    if (!Array.isArray(list)) return [];
    return list.map(value => value && typeof value === 'object' ? { ...value, ...normalizePreset(value) } : null).filter(value => value?.id);
  };
  const saveSharedMainConfig = config => {
    const shared = ensureSevenDaysSettings(), normalized = normalizePreset(config);
    shared.apiUrl = normalized.url;
    shared.apiKey = normalized.key;
    shared.apiModel = normalized.model;
    shared.apiExcludeParams = normalized.excludeParams;
    shared.apiTimeoutSec = normalized.timeoutSec;
    shared.apiStream = normalized.stream;
    notify();
    return sharedMainConfig();
  };
  const upsertSharedPreset = (name, config, id = '') => {
    // Every mutation re-reads the shared source so a concurrently changed preset pool is never replaced from a stale UI snapshot.
    const shared = ensureSevenDaysSettings();
    const list = Array.isArray(shared.apiPresets) ? [...shared.apiPresets] : [];
    const requestedId = text(id).trim();
    const presetId = requestedId || createPresetId(now, random).replace(/^q/, 'p');
    const index = list.findIndex(value => value && typeof value === 'object' && text(value.id).trim() === presetId);
    const normalized = normalizePreset({ ...config, id: presetId, name });
    const snapshot = {
      name: normalized.name,
      url: normalized.url,
      key: normalized.key,
      model: normalized.model,
      excludeParams: normalized.excludeParams,
      timeoutSec: normalized.timeoutSec,
      stream: normalized.stream,
    };
    if (index >= 0) list[index] = { ...list[index], ...snapshot, id: presetId };
    else list.push({ ...snapshot, id: presetId });
    shared.apiPresets = list;
    shared.apiPresetActiveId = presetId;
    notify();
    return presetId;
  };
  const renameSharedPreset = (id, name) => {
    const presetId = text(id).trim(), nextName = text(name).trim();
    if (!presetId || !nextName) return false;
    const shared = ensureSevenDaysSettings();
    const list = Array.isArray(shared.apiPresets) ? [...shared.apiPresets] : [];
    const index = list.findIndex(value => value && typeof value === 'object' && text(value.id).trim() === presetId);
    if (index < 0) return false;
    list[index] = { ...list[index], name: nextName };
    shared.apiPresets = list;
    notify();
    return true;
  };
  const deleteSharedPreset = id => {
    const presetId = text(id).trim();
    if (!presetId) return false;
    const shared = ensureSevenDaysSettings();
    const list = Array.isArray(shared.apiPresets) ? shared.apiPresets : [];
    const next = list.filter(value => !(value && typeof value === 'object' && text(value.id).trim() === presetId));
    if (next.length === list.length) return false;
    shared.apiPresets = next;
    if (shared.apiPresetActiveId === presetId) shared.apiPresetActiveId = '';
    if (text(shared.utilityPresetId).trim() === presetId) shared.utilityPresetId = '';
    notify();
    return true;
  };
  const sharedSnapshotKey = () => {
    const shared = sevenDaysSettings() || {};
    return JSON.stringify({
      main: sharedMainConfig(),
      presets: Array.isArray(shared.apiPresets) ? shared.apiPresets : [],
      apiPresetActiveId: shared.apiPresetActiveId || '',
      utilityPresetId: sharedUtilityPresetId(),
    });
  };
  const migrateLegacyApiSettings = () => {
    const current = get();
    if (Number(current.sharedApiMigrationVersion) >= 1) return false;
    const shared = ensureSevenDaysSettings();
    let changed = false;
    const legacyFields = [
      ['apiUrl', current.apiUrl], ['apiKey', current.apiKey], ['apiModel', current.apiModel],
      ['apiExcludeParams', parseExcludeParams(current.apiExcludeParams)], ['apiTimeoutSec', normalizeTimeout(current.apiTimeoutSec)], ['apiStream', current.apiStream === true],
    ];
    for (const [key, value] of legacyFields) {
      if (!own(shared, key)) { shared[key] = Array.isArray(value) ? [...value] : value; changed = true; }
    }
    const sharedList = Array.isArray(shared.apiPresets) ? [...shared.apiPresets] : [];
    const ids = new Set(sharedList.map(value => value && typeof value === 'object' ? text(value.id).trim() : '').filter(Boolean));
    for (const legacy of presets()) {
      if (ids.has(legacy.id)) continue;
      sharedList.push({ ...legacy }); ids.add(legacy.id); changed = true;
    }
    if (!Array.isArray(shared.apiPresets) || changed) shared.apiPresets = sharedList;
    const legacySelectedId = text(current.apiPresetActiveId).trim();
    if (!current.selectedSevenDaysPresetId && legacySelectedId && ids.has(legacySelectedId)) {
      current.apiMode = 'seven-preset'; current.selectedSevenDaysPresetId = legacySelectedId; changed = true;
    }
    current.sharedApiMigrationVersion = 1;
    notify();
    return changed;
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
    sharedUtilityPresetId,
    setSharedUtilityPresetId,
    sharedMainConfig,
    sharedPresets,
    saveSharedMainConfig,
    upsertSharedPreset,
    renameSharedPreset,
    deleteSharedPreset,
    sharedSnapshotKey,
    migrateLegacyApiSettings,
    isEnabled: () => get().pluginEnabled !== false,
  };
}
