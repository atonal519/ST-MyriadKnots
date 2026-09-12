import { normalizeMemoryTagList } from './memory-content-sanitizer.js';

export const SETTINGS_ID = 'qianqianjie';

export const DEFAULT_SETTINGS = Object.freeze({
  pluginEnabled: true,
  storyClockEnabled: true,
  storyClockPrompt: '',
  autoMemoryBatchSize: 1,
  autoHideEnabled: false,
  autoHideKeepAiCount: 3,
  apiMode: 'auto',
  selectedSevenDaysPresetId: '',
  summaryPresetId: '',
  apiUrl: '',
  apiKey: '',
  apiModel: '',
  apiExcludeParams: [],
  apiTimeoutSec: 180,
  apiStream: false,
  apiPresets: [],
  apiPresetActiveId: '',
  sharedApiMigrationVersion: 0,
  sourceWorldInfoExcludedBooks: [],
  sourceKeepTags: 'content',
  sourceExtraTags: '',
  processingPrompt: '',
  summaryPrompt: '',
  csePrompt: '',
  profilePrompt: '',
  appearanceTheme: 'auto',
  fabShow: true,
  appearanceScale: 1,
  appearanceFontCssUrl: '',
  appearanceFontFamily: '',
});

const API_MODES = new Set(['auto', 'seven-preset']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const text = value => typeof value === 'string' ? value : '';
const APPEARANCE_THEMES = new Set(['auto', 'day', 'night']);
const normalizeScale = value => Math.min(1.5, Math.max(0.75, Number.isFinite(Number(value)) ? Number(value) : 1));

export function normalizeAutoMemoryBatchSize(value) {
  return 1;
}

export function normalizeAutoHideKeepAiCount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 50 ? number : 3;
}

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

const pluginEnabledFlows = new WeakMap();

export async function applyPluginEnabledImmediately({ settings, enabled, onChange } = {}) {
  if (!settings || typeof settings.update !== 'function' || typeof settings.isEnabled !== 'function') throw new TypeError('千千结总开关设置存储无效');
  const previous = settings.isEnabled();
  const desired = enabled === true;
  const flow = pluginEnabledFlows.get(settings) ?? { sequence: 0, tail: Promise.resolve() };
  pluginEnabledFlows.set(settings, flow);
  const sequence = ++flow.sequence;
  try { settings.update({ pluginEnabled: desired }, { observeSaveFailure: true }); }
  catch (error) {
    try { settings.update({ pluginEnabled: previous }); } catch { /* restore the in-memory truth even if host scheduling also fails */ }
    throw error;
  }
  const task = flow.tail.catch(() => {}).then(async () => {
    if (sequence !== flow.sequence) return Object.freeze({ enabled: settings.isEnabled(), previous, persistence: 'scheduled', stale: true });
    try {
      await onChange?.(desired);
      if (sequence !== flow.sequence) return Object.freeze({ enabled: settings.isEnabled(), previous, persistence: 'scheduled', stale: true });
      return Object.freeze({ enabled: desired, previous, persistence: 'scheduled', stale: false });
    } catch (error) {
      if (sequence !== flow.sequence) return Object.freeze({ enabled: settings.isEnabled(), previous, persistence: 'scheduled', stale: true });
      if (sequence === flow.sequence) {
        try { settings.update({ pluginEnabled: previous }); } catch { /* in-memory rollback happens before host save scheduling */ }
        try { await onChange?.(previous); } catch { /* rollback is best effort */ }
      }
      throw error;
    }
  });
  flow.tail = task.catch(() => {});
  return task;
}

