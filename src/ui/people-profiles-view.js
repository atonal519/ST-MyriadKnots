const PROFILE_FIELDS = Object.freeze(['name', 'aliases', 'background', 'appearance', 'personality', 'notes']);
const LABELS = Object.freeze({ name: '姓名', aliases: '别名', background: '身份背景', appearance: '外貌', personality: '基础性格', notes: '补充说明' });
const PLACEHOLDERS = Object.freeze({ name: '人物姓名', aliases: '多个别名可用顿号或换行分隔', background: '仅填写不会随剧情变化的身份与背景', appearance: '稳定外貌特征', personality: '基础性格，不写临时情绪', notes: '其他静态基础信息' });

function fieldsFrom(person) {
  const profile = person?.profile;
  return {
    name: profile ? profile.name : person?.entityDisplayName ?? '',
    aliases: profile ? profile.aliases : (person?.aliases ?? []).join('、'),
    background: profile?.background ?? '', appearance: profile?.appearance ?? '',
    personality: profile?.personality ?? '', notes: profile?.notes ?? '',
  };
}
function sameFields(left, right) { return PROFILE_FIELDS.every(field => String(left?.[field] ?? '') === String(right?.[field] ?? '')); }

export function createPeopleProfilesView({ runtime, documentRef = globalThis.document } = {}) {
  if (!runtime || ['getState', 'refresh', 'setSelectedEntityIds', 'saveProfile', 'generateMissingProfiles'].some(name => typeof runtime[name] !== 'function')) throw new TypeError('千人人物资料 runtime 无效');
  if (!documentRef?.createElement) throw new TypeError('千人人物资料 documentRef 无效');
  let container = null, active = false, epoch = 0, unsubscribe = null, state = runtime.getState(), chatId = state.chatId ?? null, feedback = '';
  let currentEntityId = null, showMore = false;
  const drafts = new Map();
  const element = (tag, className = '', text = '') => { const node = documentRef.createElement(tag); if (className) node.className = className; if (text !== '') node.textContent = text; return node; };
  const busyExceptGeneration = value => Boolean(value.active && value.active.kind !== 'generating');
  const statusCopy = value => {
    if (value.status === 'disabled') return '千千结已关闭';
    if (value.active?.kind === 'loading') return '正在读取当前聊天的人物资料';
    if (value.active?.kind === 'generating') return `正在整理 ${value.unprofiledSelectedCount} 位未建档人物`;
    if (value.active?.kind === 'savingSelection') return '正在保存重要人物选择';
    if (value.active?.kind === 'savingProfile') return '正在保存人物资料';
    if (value.lastError?.message) return `需要处理 · ${value.lastError.message}`;
    return `已选 ${value.people.filter(person => person.selected).length} 位重要人物 · ${value.unprofiledSelectedCount} 位待建档`;
  };
  function resetForChat(nextChatId) {
    if (chatId === nextChatId) return;
    chatId = nextChatId; drafts.clear(); currentEntityId = null; showMore = false; feedback = '';
  }
  async function run(label, task, { after = null } = {}) {
    const mine = ++epoch, operationChatId = chatId; feedback = `${label}…`; render(state);
    try {
      const result = await task(); state = runtime.getState();
      if ((state.chatId ?? null) === operationChatId) after?.(state);
      if (active && mine === epoch) { feedback = `${label}完成。`; render(state); }
      return result;
    } catch (error) {
      state = runtime.getState();
      if (active && mine === epoch) { feedback = `${label}失败：${error?.message || '未知错误'}`; render(state); }
      return { status: 'error', error };
    }
  }
  function selectionButton(person, selectedIds) {
    const selected = new Set(selectedIds);
    const button = element('button', person.selected ? 'secondary-action' : 'primary-action', person.selected ? '移出关注' : '设为重要');
    button.type = 'button'; button.disabled = busyExceptGeneration(state);
    button.addEventListener('click', () => {
      const operationChatId = chatId, before = state.people.filter(item => item.selected).map(item => item.entityId), removingCurrent = person.selected && currentEntityId === person.entityId;
      let nextCurrent = currentEntityId;
      if (person.selected) {
        selected.delete(person.entityId);
        if (removingCurrent) { const index = before.indexOf(person.entityId); nextCurrent = before[index + 1] ?? before[index - 1] ?? null; }
      } else { selected.add(person.entityId); if (!currentEntityId) nextCurrent = person.entityId; }
      void run(person.selected ? '移出关注人物' : '加入重要人物', () => runtime.setSelectedEntityIds([...selected]), {
        after: next => { if ((next.chatId ?? null) === operationChatId) currentEntityId = nextCurrent; },
      });
    });
    return button;
  }
  function profileDraft(person, beginEditing = false) {
    let draft = drafts.get(person.entityId);
    let editing = beginEditing || draft?.editing === true;
    if (draft && person.profiled && !draft.wasProfiled && !draft.dirty && !draft.saving) { draft = null; editing = true; }
    if (!draft) {
      const initial = fieldsFrom(person);
      draft = { ...initial, original: { ...initial }, wasProfiled: person.profiled, dirty: false, saving: false, editing, error: '', notice: '' };
      drafts.set(person.entityId, draft);
    }
    if (beginEditing) draft.editing = true;
    return draft;
  }
  function saveProfile(person, draft) {
    const current = fieldsFrom(person);
    if (person.profiled && sameFields(draft, current)) { draft.editing = false; draft.notice = '未修改内容'; draft.error = ''; render(state); return; }
    const token = Object.freeze({ chatId, entityId: person.entityId, draft });
    const payload = Object.fromEntries(PROFILE_FIELDS.map(field => [field, draft[field]]));
    draft.saving = true; draft.notice = '保存中…'; draft.error = ''; render(state);
    void runtime.saveProfile(person.entityId, payload).then(() => {
      const next = runtime.getState(); state = next;
      if ((next.chatId ?? null) !== token.chatId || drafts.get(token.entityId) !== token.draft) return;
      const updated = next.people.find(item => item.entityId === token.entityId);
      if (!updated?.profiled) {
        token.draft.saving = false; token.draft.notice = ''; token.draft.error = '保存失败：没有读到已保存资料';
      } else {
        const saved = fieldsFrom(updated);
        drafts.set(token.entityId, { ...saved, original: { ...saved }, wasProfiled: true, dirty: false, saving: false, editing: false, error: '', notice: '已保存' });
      }
      if (active) render(next);
    }, error => {
      const next = runtime.getState(); state = next;
      if ((next.chatId ?? null) !== token.chatId || drafts.get(token.entityId) !== token.draft) return;
      token.draft.saving = false; token.draft.editing = true; token.draft.notice = ''; token.draft.error = `保存失败：${error?.message || '未知错误'}`;
      if (active) render(next);
    });
  }
  function profilePanel(person) {
    const panel = element('section', 'qqj-profile-card');
    const header = element('header', 'qqj-profile-summary');
    header.append(element('strong', '', person.displayName || person.entityDisplayName));
    if (person.recommended) header.append(element('span', 'qqj-recommend-badge', '推荐'));
    header.append(element('span', 'v3-memory-status', person.profiled ? '已建档' : '待建档'));
    panel.append(header);
    const body = element('div', 'qqj-profile-body'), draft = drafts.has(person.entityId) ? profileDraft(person) : null;
    if (draft?.editing) {
      const form = element('div', 'qqj-profile-form');
      for (const field of PROFILE_FIELDS) {
        const label = element('label', 'qqj-profile-field'); label.append(element('span', '', LABELS[field]));
        const input = field === 'name' ? element('input', 'settings-input') : element('textarea', 'settings-input');
        input.value = draft[field]; input.placeholder = PLACEHOLDERS[field]; input.disabled = draft.saving || busyExceptGeneration(state);
        input.addEventListener('input', () => { draft[field] = input.value; draft.dirty = !sameFields(draft, draft.original); draft.notice = ''; draft.error = ''; });
        label.append(input); form.append(label);
      }
      const actions = element('div', 'qqj-profile-save-row');
      const save = element('button', 'primary-action', draft.saving ? '保存中…' : '保存资料'); save.type = 'button'; save.disabled = draft.saving || busyExceptGeneration(state);
      save.addEventListener('click', () => saveProfile(person, draft)); actions.append(save);
      const cancel = element('button', 'secondary-action', '取消'); cancel.type = 'button'; cancel.disabled = draft.saving || busyExceptGeneration(state);
      cancel.addEventListener('click', () => { drafts.delete(person.entityId); render(state); }); actions.append(cancel, selectionButton(person, state.selectedEntityIds));
      if (draft.notice || draft.error) actions.append(saveResult(draft));
      form.append(actions); body.append(form);
    } else {
      const values = fieldsFrom(person), facts = element('dl', 'qqj-profile-facts');
      for (const field of PROFILE_FIELDS) { const row = element('div', 'qqj-profile-fact'); row.append(element('dt', '', LABELS[field]), element('dd', '', values[field] || '未填写')); facts.append(row); }
      body.append(facts);
      const actions = element('div', 'qqj-profile-save-row'), edit = element('button', 'primary-action', '编辑资料'); edit.type = 'button'; edit.disabled = busyExceptGeneration(state);
      edit.addEventListener('click', () => { profileDraft(person, true); render(state); }); actions.append(edit, selectionButton(person, state.selectedEntityIds));
      if (draft?.notice || draft?.error) actions.append(saveResult(draft)); body.append(actions);
    }
    panel.append(body); return panel;
  }
  function saveResult(draft) {
    const result = element('p', `qqj-profile-save-result${draft.error ? ' error' : draft.notice === '已保存' ? ' success' : ''}`, draft.error || draft.notice);
    result.setAttribute?.('role', 'status'); result.setAttribute?.('aria-live', 'polite'); return result;
  }
  function switcher(selected) {
    const bar = element('div', 'qqj-profile-switcher'); bar.setAttribute?.('role', 'tablist'); bar.setAttribute?.('aria-label', '重要人物切换');
    selected.forEach((person, index) => {
      const selectedTab = person.entityId === currentEntityId;
      const displayName = person.displayName || person.entityDisplayName;
      const button = element('button', `qqj-profile-tab${selectedTab ? ' active' : ''}`, displayName);
      button.type = 'button'; button.tabIndex = selectedTab ? 0 : -1; button.setAttribute?.('role', 'tab'); button.setAttribute?.('aria-selected', selectedTab ? 'true' : 'false');
      button.setAttribute?.('title', displayName);
      button.addEventListener('click', () => { currentEntityId = person.entityId; showMore = false; feedback = ''; render(state); });
      button.addEventListener('keydown', event => {
        const offsets = { ArrowLeft: -1, ArrowRight: 1 }, offset = offsets[event.key];
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? selected.length - 1 : Number.isInteger(offset) ? (index + offset + selected.length) % selected.length : null;
        if (target === null || !selected[target]) return; event.preventDefault?.(); currentEntityId = selected[target].entityId; showMore = false; render(state);
        container?.querySelector?.('.qqj-profile-tab.active')?.focus?.();
      });
      bar.append(button);
    });
    if (!selected.length) bar.append(element('span', 'qqj-profile-switch-empty', '尚未选择重要人物'));
    return bar;
  }
  function peoplePicker(people) {
    const picker = element('section', 'qqj-profile-picker'), heading = element('header', 'qqj-profile-picker-heading');
    heading.append(element('strong', '', '更多人物'), element('span', 'v3-memory-status', `${people.length} 位已识别人物`)); picker.append(heading);
    const list = element('div', 'qqj-more-people-list');
    for (const person of people) {
      const row = element('div', 'qqj-more-person-row'), copy = element('div', 'qqj-more-person-copy');
      copy.append(element('strong', '', person.displayName || person.entityDisplayName));
      const detail = [person.selected ? '已选重要' : '', person.profiled ? '已建档' : '', person.aliases.length ? `别名：${person.aliases.join('、')}` : '', person.appearanceCount ? `出现 ${person.appearanceCount} 楼` : '', person.recommended ? '推荐' : ''].filter(Boolean).join(' · ');
      copy.append(element('small', '', detail || '已发现人物')); row.append(copy, selectionButton(person, state.selectedEntityIds)); list.append(row);
    }
    if (!people.length) list.append(element('p', 'settings-hint', '当前没有已识别人物。后续摘要和状态分析仍会正常发现人物。'));
    picker.append(list); return picker;
  }
  function render(next = runtime.getState()) {
    state = next; resetForChat(state.chatId ?? null); if (!container) return;
    const page = element('section', 'qqj-page qqj-profiles-page');
    const heading = element('header', 'qqj-view-heading'); heading.append(element('h2', '', '千人'), element('p', '', '自由选择重要人物，并维护不会随剧情自动变化的基础资料。'));
    heading.append(element('p', `qqj-page-health${state.lastError ? ' error' : ''}`, statusCopy(state))); page.append(heading);
    if (feedback) page.append(element('p', `v3-foundation-feedback${feedback.includes('失败') ? ' error' : ''}`, feedback));
    const selected = state.people.filter(person => person.selected), moreCount = state.people.length - selected.length;
    if (!selected.some(person => person.entityId === currentEntityId)) currentEntityId = selected[0]?.entityId ?? null;
    const toolbar = element('div', 'qqj-profile-toolbar'), switchRow = element('div', 'qqj-profile-switch-row'); switchRow.append(switcher(selected));
    const actions = element('div', 'qqj-profile-toolbar-actions');
    const generate = element('button', 'secondary-action', state.active?.kind === 'generating' ? '正在整理…' : `整理基础资料${state.unprofiledSelectedCount ? `（${state.unprofiledSelectedCount}）` : ''}`);
    generate.type = 'button'; generate.disabled = Boolean(state.active) || state.unprofiledSelectedCount < 1;
    generate.addEventListener('click', () => { void run('整理基础资料', () => runtime.generateMissingProfiles()); }); actions.append(generate);
    const more = element('button', `secondary-action qqj-profile-more${showMore ? ' active' : ''}`, showMore ? '返回资料' : `更多人物（${moreCount}）`);
    more.type = 'button'; more.addEventListener('click', () => { showMore = !showMore; feedback = ''; render(state); }); actions.append(more); switchRow.append(actions); toolbar.append(switchRow); page.append(toolbar);
    if (showMore) page.append(peoplePicker(state.people));
    else {
      const current = selected.find(person => person.entityId === currentEntityId);
      if (current) page.append(profilePanel(current));
      else page.append(element('div', 'qqj-inline-empty', '尚未选择重要人物。点击上方“更多人物”即可自由选择，选择 0 位也完全可以。'));
    }
    const unavailable = state.selectedEntityIds.length - selected.length;
    if (unavailable > 0) page.append(element('p', 'settings-hint', `有 ${unavailable} 个旧人物选择在当前记忆图中暂不可匹配；其选择与资料仍保留。`));
    container.replaceChildren(page);
  }
  function subscribe() {
    if (!active || unsubscribe || typeof runtime.subscribe !== 'function') return;
    const release = runtime.subscribe(next => { state = next; if (active && container) render(next); });
    if (typeof release === 'function') unsubscribe = release;
  }
  function mount(target) { unsubscribe?.(); unsubscribe = null; container = target; active = true; render(runtime.getState()); subscribe(); }
  async function activate() {
    if (!container) throw new Error('千人人物资料 view 尚未挂载');
    active = true; subscribe(); const mine = ++epoch; feedback = '正在读取当前聊天…'; render(runtime.getState());
    try { const result = await runtime.refresh(); if (!active || mine !== epoch) return { status: 'stale' }; state = result; feedback = ''; render(result); return result; }
    catch (error) { if (!active || mine !== epoch) return { status: 'stale' }; state = runtime.getState(); feedback = `读取失败：${error?.message || '未知错误'}`; render(state); return { status: 'error', error }; }
  }
  function deactivate() { active = false; epoch += 1; unsubscribe?.(); unsubscribe = null; }
  return Object.freeze({ mount, activate, deactivate, render });
}
