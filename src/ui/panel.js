import html from './panel.html?raw';
import css from './panel.css?inline';

const types = [['single', '单人', '围绕一位角色，建立清晰的关系档案。'], ['multi', '多人', '记录群像关系与多角色互动。'], ['open_world', '大世界', '让角色档案连接到更大的世界。'], ['simulator', '模拟器', '用于测试关系变化与叙事走向。']];
const shellCss = ':host{position:fixed;inset:0;z-index:1001;width:100dvw;height:100dvh;pointer-events:none;background:transparent}:host([hidden]){display:none!important;pointer-events:none!important}.panel{position:fixed;top:80px;right:20px;width:360px;max-width:calc(100vw - 40px);max-height:85vh;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;pointer-events:auto}.body{min-height:0;max-height:none;overflow-y:auto}.tabs{min-width:0;overflow-x:auto;flex-wrap:nowrap}.tab{flex:0 0 auto}@media(max-width:640px){.panel{top:calc(20px + env(safe-area-inset-top,0px));left:50%;right:auto;bottom:auto;transform:translateX(-50%);width:calc(100dvw - 20px);max-width:calc(100dvw - 20px);height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));max-height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));min-height:0;border-radius:14px}.body{min-height:0;overflow-y:auto}.choices{grid-template-columns:1fr}.tab{padding-left:9px;padding-right:9px}}';

