import html from './panel.html?raw';
import css from './panel.css?inline';

const types = [['single', '单人', '围绕一位角色，建立清晰的关系档案。'], ['multi', '多人', '记录群像关系与多角色互动。'], ['open_world', '大世界', '让角色档案连接到更大的世界。'], ['simulator', '模拟器', '用于测试关系变化与叙事走向。']];
const shellCss = ':host{position:fixed;inset:0;z-index:1001;width:100dvw;height:100dvh;pointer-events:none;background:transparent}:host([hidden]){display:none!important;pointer-events:none!important}.panel{position:fixed;top:80px;right:20px;width:360px;max-width:calc(100vw - 40px);max-height:85vh;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;pointer-events:auto}.body{min-height:0;max-height:none;overflow-y:auto}.tabs{min-width:0;overflow-x:auto;flex-wrap:nowrap}.tab{flex:0 0 auto}@media(max-width:640px){.panel{top:calc(20px + env(safe-area-inset-top,0px));left:50%;right:auto;bottom:auto;transform:translateX(-50%);width:calc(100dvw - 20px);max-width:calc(100dvw - 20px);height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));max-height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));min-height:0;border-radius:14px}.body{min-height:0;overflow-y:auto}.choices{grid-template-columns:1fr}.tab{padding-left:9px;padding-right:9px}}';

