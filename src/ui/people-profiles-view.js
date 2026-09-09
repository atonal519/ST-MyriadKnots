import { KNOT_ICON_SVG } from './brand.js';
import { createOperationMenuController } from './operation-menu-controller.js';
import { PEOPLE_PROFILE_FIELDS, PEOPLE_PROFILE_GROUPS, PEOPLE_PROFILE_LABELS, emptyPeopleProfileFields } from '../v3/people-profile-fields.js';
import { avatarCropLayout, cropAvatarDataUrl, loadAvatarSource } from './avatar-cropper.js';

const PLACEHOLDERS = Object.freeze({ name: '人物姓名', aliases: '多个别名可用顿号或换行分隔', gender: '有明确依据时填写', age: '不把外观年龄当作实际年龄', birthday: '有明确依据时填写', species: '种族或物种', notes: '其他稳定基础资料', appearance: '旧资料或难归类的外貌补充', background: '稳定的背景经历', personality: '长期核心性格', nsfw: '有明确依据的成人向资料' });

function fieldsFrom(person) {
  const profile = person?.profile;
  const result = emptyPeopleProfileFields();
  for (const field of PEOPLE_PROFILE_FIELDS) result[field] = profile?.[field] ?? '';
  if (!profile) { result.name = person?.entityDisplayName ?? ''; result.aliases = (person?.aliases ?? []).join('、'); }
  return result;
}
function sameFields(left, right) { return PEOPLE_PROFILE_FIELDS.every(field => String(left?.[field] ?? '') === String(right?.[field] ?? '')); }