export function createPanel({ formal, people, settings, apiTools, loadState, initialRelations, reviewActions, onPluginEnabledChange, onClose } = {}) {
  const host = document.createElement('div');
  host.id = 'qqj-panel-host'; host.hidden = true; host.setAttribute('aria-hidden', 'true');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' + css + shellCss + '</style>' + html;
  const view = root.querySelector('.view'), label = root.querySelector('.status-label'), meta = root.querySelector('.status-meta'), dot = root.querySelector('.status-dot');
  let state = { status: 'loading' }, selected = null, selectedProfileId = null, busy = false, trigger = null, screen = 'people', activeTab = 'people', settingsDraftKey = '', settingsRenderEpoch = 0;
  let actionEpoch = 0, localRelationStatus = null, basicEditing = false, basicBusy = false, basicMessage = null;
  const focusables = () => [...root.querySelectorAll('button,input,select,textarea,[href],[tabindex]:not([tabindex="-1"])')].filter(item => !item.disabled && item.offsetParent !== null);
  const close = () => { actionEpoch += 1; host.hidden = true; host.setAttribute('aria-hidden', 'true'); const old = trigger; trigger = null; onClose?.(); old?.focus?.(); };

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

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const bindPeopleActions = container => {
    container.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', async () => {
      const confirmed = Array.isArray(state.people?.confirmed) ? state.people.confirmed : [];
      const name = globalThis.prompt?.('新的显示名', confirmed.find(item => item.identityId === button.dataset.edit)?.displayName ?? '');
      if (name?.trim() && people?.editDisplayName) await applyPeopleOperation(() => people.editDisplayName({ identityId: button.dataset.edit, displayName: name }));
    }));
    container.querySelectorAll('[data-select]').forEach(button => button.addEventListener('click', () => applyPeopleOperation(() => people.select({ identityId: button.dataset.select }))));
    container.querySelectorAll('[data-unselect]').forEach(button => button.addEventListener('click', () => applyPeopleOperation(() => people.unselect({ identityId: button.dataset.unselect }))));
    container.querySelectorAll('[data-shelve]').forEach(button => button.addEventListener('click', async () => {
      if (globalThis.confirm?.('搁置后人物会从主列表隐藏，但可随时恢复。继续吗？') && people?.shelve) await applyPeopleOperation(() => people.shelve({ identityId: button.dataset.shelve }));
    }));
    container.querySelectorAll('[data-restore]').forEach(button => button.addEventListener('click', () => applyPeopleOperation(() => people.restore({ identityId: button.dataset.restore }))));
  };

  const renderPeoplePool = container => {
    const confirmed = Array.isArray(state.people?.confirmed) ? state.people.confirmed : [];
    const candidates = Array.isArray(state.people?.candidate) ? state.people.candidate : [];
    const shelved = Array.isArray(state.people?.shelved) ? state.people.shelved : [];
    const warnings = Array.isArray(state.people?.warnings) ? state.people.warnings : [];
    const normalizationWarning = warnings.some(item => String(item?.code || '').startsWith('NORMALIZATION_'));
    const sourceWarning = warnings.some(item => !String(item?.code || '').startsWith('NORMALIZATION_'));
    if (sourceWarning) container.append(element('p', 'error', '部分原设来源当前不可用，已按其余来源继续。'));
    if (normalizationWarning) container.append(element('p', 'error', '部分人物格式已自动修正或跳过。'));
    if (state.peopleError) container.append(element('p', 'error', state.peopleError));

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
      container.append(list);
    } else if (!sourceWarning && !state.peopleError) {
      container.append(element('p', 'pool-empty', '当前来源尚未登记明确人物。'));
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
      container.append(pending);
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
      details.append(list); container.append(details);
    }
    bindPeopleActions(container);
  };

  const relationCopy = status => ({
    uninitialized: ['生成首次档案', '读取当前 Persona、已选择人物、作者设定与稳定聊天，整理出有来源的关系档案。'],
    generating: ['正在整理人物与关系', '正在生成首次档案；人物骨架和已保存内容不会被清空。'],
    applying: ['正在保存关系档案', '正在把已生成内容安全写入人物档案；继续时不会重复调用 AI。'],
    cancelled: ['已停止', '人物骨架和已保存进度都还在，可以稍后继续。'],
    failed_retryable: ['这次没有生成完成', '已有档案保持原样，可以重新尝试。'],
    storage_error: ['保存暂时失败', '已保存的部分仍在，可以重新加载后继续。'],
    conflict: ['档案刚刚发生变化', '请重新加载最新档案，再决定下一步。'],
    stale: ['当前页面已经过期', '聊天、Persona 或来源发生了变化，请重新加载。'],
    blocked_source_changed: ['作者来源已经变化', '可采用当前开场白与激活世界书；重新读取状态本身不会更新作者来源。'],
    adopted_sources: ['作者来源已更新', '当前开场白与世界书已经重新锚定；确认无误后，可生成首次档案。'],
    adopting_sources: ['正在采用当前作者来源', '正在重新锚定当前开场白与激活世界书，不会调用 AI。'],
    requires_rebuild: ['已有首次档案', '当前档案已经写入首次内容，不能直接换来源；需要另行重算。'],
    input_too_large: ['当前材料太长', '本次没有截断或生成内容；请先缩小来源范围。'],
    mismatch: ['身份需要确认', '当前聊天、角色或 Persona 与档案绑定不一致，本页保持只读。'],
    future_schema_readonly: ['档案来自更新版本', '当前版本只读显示，不会覆盖数据。'],
  })[status] || ['首次档案尚未完成', '重新加载后再试。'];

  const sourceLabel = item => {
    const kinds = [...new Set((Array.isArray(item?.sourceRefs) ? item.sourceRefs : []).map(ref => ({ persona: 'Persona', card: '角色卡', greeting: '开场白', worldbook: '世界书', chat: '稳定聊天' })[ref?.kind]).filter(Boolean))];
    return kinds.length ? kinds.join(' · ') : '来源未标注';
  };

  const relationTargetLabel = (item, names) => item?.relationToIdentityId && names.has(item.relationToIdentityId) ? `关系对象：${names.get(item.relationToIdentityId)}` : '';

  const renderFactLayer = (profile, key, title, description, names, { initialGenerated = true, canonCount = null } = {}) => {
    const section = element('section', `profile-layer ${key === 'sourceFacts' ? 'facts' : 'interpretations'}`);
    const heading = element('div', 'profile-layer-head'); heading.append(element('h3', '', title), element('p', '', description)); section.append(heading);
    const items = Array.isArray(profile?.[key]) ? profile[key] : [];
    if (!items.length) section.append(element('p', 'layer-empty', !initialGenerated ? '首次档案尚未生成。'
      : key === 'sourceFacts' ? '当前作者来源没有可展示的明确事实。'
        : canonCount === 0 ? '当前没有稳定聊天可供归纳。' : '当前稳定聊天没有可展示的 AI 归纳。'));
    for (const item of items) {
      const article = element('article', 'fact-item');
      article.append(element('p', 'fact-value', item?.value ?? ''), element('span', 'fact-source', sourceLabel(item)));
      const target = relationTargetLabel(item, names); if (target) article.append(element('span', 'fact-target', target));
      section.append(article);
    }
    return section;
  };

  const runInitialAction = async mode => {
    if (busy || !initialRelations?.[mode]) return;
    busy = true; localRelationStatus = mode === 'resume' ? 'applying' : mode === 'adoptCurrentSources' ? 'adopting_sources' : 'generating'; const mine = ++actionEpoch; renderReady();
    try {
      await initialRelations[mode]();
      if (mine !== actionEpoch || host.hidden) return;
      localRelationStatus = null; busy = false;
      await loadState?.();
    } finally { if (mine === actionEpoch) { busy = false; if (localRelationStatus) { localRelationStatus = null; renderReady(); } } }
  };

  const cancelInitialAction = () => {
    if (!initialRelations?.cancel) return;
    actionEpoch += 1; initialRelations.cancel(); busy = false; localRelationStatus = 'cancelled'; renderReady();
  };

  const resolveReview = async (profile, item, decision, card, focusTarget) => {
    if (card.dataset.busy === 'true' || !reviewActions?.resolvePendingReview || !reviewActions?.itemDigest) return;
    card.dataset.busy = 'true'; card.querySelectorAll('button').forEach(button => { button.disabled = true; });
    const mine = ++actionEpoch;
    try {
      const expectedItemDigest = await reviewActions.itemDigest(item);
      const result = await reviewActions.resolvePendingReview({ identityId: profile.identityId, pendingItemId: item.id, decision, expectedItemDigest });
      if (mine !== actionEpoch || host.hidden) return;
      await loadState?.();
      if (host.hidden) return;
      if (result?.status !== 'ready') {
        state = { ...state, reviewError: result?.status === 'conflict' ? '这条建议已经变化，请重新加载后再处理。' : '当前档案已变化，本次没有操作。' };
        renderReady();
      }
      (root.querySelector('.profile-tab.active') || focusTarget)?.focus?.();
    } catch {
      if (mine === actionEpoch) { state = { ...state, reviewError: '当前无法处理这条建议，原档案保持不变。' }; renderReady(); }
    }
  };

  const renderPending = (profile, names) => {
    const section = element('section', 'pending-section');
    const heading = element('div', 'section-heading'); heading.append(element('h3', '', '需要确认'), element('span', '', '只在你确认后加入正式档案')); section.append(heading);
    const items = Array.isArray(profile?.pendingReview) ? profile.pendingReview : [];
    if (!items.length) section.append(element('p', 'layer-empty', '当前没有需要你确认的内容。'));
    for (const item of items) {
      const card = element('article', 'pending-card');
      card.append(element('p', 'pending-value', item?.value ?? ''), element('p', 'pending-reason', item?.reason ? `为什么需要确认：${item.reason}` : '这条内容需要你判断。'));
      const metaLine = element('div', 'pending-meta');
      metaLine.append(element('span', '', item?.proposedLayer === 'sourceFacts' ? '拟加入：来源事实' : '拟加入：AI 归纳'), element('span', '', sourceLabel(item)));
      const target = relationTargetLabel(item, names); if (target) metaLine.append(element('span', '', target)); card.append(metaLine);
      const actions = element('div', 'pending-actions');
      const accept = element('button', 'primary-action', '确认加入'), reject = element('button', 'secondary-action', '拒绝');
      accept.type = reject.type = 'button'; actions.append(accept, reject); card.append(actions); section.append(card);
      accept.addEventListener('click', () => resolveReview(profile, item, 'accept', card, section));
      reject.addEventListener('click', () => resolveReview(profile, item, 'reject', card, section));
    }
    return section;
  };

  const basicFieldDefinitions = [
    ['name', '姓名'], ['gender', '性别'], ['age', '年龄'], ['appearance', '外貌'], ['personality', '性格'], ['identity', '身份'], ['nsfwPreferences', 'NSFW 喜好'],
    ['abilities', '能力'], ['likes', '喜好'], ['dislikes', '厌恶'], ['principles', '原则'], ['relationships', '人际关系'],
  ];
  const basicFieldRows = [
    ['name', 'gender', 'age'],
    ['appearance', 'personality', 'identity'],
    ['abilities', 'principles', 'nsfwPreferences'],
    ['likes', 'dislikes'],
    ['relationships'],
  ];

  const runBasicExtraction = async profile => {
    if (busy || basicBusy || !initialRelations?.extractBasicInfo) return;
    basicBusy = true; basicMessage = { kind: '', text: '正在提取基础信息…' }; renderReady(); const mine = ++actionEpoch;
    try {
      const result = await initialRelations.extractBasicInfo({ identityId: profile.identityId });
      if (mine !== actionEpoch || host.hidden) return;
      if (result?.status === 'ready') {
        const accepted = Number(result.acceptedFields) || 0, rejected = Number(result.rejectedFields) || 0;
        basicMessage = accepted === 0 && rejected > 0
          ? { kind: 'error', text: `AI 返回了 ${rejected} 项，但格式未能采用；原有基础信息保持不变。` }
          : { kind: 'success', text: result.emptyResult ? '提取完成，没有发现可可靠填写的新信息。' : `提取完成，采用了 ${accepted} 项。` };
        basicBusy = false;
        await loadState?.();
      } else basicMessage = { kind: 'error', text: result?.status === 'conflict' ? '档案刚刚发生变化，请重新加载后再试。' : result?.status === 'no_selected_character' ? '当前没有已选择人物，请先到人物池选择 C。' : '提取失败，原有基础信息保持不变。' };
    } catch { if (mine === actionEpoch) basicMessage = { kind: 'error', text: '提取失败，原有基础信息保持不变。' }; }
    finally { if (mine === actionEpoch) { basicBusy = false; renderReady(); } }
  };

  const saveBasicEdits = async (profile, registryName, section) => {
    if (busy || basicBusy) return;
    const controls = new Map([...section.querySelectorAll('[data-basic-field]')].map(node => [node.dataset.basicField, node]));
    basicBusy = true; basicMessage = { kind: '', text: '正在保存基础信息…' }; renderReady(); const mine = ++actionEpoch;
    try {
      const name = controls.get('name')?.value?.trim?.() || '';
      if (!name) throw new Error('姓名不能为空');
      if (name !== registryName) {
        const renamed = await people?.editDisplayName?.({ identityId: profile.identityId, displayName: name });
        if (renamed?.status === 'conflict' || renamed?.status === 'future_schema_readonly') throw new Error('姓名保存冲突');
      }
      for (const [field] of basicFieldDefinitions.slice(1)) {
        const value = controls.get(field)?.value ?? '';
        const previous = profile.basicFields?.[field]?.value ?? '';
        if (String(value).replace(/\r\n?/g, '\n').trim() === String(previous).replace(/\r\n?/g, '\n').trim()) continue;
        const saved = await initialRelations?.saveBasicField?.({ identityId: profile.identityId, field, value });
        if (saved?.status !== 'ready') throw new Error('字段保存冲突');
      }
      if (mine !== actionEpoch || host.hidden) return;
      basicEditing = false; basicMessage = { kind: 'success', text: '基础信息已保存；用户填写内容不会被重新提取覆盖。' };
      basicBusy = false;
      await loadState?.();
    } catch (error) { if (mine === actionEpoch) basicMessage = { kind: 'error', text: error?.message === '姓名不能为空' ? '姓名不能为空。' : '保存未全部完成；部分已成功字段可能已保存，请重新加载确认。' }; }
    finally { if (mine === actionEpoch) { basicBusy = false; renderReady(); } }
  };

  const renderBasicInfo = (profile, registryName) => {
    const section = element('section', 'basic-info');
    const head = element('div', 'basic-info-head');
    const copy = element('div'); copy.append(element('h3', '', '基础信息'), element('p', '', '只记录稳定且有依据的角色信息；缺失不会猜测。')); head.append(copy);
    const actions = element('div', 'basic-info-actions');
    if (!basicEditing) {
      const hasExtracted = Object.values(profile.basicFields || {}).some(item => item?.value);
      const extract = element('button', 'secondary-action', basicBusy ? '正在提取…' : hasExtracted ? '重新提取' : '提取基础信息'); extract.type = 'button'; extract.disabled = basicBusy; extract.addEventListener('click', () => runBasicExtraction(profile));
      const edit = element('button', 'secondary-action', '编辑'); edit.type = 'button'; edit.disabled = basicBusy; edit.addEventListener('click', () => { basicEditing = true; basicMessage = null; renderReady(); }); actions.append(extract, edit);
    }
    head.append(actions); section.append(head);
    const grid = element('div', 'basic-fields');
    const renderField = ([field, labelText]) => {
      const item = element('div', 'basic-field'); item.append(element('span', 'basic-label', labelText));
      const stored = field === 'name' ? registryName : profile.basicFields?.[field]?.value;
      if (basicEditing) {
        const input = document.createElement(field === 'name' || ['gender', 'age'].includes(field) ? 'input' : 'textarea'); input.dataset.basicField = field; input.value = stored || ''; input.maxLength = field === 'name' ? 120 : 2400; input.setAttribute('aria-label', labelText); item.append(input);
      } else {
        item.append(element('p', `basic-value ${stored ? '' : 'missing'}`.trim(), stored || '未提及'));
        if (field !== 'name' && stored) item.append(element('small', 'basic-source', profile.basicFields?.[field]?.provenance === 'user' ? '用户填写' : sourceLabel(profile.basicFields?.[field])));
      }
      return item;
    };
    const definitions = new Map(basicFieldDefinitions.map(definition => [definition[0], definition]));
    for (const fields of basicFieldRows) {
      const rowClass = fields.length === 3 ? 'basic-row-three' : fields.length === 2 ? 'basic-row-two basic-preference-row' : 'basic-row-one basic-relationships-row';
      const row = element('div', `basic-row ${rowClass}`);
      for (const field of fields) row.append(renderField(definitions.get(field)));
      grid.append(row);
    }
    section.append(grid);
    if (basicEditing) {
      const editActions = element('div', 'basic-edit-actions');
      const save = element('button', 'primary-action', basicBusy ? '正在保存…' : '保存基础信息'), cancel = element('button', 'secondary-action', '取消'); save.type = cancel.type = 'button'; save.disabled = cancel.disabled = basicBusy;
      save.addEventListener('click', () => saveBasicEdits(profile, registryName, section)); cancel.addEventListener('click', () => { basicEditing = false; basicMessage = null; renderReady(); }); editActions.append(save, cancel); section.append(editActions);
    }
    if (basicMessage) section.append(element('p', `basic-message ${basicMessage.kind}`.trim(), basicMessage.text));
    return section;
  };

  const renderGenerationBanner = (activeIds, hasSelectedCharacter) => {
    const persisted = state.initialRelations || state.peopleFoundation?.state?.initialGeneration || { status: 'uninitialized', completedMemberIds: [] };
    const lastAttempt = persisted.lastAttempt || state.peopleFoundation?.state?.lastAttempt;
    const adopted = lastAttempt?.action === 'adopt_current_sources' && lastAttempt?.status === 'ready';
    const status = localRelationStatus || (adopted && ['blocked_source_changed', 'uninitialized'].includes(persisted.status) ? 'adopted_sources' : persisted.status) || 'uninitialized';
    const completed = new Set(persisted.completedMemberIds || []), hasMissing = activeIds.some(id => !completed.has(id));
    const emptyResult = lastAttempt?.emptyResult === true;
    if (status === 'ready' && !hasMissing && !emptyResult) return null;
    const banner = element('section', 'generation-banner'); banner.setAttribute('aria-live', 'polite'); banner.setAttribute('aria-busy', String(['generating', 'applying'].includes(status)));
    const [title, description] = status === 'ready' && !hasMissing && emptyResult ? ['首次整理已完成', '没有可靠结果；人物骨架和用户内容保持不变。']
      : status === 'ready' && hasMissing ? ['有新人物等待补充', '只会为尚未完成的已选择人物生成首次档案。'] : relationCopy(status);
    banner.append(element('h3', '', title), element('p', '', description));
    if (persisted.status === 'blocked_source_changed' && lastAttempt?.sourceDiagnostics) {
      const diagnostic = lastAttempt.sourceDiagnostics;
      const greeting = diagnostic.greeting === 'changed' ? '开场白已变化' : diagnostic.greeting === 'unavailable' ? '开场白暂时无法读取' : '开场白未变化';
      const unreadable = Number(diagnostic.worldbookUnreadable) || 0;
      const unreadableCopy = unreadable > 0 ? `，暂时无法读取 ${unreadable} 条` : '';
      banner.append(element('p', 'source-change-summary', `${greeting}；世界书 ${Number(diagnostic.worldbookChanged) || 0} 条变化，${Number(diagnostic.worldbookMissing) || 0} 条缺失${unreadableCopy}。`));
    }
    const actions = element('div', 'generation-actions');
    if (['generating', 'applying'].includes(status)) {
      const cancel = element('button', 'secondary-action', '停止，稍后继续'); cancel.type = 'button'; cancel.addEventListener('click', cancelInitialAction); actions.append(cancel);
    } else if (status === 'blocked_source_changed') {
      const adopt = element('button', 'primary-action', '采用当前作者来源'); adopt.type = 'button'; adopt.disabled = busy; adopt.addEventListener('click', () => runInitialAction('adoptCurrentSources')); actions.append(adopt);
    } else if (!(status === 'ready' && !hasMissing) && !['mismatch', 'future_schema_readonly', 'input_too_large', 'requires_rebuild'].includes(status)) {
      const start = element('button', 'primary-action', status === 'ready' && hasMissing ? '为新人物补充档案' : status === 'cancelled' ? '继续整理档案' : '生成首次档案');
      start.type = 'button'; start.disabled = busy; start.addEventListener('click', () => runInitialAction(persisted.status === 'applying' ? 'resume' : 'start')); actions.append(start);
    }
    if (!['generating', 'applying'].includes(status)) {
      const reload = element('button', 'secondary-action', status === 'blocked_source_changed' ? '重新读取状态' : '重新加载'); reload.type = 'button'; reload.addEventListener('click', () => loadState?.({ announceLoading: true })); actions.append(reload);
    }
    if (!hasSelectedCharacter && status === 'uninitialized') banner.append(element('p', 'generation-hint', '还没有选择 C；可以先到“管理人物池”选择人物。'));
    if (actions.children?.length || actions.childNodes?.length) banner.append(actions);
    return banner;
  };

  const renderReady = () => {
    view.replaceChildren();
    const foundation = state.peopleFoundation;
    if (foundation?.status !== 'ready' || !Array.isArray(foundation.profiles)) {
      const fallback = element('div', 'empty'); fallback.append(element('div', 'eyebrow', 'PEOPLE / POOL'), element('h2', '', '先管理当前人物'), element('p', '', '选择只表示你当前想关注这位人物，不代表已经恋爱或发生关系。关系档案骨架尚未就绪时，人物池仍可查看和管理。'));
      renderPeoplePool(fallback); view.append(fallback); return;
    }
    const selectedCharacters = (Array.isArray(state.people?.confirmed) ? state.people.confirmed : []).filter(item => item.selection?.status === 'selected');
    const selectedIds = new Set(selectedCharacters.map(item => item.identityId));
    const registryNames = new Map(selectedCharacters.map(item => [item.identityId, item.displayName || '未命名人物']));
    const activeIds = [...selectedIds];
    const profiles = foundation.profiles.filter(profile => profile.subject === 'character' && selectedIds.has(profile.identityId));
    const profileMap = new Map(profiles.map(profile => [profile.identityId, profile]));
    if (!selectedProfileId || !profileMap.has(selectedProfileId)) selectedProfileId = profiles[0]?.identityId || null;
    const current = profileMap.get(selectedProfileId);
    const persisted = state.initialRelations || foundation.state?.initialGeneration || { status: 'uninitialized', completedMemberIds: [] };
    const completed = new Set(persisted.completedMemberIds || []);
    const canonCount = Number.isInteger(persisted.lastAttempt?.canonCount) ? persisted.lastAttempt.canonCount
      : Number.isInteger(foundation.state?.lastAttempt?.canonCount) ? foundation.state.lastAttempt.canonCount
        : Number.isInteger(foundation.state?.canonRef?.canonLength) ? foundation.state.canonRef.canonLength : null;
    const names = new Map([[foundation.state?.personaId, '我'], ...profiles.map(profile => [profile.identityId, registryNames.get(profile.identityId) || profile.displayName || '未命名人物'])]);
    const page = element('div', 'people-page');
    const banner = renderGenerationBanner(activeIds, profiles.length > 0); if (banner) page.append(banner);
    const switcher = element('div', 'profile-switcher'); switcher.setAttribute('role', 'tablist'); switcher.setAttribute('aria-label', '切换人物档案');
    for (const profile of profiles) {
      const button = element('button', `profile-tab ${profile.identityId === selectedProfileId ? 'active' : ''}`.trim()); button.type = 'button'; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(profile.identityId === selectedProfileId));
      button.append(element('span', 'subject-tag tag-c', 'C'), element('span', '', names.get(profile.identityId)));
      button.addEventListener('click', () => { selectedProfileId = profile.identityId; basicEditing = false; basicMessage = null; renderReady(); }); switcher.append(button);
    }
    page.append(switcher);
    if (!current) page.append(element('p', 'layer-empty', '还没有已选择的 C。请展开“管理人物池”并选择一位人物。'));
    else {
      const dossier = element('section', 'dossier-card');
      const summary = element('header', 'profile-summary'); summary.append(element('span', 'subject-tag tag-c', 'C'));
      const heading = element('div'); heading.append(element('h2', '', names.get(current.identityId)), element('p', '', '当前已选择人物的稳定关系档案')); summary.append(heading); dossier.append(summary);
      dossier.append(renderBasicInfo(current, names.get(current.identityId)));
      const layerOptions = { initialGenerated: completed.has(current.identityId), canonCount };
      dossier.append(renderFactLayer(current, 'sourceFacts', '来源事实', '来自 Persona、角色卡、开场白或世界书的明确内容', names, layerOptions));
      dossier.append(renderFactLayer(current, 'interpretations', 'AI 归纳', '只根据稳定聊天整理，不覆盖来源事实', names, layerOptions));
      if (state.reviewError) dossier.append(element('p', 'error review-error', state.reviewError));
      dossier.append(renderPending(current, names)); page.append(dossier);
    }
    const pool = element('details', 'people-pool');
    const summary = element('summary', '', '管理人物池'); pool.append(summary);
    const intro = element('p', 'pool-intro', '选择、取消选择、改名、搁置或恢复人物。这里的选择只表示当前关注，不代表关系已经成立。'); pool.append(intro);
    renderPeoplePool(pool); page.append(pool); view.append(page);
  };

  const renderUnavailableModule = () => {
    const names = { bonds: '双丝网', milestones: '千事', knots: '千结' };
    const empty = element('div', 'empty');
    empty.append(element('div', 'eyebrow', 'COMING LATER'), element('h2', '', names[activeTab] || '此模块'), element('p', '', '尚未接入业务数据。本次只完成千人关系档案。'));
    view.replaceChildren(empty);
  };

  const setState = next => {
    if (localRelationStatus === 'cancelled' && next?.status === 'stale' && ['ready', 'route_ready'].includes(state?.status)) {
      busy = false; renderReady(); return;
    }
    actionEpoch += 1; busy = false; localRelationStatus = null;
    state = next || { status: 'error' };
    if (screen === 'settings') return;
    if (activeTab !== 'people') return renderUnavailableModule();
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
    const empty = element('div', 'empty');
    empty.append(element('div', 'eyebrow', 'QIANQIANJIE'), element('h2', '', copy[0]), element('p', '', copy[1]));
    if (status === 'disabled') { const button = element('button', 'open-settings', '打开设置'); button.type = 'button'; button.addEventListener('click', renderSettings); empty.append(button); }
    view.replaceChildren(empty);
  };

  const applyPeopleOperation = async operation => {
    if (busy) return;
    busy = true;
    try {
      const result = await operation();
      if (result?.status === 'conflict' || result?.status === 'error') { setState({ ...state, status: ['ready', 'route_ready'].includes(state.status) ? state.status : result.status, people: state.people, peopleError: '档案发生冲突，请稍后重试' }); return; }
      if (typeof loadState === 'function') { await loadState(); return; }
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
  root.querySelector('.settings-btn')?.addEventListener('click', () => { if (screen === 'settings') { settingsRenderEpoch += 1; screen = 'people'; activeTab = 'people'; root.querySelectorAll('.tab').forEach((item, index) => { item.classList.toggle('active', index === 0); item.setAttribute('aria-selected', String(index === 0)); }); setState(state); } else renderSettings(); });
  root.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => { settingsRenderEpoch += 1; screen = 'people'; activeTab = tab.dataset.tab || 'people'; root.querySelectorAll('.tab').forEach(item => { const active = item === tab; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); }); setState(state); }));
  setState(state);
  return { host, root, show, close, setState, showSettings: renderSettings, getState: () => ({ ...state }) };
}