export function createSettingsStore({ extensionSettings, save = () => {}, now, random } = {}) {
  if (!extensionSettings || typeof extensionSettings !== 'object') throw new Error('千千结设置存储不可用');
  const get = () => {
    const settings = extensionSettings[SETTINGS_ID] ??= { ...DEFAULT_SETTINGS, apiExcludeParams: [], apiPresets: [] };
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) if (!own(settings, key)) {
      settings[key] = Array.isArray(value) ? [] : (value && typeof value === 'object' ? {} : value);
    }
    if (!API_MODES.has(settings.apiMode)) settings.apiMode = 'auto';
    if (!Array.isArray(settings.apiExcludeParams)) settings.apiExcludeParams = [];
    if (!Array.isArray(settings.apiPresets)) settings.apiPresets = [];
    if (!Array.isArray(settings.sourceWorldInfoExcludedBooks)) settings.sourceWorldInfoExcludedBooks = [];
    if (!APPEARANCE_THEMES.has(settings.appearanceTheme)) settings.appearanceTheme = 'auto';
    settings.fabShow = settings.fabShow !== false;
    settings.appearanceScale = normalizeScale(settings.appearanceScale);
    settings.apiTimeoutSec = normalizeTimeout(settings.apiTimeoutSec);
    settings.autoMemoryBatchSize = normalizeAutoMemoryBatchSize(settings.autoMemoryBatchSize);
    settings.autoHideEnabled = settings.autoHideEnabled === true;
    settings.autoHideKeepAiCount = normalizeAutoHideKeepAiCount(settings.autoHideKeepAiCount);
    return settings;
  };
  const notify = (observeSaveFailure = false) => {
    try { return save(); }
    catch (error) { if (observeSaveFailure) throw error; }
  };
  const update = (patch, { observeSaveFailure = false } = {}) => {
    const settings = get();
    if (own(patch, 'pluginEnabled')) settings.pluginEnabled = patch.pluginEnabled !== false;
    if (own(patch, 'storyClockEnabled')) settings.storyClockEnabled = patch.storyClockEnabled !== false;
    if (own(patch, 'storyClockPrompt')) settings.storyClockPrompt = text(patch.storyClockPrompt);
    if (own(patch, 'autoMemoryBatchSize')) settings.autoMemoryBatchSize = normalizeAutoMemoryBatchSize(patch.autoMemoryBatchSize);
    if (own(patch, 'autoHideEnabled')) settings.autoHideEnabled = patch.autoHideEnabled === true;
    if (own(patch, 'autoHideKeepAiCount')) settings.autoHideKeepAiCount = normalizeAutoHideKeepAiCount(patch.autoHideKeepAiCount);
    if (own(patch, 'apiMode')) settings.apiMode = API_MODES.has(patch.apiMode) ? patch.apiMode : 'auto';
    if (own(patch, 'selectedSevenDaysPresetId')) settings.selectedSevenDaysPresetId = text(patch.selectedSevenDaysPresetId).trim();
    if (own(patch, 'summaryPresetId')) settings.summaryPresetId = text(patch.summaryPresetId).trim();
    if (own(patch, 'apiUrl')) settings.apiUrl = text(patch.apiUrl).trim();
    if (own(patch, 'apiKey')) settings.apiKey = text(patch.apiKey).trim();
    if (own(patch, 'apiModel')) settings.apiModel = text(patch.apiModel).trim();
    if (own(patch, 'apiExcludeParams')) settings.apiExcludeParams = parseExcludeParams(patch.apiExcludeParams);
    if (own(patch, 'apiTimeoutSec')) settings.apiTimeoutSec = normalizeTimeout(patch.apiTimeoutSec);
    if (own(patch, 'apiStream')) settings.apiStream = patch.apiStream === true;
    if (own(patch, 'apiPresetActiveId')) settings.apiPresetActiveId = text(patch.apiPresetActiveId).trim();
    if (own(patch, 'sourceWorldInfoExcludedBooks')) settings.sourceWorldInfoExcludedBooks = Array.isArray(patch.sourceWorldInfoExcludedBooks) ? patch.sourceWorldInfoExcludedBooks : [];
    if (own(patch, 'sourceKeepTags')) settings.sourceKeepTags = normalizeMemoryTagList(patch.sourceKeepTags).join(',');
    if (own(patch, 'sourceExtraTags')) settings.sourceExtraTags = normalizeMemoryTagList(patch.sourceExtraTags).join(',');
    if (own(patch, 'processingPrompt')) settings.processingPrompt = text(patch.processingPrompt);
    if (own(patch, 'summaryPrompt')) settings.summaryPrompt = text(patch.summaryPrompt);
    if (own(patch, 'csePrompt')) settings.csePrompt = text(patch.csePrompt);
    if (own(patch, 'profilePrompt')) settings.profilePrompt = text(patch.profilePrompt);
    if (own(patch, 'appearanceTheme')) settings.appearanceTheme = APPEARANCE_THEMES.has(patch.appearanceTheme) ? patch.appearanceTheme : 'auto';
    if (own(patch, 'fabShow')) settings.fabShow = patch.fabShow !== false;
    if (own(patch, 'appearanceScale')) settings.appearanceScale = normalizeScale(patch.appearanceScale);
    if (own(patch, 'appearanceFontCssUrl')) settings.appearanceFontCssUrl = text(patch.appearanceFontCssUrl).trim();
    if (own(patch, 'appearanceFontFamily')) settings.appearanceFontFamily = text(patch.appearanceFontFamily).trim();
    notify(observeSaveFailure);
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
  const mainConfig = () => ({ ...localConfig(), name: '主配置' });
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
  const normalizeWorldBookNames = value => {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.map(item => text(item).trim()).filter(item => {
      if (!item) return false;
      const key = item.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('zh-Hans-CN');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const sharedWorldInfoExcludedBooks = () => {
    try { return normalizeWorldBookNames(sevenDaysSettings()?.wiExcludeBooks); }
    catch { return []; }
  };
  const setSharedWorldInfoExcluded = (bookName, excluded) => {
    const name = text(bookName).trim();
    if (!name) throw new TypeError('世界书名称无效');
    const canonical = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('zh-Hans-CN');
    const shared = ensureSevenDaysSettings();
    const next = sharedWorldInfoExcludedBooks().filter(item => canonical(item) !== canonical(name));
    if (excluded === true) next.push(name);
    shared.wiExcludeBooks = next;
    notify();
    return [...next];
  };
  const sourcePermissionSnapshot = () => ({
    ...get(),
    sourceWorldInfoExcludedBooks: sharedWorldInfoExcludedBooks(),
  });
  const summaryPresetId = () => text(get().summaryPresetId).trim();
  const setSummaryPresetId = id => {
    const current = get();
    current.summaryPresetId = text(id).trim();
    notify();
    return current.summaryPresetId;
  };
  const sharedPresets = () => {
    const list = sevenDaysSettings()?.apiPresets;
    if (!Array.isArray(list)) return [];
    return list.map(value => value && typeof value === 'object' ? { ...value, ...normalizePreset(value) } : null).filter(value => value?.id);
  };
  const saveMainConfig = config => {
    const current = get(), normalized = normalizePreset(config);
    current.apiUrl = normalized.url;
    current.apiKey = normalized.key;
    current.apiModel = normalized.model;
    current.apiExcludeParams = normalized.excludeParams;
    current.apiTimeoutSec = normalized.timeoutSec;
    current.apiStream = normalized.stream;
    notify();
    return mainConfig();
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
    const current = get();
    if (current.apiMode === 'seven-preset' && text(current.selectedSevenDaysPresetId).trim() === presetId) {
      current.apiMode = 'auto';
      current.selectedSevenDaysPresetId = '';
    }
    if (text(current.summaryPresetId).trim() === presetId) current.summaryPresetId = '';
    notify();
    return true;
  };
  const sharedSnapshotKey = () => {
    const shared = sevenDaysSettings() || {};
    return JSON.stringify({
      presets: Array.isArray(shared.apiPresets) ? shared.apiPresets : [],
    });
  };
  const migrateLegacyApiSettings = () => {
    const current = get();
    const migrationVersion = Number(current.sharedApiMigrationVersion) || 0;
    if (migrationVersion >= 2) return false;
    const existingShared = sevenDaysSettings();
    const sharedList = Array.isArray(existingShared?.apiPresets) ? [...existingShared.apiPresets] : [];
    const ids = new Set(sharedList.map(value => value && typeof value === 'object' ? text(value.id).trim() : '').filter(Boolean));
    if (migrationVersion < 1) {
      for (const legacy of presets()) {
        if (ids.has(legacy.id)) continue;
        sharedList.push({ ...legacy }); ids.add(legacy.id);
      }
      if (sharedList.length || Array.isArray(existingShared?.apiPresets)) ensureSevenDaysSettings().apiPresets = sharedList;
      const legacySelectedId = text(current.apiPresetActiveId).trim();
      if (!current.selectedSevenDaysPresetId && legacySelectedId && ids.has(legacySelectedId)) {
        current.apiMode = 'seven-preset';
        current.selectedSevenDaysPresetId = legacySelectedId;
      }
    }
    const shared = existingShared || {};
    const migratedMain = normalizePreset({
      name: '主配置',
      url: own(shared, 'apiUrl') ? shared.apiUrl : current.apiUrl,
      key: own(shared, 'apiKey') ? shared.apiKey : current.apiKey,
      model: own(shared, 'apiModel') ? shared.apiModel : current.apiModel,
      excludeParams: own(shared, 'apiExcludeParams') ? shared.apiExcludeParams : current.apiExcludeParams,
      timeoutSec: own(shared, 'apiTimeoutSec') ? shared.apiTimeoutSec : current.apiTimeoutSec,
      stream: own(shared, 'apiStream') ? shared.apiStream : current.apiStream,
    });
    current.apiUrl = migratedMain.url;
    current.apiKey = migratedMain.key;
    current.apiModel = migratedMain.model;
    current.apiExcludeParams = migratedMain.excludeParams;
    current.apiTimeoutSec = migratedMain.timeoutSec;
    current.apiStream = migratedMain.stream;
    const legacySummaryId = text(shared.utilityPresetId).trim();
    const legacySummary = legacySummaryId ? sharedList.map(normalizePreset).find(item => item.id === legacySummaryId) : null;
    current.summaryPresetId = legacySummary?.url && legacySummary?.key ? legacySummaryId : '';
    current.sharedApiMigrationVersion = 2;
    notify();
    return true;
  };
  return {
    get,
    update,
    localConfig,
    mainConfig,
    presets,
    upsertPreset,
    renamePreset,
    deletePreset,
    sevenDaysSettings,
    summaryPresetId,
    setSummaryPresetId,
    sharedPresets,
    saveMainConfig,
    upsertSharedPreset,
    renameSharedPreset,
    deleteSharedPreset,
    sharedSnapshotKey,
    sharedWorldInfoExcludedBooks,
    setSharedWorldInfoExcluded,
    sourcePermissionSnapshot,
    migrateLegacyApiSettings,
    isEnabled: () => get().pluginEnabled !== false,
  };
}
