import { createSettingsKit } from './kit.js';
import { normalizeVectorConfig, VECTOR_DEFAULT_MODEL, VECTOR_DEFAULT_URL } from '../../vector-api.js';
import { publicErrorMessage } from '../../public-error.js';

// 向量配置独立保存；旧显式预设只用于回填，用户保存后复制配置并解除共享引用。
export function createVectorApiSettings({ settings, vectorApi, vectorIndex, documentRef = globalThis.document, open = false, onToggle } = {}) {
  const { element, field, button, subDrawer } = createSettingsKit(documentRef);
  const { drawer: node, body } = subDrawer({ title: '向量召回', id: 'qqj-settings-vector-api', open, onToggle });
  node.classList.add('qqj-vector-api-settings');
  const savedConfig = () => {
    const value = settings.get();
    const config = value.vectorPresetId
      ? settings.sharedPresets().find(preset => preset.id === value.vectorPresetId) ?? {}
      : { url: value.vectorUrl, key: value.vectorKey, model: value.vectorModel };
    return { url: String(config.url ?? '').trim() || VECTOR_DEFAULT_URL, key: String(config.key ?? '').trim(), model: String(config.model ?? '').trim() || VECTOR_DEFAULT_MODEL };
  };
  const current = savedConfig();
  const enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = settings.get().vectorEnabled === true;
  enabled.setAttribute('aria-label', '开启向量召回');
  const enabledRow = element('label', 'setting-switch qqj-vector-enable');
  enabledRow.append(element('span', '', '开启向量召回'), enabled);
  const url = element('input', 'settings-input'); url.value = current.url; url.placeholder = VECTOR_DEFAULT_URL;
  const key = element('input', 'settings-input'); key.type = 'password';
  const model = element('input', 'settings-input'); model.value = current.model; model.placeholder = VECTOR_DEFAULT_MODEL;
  const result = element('p', 'settings-result');
  const progress = element('p', 'settings-result qqj-vector-progress');
  let testing = false;
  const draft = () => ({ url: url.value.trim() || VECTOR_DEFAULT_URL, key: key.value.trim() || savedConfig().key, model: model.value.trim() || VECTOR_DEFAULT_MODEL });
  const updateKeyHint = () => { key.placeholder = savedConfig().key ? '已保存，留空保持不变' : '输入硅基 API Key'; };
  const saveConfig = () => {
    const previous = savedConfig(), config = draft();
    settings.update({ vectorEnabled: enabled.checked, vectorPresetId: '', vectorUrl: config.url, vectorKey: config.key, vectorModel: config.model });
    // 相同配置保留已加载向量，重复建立仍可复用未变片段。
    if (['url', 'key', 'model'].some(name => config[name] !== previous[name])) vectorIndex?.abortAll();
    url.value = config.url; model.value = config.model; key.value = ''; updateKeyHint();
  };
  enabled.addEventListener('change', () => {
    settings.update({ vectorEnabled: enabled.checked }); vectorIndex?.abortAll(); sync();
  });
  const save = button('保存', 'secondary-action', () => {
    saveConfig(); result.textContent = '向量设置已保存'; result.className = 'settings-result success';
  });
  const test = button('测试连接', 'secondary-action', async () => {
    if (test.disabled) return;
    testing = true; sync(); result.textContent = '正在测试…'; result.className = 'settings-result';
    try { await vectorApi.embed(normalizeVectorConfig(draft()), ['连接测试']); result.textContent = '连接成功'; result.className = 'settings-result success'; }
    catch (error) { result.textContent = publicErrorMessage(error, { fallback: '向量连接测试失败，请重试。' }); result.className = 'settings-result error'; }
    finally { testing = false; sync(); }
  });
  const build = button('建立索引', 'secondary-action', async () => {
    if (build.disabled) return;
    saveConfig(); result.textContent = ''; result.className = 'settings-result';
    try { await vectorIndex.build(); }
    catch (error) { if (!vectorIndex.getState().error) { result.textContent = publicErrorMessage(error, { fallback: '索引建立失败，请重试。' }); result.className = 'settings-result error'; } }
  });
  const cancel = button('取消', 'secondary-action', () => vectorIndex?.abortAll());
  const actions = element('div', 'settings-actions qqj-vector-actions'); actions.append(save, test, build, cancel);
  function sync() {
    const state = vectorIndex?.getState(), busy = state?.active === true || state?.status === 'building';
    build.disabled = !enabled.checked || busy || !vectorIndex;
    test.disabled = !enabled.checked || testing || !vectorApi;
    cancel.hidden = !busy;
    progress.textContent = busy ? state.total > 0 ? `建立中 ${state.completed}/${state.total}` : '正在读取原文…'
      : state?.error ? state.error
      : state?.status === 'ready' ? state.total > 0 ? `已索引 ${state.total} 个片段` : '当前没有可索引的原文。'
      : '';
    progress.className = `settings-result qqj-vector-progress${state?.error ? ' error' : state?.status === 'ready' && !busy ? ' success' : ''}`;
    progress.hidden = !progress.textContent;
  }
  body.append(enabledRow, field('URL', url), field('Key', key), field('模型', model),
    element('p', 'settings-hint', '索引仅当前聊天；更新原文后可重新建立。'), actions, result, progress);
  updateKeyHint(); sync();
  // 订阅属于设置界面；切页只释放监听，返回恢复运行时进度，不取消后台任务。
  const releaseProgress = vectorIndex?.subscribe(() => sync());
  return { node, dispose: () => releaseProgress?.() };
}