export function createPeopleProfilesView({ runtime, dialog = null, documentRef = globalThis.document, imageFactory = () => new Image(), urlApi = globalThis.URL } = {}) {
  if (!runtime || ['getState', 'refresh', 'setSelectedEntityIds', 'saveProfile', 'saveAvatar', 'generateMissingProfiles', 'regenerateProfile'].some(name => typeof runtime[name] !== 'function')) throw new TypeError('千人人物资料 runtime 无效');
  if (!documentRef?.createElement) throw new TypeError('千人人物资料 documentRef 无效');
  let container = null, active = false, epoch = 0, unsubscribe = null, state = runtime.getState(), chatId = state.chatId ?? null, feedback = '人物资料状态已显示。';
  let currentEntityId = null, showMore = false, cropDraft = null, cropLoadId = 0, cropLoadController = null;
  let switcherNode = null, switcherSignature = null, switcherScrollLeft = 0;
  const drafts = new Map();
  const operationMenus = createOperationMenuController(documentRef);
  const releaseCrop = draft => { draft?.source?.release?.(); if (cropDraft === draft) cropDraft = null; };
  const closeCrop = () => {
    cropLoadId += 1; cropLoadController?.abort(); cropLoadController = null;
    const draft = cropDraft;
    if (draft?.dialogOpen && dialog?.cancelTop?.()) return;
    releaseCrop(draft);
  };
  const element = (tag, className = '', text = '') => { const node = documentRef.createElement(tag); if (className) node.className = className; if (text !== '') node.textContent = text; return node; };
  const busyExceptGeneration = value => Boolean(value.active && value.active.kind !== 'generating');
  const statusCopy = value => {
    if (value.status === 'disabled') return '千千结已关闭';
    if (value.active?.kind === 'loading') return '正在读取当前聊天的人物资料';
    if (value.active?.kind === 'generating') return '正在整理人物资料';
    if (value.active?.kind === 'savingSelection') return '正在保存重要人物选择';
    if (value.active?.kind === 'savingProfile') return '正在保存人物资料';
    if (value.lastError?.message) return `需要处理 · ${value.lastError.message}`;
    return `已选 ${value.people.filter(person => person.selected).length} 位重要人物 · ${value.unprofiledSelectedCount} 位待建档`;
  };
  const healthClass = value => {
    if (value.lastError) return 'qqj-page-health qqj-profile-health error';
    const checking = Boolean(value.active) || !['ready', 'empty'].includes(value.status);
    return `qqj-page-health qqj-profile-health ${checking ? 'checking' : 'healthy'}`;
  };
  function resetForChat(nextChatId) {
    if (chatId === nextChatId) return;
    closeCrop(); chatId = nextChatId; drafts.clear(); currentEntityId = null; showMore = false; switcherNode = null; switcherSignature = null; switcherScrollLeft = 0; feedback = '人物资料状态已显示。';
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
      draft = { ...initial, original: { ...initial }, dirtyFields: new Set(), wasProfiled: person.profiled, dirty: false, saving: false, editing, error: '', notice: '' };
      drafts.set(person.entityId, draft);
    }
    if (beginEditing) draft.editing = true;
    return draft;
  }
  function saveProfile(person, draft) {
    const current = fieldsFrom(person);
    if (person.profiled && sameFields(draft, current)) { draft.editing = false; draft.notice = '未修改内容'; draft.error = ''; render(state); return; }
    const token = Object.freeze({ chatId, entityId: person.entityId, draft });
    const payload = Object.fromEntries(PEOPLE_PROFILE_FIELDS.map(field => [field, draft[field]]));
    draft.saving = true; draft.notice = '保存中…'; draft.error = ''; render(state);
    void runtime.saveProfile(person.entityId, payload, { manualFields: [...draft.dirtyFields] }).then(() => {
      const next = runtime.getState(); state = next;
      if ((next.chatId ?? null) !== token.chatId || drafts.get(token.entityId) !== token.draft) return;
      const updated = next.people.find(item => item.entityId === token.entityId);
      if (!updated?.profiled) {
        token.draft.saving = false; token.draft.notice = ''; token.draft.error = '保存失败：没有读到已保存资料';
      } else {
        const saved = fieldsFrom(updated);
        drafts.set(token.entityId, { ...saved, original: { ...saved }, dirtyFields: new Set(), wasProfiled: true, dirty: false, saving: false, editing: false, error: '', notice: '已保存' });
      }
      if (active) render(next);
    }, error => {
      const next = runtime.getState(); state = next;
      if ((next.chatId ?? null) !== token.chatId || drafts.get(token.entityId) !== token.draft) return;
      token.draft.saving = false; token.draft.editing = true; token.draft.notice = ''; token.draft.error = `保存失败：${error?.message || '未知错误'}`;
      if (active) render(next);
    });
  }
  function generationButton(className = 'secondary-action') {
    const button = element('button', className, state.active?.kind === 'generating' ? '正在整理…' : `整理待建档人物${state.unprofiledSelectedCount ? `（${state.unprofiledSelectedCount}）` : ''}`);
    button.type = 'button'; button.disabled = Boolean(state.active) || state.unprofiledSelectedCount < 1;
    button.addEventListener('click', () => { void run('整理基础资料', () => runtime.generateMissingProfiles()); });
    return button;
  }
  function personGenerationButton(person, className = 'secondary-action') {
    const label = person.profiled ? '重新整理资料' : '整理当前资料';
    const button = element('button', className, state.active?.kind === 'generating' ? '正在整理…' : label);
    button.type = 'button'; button.disabled = Boolean(state.active);
    button.addEventListener('click', () => { void run(label, () => runtime.regenerateProfile(person.entityId)); });
    return button;
  }
  async function chooseAvatar(person, mark, file) {
    cropLoadController?.abort();
    const controller = new AbortController(); cropLoadController = controller;
    const loadId = ++cropLoadId, operationChatId = chatId, entityId = person.entityId;
    const rect = mark.getBoundingClientRect?.() ?? {};
    const aspectRatio = Number(rect.width) > 0 && Number(rect.height) > 0 ? rect.width / rect.height : fieldsFrom(person).aliases ? 5 / 6 : 1;
    try {
      const source = await loadAvatarSource(file, { imageFactory, urlApi, signal: controller.signal });
      if (loadId !== cropLoadId || chatId !== operationChatId || currentEntityId !== entityId) { source.release(); return; }
      cropLoadController = null; closeCrop();
      const draft = { entityId, chatId: operationChatId, source, aspectRatio, zoom: 1, offsetX: 0, offsetY: 0, saving: false, dialogOpen: false };
      cropDraft = draft;
      if (!dialog?.custom) { releaseCrop(draft); feedback = '当前环境无法打开头像裁剪窗口。'; render(state); return; }
      const crop = avatarCropContent(person, draft); draft.dialogOpen = true;
      void dialog.custom({ title: '裁剪头像', content: crop.content, confirmText: '确认头像', cancelText: '取消', submit: crop.submit,
        onClose: () => { draft.dialogOpen = false; releaseCrop(draft); } }).then(saved => {
          if (saved && chatId === operationChatId && currentEntityId === entityId) { state = runtime.getState(); feedback = '头像已保存。'; if (active) render(state); }
        });
    } catch (error) {
      if (cropLoadController === controller) cropLoadController = null;
      if (error?.name !== 'AbortError' && loadId === cropLoadId && chatId === operationChatId && currentEntityId === entityId) { feedback = `头像读取失败：${error?.message || '未知错误'}`; render(state); }
    }
  }
  function avatarCropContent(person, draft) {
    const panel = element('section', 'qqj-avatar-crop-panel');
    const frame = element('div', 'qqj-avatar-crop-frame'), image = element('img', 'qqj-avatar-crop-image');
    frame.style?.setProperty?.('--qqj-avatar-aspect', String(draft.aspectRatio)); image.src = draft.source.objectUrl; image.alt = '';
    const applyPreview = () => {
      const layout = avatarCropLayout({ naturalWidth: draft.source.image.naturalWidth, naturalHeight: draft.source.image.naturalHeight, frameWidth: 240, frameHeight: 240 / draft.aspectRatio, zoom: draft.zoom, offsetX: draft.offsetX, offsetY: draft.offsetY });
      draft.zoom = layout.zoom; draft.offsetX = layout.offsetX; draft.offsetY = layout.offsetY;
      if (image.style) { image.style.width = `${layout.width}px`; image.style.height = `${layout.height}px`; image.style.left = `${layout.left}px`; image.style.top = `${layout.top}px`; }
    };
    let pointer = null;
    frame.addEventListener('pointerdown', event => { if (draft.saving) return; pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, offsetX: draft.offsetX, offsetY: draft.offsetY }; frame.setPointerCapture?.(event.pointerId); });
    frame.addEventListener('pointermove', event => { if (!pointer || event.pointerId !== pointer.id) return; event.preventDefault?.(); draft.offsetX = pointer.offsetX + event.clientX - pointer.x; draft.offsetY = pointer.offsetY + event.clientY - pointer.y; applyPreview(); });
    const endPointer = event => { if (!pointer || (event.pointerId !== undefined && event.pointerId !== pointer.id)) return; frame.releasePointerCapture?.(pointer.id); pointer = null; };
    frame.addEventListener('pointerup', endPointer); frame.addEventListener('pointercancel', endPointer); frame.append(image); applyPreview(); panel.append(frame);
    const zoomLabel = element('label', 'qqj-avatar-zoom'); zoomLabel.append(element('span', '', '缩放'));
    const zoom = element('input', 'settings-input'); zoom.type = 'range'; zoom.min = '1'; zoom.max = '3'; zoom.step = '0.01'; zoom.value = String(draft.zoom); zoom.disabled = draft.saving;
    zoom.addEventListener('input', () => { draft.zoom = Number(zoom.value); applyPreview(); }); zoomLabel.append(zoom); panel.append(zoomLabel);
    const submit = async () => {
      let dataUrl;
      dataUrl = cropAvatarDataUrl({ image: draft.source.image, aspectRatio: draft.aspectRatio, zoom: draft.zoom, offsetX: draft.offsetX, offsetY: draft.offsetY, canvas: documentRef.createElement('canvas') });
      const token = { chatId, entityId: person.entityId, draft }; draft.saving = true;
      try {
        await runtime.saveAvatar(person.entityId, dataUrl);
        if (chatId !== token.chatId || cropDraft !== token.draft || currentEntityId !== token.entityId) throw new Error('页面已切换，本次头像没有应用到当前页面。');
        return true;
      } finally { draft.saving = false; }
    };
    return Object.freeze({ content: panel, submit });
  }
  function profilePanel(person) {
    const panel = element('section', 'qqj-profile-card');
    const values = fieldsFrom(person), draft = drafts.has(person.entityId) ? profileDraft(person) : null;
    const header = element('header', 'qqj-profile-summary');
    const hasAlias = Boolean(values.aliases);
    const mark = element('button', `qqj-profile-mark${hasAlias ? ' has-alias' : ''}`); mark.type = 'button'; mark.setAttribute?.('aria-label', person.avatar ? '替换头像' : '上传头像');
    if (person.avatar) { const avatar = element('img', 'qqj-profile-avatar'); avatar.src = person.avatar; avatar.alt = ''; mark.append(avatar); } else { mark.innerHTML = KNOT_ICON_SVG; }
    const file = element('input', 'qqj-avatar-file'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp'; file.addEventListener('change', event => { const selected = event.target?.files?.[0]; if (selected) void chooseAvatar(person, mark, selected); event.target.value = ''; });
    mark.addEventListener('click', () => file.click?.());
    const identity = element('div', 'qqj-profile-identity');
    const name = element('h2', '', values.name || person.displayName || person.entityDisplayName || '未命名人物');
    name.setAttribute?.('title', name.textContent); name.setAttribute?.('aria-label', `姓名：${name.textContent}`);
    identity.append(name); if (hasAlias) identity.append(element('p', 'qqj-profile-alias', `别名 · ${values.aliases}`));
    const badges = element('div', 'qqj-profile-badges');
    if (person.recommended) badges.append(element('span', 'qqj-recommend-badge', '推荐'));
    badges.append(element('span', 'v3-memory-status', person.profiled ? '已建档' : '待建档'));
    if (!draft?.editing) {
      const menu = operationMenus.register(element('details', 'qqj-profile-menu')), toggle = element('summary', 'qqj-profile-menu-toggle', '⋮');
      toggle.setAttribute?.('aria-label', '人物操作'); toggle.setAttribute?.('title', '人物操作');
      const menuBody = element('div', 'qqj-profile-menu-pop');
      const edit = element('button', 'qqj-profile-menu-action', '编辑资料'); edit.type = 'button'; edit.disabled = busyExceptGeneration(state);
      edit.addEventListener('click', () => { profileDraft(person, true); render(state); });
      const avatarAction = element('button', 'qqj-profile-menu-action', person.avatar ? '替换头像' : '上传头像'); avatarAction.type = 'button'; avatarAction.addEventListener('click', () => file.click?.());
      const avatarRemove = person.avatar ? element('button', 'qqj-profile-menu-action danger', '移除头像') : null;
      avatarRemove?.addEventListener('click', () => { void run('移除头像', () => runtime.saveAvatar(person.entityId, null)); });
      const remove = selectionButton(person, state.selectedEntityIds); remove.className = `${remove.className} qqj-profile-menu-action danger`;
      menuBody.append(personGenerationButton(person, 'qqj-profile-menu-action'), edit, avatarAction); if (avatarRemove) menuBody.append(avatarRemove); menuBody.append(element('span', 'qqj-profile-menu-separator'), remove); menu.append(toggle, menuBody); badges.append(menu);
    }
    header.append(mark, identity, badges);
    panel.append(header, file);
    const body = element('div', 'qqj-profile-body');
    if (draft?.editing) {
      const form = element('div', 'qqj-profile-form');
      const groups = [{ key: 'basic', label: '基础信息', fields: [['name', '姓名', 'input'], ['aliases', '别名', 'textarea'], ...PEOPLE_PROFILE_GROUPS[0].fields] }, ...PEOPLE_PROFILE_GROUPS.slice(1)];
      for (const group of groups) {
        const section = element('section', 'qqj-profile-form-group'); section.append(element('h3', '', group.label));
        for (const [field, labelText, control] of group.fields) {
          const label = element('label', 'qqj-profile-field'); label.append(element('span', '', labelText));
          const input = element(control === 'input' ? 'input' : 'textarea', 'settings-input'); input.value = draft[field]; input.placeholder = PLACEHOLDERS[field] ?? `填写${labelText}`; input.disabled = draft.saving || busyExceptGeneration(state);
          input.addEventListener('input', () => { draft[field] = input.value; if (String(draft[field]) === String(draft.original[field])) draft.dirtyFields.delete(field); else draft.dirtyFields.add(field); draft.dirty = !sameFields(draft, draft.original); draft.notice = ''; draft.error = ''; });
          label.append(input); section.append(label);
        }
        form.append(section);
      }
      const actions = element('div', 'qqj-profile-save-row');
      const save = element('button', 'primary-action', draft.saving ? '保存中…' : '保存资料'); save.type = 'button'; save.disabled = draft.saving || busyExceptGeneration(state);
      save.addEventListener('click', () => saveProfile(person, draft)); actions.append(save);
      const cancel = element('button', 'secondary-action', '取消'); cancel.type = 'button'; cancel.disabled = draft.saving || busyExceptGeneration(state);
      cancel.addEventListener('click', () => { drafts.delete(person.entityId); render(state); }); actions.append(cancel, selectionButton(person, state.selectedEntityIds));
      if (draft.notice || draft.error) actions.append(saveResult(draft));
      form.append(actions); body.append(form);
    } else {
      const reading = element('div', 'qqj-profile-reading');
      for (const group of PEOPLE_PROFILE_GROUPS) {
        const present = group.fields.filter(([field]) => values[field]);
        if (!present.length) continue;
        const section = element('section', `qqj-profile-section qqj-profile-section-${group.key}${reading.children.length ? '' : ' lead'}`); section.append(element('h3', '', group.label));
        for (const [field] of present) { const row = element('div', `qqj-profile-read-row qqj-profile-read-${field}`); row.append(element('span', '', PEOPLE_PROFILE_LABELS[field]), element('p', '', values[field])); section.append(row); }
        reading.append(section);
      }
      body.append(reading);
      if (draft?.notice || draft?.error) { const result = saveResult(draft); result.className += ' qqj-profile-reading-result'; body.append(result); }
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
      button.addEventListener('click', () => { if (currentEntityId !== person.entityId) closeCrop(); currentEntityId = person.entityId; showMore = false; render(state); });
      button.addEventListener('keydown', event => {
        const offsets = { ArrowLeft: -1, ArrowRight: 1 }, offset = offsets[event.key];
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? selected.length - 1 : Number.isInteger(offset) ? (index + offset + selected.length) % selected.length : null;
        if (target === null || !selected[target]) return; event.preventDefault?.(); if (currentEntityId !== selected[target].entityId) closeCrop(); currentEntityId = selected[target].entityId; showMore = false; render(state);
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
      const detail = [person.selected ? '已选重要' : '', person.profiled ? '已建档' : '', person.aliases.length ? `别名：${person.aliases.join('、')}` : '', person.appearanceCount ? `出现 ${person.appearanceCount} 楼` : '', person.recommended ? '推荐' : ''].filter(Boolean).join('，');
      copy.append(element('small', '', detail || '已发现人物')); row.append(copy, selectionButton(person, state.selectedEntityIds)); list.append(row);
    }
    if (!people.length) list.append(element('p', 'settings-hint', '当前没有已识别人物。后续摘要和状态分析仍会正常发现人物。'));
    picker.append(list); return picker;
  }
  function render(next = runtime.getState()) {
    if (switcherNode) switcherScrollLeft = Number(switcherNode.scrollLeft) || 0;
    const previousChatId = chatId, previousSignature = switcherSignature;
    state = next; resetForChat(state.chatId ?? null); if (!container) return;
    operationMenus.reset();
    const page = element('section', 'qqj-page qqj-profiles-page'), status = element('div', 'qqj-page-status');
    const health = element('p', healthClass(state), statusCopy(state));
    health.setAttribute?.('role', 'status'); status.append(health, element('p', `v3-foundation-feedback${feedback.includes('失败') ? ' error' : ''}`, feedback)); page.append(status);
    const selected = state.people.filter(person => person.selected), moreCount = state.people.length - selected.length;
    if (!selected.some(person => person.entityId === currentEntityId)) { closeCrop(); currentEntityId = selected[0]?.entityId ?? null; }
    const nextSignature = JSON.stringify(selected.map(person => person.entityId));
    const nextSwitcher = switcher(selected);
    const preserveSwitcherScroll = previousChatId === chatId && previousSignature === nextSignature;
    const toolbar = element('div', 'qqj-profile-toolbar'), switchRow = element('div', 'qqj-profile-switch-row'); switchRow.append(nextSwitcher);
    const actions = element('div', 'qqj-profile-toolbar-actions');
    actions.append(generationButton());
    const more = element('button', `secondary-action qqj-profile-more${showMore ? ' active' : ''}`, showMore ? '返回资料' : `更多人物（${moreCount}）`);
    more.type = 'button'; more.addEventListener('click', () => { closeCrop(); showMore = !showMore; render(state); }); actions.append(more); switchRow.append(actions); toolbar.append(switchRow); page.append(toolbar);
    if (showMore) page.append(peoplePicker(state.people));
    else {
      const current = selected.find(person => person.entityId === currentEntityId);
      if (current) page.append(profilePanel(current));
      else page.append(element('div', 'qqj-inline-empty', '尚未选择重要人物。点击上方“更多人物”即可自由选择，选择 0 位也完全可以。'));
    }
    const unavailable = state.selectedEntityIds.length - selected.length;
    if (unavailable > 0) page.append(element('p', 'settings-hint', `有 ${unavailable} 个旧人物选择在当前记忆图中暂不可匹配；其选择与资料仍保留。`));
    container.replaceChildren(page);
    nextSwitcher.scrollLeft = preserveSwitcherScroll ? switcherScrollLeft : 0;
    switcherNode = nextSwitcher; switcherSignature = nextSignature; switcherScrollLeft = nextSwitcher.scrollLeft;
  }
  function subscribe() {
    if (!active || unsubscribe || typeof runtime.subscribe !== 'function') return;
    const release = runtime.subscribe(next => { state = next; if (active && container) render(next); });
    if (typeof release === 'function') unsubscribe = release;
  }
  function mount(target) { unsubscribe?.(); unsubscribe = null; operationMenus.deactivate(); container = target; active = true; render(runtime.getState()); operationMenus.activate(); subscribe(); }
  async function activate() {
    if (!container) throw new Error('千人人物资料 view 尚未挂载');
    active = true; operationMenus.activate(); subscribe(); const mine = ++epoch; feedback = '正在读取当前聊天…'; render(runtime.getState());
    try { const result = await runtime.refresh({ refreshMemory: false }); if (!active || mine !== epoch) return { status: 'stale' }; state = result; feedback = '人物资料读取完成。'; render(result); return result; }
    catch (error) { if (!active || mine !== epoch) return { status: 'stale' }; state = runtime.getState(); feedback = `读取失败：${error?.message || '未知错误'}`; render(state); return { status: 'error', error }; }
  }
  function deactivate() { active = false; epoch += 1; closeCrop(); operationMenus.deactivate(); unsubscribe?.(); unsubscribe = null; }
  return Object.freeze({ mount, activate, deactivate, render });
}