export function createPanel({ formal, people, settings, apiTools, onPluginEnabledChange, onClose } = {}) {
  const host = document.createElement('div');
  host.id = 'qqj-panel-host'; host.hidden = true; host.setAttribute('aria-hidden', 'true');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' + css + shellCss + '</style>' + html;
  const view = root.querySelector('.view'), label = root.querySelector('.status-label'), meta = root.querySelector('.status-meta'), dot = root.querySelector('.status-dot');
  let state = { status: 'loading' }, selected = null, busy = false, trigger = null, screen = 'people', settingsDraftKey = '', settingsRenderEpoch = 0;
  const focusables = () => [...root.querySelectorAll('button,input,select,textarea,[href],[tabindex]:not([tabindex="-1"])')].filter(item => !item.disabled && item.offsetParent !== null);
  const close = () => { host.hidden = true; host.setAttribute('aria-hidden', 'true'); const old = trigger; trigger = null; onClose?.(); old?.focus?.(); };

  const apiErrorCopy = error => {
    const code = String(error?.code || '');
    const known = {
      QQJ_CONFIG: 'API 配置不完整，请检查 URL 和 Key。', QQJ_TIMEOUT: '连接超时，请检查网络或调高超时时间。',
      QQJ_AUTH: '认证失败，请检查 Key 和模型权限。', QQJ_NOT_FOUND: '接口地址不存在，请检查 Base URL。',
      QQJ_RATE_LIMIT: '请求过于频繁，请稍后再试。', QQJ_SERVER: 'API 服务暂时异常，请稍后再试。',
      QQJ_NETWORK: '无法连接 API，请检查地址和网络。', QQJ_EMPTY: '模型没有返回内容，请更换模型或检查配置。',
      QQJ_FORMAT: '模型没有按约定返回测试结果。', QQJ_MODELS: '接口没有返回可用模型。',
      QQJ_TAVERN: '当前走酒馆创作预设，无法独立测试；请选择构画或千千结本地 API。',
      QQJ_DISABLED: '千千结已关闭；启用并保存后才能测试连接。',
    };
    return known[code] || '连接失败，请检查 API 配置后重试。';
  };
  const appendOption = (select, value, label) => {
    const option = document.createElement('option'); option.value = value; option.textContent = label; select?.append?.(option); return option;
  };
  const currentLocalDraft = () => {
    const timeout = Number(view.querySelector?.('[data-setting="timeout"]')?.value);
    return {
      url: view.querySelector?.('[data-setting="url"]')?.value?.trim?.() || '', key: settingsDraftKey,
      model: view.querySelector?.('[data-setting="model"]')?.value?.trim?.() || '',
      excludeParams: view.querySelector?.('[data-setting="exclude"]')?.value || '', timeoutSec: timeout,
      stream: view.querySelector?.('[data-setting="stream"]')?.checked === true,
    };
  };
  const selectedApiDraft = () => {
    const value = view.querySelector?.('[data-setting="source"]')?.value || 'auto';
    if (value.startsWith('seven:')) return { apiMode: 'seven-preset', selectedSevenDaysPresetId: value.slice(6) };
    if (value === 'local') return { apiMode: 'local', selectedSevenDaysPresetId: '', localConfig: currentLocalDraft() };
    if (value === 'tavern') return { apiMode: 'tavern', selectedSevenDaysPresetId: '' };
    return { apiMode: 'auto', selectedSevenDaysPresetId: '' };
  };
  const settingsResult = (message, tone = '') => {
    const target = view.querySelector?.('.settings-result');
    if (target) { target.textContent = message; target.className = `settings-result ${tone}`.trim(); }
  };
  const fillLocalDraft = config => {
    const url = view.querySelector?.('[data-setting="url"]'), model = view.querySelector?.('[data-setting="model"]'), exclude = view.querySelector?.('[data-setting="exclude"]'), timeout = view.querySelector?.('[data-setting="timeout"]'), stream = view.querySelector?.('[data-setting="stream"]'), key = view.querySelector?.('[data-setting="key"]');
    if (url) url.value = config?.url || ''; if (model) model.value = config?.model || ''; if (exclude) exclude.value = (config?.excludeParams || []).join('\n');
    if (timeout) timeout.value = String(config?.timeoutSec || 180); if (stream) stream.checked = config?.stream === true;
    settingsDraftKey = config?.key || ''; if (key) { key.value = ''; key.placeholder = settingsDraftKey ? '已保存（输入新值可替换）' : '输入 API Key'; key.type = 'password'; }
  };

  const renderSettings = () => {
    const renderEpoch = ++settingsRenderEpoch;
    if (!settings?.get) { settingsResult('设置存储暂不可用。', 'error'); return; }
    screen = 'settings';
    root.querySelectorAll('.tab').forEach(item => { item.classList.toggle('active', false); item.setAttribute('aria-selected', 'false'); });
    const current = settings.get(), local = settings.localConfig(), description = apiTools?.describe?.() || { sourceLabel: '尚未解析', sevenDaysPresets: [] };
    label.textContent = '千千结设置'; meta.textContent = 'LOCAL'; dot.className = `status-dot ${current.pluginEnabled !== false ? 'ready' : 'warn'}`;
    view.innerHTML = '<section class="settings-view"><div class="settings-heading"><div><div class="eyebrow">THREAD CONTROL</div><h2>连接与总开关</h2></div><label class="master-switch"><input data-setting="enabled" type="checkbox"><span>启用千千结</span></label></div><div class="api-source-card"><span>当前请求来源</span><strong class="api-source-label"></strong><small>构画配置只读继承，密钥不会复制到千千结。</small></div><label class="field"><span>API 来源</span><select data-setting="source"></select></label><section class="settings-section"><div class="section-title"><div><b>千千结本地 API</b><small>构画不可用时自动接力，也可手动选择。</small></div></div><label class="field"><span>本地预设</span><select data-setting="local-preset"></select></label><div class="preset-actions"><button type="button" data-action="preset-new">新增</button><button type="button" data-action="preset-update">更新</button><button type="button" data-action="preset-rename">改名</button><button type="button" data-action="preset-delete">删除</button></div><label class="field"><span>Base URL</span><input data-setting="url" type="url" autocomplete="off" placeholder="https://api.example.com/v1"></label><label class="field"><span>API Key</span><span class="key-row"><input data-setting="key" type="password" autocomplete="new-password"><button type="button" data-action="key-toggle" aria-label="显示或隐藏 Key">显示</button><button type="button" data-action="key-clear">清除</button></span></label><label class="field"><span>模型</span><span class="model-row"><input data-setting="model" type="text" autocomplete="off" placeholder="gpt-4o-mini"><button type="button" data-action="models">拉取模型</button></span></label><div class="model-results" hidden></div><details class="advanced"><summary>高级设置</summary><label class="field"><span>剔除参数（每行一个）</span><textarea data-setting="exclude" rows="3" placeholder="frequency_penalty"></textarea></label><div class="advanced-row"><label class="field"><span>超时（5–600 秒）</span><input data-setting="timeout" type="number" min="5" max="600"></label><label class="check-field"><input data-setting="stream" type="checkbox"><span>流式响应</span></label></div></details></section><div class="settings-actions"><button class="secondary-action" type="button" data-action="test">测试连接</button><button class="primary-action" type="button" data-action="save">保存设置</button></div><p class="settings-result" role="status" aria-live="polite"></p></section>';
    const enabledInput = view.querySelector('[data-setting="enabled"]'); if (enabledInput) enabledInput.checked = current.pluginEnabled !== false;
    const sourceLabel = view.querySelector('.api-source-label'); if (sourceLabel) sourceLabel.textContent = description.sourceLabel;
    const source = view.querySelector('[data-setting="source"]');
    appendOption(source, 'auto', '自动继承构画');
    for (const preset of description.sevenDaysPresets || []) appendOption(source, `seven:${preset.id}`, `构画预设 · ${preset.name}`);
    appendOption(source, 'local', '千千结本地 API'); appendOption(source, 'tavern', '酒馆当前模型');
    if (source) source.value = current.apiMode === 'seven-preset' ? `seven:${current.selectedSevenDaysPresetId}` : current.apiMode || 'auto';
    const localSelect = view.querySelector('[data-setting="local-preset"]'); appendOption(localSelect, '', '当前本地配置');
    for (const preset of settings.presets()) appendOption(localSelect, preset.id, preset.name);
    if (localSelect) localSelect.value = current.apiPresetActiveId || '';
    const activeLocalPreset = settings.presets().find(item => item.id === current.apiPresetActiveId);
    fillLocalDraft(activeLocalPreset || local);
    const apiActionsEnabled = current.pluginEnabled !== false;
    const testButton = view.querySelector('[data-action="test"]'), modelsButton = view.querySelector('[data-action="models"]');
    if (testButton) testButton.disabled = !apiActionsEnabled; if (modelsButton) modelsButton.disabled = !apiActionsEnabled;

    localSelect?.addEventListener('change', () => {
      const preset = settings.presets().find(item => item.id === localSelect.value);
      fillLocalDraft(preset || settings.localConfig());
    });
    view.querySelector('[data-setting="key"]')?.addEventListener('input', event => { settingsDraftKey = event.target.value; });
    view.querySelector('[data-action="key-toggle"]')?.addEventListener('click', event => {
      const input = view.querySelector('[data-setting="key"]'); if (!input) return;
      if (input.type === 'password') { if (!input.value && settingsDraftKey) input.value = settingsDraftKey; input.type = 'text'; event.currentTarget.textContent = '隐藏'; }
      else { settingsDraftKey = input.value; input.value = ''; input.type = 'password'; input.placeholder = settingsDraftKey ? '已保存（输入新值可替换）' : '输入 API Key'; event.currentTarget.textContent = '显示'; }
    });
    view.querySelector('[data-action="key-clear"]')?.addEventListener('click', () => { settingsDraftKey = ''; const input = view.querySelector('[data-setting="key"]'); if (input) { input.value = ''; input.placeholder = '输入 API Key'; } settingsResult('保存后会清除千千结本地 Key。'); });
    view.querySelector('[data-action="preset-new"]')?.addEventListener('click', () => {
      const name = globalThis.prompt?.('新预设名称', '新预设')?.trim(); if (!name) return;
      const id = settings.upsertPreset(name, currentLocalDraft()); settings.update({ apiPresetActiveId: id }); renderSettings(); settingsResult(`已新增本地预设「${name}」。`, 'success');
    });
    view.querySelector('[data-action="preset-update"]')?.addEventListener('click', () => {
      const id = view.querySelector('[data-setting="local-preset"]')?.value, preset = settings.presets().find(item => item.id === id);
      if (!preset) return settingsResult('请先选择要更新的本地预设。', 'error');
      settings.upsertPreset(preset.name, currentLocalDraft(), id); renderSettings(); settingsResult(`已更新本地预设「${preset.name}」。`, 'success');
    });
    view.querySelector('[data-action="preset-rename"]')?.addEventListener('click', () => {
      const id = view.querySelector('[data-setting="local-preset"]')?.value, preset = settings.presets().find(item => item.id === id); if (!preset) return settingsResult('请先选择要改名的本地预设。', 'error');
      const name = globalThis.prompt?.('新的预设名称', preset.name)?.trim(); if (!name) return; settings.renamePreset(id, name); renderSettings(); settingsResult(`已改名为「${name}」。`, 'success');
    });
    view.querySelector('[data-action="preset-delete"]')?.addEventListener('click', () => {
      const id = view.querySelector('[data-setting="local-preset"]')?.value, preset = settings.presets().find(item => item.id === id); if (!preset) return settingsResult('请先选择要删除的本地预设。', 'error');
      if (globalThis.confirm?.(`删除本地预设「${preset.name}」？`)) { settings.deletePreset(id); renderSettings(); settingsResult('本地预设已删除。', 'success'); }
    });
    view.querySelector('[data-action="save"]')?.addEventListener('click', async () => {
      const draft = currentLocalDraft();
      if (!Number.isInteger(draft.timeoutSec) || draft.timeoutSec < 5 || draft.timeoutSec > 600) return settingsResult('超时时间必须是 5–600 秒的整数。', 'error');
      const selection = selectedApiDraft(), wasEnabled = settings.isEnabled();
      settings.update({ ...selection, pluginEnabled: enabledInput?.checked !== false, apiUrl: draft.url, apiKey: draft.key, apiModel: draft.model, apiExcludeParams: draft.excludeParams, apiTimeoutSec: draft.timeoutSec, apiStream: draft.stream, apiPresetActiveId: view.querySelector('[data-setting="local-preset"]')?.value || '' });
      const isEnabled = settings.isEnabled(); if (wasEnabled !== isEnabled) await onPluginEnabledChange?.(isEnabled);
      renderSettings(); settingsResult('设置已保存。', 'success');
    });
    view.querySelector('[data-action="test"]')?.addEventListener('click', async event => {
      if (!settings.isEnabled()) { settingsResult('千千结已关闭；启用并保存后才能测试连接。', 'error'); return; }
      const selection = selectedApiDraft(); event.currentTarget.disabled = true; settingsResult('正在发送不含聊天与人物数据的短测试…');
      try { const result = await apiTools?.testConnection?.(selection); if (renderEpoch === settingsRenderEpoch && settings.isEnabled()) settingsResult(`连接成功 · ${result?.model || '当前模型'}`, 'success'); }
      catch (error) { if (renderEpoch === settingsRenderEpoch && settings.isEnabled()) settingsResult(apiErrorCopy(error), 'error'); }
      finally { if (renderEpoch === settingsRenderEpoch && settings.isEnabled()) event.currentTarget.disabled = false; }
    });
    view.querySelector('[data-action="models"]')?.addEventListener('click', async event => {
      if (!settings.isEnabled()) { settingsResult('千千结已关闭；启用并保存后才能读取模型列表。', 'error'); return; }
      const selection = selectedApiDraft(); event.currentTarget.disabled = true; settingsResult('正在读取模型列表…');
      try {
        const models = await apiTools?.fetchModels?.(selection), target = view.querySelector('.model-results'); if (!target) return;
        if (renderEpoch !== settingsRenderEpoch || !settings.isEnabled()) return;
        target.replaceChildren(); target.hidden = false;
        for (const name of models || []) { const button = document.createElement('button'); button.type = 'button'; button.textContent = name; button.addEventListener('click', () => { const input = view.querySelector('[data-setting="model"]'); if (input) input.value = name; }); target.append(button); }
        settingsResult(`已读取 ${models?.length || 0} 个模型。`, 'success');
      } catch (error) { if (renderEpoch === settingsRenderEpoch && settings.isEnabled()) settingsResult(apiErrorCopy(error), 'error'); }
      finally { if (renderEpoch === settingsRenderEpoch && settings.isEnabled()) event.currentTarget.disabled = false; }
    });
  };

  const renderChoices = () => {
    view.innerHTML = '<div class="empty"><div class="eyebrow">FIRST THREAD</div><h2>先为这段关系选一种形状</h2><p>选择只决定档案的起始方式，之后仍可以在正式数据中继续补充。</p><div class="choices">' + types.map(type => '<label class="choice"><input type="radio" name="qqj-card-type" value="' + type[0] + '"><strong>' + type[1] + '</strong><span>' + type[2] + '</span></label>').join('') + '</div><button class="init" type="button" disabled>初始化档案</button></div>';
    view.querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
      selected = input.value;
      view.querySelectorAll('.choice').forEach(choice => choice.classList.toggle('selected', choice.querySelector('input').checked));
      view.querySelector('.init').disabled = false;
    }));
    view.querySelector('.init').addEventListener('click', async () => {
      if (busy || !selected) return;
      busy = true; view.querySelector('.init').disabled = true; label.textContent = '正在写入正式档案';
      try { setState(await formal.initializeCard({ cardType: selected })); }
      catch { setState({ status: 'error' }); }
      finally { busy = false; }
    });
  };

  const actionButton = (text, action, identityId) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'person-action'; button.dataset[action] = identityId; button.textContent = text;
    return button;
  };

  const renderReady = () => {
    const confirmed = Array.isArray(state.people?.confirmed) ? state.people.confirmed : [];
    const candidates = Array.isArray(state.people?.candidate) ? state.people.candidate : [];
    const shelved = Array.isArray(state.people?.shelved) ? state.people.shelved : [];
    const warnings = Array.isArray(state.people?.warnings) ? state.people.warnings : [];
    const normalizationWarning = warnings.some(item => String(item?.code || '').startsWith('NORMALIZATION_'));
    const sourceWarning = warnings.some(item => !String(item?.code || '').startsWith('NORMALIZATION_'));
    view.replaceChildren();
    const empty = document.createElement('div'); empty.className = 'empty';
    const eyebrow = document.createElement('div'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'FORMAL PROFILE / READY';
    const title = document.createElement('h2'); title.textContent = '关系档案已就绪';
    const intro = document.createElement('p'); intro.textContent = '“选择”只表示你当前想关注和发展这位人物，可多选；不代表已经恋爱或发生关系。未选择人物会继续保留。';
    empty.append(eyebrow, title, intro);
    if (sourceWarning) { const warning = document.createElement('p'); warning.className = 'error'; warning.textContent = '部分原设来源当前不可用，已按其余来源继续。'; empty.append(warning); }
    if (normalizationWarning) { const warning = document.createElement('p'); warning.className = 'error'; warning.textContent = '部分人物格式已自动修正或跳过。'; empty.append(warning); }
    if (state.peopleError) { const error = document.createElement('p'); error.className = 'error'; error.textContent = state.peopleError; empty.append(error); }

    if (confirmed.length) {
      const list = document.createElement('section'); list.className = 'people-list';
      const heading = document.createElement('h3'); heading.textContent = '明确人物'; list.append(heading);
      confirmed.forEach(item => {
        const article = document.createElement('article'); article.className = 'module person-card';
        const name = document.createElement('b'); name.textContent = item.displayName ?? '';
        const selectedNow = item.selection?.status === 'selected';
        const hint = document.createElement('small'); hint.textContent = selectedNow ? '当前关注 · 不代表已经恋爱' : '尚未选择 · 人物仍会长期保留';
        const actions = document.createElement('div'); actions.className = 'person-actions';
        actions.append(
          actionButton(selectedNow ? '取消选择' : '选择', selectedNow ? 'unselect' : 'select', item.identityId),
          actionButton('改名', 'edit', item.identityId),
          actionButton('搁置', 'shelve', item.identityId),
        );
        article.append(name, hint, actions); list.append(article);
      });
      empty.append(list);
    } else if (!sourceWarning && !state.peopleError) {
      const none = document.createElement('p'); none.textContent = '当前来源尚未登记明确人物。'; empty.append(none);
    }

    if (candidates.length) {
      const pending = document.createElement('section'); pending.className = 'people-list';
      const heading = document.createElement('h3'); heading.textContent = '待判断人物'; pending.append(heading);
      candidates.forEach(item => {
        const article = document.createElement('article'); article.className = 'module person-card';
        const name = document.createElement('b'); name.textContent = item.name ?? '';
        const hint = document.createElement('small'); hint.textContent = '身份或重要性仍需判断 · 未选择';
        article.append(name, hint); pending.append(article);
      });
      empty.append(pending);
    }

    if (shelved.length) {
      const details = document.createElement('details'); details.className = 'shelved-people';
      const summary = document.createElement('summary'); summary.textContent = `已搁置人物（${shelved.length}）`; details.append(summary);
      const list = document.createElement('div'); list.className = 'people-list';
      shelved.forEach(item => {
        const article = document.createElement('article'); article.className = 'module person-card';
        const name = document.createElement('b'); name.textContent = item.displayName ?? '';
        const hint = document.createElement('small'); hint.textContent = '已保留身份、改名和用户事实';
        const actions = document.createElement('div'); actions.className = 'person-actions'; actions.append(actionButton('恢复', 'restore', item.identityId));
        article.append(name, hint, actions); list.append(article);
      });
      details.append(list); empty.append(details);
    }

    const modules = document.createElement('div'); modules.className = 'modules';
    ['双丝网', '千事', '千结'].forEach(moduleName => { const article = document.createElement('article'); article.className = 'module'; const name = document.createElement('b'); name.textContent = moduleName; const hint = document.createElement('small'); hint.textContent = '尚未接入业务数据'; article.append(name, hint); modules.append(article); });
    empty.append(modules); view.append(empty);

    view.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', async () => {
      const name = globalThis.prompt?.('新的显示名', confirmed.find(item => item.identityId === button.dataset.edit)?.displayName ?? '');
      if (name?.trim() && people?.editDisplayName) await applyPeopleOperation(() => people.editDisplayName({ identityId: button.dataset.edit, displayName: name }));
    }));
    view.querySelectorAll('[data-select]').forEach(button => button.addEventListener('click', () => applyPeopleOperation(() => people.select({ identityId: button.dataset.select }))));
    view.querySelectorAll('[data-unselect]').forEach(button => button.addEventListener('click', () => applyPeopleOperation(() => people.unselect({ identityId: button.dataset.unselect }))));
    view.querySelectorAll('[data-shelve]').forEach(button => button.addEventListener('click', async () => {
      if (globalThis.confirm?.('搁置后人物会从主列表隐藏，但可随时恢复。继续吗？') && people?.shelve) await applyPeopleOperation(() => people.shelve({ identityId: button.dataset.shelve }));
    }));
    view.querySelectorAll('[data-restore]').forEach(button => button.addEventListener('click', () => applyPeopleOperation(() => people.restore({ identityId: button.dataset.restore }))));
  };

  const setState = next => {
    state = next || { status: 'error' };
    if (screen === 'settings') return;
    const status = state.status;
    const recognitionFailed = ['ready', 'route_ready'].includes(status) && state.peopleRecognitionFailed;
    const normalizationWarning = Array.isArray(state.people?.warnings) && state.people.warnings.some(item => String(item?.code || '').startsWith('NORMALIZATION_'));
    label.textContent = recognitionFailed ? '人物识别失败，已保留旧列表' : ({ disabled: '千千结已关闭', loading: '正在读取当前聊天', reading_sources: '正在读取路线来源', waiting_ai: '正在等待 AI 识别', saving_people: '正在写入人物档案', preparing: '正在恢复档案', renaming: '正在恢复人物改名', awaiting_card_type: '档案尚未初始化', migrated: '档案已迁移，等待选择类型', route_ready: '来源已锚定，正式档案已就绪', ready: '来源已锚定，正式档案已就绪', route_unavailable: '路线来源扫描不可用', route_mismatch: '路线来源发生变化，需要处理', mismatch: '当前身份或路线不一致', offline: '暂时无法连接正式存储', stopped: '当前聊天暂不可用', error: '正式状态读取失败', conflict: '档案发生冲突' })[status] || status;
    meta.textContent = status === 'route_unavailable' ? (['GREETING_INVALID', 'SCANNER_UNAVAILABLE', 'SCAN_FAILED', 'SCAN_RESULT_INVALID', 'ENTRY_INVALID', 'ROUTE_INVALID', 'UNKNOWN'].includes(state.diagnosticCode) ? state.diagnosticCode : 'UNKNOWN') : state.cardType || '';
    dot.className = 'status-dot ' + (recognitionFailed || normalizationWarning || ['disabled', 'mismatch', 'route_mismatch', 'route_unavailable', 'error', 'conflict'].includes(status) ? 'warn' : ['ready', 'route_ready'].includes(status) ? 'ready' : '');
    if (status === 'awaiting_card_type' || status === 'migrated') return renderChoices();
    if (['ready', 'route_ready'].includes(status)) return renderReady();
    const copy = status === 'disabled' ? ['千千结现在是关闭的', '不会读取聊天、扫描来源、调用 AI 或写入档案。已有数据保持原样。']
      : status === 'route_mismatch' ? ['路线来源需要确认', '当前路线已锁定，来源诊断仅作提示，不影响人物识别。']
      : status === 'route_unavailable' ? ['来源扫描不可用', '当前世界书无法进行安全的 dry-run 扫描，请稍后重试。']
        : status === 'mismatch' ? ['身份需要确认', '当前角色、Persona 或正式档案绑定不一致。为保护已有数据，本次只读。']
          : status === 'offline' ? ['暂时离线', '正式存储暂时不可用，恢复连接后可重新打开。']
            : status === 'stopped' ? ['还没有可用聊天', '请先打开一个单人聊天，再打开千千结。']
              : status === 'preparing' ? ['正在恢复档案', '请稍候，档案恢复完成前不能操作人物。']
                : status === 'renaming' ? ['正在恢复人物改名', '上次改名尚未完成，正在核对人物档案与列表。']
                : ['正在准备档案', '正式状态尚未就绪，请稍后重试。'];
    view.innerHTML = '<div class="empty"><div class="eyebrow">QIANQIANJIE / ' + status.toUpperCase() + '</div><h2>' + copy[0] + '</h2><p>' + copy[1] + '</p>' + (status === 'disabled' ? '<button class="open-settings" type="button">打开设置</button>' : '') + '</div>';
    view.querySelector?.('.open-settings')?.addEventListener('click', renderSettings);
  };

  const applyPeopleOperation = async operation => {
    if (busy) return;
    busy = true;
    try {
      const result = await operation();
      if (result?.status === 'conflict' || result?.status === 'error') { setState({ ...state, status: ['ready', 'route_ready'].includes(state.status) ? state.status : result.status, people: state.people, peopleError: '档案发生冲突，请稍后重试' }); return; }
      const refreshed = people?.getPeople ? await people.getPeople() : result;
      setState(state.peopleRecognitionFailed ? { ...state, people: refreshed } : { ...state, people: refreshed, peopleError: null });
    } catch { setState({ ...state, status: ['ready', 'route_ready'].includes(state.status) ? state.status : 'error', people: state.people, peopleError: '操作失败，原人物列表已保留' }); }
    finally { busy = false; }
  };
  const show = (source = document.activeElement) => { trigger = source; host.hidden = false; host.setAttribute('aria-hidden', 'false'); root.querySelector('.close').focus(); };
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const items = focusables(); if (!items.length) return; const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  root.querySelector('.close').addEventListener('click', close);
  root.querySelector('.settings-btn')?.addEventListener('click', () => { if (screen === 'settings') { settingsRenderEpoch += 1; screen = 'people'; const first = root.querySelector('.tab'); first?.classList.toggle('active', true); first?.setAttribute('aria-selected', 'true'); setState(state); } else renderSettings(); });
  root.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => { settingsRenderEpoch += 1; screen = 'people'; root.querySelectorAll('.tab').forEach(item => { const active = item === tab; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); }); setState(state); }));
  setState(state);
  return { host, root, show, close, setState, showSettings: renderSettings, getState: () => ({ ...state }) };
}
