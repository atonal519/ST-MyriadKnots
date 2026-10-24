import { KNOT_ICON_SVG } from './brand.js';
import { createOperationMenuController } from './operation-menu-controller.js';
import { createInlineSelect } from './inline-select.js';
import { PEOPLE_PROFILE_FIELDS, PEOPLE_PROFILE_GROUPS, PEOPLE_PROFILE_LABELS, emptyPeopleProfileFields } from '../v3/people-profile-fields.js';
import { avatarCropLayout, cropAvatarDataUrl, fitAvatarDataUrl, loadAvatarSource } from './avatar-cropper.js';
import { publicErrorMessage } from '../public-error.js';
import { bindHorizontalStrip, openPeopleOrderDialog } from './people-interactions.js';

const PLACEHOLDERS = Object.freeze({ name: '人物姓名', aliases: '多个别名可用顿号或换行分隔', gender: '有明确依据时填写', age: '不把外观年龄当作实际年龄', birthday: '有明确依据时填写', species: '种族或物种', notes: '其他稳定基础资料', appearance: '旧资料或难归类的外貌补充', background: '稳定的背景经历', personality: '长期核心性格', nsfw: '有明确依据的成人向资料' });

function fieldsFrom(person) {
  const profile = person?.profile;
  const result = emptyPeopleProfileFields();
  for (const field of PEOPLE_PROFILE_FIELDS) result[field] = profile?.[field] ?? '';
  if (!profile) result.name = person?.entityDisplayName ?? '';
  if (Array.isArray(person?.aliases)) result.aliases = person.aliases.join('、');
  return result;
}
function sameFields(left, right) { return PEOPLE_PROFILE_FIELDS.every(field => String(left?.[field] ?? '') === String(right?.[field] ?? '')); }
function profileReadingText(value) {
  // Reading-only formatting: keep the stored/editor value untouched.
  return String(value ?? '').replace(/([；;。](?:[”’」』"'])*)[ \t]*(?=[^\s”’」』"'])/gu, '$1\n');
}

export function createPeopleProfilesView({ runtime, sessionStateProvider = null, prepareSession = null, dialog = null, documentRef = globalThis.document, imageFactory = () => new Image(), urlApi = globalThis.URL } = {}) {
  if (!runtime || ['getState', 'refresh', 'setSelectedEntityIds', 'setPersonOrderEntityIds', 'saveProfile', 'saveAvatar', 'mergePeople', 'deletePerson', 'regenerateProfile'].some(name => typeof runtime[name] !== 'function')) throw new TypeError('千人人物资料 runtime 无效');
  if (!documentRef?.createElement) throw new TypeError('千人人物资料 documentRef 无效');
  let container = null, active = false, epoch = 0, unsubscribe = null, state = runtime.getState(), chatId = state.chatId ?? null, feedback = '人物资料状态已显示。';
  let currentEntityId = null, showMore = false, cropDraft = null, cropLoadId = 0, cropLoadController = null;
  let switcherNode = null, switcherSignature = null, switcherScrollLeft = 0;
  let renderedState = null, renderedNodes = null, busyControls = [], generationButtons = [];
  const drafts = new Map();
  const archivedHistory = new Map();
  const operationMenus = createOperationMenuController(documentRef);
  const releaseCrop = draft => { draft?.source?.release?.(); if (cropDraft === draft) cropDraft = null; };
  const closeCrop = () => {
    cropLoadId += 1; cropLoadController?.abort(); cropLoadController = null;
    const draft = cropDraft;
    if (draft?.dialogOpen && dialog?.cancelTop?.()) return;
    releaseCrop(draft);
  };
  const element = (tag, className = '', text = '') => { const node = documentRef.createElement(tag); if (className) node.className = className; if (text !== '') node.textContent = text; return node; };
  const busyControl = (node, isDisabled) => { busyControls.push({ node, isDisabled }); return node; };
  const busyExceptGeneration = value => Boolean(value.active && !['generating', 'generatingAvatar'].includes(value.active.kind));
  const readFeedback = value => value.active?.kind === 'loading' ? '正在读取当前聊天…'
    : value.lastError ? `读取失败：${publicErrorMessage(value.lastError, { fallback: '人物资料暂时无法读取，请重试。' })}` : '人物资料读取完成。';
  const statusCopy = value => {
    if (value.status === 'disabled') return '千千结已关闭';
    if (value.active?.kind === 'loading') return '正在读取当前聊天的人物资料';
    if (value.active?.kind === 'generating') {
      const index = value.active.batchIndex, total = value.active.batchTotal;
      const progress = Number.isSafeInteger(index) && Number.isSafeInteger(total) && index > 0 && total >= index ? ` · 第 ${index}/${total} 批` : '';
      return `正在整理人物资料${progress}`;
    }
    if (value.active?.kind === 'savingSelection') return '正在保存重要人物选择';
    if (value.active?.kind === 'savingOrder') return '正在保存人物顺序';
    if (value.active?.kind === 'savingProfile') return '正在保存人物资料';
    if (value.active?.kind === 'generatingAvatar') return '正在生成头像';
    if (value.active?.kind === 'savingAvatar') return '正在保存人物头像';
    if (value.active?.kind === 'merging') return '正在合并人物归属';
    if (value.active?.kind === 'deleting') return '正在删除人物';
    if (value.lastError?.message) return `需要处理 · ${publicErrorMessage(value.lastError, { fallback: '人物资料处理失败，请重试。' })}`;
    return `已选 ${value.people.filter(person => person.selected).length} 位重要人物 · ${value.unprofiledSelectedCount} 位待建档`;
  };
  const healthClass = value => {
    if (value.lastError) return 'qqj-page-health qqj-profile-health error';
    const checking = Boolean(value.active) || !['ready', 'empty'].includes(value.status);
    return `qqj-page-health qqj-profile-health ${checking ? 'checking' : 'healthy'}`;
  };
  function resetForChat(nextChatId) {
    if (chatId === nextChatId) return;
    closeCrop(); chatId = nextChatId; drafts.clear(); archivedHistory.clear(); currentEntityId = null; showMore = false; switcherNode = null; switcherSignature = null; switcherScrollLeft = 0; feedback = '人物资料状态已显示。';
  }
  async function run(label, task, { after = null, generationReport = false } = {}) {
    const mine = ++epoch, operationChatId = chatId; feedback = `${label}…`; render(state);
    try {
      const result = await task(); state = runtime.getState();
      if ((state.chatId ?? null) === operationChatId) after?.(state);
      if (active && mine === epoch) {
        const report = generationReport ? result?.lastGenerationReport : null;
        const details = report ? [report.missing ? `未返回 ${report.missing} 位` : '', report.conflicts ? `回复重复 ${report.conflicts} 位` : '', report.invalid ? `格式无效 ${report.invalid} 位` : '', report.unknown ? `无法对应人物 ${report.unknown} 项` : '', report.skipped ? `未更新 ${report.skipped} 位` : '',
          report.aliasesNotUpdated ? `别名未更新 ${report.aliasesNotUpdated} 位` : '',
          Number.isSafeInteger(report.worldInfoMatched) ? `送入世界书 ${report.worldInfoMatched} 项` : '',
          ].filter(Boolean) : [];
        feedback = report ? `保存 ${report.saved}/${report.requested} 位${details.length ? `；${details.join('；')}` : ''}。` : `${label}完成。`;
        render(state);
      }
      return result;
    } catch (error) {
      state = runtime.getState();
      if (active && mine === epoch) { feedback = `${label}失败：${publicErrorMessage(error, { fallback: '操作没有完成，请重试。' })}`; render(state); }
      return { status: 'error', error };
    }
  }
  function selectionButton(person, selectedIds) {
    const selected = new Set(selectedIds);
    const button = element('button', person.selected ? 'secondary-action' : 'primary-action', person.selected ? '移出关注' : '设为重要');
    button.type = 'button'; button.disabled = busyExceptGeneration(state); busyControl(button, () => busyExceptGeneration(state));
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
    if (draft && person.profiled && draft.wasProfiled && !draft.dirty && !draft.saving) {
      const latest = fieldsFrom(person);
      if (!sameFields(draft, latest)) {
        draft = { ...latest, original: { ...latest }, dirtyFields: new Set(), wasProfiled: true, dirty: false,
          saving: false, editing, error: draft.error, notice: draft.notice };
        drafts.set(person.entityId, draft);
      }
    }
    if (!draft) {
      const initial = fieldsFrom(person);
      draft = { ...initial, original: { ...initial }, dirtyFields: new Set(), wasProfiled: person.profiled, dirty: false, saving: false, editing, error: '', notice: '' };
      drafts.set(person.entityId, draft);
    }
    if (beginEditing) draft.editing = true;
    return draft;
  }
  async function saveProfile(person, draft) {
    const current = fieldsFrom(person);
    if (person.profiled && sameFields(draft, current)) return true;
    const token = Object.freeze({ chatId, entityId: person.entityId, draft });
    const payload = Object.fromEntries(PEOPLE_PROFILE_FIELDS.filter(field => !person.profiled || draft.dirtyFields.has(field)).map(field => [field, draft[field]]));
    draft.saving = true; draft.notice = '保存中…'; draft.error = '';
    try {
      await runtime.saveProfile(person.entityId, payload, { manualFields: [...draft.dirtyFields] });
      const next = runtime.getState(); state = next;
      if ((next.chatId ?? null) !== token.chatId || drafts.get(token.entityId) !== token.draft) return false;
      const updated = next.people.find(item => item.entityId === token.entityId);
      if (!updated?.profiled) {
        token.draft.saving = false; token.draft.notice = ''; token.draft.error = '保存失败：没有读到已保存资料';
        throw new Error(token.draft.error);
      } else {
        const saved = fieldsFrom(updated);
        drafts.set(token.entityId, { ...saved, original: { ...saved }, dirtyFields: new Set(), wasProfiled: true, dirty: false, saving: false, editing: false, error: '', notice: '已保存' });
      }
      if (active) render(next);
      return true;
    } catch (error) {
      const next = runtime.getState(); state = next;
      if ((next.chatId ?? null) !== token.chatId || drafts.get(token.entityId) !== token.draft) throw error;
      token.draft.saving = false; token.draft.editing = true; token.draft.notice = ''; token.draft.error = `保存失败：${publicErrorMessage(error, { fallback: '人物资料没有保存，请重试。' })}`;
      if (active) render(next);
      throw new Error(token.draft.error);
    }
  }
  function personGenerationButton(person, className = 'secondary-action') {
    const label = person.profiled ? '重新整理资料' : '整理当前资料';
    const button = element('button', className, state.active?.kind === 'generating' ? '正在整理…' : label);
    button.title = '按已记录的事实和原句核对资料，重新筛选非人工别名；人工字段保留。';
    button.type = 'button'; button.disabled = Boolean(state.active); busyControl(button, () => Boolean(state.active));
    generationButtons.push({ node: button, label });
    button.addEventListener('click', () => { void run(label, () => runtime.regenerateProfile(person.entityId), { generationReport: true }); });
    return button;
  }
  async function deletePerson(person) {
    if (!dialog?.confirm) { feedback = '当前环境无法打开删除确认窗口。'; render(state); return; }
    const name = person.displayName || person.entityDisplayName || '该人物';
    const confirmed = await dialog.confirm({ title: `删除人物 · ${name}`, body: '删除人物档案、头像和重要人物选择，并从人物候选中隐藏。',
      note: '正文、摘要和双丝网保留；剧情出现新的同名身份时，可能重新入列。', confirmText: '删除人物', cancelText: '取消' });
    if (!confirmed) return;
    await run('删除人物', () => runtime.deletePerson(person.entityId), { after: () => {
      drafts.delete(person.entityId); if (currentEntityId === person.entityId) currentEntityId = null;
    } });
  }
  function mergeDialogContent(person) {
    const targets = state.people.filter(item => item.entityId !== person.entityId);
    const nameOf = value => value?.displayName || value?.entityDisplayName || '未命名人物';
    const profileChoice = value => `保留「${nameOf(value)}」的资料与头像${value?.profiled ? '' : '（尚未建档）'}`;
    const panel = element('section', 'qqj-merge-dialog');
    panel.append(element('p', 'qqj-merge-dialog-intro', '保留双方正文、摘要和双丝网，统一人物归属；选择保留哪一方的资料和头像。'));

    const targetField = element('div', 'qqj-merge-field');
    targetField.append(element('span', 'qqj-merge-field-title', '合并目标'));
    const profileHost = element('div', 'qqj-merge-select-host');
    let profileSelect = null;
    const renderProfileSelect = () => {
      const selected = profileSelect?.value ?? 'target';
      const target = targets.find(item => item.entityId === targetSelect.value) ?? targets[0];
      profileSelect = createInlineSelect({
        documentRef,
        options: [{ value: 'target', label: profileChoice(target) }, { value: 'source', label: profileChoice(person) }],
        value: selected,
        ariaLabel: '选择保留哪位人物的资料与头像',
      });
      profileHost.replaceChildren(profileSelect.node);
    };
    const targetSelect = createInlineSelect({
      documentRef,
      options: targets.map(target => ({ value: target.entityId, label: nameOf(target) })),
      value: targets[0]?.entityId ?? '',
      ariaLabel: '选择人物合并目标',
      onChange: renderProfileSelect,
    });
    targetField.append(targetSelect.node); panel.append(targetField);

    const profileField = element('div', 'qqj-merge-field');
    profileField.append(element('span', 'qqj-merge-field-title', '保留资料与头像'), profileHost); panel.append(profileField);
    renderProfileSelect();
    return { panel, targetSelect, get profileSelect() { return profileSelect; } };
  }
  function mergePerson(person) {
    if (!dialog?.custom) { feedback = '当前环境无法打开合并窗口。'; render(state); return; }
    const targets = state.people.filter(item => item.entityId !== person.entityId);
    if (!targets.length) { feedback = '当前没有其他可作为合并目标的人物。'; render(state); return; }
    const operationChatId = chatId, content = mergeDialogContent(person);
    void dialog.custom({ title: `合并人物 · ${person.displayName || person.entityDisplayName}`, content: content.panel, confirmText: '确认合并', cancelText: '取消', submit: async () => {
      const targetEntityId = content.targetSelect.value;
      if (!targetEntityId) throw new Error('请选择合并目标。');
      await runtime.mergePeople(person.entityId, targetEntityId, content.profileSelect.value);
      const next = runtime.getState();
      if ((next.chatId ?? null) !== operationChatId) throw new Error('聊天已变化，本次合并未应用到当前页面。');
      state = next; drafts.delete(person.entityId); currentEntityId = targetEntityId; feedback = '人物已合并；历史摘要与 CSE 归属已汇集到目标人物。'; if (active) render(next); return true;
    } });
  }
  function managementButtons(person, menuBody) {
    const merge = element('button', 'qqj-profile-menu-action', '合并到其他人物'); merge.type = 'button'; merge.disabled = Boolean(state.active) || state.people.length < 2; busyControl(merge, () => Boolean(state.active) || state.people.length < 2); merge.addEventListener('click', () => mergePerson(person));
    const remove = element('button', 'qqj-profile-menu-action danger', '删除人物'); remove.type = 'button'; remove.disabled = Boolean(state.active); busyControl(remove, () => Boolean(state.active)); remove.addEventListener('click', () => { void deletePerson(person); });
    menuBody.append(merge, remove);
  }
  function archivedProfileView(person) {
    if (!(state.archivedPeopleSnapshotCount > 0) || typeof runtime.readArchivedProfileHistory !== 'function') return null;
    const ownerChatId = chatId, key = `${ownerChatId}:${person.entityId}`;
    const entry = archivedHistory.get(key) ?? { open: false, loading: false, snapshots: null, error: '' };
    archivedHistory.set(key, entry);
    const section = element('section', 'qqj-profile-archive');
    const toggle = element('button', 'secondary-action qqj-profile-archive-toggle', entry.open ? '收起搬家前资料' : '查看搬家前资料（只读）');
    toggle.type = 'button'; toggle.setAttribute?.('aria-expanded', String(entry.open));
    toggle.addEventListener('click', () => {
      entry.open = !entry.open;
      if (entry.open && entry.snapshots === null && !entry.loading) {
        entry.loading = true; entry.error = ''; render(state);
        void runtime.readArchivedProfileHistory(person.entityId).then(values => {
          entry.snapshots = values; entry.loading = false;
          if (active && chatId === ownerChatId && currentEntityId === person.entityId) render(state);
        }, error => {
          entry.loading = false; entry.error = publicErrorMessage(error, { fallback: '搬家前资料读取失败。' });
          if (active && chatId === ownerChatId && currentEntityId === person.entityId) render(state);
        });
      } else render(state);
    });
    section.append(toggle);
    if (entry.open) {
      if (entry.loading) section.append(element('p', 'settings-hint', '正在读取搬家前资料…'));
      else if (entry.error) section.append(element('p', 'v3-foundation-feedback error', `搬家前资料读取失败：${entry.error}`));
      else if (Array.isArray(entry.snapshots) && !entry.snapshots.length) section.append(element('p', 'settings-hint', '该人物没有已保存的搬家前资料。'));
      else for (const [index, snapshot] of (entry.snapshots ?? []).entries()) {
        const profile = snapshot.profile ?? {}, details = element('details', 'qqj-profile-archive-entry');
        const summary = element('summary', '', `搬家前资料 ${index + 1}${profile.name ? ` · ${profile.name}` : ''}`);
        details.append(summary);
        if (String(profile.aliases ?? '').trim()) details.append(element('p', 'qqj-profile-alias', `别名 · ${profile.aliases}`));
        for (const group of PEOPLE_PROFILE_GROUPS) {
          const present = group.fields.filter(([field]) => String(profile[field] ?? '').trim());
          if (!present.length) continue;
          const groupNode = element('section', 'qqj-profile-section'); groupNode.append(element('h3', '', group.label));
          for (const [field, , control] of present) {
            const row = element('div', `qqj-profile-read-row qqj-profile-read-${field}`);
            row.append(element('span', '', PEOPLE_PROFILE_LABELS[field]), element('p', '', control === 'textarea' ? profileReadingText(profile[field]) : String(profile[field])));
            groupNode.append(row);
          }
          details.append(groupNode);
        }
        section.append(details);
      }
    }
    return section;
  }
  async function generateAvatar(person, mark) {
    const cropLifecycle = cropLoadId;
    try {
      const options = runtime.prepareAvatarGeneration(person.entityId);
      let character = Number.isInteger(options.selectedIndex) ? options.characters[options.selectedIndex] : null;
      if (!character) {
        if (!dialog?.custom) throw new Error('当前环境无法选择柏宝绘角色。');
        const content = element('section', 'qqj-editor-dialog');
        content.append(element('p', 'qqj-editor-intro', '请选择用于这位人物头像的外貌档案。'));
        const nameCounts = new Map();
        for (const item of options.characters) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
        const select = createInlineSelect({ documentRef, ariaLabel: '柏宝绘角色', options: options.characters.map((item, index) => ({ value: String(index), label: `${item.name}${item.scope === 'global' ? '（全局）' : item.scope === 'chat' ? '（当前聊天）' : ''}${nameCounts.get(item.name) > 1 ? ` · ${item.nl || item.tag}` : ''}` })) });
        content.append(select.node);
        const selected = await dialog.custom({ title: '选择柏宝绘角色', content, confirmText: '生成头像', cancelText: '取消', submit: () => options.characters[Number(select.value)] });
        if (!selected) return;
        character = selected;
      }
      const result = await run('生成头像', () => runtime.generateAvatar(person.entityId, { character }));
      if (result?.dataUrl && active && cropLifecycle === cropLoadId) await chooseAvatar(person, mark, result.dataUrl, true);
    } catch (error) {
      feedback = `生成头像失败：${publicErrorMessage(error, { fallback: '头像没有生成，请检查柏宝绘设置。' })}`; if (active) render(state);
    }
  }
  async function chooseAvatar(person, mark, file, generated = false) {
    cropLoadController?.abort();
    const controller = new AbortController(); cropLoadController = controller;
    const loadId = ++cropLoadId, operationChatId = chatId, entityId = person.entityId;
    const rect = mark.getBoundingClientRect?.() ?? {};
    const aspectRatio = Number(rect.width) > 0 && Number(rect.height) > 0 ? rect.width / rect.height : 1;
    try {
      const source = await loadAvatarSource(file, { imageFactory, urlApi, signal: controller.signal });
      if (loadId !== cropLoadId || chatId !== operationChatId || currentEntityId !== entityId) { source.release(); return; }
      cropLoadController = null; closeCrop();
      const draft = { entityId, chatId: operationChatId, source, generated, originalRef: null, aspectRatio, cropping: false, zoom: 1, offsetX: 0, offsetY: 0, saving: false, dialogOpen: false };
      cropDraft = draft;
      if (!dialog?.custom) { releaseCrop(draft); feedback = '当前环境无法打开头像预览窗口。'; render(state); return; }
      const crop = avatarCropContent(person, draft); draft.dialogOpen = true;
      void dialog.custom({ title: '头像预览', content: crop.content, confirmText: '确认头像', cancelText: '取消', submit: crop.submit,
        onClose: () => { draft.dialogOpen = false; releaseCrop(draft); } }).then(saved => {
          if (saved && chatId === operationChatId && currentEntityId === entityId) { state = runtime.getState(); feedback = '头像已保存。'; if (active) render(state); }
        });
    } catch (error) {
      if (cropLoadController === controller) cropLoadController = null;
      if (error?.name !== 'AbortError' && loadId === cropLoadId && chatId === operationChatId && currentEntityId === entityId) { feedback = `头像读取失败：${publicErrorMessage(error, { fallback: '无法读取所选图片。' })}`; render(state); }
    }
  }
  function avatarCropContent(person, draft) {
    const panel = element('section', 'qqj-avatar-crop-panel');
    const frame = element('div', 'qqj-avatar-crop-frame'), image = element('img', 'qqj-avatar-crop-image');
    frame.style?.setProperty?.('--qqj-avatar-aspect', String(draft.aspectRatio)); image.src = draft.source.objectUrl; image.alt = '';
    const applyPreview = () => {
      frame.className = draft.cropping ? 'qqj-avatar-crop-frame' : 'qqj-avatar-preview-frame';
      image.className = draft.cropping ? 'qqj-avatar-crop-image' : 'qqj-avatar-preview-image';
      zoomLabel.hidden = !draft.cropping; zoom.disabled = !draft.cropping || draft.saving;
      toggle.textContent = draft.cropping ? '显示完整图片' : '裁剪';
      toggle.disabled = draft.saving;
      panel.setAttribute('aria-busy', String(draft.saving));
      if (!draft.cropping) {
        if (image.style) for (const property of ['width', 'height', 'left', 'top']) image.style[property] = '';
        return;
      }
      const layout = avatarCropLayout({ naturalWidth: draft.source.image.naturalWidth, naturalHeight: draft.source.image.naturalHeight, frameWidth: 240, frameHeight: 240 / draft.aspectRatio, zoom: draft.zoom, offsetX: draft.offsetX, offsetY: draft.offsetY });
      draft.zoom = layout.zoom; draft.offsetX = layout.offsetX; draft.offsetY = layout.offsetY;
      if (image.style) { image.style.width = `${layout.width}px`; image.style.height = `${layout.height}px`; image.style.left = `${layout.left}px`; image.style.top = `${layout.top}px`; }
    };
    let pointer = null;
    frame.addEventListener('pointerdown', event => { if (!draft.cropping || draft.saving) return; pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, offsetX: draft.offsetX, offsetY: draft.offsetY }; frame.setPointerCapture?.(event.pointerId); });
    frame.addEventListener('pointermove', event => { if (!pointer || event.pointerId !== pointer.id) return; event.preventDefault?.(); draft.offsetX = pointer.offsetX + event.clientX - pointer.x; draft.offsetY = pointer.offsetY + event.clientY - pointer.y; applyPreview(); });
    const endPointer = event => { if (!pointer || (event.pointerId !== undefined && event.pointerId !== pointer.id)) return; frame.releasePointerCapture?.(pointer.id); pointer = null; };
    frame.addEventListener('pointerup', endPointer); frame.addEventListener('pointercancel', endPointer); frame.append(image); panel.append(frame);
    const actions = element('div', 'qqj-editor-inline-actions');
    const toggle = element('button', 'secondary-action', '裁剪'); toggle.type = 'button';
    toggle.addEventListener('click', () => { if (draft.saving) return; pointer = null; draft.cropping = !draft.cropping; applyPreview(); });
    const download = element('a', 'secondary-action', '保存原图'); download.href = draft.source.objectUrl;
    download.download = `头像原图.${draft.source.mimeType === 'image/jpeg' ? 'jpg' : draft.source.mimeType.split('/')[1]}`;
    actions.append(toggle, download); panel.append(actions);
    const zoomLabel = element('label', 'qqj-avatar-zoom'); zoomLabel.append(element('span', '', '缩放'));
    const zoom = element('input', 'settings-input'); zoom.type = 'range'; zoom.min = '1'; zoom.max = '3'; zoom.step = '0.01'; zoom.value = String(draft.zoom); zoom.disabled = draft.saving;
    zoom.addEventListener('input', () => { draft.zoom = Number(zoom.value); applyPreview(); }); zoomLabel.append(zoom); panel.append(zoomLabel); applyPreview();
    const status = element('p', 'sp-dialog-note'); status.hidden = true; status.setAttribute('aria-live', 'polite'); panel.append(status);
    const submit = async () => {
      const token = { chatId, entityId: person.entityId, draft }; draft.saving = true;
      status.hidden = false; status.textContent = '正在处理头像…'; applyPreview();
      try {
        // 先让本弹窗的忙态完成一帧绘制，再进行同步图片编码。
        const owner = documentRef.defaultView ?? globalThis;
        await new Promise(resolve => {
          if (typeof owner.requestAnimationFrame === 'function') owner.requestAnimationFrame(() => owner.requestAnimationFrame(resolve));
          else setTimeout(resolve, 0);
        });
        if (cropDraft !== draft || !draft.dialogOpen) return false;
        const dataUrl = draft.cropping
          ? cropAvatarDataUrl({ image: draft.source.image, aspectRatio: draft.aspectRatio, zoom: draft.zoom, offsetX: draft.offsetX, offsetY: draft.offsetY, canvas: documentRef.createElement('canvas') })
          : fitAvatarDataUrl({ image: draft.source.image, canvas: documentRef.createElement('canvas') });
        status.textContent = '正在保存头像…';
        await runtime.saveAvatar(person.entityId, dataUrl, { originalFile: draft.source.blob, originalRef: draft.originalRef, generated: draft.generated,
          crop: draft.cropping ? { aspectRatio: draft.aspectRatio, zoom: draft.zoom, offsetX: draft.offsetX, offsetY: draft.offsetY } : null,
          onOriginalUploaded: value => { draft.originalRef = value; } });
        if (chatId !== token.chatId || cropDraft !== token.draft || currentEntityId !== token.entityId) throw new Error('页面已切换，本次头像没有应用到当前页面。');
        return true;
      } finally { draft.saving = false; status.hidden = true; status.textContent = ''; if (cropDraft === draft) applyPreview(); }
    };
    return Object.freeze({ content: panel, submit });
  }
  function viewAvatar(person) {
    if (!dialog?.custom) { feedback = '当前环境无法打开头像。'; render(state); return; }
    closeCrop();
    const content = element('section', 'qqj-avatar-crop-panel'), frame = element('div', 'qqj-avatar-preview-frame');
    const image = element('img', 'qqj-avatar-preview-image'), status = element('p', 'sp-dialog-note', '正在读取图片…');
    const path = person.avatarSource?.path ?? person.avatar;
    const draft = { dialogOpen: true, source: { release() { image.onload = null; image.onerror = null; image.src = ''; } } };
    cropDraft = draft;
    image.alt = `${person.displayName || person.entityDisplayName}的头像`;
    image.onload = () => { if (cropDraft === draft) { status.textContent = ''; status.hidden = true; } };
    image.onerror = () => { if (cropDraft === draft) status.textContent = '图片暂时无法读取，请关闭后重试。'; };
    image.src = path; frame.append(image); content.append(frame, status);
    const download = element('a', 'secondary-action', person.avatarSource ? '保存原图' : '保存图片');
    download.href = path; download.download = `头像.${person.avatarSource?.mimeType === 'image/jpeg' ? 'jpg' : person.avatarSource?.mimeType?.split('/')[1] || 'webp'}`; content.append(download);
    void dialog.custom({ title: '头像大图', content, confirmText: '关闭', cancelText: '', submit: () => true,
      onClose: () => { draft.dialogOpen = false; releaseCrop(draft); } });
  }
  function profilePanel(person) {
    const panel = element('section', 'qqj-profile-card');
    panel.setAttribute('data-qqj-person-id', person.entityId);
    const values = fieldsFrom(person), draft = drafts.has(person.entityId) ? profileDraft(person) : null;
    const header = element('header', 'qqj-profile-summary');
    const hasAlias = Boolean(values.aliases);
    const mark = element('button', 'qqj-profile-mark'); mark.type = 'button'; mark.setAttribute?.('aria-label', person.avatar ? '查看头像大图' : '上传头像');
    mark.disabled = busyExceptGeneration(state); busyControl(mark, () => busyExceptGeneration(state));
    if (person.avatar) { const avatar = element('img', 'qqj-profile-avatar'); avatar.src = person.avatar; avatar.alt = ''; mark.append(avatar); } else { mark.innerHTML = KNOT_ICON_SVG; }
    const file = element('input', 'qqj-avatar-file'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp'; file.addEventListener('change', event => { const selected = event.target?.files?.[0]; if (selected) void chooseAvatar(person, mark, selected); event.target.value = ''; });
    mark.addEventListener('click', () => person.avatar ? viewAvatar(person) : file.click?.());
    const identity = element('div', 'qqj-profile-identity');
    const name = element('h2', '', values.name || person.displayName || person.entityDisplayName || '未命名人物');
    name.setAttribute?.('title', name.textContent); name.setAttribute?.('aria-label', `姓名：${name.textContent}`);
    const titleRow = element('div', 'qqj-profile-title-row');
    const badges = element('div', 'qqj-profile-badges');
    badges.append(element('span', 'v3-memory-status', person.profiled ? '已建档' : '待建档'));
    {
      const menu = operationMenus.register(element('details', 'qqj-profile-menu')), toggle = element('summary', 'qqj-profile-menu-toggle', '⋮');
      toggle.setAttribute?.('aria-label', '人物操作'); toggle.setAttribute?.('title', '人物操作');
      const menuBody = element('div', 'qqj-profile-menu-pop');
      const edit = element('button', 'qqj-profile-menu-action', '编辑资料'); edit.type = 'button'; edit.disabled = busyExceptGeneration(state); busyControl(edit, () => busyExceptGeneration(state));
      edit.addEventListener('click', () => { void openProfileEditor(person); });
      const avatarAction = element('button', 'qqj-profile-menu-action', person.avatar ? '替换头像' : '上传头像'); avatarAction.type = 'button'; avatarAction.addEventListener('click', () => file.click?.());
      avatarAction.disabled = busyExceptGeneration(state); busyControl(avatarAction, () => busyExceptGeneration(state));
      const avatarGenerate = element('button', 'qqj-profile-menu-action', '生成头像'); avatarGenerate.type = 'button'; avatarGenerate.disabled = Boolean(state.active); busyControl(avatarGenerate, () => Boolean(state.active));
      avatarGenerate.addEventListener('click', () => { void generateAvatar(person, mark); });
      const avatarRemove = person.avatar ? element('button', 'qqj-profile-menu-action danger', '移除头像') : null;
      if (avatarRemove) { avatarRemove.disabled = busyExceptGeneration(state); busyControl(avatarRemove, () => busyExceptGeneration(state)); }
      avatarRemove?.addEventListener('click', () => { void run('移除头像', () => runtime.saveAvatar(person.entityId, null)); });
      const remove = selectionButton(person, state.selectedEntityIds); remove.className = `${remove.className} qqj-profile-menu-action danger`;
      menuBody.append(personGenerationButton(person, 'qqj-profile-menu-action'), edit, avatarAction, avatarGenerate); if (avatarRemove) menuBody.append(avatarRemove); menuBody.append(element('span', 'qqj-profile-menu-separator'), remove, element('span', 'qqj-profile-menu-separator')); managementButtons(person, menuBody); menu.append(toggle, menuBody); badges.append(menu);
    }
    titleRow.append(name, badges); identity.append(titleRow);
    if (hasAlias) identity.append(element('p', 'qqj-profile-alias', `别名 · ${values.aliases}`));
    header.append(mark, identity);
    panel.append(header, file);
    const body = element('div', 'qqj-profile-body');
    {
      const reading = element('div', 'qqj-profile-reading');
      for (const group of PEOPLE_PROFILE_GROUPS) {
        const present = group.fields.filter(([field]) => values[field]);
        if (!present.length) continue;
        const section = element('section', `qqj-profile-section qqj-profile-section-${group.key}${reading.children.length ? '' : ' lead'}`); section.append(element('h3', '', group.label));
        for (const [field,,control] of present) { const row = element('div', `qqj-profile-read-row qqj-profile-read-${field}`); row.append(element('span', '', PEOPLE_PROFILE_LABELS[field]), element('p', '', control === 'textarea' ? profileReadingText(values[field]) : values[field])); section.append(row); }
        reading.append(section);
      }
      body.append(reading);
      if (draft?.notice || draft?.error) { const result = saveResult(draft); result.className += ' qqj-profile-reading-result'; body.append(result); }
    }
    panel.append(body);
    const archived = archivedProfileView(person); if (archived) panel.append(archived);
    return panel;
  }
  function openProfileEditor(person) {
    if (typeof dialog?.custom !== 'function') { feedback = '当前环境无法打开人物资料编辑窗口。'; render(state); return; }
    const draft = profileDraft(person, true), form = element('div', 'qqj-editor-dialog qqj-profile-form');
    if (renderedState && currentEntityId === person.entityId) renderedState = { ...renderedState, draftStamp: `${draft.editing}:${draft.saving}:${draft.error}:${draft.notice}` };
    const groups = [{ key: 'basic', label: '基础信息', fields: [['name', '姓名', 'input'], ['aliases', '别名', 'textarea'], ...PEOPLE_PROFILE_GROUPS[0].fields] }, ...PEOPLE_PROFILE_GROUPS.slice(1)];
    for (const group of groups) {
      const section = element(group.key === 'basic' ? 'section' : 'details', `qqj-editor-group qqj-profile-form-group${group.key === 'basic' ? '' : ' qqj-editor-collapsible'}`);
      if (group.key !== 'basic') { section.open = false; const summary = element('summary', 'qqj-editor-group-summary', group.label); section.append(summary); }
      else section.append(element('h3', '', group.label));
      for (const [field, labelText, control] of group.fields) {
        const label = element('label', 'qqj-profile-field'); label.append(element('span', '', labelText));
        const input = element(control === 'input' ? 'input' : 'textarea', 'settings-input'); input.value = draft[field]; input.placeholder = PLACEHOLDERS[field] ?? `填写${labelText}`;
        input.addEventListener('input', () => { draft[field] = input.value; if (String(draft[field]) === String(draft.original[field])) draft.dirtyFields.delete(field); else draft.dirtyFields.add(field); draft.dirty = !sameFields(draft, draft.original); draft.notice = ''; draft.error = ''; });
        label.append(input); section.append(label);
      }
      form.append(section);
    }
    if (draft.notice || draft.error) form.append(saveResult(draft));
    void Promise.resolve(dialog.custom({ title: `编辑人物资料 · ${person.displayName || person.entityDisplayName}`, content: form, confirmText: '保存', cancelText: '取消', submit: () => saveProfile(person, draft) }))
      .then(result => { if (result !== true && drafts.get(person.entityId) === draft) drafts.delete(person.entityId); if (active) render(state); });
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
    return bindHorizontalStrip(bar);
  }
  function openOrderDialog() {
    if (!dialog?.custom) { feedback = '当前环境无法打开人物排序窗口。'; render(state); return; }
    const operationChatId = chatId;
    void openPeopleOrderDialog({ customImpl: options => dialog.custom(options), runtime, people: state.people, documentRef, chatId: operationChatId,
      onSaved: next => { if ((next.chatId ?? null) !== operationChatId) return; state = next; feedback = '人物顺序已保存。'; if (active) render(next); } });
  }
  function peoplePicker(people) {
    const picker = element('section', 'qqj-profile-picker'), heading = element('header', 'qqj-profile-picker-heading');
    const order = element('button', 'secondary-action qqj-people-order-open', '排序'); order.type = 'button'; order.disabled = Boolean(state.active) || people.length < 2; busyControl(order, () => Boolean(state.active) || people.length < 2); order.addEventListener('click', openOrderDialog);
    heading.append(element('strong', '', '更多人物'), element('span', 'v3-memory-status', `${people.length} 位已识别人物`), order); picker.append(heading);
    const list = element('div', 'qqj-more-people-list');
    for (const person of people) {
      const row = element('div', 'qqj-more-person-row'), copy = element('div', 'qqj-more-person-copy');
      copy.append(element('strong', '', person.displayName || person.entityDisplayName));
      const detail = [person.selected ? '已选重要' : '', person.profiled ? '已建档' : '', person.aliases.length ? `别名：${person.aliases.join('、')}` : '', person.appearanceCount ? `出现 ${person.appearanceCount} 楼` : ''].filter(Boolean).join('，');
      copy.append(element('small', '', detail || '已发现人物'));
      const actions = element('div', 'qqj-more-person-actions'); actions.append(selectionButton(person, state.selectedEntityIds));
      const menu = operationMenus.register(element('details', 'qqj-profile-menu')), toggle = element('summary', 'qqj-profile-menu-toggle', '⋮');
      toggle.setAttribute?.('aria-label', `${person.displayName || person.entityDisplayName}人物操作`);
      const menuBody = element('div', 'qqj-profile-menu-pop'); managementButtons(person, menuBody); menu.append(toggle, menuBody); actions.append(menu);
      row.append(copy, actions); list.append(row);
    }
    if (!people.length) list.append(element('p', 'settings-hint', '当前没有已识别人物。后续摘要和状态分析仍会正常发现人物。'));
    picker.append(list); return picker;
  }
  function render(next = runtime.getState()) {
    state = next; resetForChat(state.chatId ?? null); if (!container) return;
    const active = state.active;
    const draft = currentEntityId ? drafts.get(currentEntityId) : null;
    const draftStamp = draft ? `${draft.editing}:${draft.saving}:${draft.error}:${draft.notice}` : '';
    const archive = currentEntityId ? archivedHistory.get(`${chatId}:${currentEntityId}`) : null;
    const archiveStamp = archive ? [archive.open, archive.loading, archive.error, archive.snapshots] : [false, false, '', null];
    const sameActive = (left, right) => left?.kind === right?.kind && left?.batchIndex === right?.batchIndex && left?.batchTotal === right?.batchTotal;
    const sameContent = renderedState && renderedNodes && renderedState.chatId === chatId && renderedState.people === state.people
      && renderedState.revision === state.revision && renderedState.archivedPeopleSnapshotCount === state.archivedPeopleSnapshotCount
      && renderedState.showMore === showMore && renderedState.currentEntityId === currentEntityId
      && renderedState.draftStamp === draftStamp && renderedState.archiveStamp[0] === archiveStamp[0]
      && renderedState.archiveStamp[1] === archiveStamp[1] && renderedState.archiveStamp[2] === archiveStamp[2]
      && renderedState.archiveStamp[3] === archiveStamp[3];
    if (sameContent) {
      const statusChanged = renderedState.status !== state.status || !sameActive(renderedState.active, active)
        || renderedState.lastError !== state.lastError || renderedState.lastGenerationReport !== state.lastGenerationReport
        || renderedState.unprofiledSelectedCount !== state.unprofiledSelectedCount || renderedState.feedback !== feedback;
      if (!statusChanged) return;
      renderedNodes.health.className = healthClass(state);
      renderedNodes.health.textContent = statusCopy(state);
      renderedNodes.feedback.className = `v3-foundation-feedback${feedback.includes('失败') ? ' error' : ''}`;
      renderedNodes.feedback.textContent = feedback;
      for (const control of busyControls) control.node.disabled = control.isDisabled();
      for (const button of generationButtons) button.node.textContent = active?.kind === 'generating' ? '正在整理…' : button.label;
      renderedState = { ...renderedState, status: state.status, active, lastError: state.lastError,
        lastGenerationReport: state.lastGenerationReport, unprofiledSelectedCount: state.unprofiledSelectedCount, feedback };
      return;
    }
    if (switcherNode) switcherScrollLeft = Number(switcherNode.scrollLeft) || 0;
    const previousChatId = chatId, previousSignature = switcherSignature;
    operationMenus.reset(); busyControls = []; generationButtons = [];
    const page = element('section', 'qqj-page qqj-profiles-page'), status = element('div', 'qqj-page-status');
    const health = element('p', healthClass(state), statusCopy(state));
    health.setAttribute?.('role', 'status');
    const feedbackNode = element('p', `v3-foundation-feedback${feedback.includes('失败') ? ' error' : ''}`, feedback);
    status.append(health, feedbackNode); page.append(status);
    const selected = state.people.filter(person => person.selected), moreCount = state.people.length - selected.length;
    if (!selected.some(person => person.entityId === currentEntityId)) { closeCrop(); currentEntityId = selected[0]?.entityId ?? null; }
    const nextSignature = JSON.stringify(selected.map(person => person.entityId).sort());
    const nextSwitcher = switcher(selected);
    const preserveSwitcherScroll = previousChatId === chatId && previousSignature === nextSignature;
    const toolbar = element('div', 'qqj-profile-toolbar'), switchRow = element('div', 'qqj-profile-switch-row'); switchRow.append(nextSwitcher);
    const actions = element('div', 'qqj-profile-toolbar-actions');
    const more = element('button', `secondary-action qqj-profile-more${showMore ? ' active' : ''}`, showMore ? '返回资料' : `更多人物（${moreCount}）`);
    more.type = 'button'; more.addEventListener('click', () => { closeCrop(); showMore = !showMore; render(state); }); actions.append(more); switchRow.append(actions); toolbar.append(switchRow); page.append(toolbar);
    if (showMore) page.append(peoplePicker(state.people));
    else {
      const current = selected.find(person => person.entityId === currentEntityId);
      if (current) page.append(profilePanel(current));
      else page.append(element('div', 'qqj-inline-empty', state.people.length
        ? '尚未选择重要人物。点击上方“更多人物”即可自由选择，选择 0 位也完全可以。'
        : '尚无已识别人物。摘要和人物状态分析后会在此显示；已有聊天历史可在“记忆管理”中点击“补齐缺失”。'));
    }
    const unavailable = state.selectedEntityIds.length - selected.length;
    if (unavailable > 0) page.append(element('p', 'settings-hint', `${unavailable} 个旧人物暂未匹配，选择与资料仍保留。`));
    container.replaceChildren(page);
    nextSwitcher.scrollLeft = preserveSwitcherScroll ? switcherScrollLeft : 0;
    switcherNode = nextSwitcher; switcherSignature = nextSignature; switcherScrollLeft = nextSwitcher.scrollLeft;
    renderedNodes = { health, feedback: feedbackNode };
    renderedState = { chatId, people: state.people, revision: state.revision, status: state.status, active,
      lastError: state.lastError, lastGenerationReport: state.lastGenerationReport,
      unprofiledSelectedCount: state.unprofiledSelectedCount, archivedPeopleSnapshotCount: state.archivedPeopleSnapshotCount,
      feedback, showMore, currentEntityId, draftStamp, archiveStamp };
  }
  function subscribe() {
    if (!active || unsubscribe || typeof runtime.subscribe !== 'function') return;
    const release = runtime.subscribe(next => {
      const reading = state.active?.kind === 'loading' || next.active?.kind === 'loading';
      state = next; resetForChat(next.chatId ?? null);
      if (reading) feedback = readFeedback(next);
      if (active && container) render(next);
    });
    if (typeof release === 'function') unsubscribe = release;
  }
  function mount(target) { unsubscribe?.(); unsubscribe = null; operationMenus.deactivate(); renderedState = null; renderedNodes = null; busyControls = []; generationButtons = []; switcherNode = null; container = target; active = true; render(runtime.getState()); operationMenus.activate(); subscribe(); }
  async function activate() {
    if (!container) throw new Error('千人人物资料 view 尚未挂载');
    active = true; operationMenus.activate(); subscribe(); const mine = ++epoch; feedback = '正在读取当前聊天…'; render(runtime.getState());
    let preparingIdentity = false;
    try {
      const sessionState = sessionStateProvider?.() ?? null;
      preparingIdentity = sessionState?.status === 'error';
      if (sessionState?.status === 'error') throw sessionState.error ?? new Error('当前聊天身份准备失败，请稍后重试。');
      if (['idle', 'preparing'].includes(sessionState?.status) && typeof prepareSession === 'function') {
        preparingIdentity = true;
        const prepared = await prepareSession();
        preparingIdentity = false;
        if (!active || mine !== epoch) return { status: 'stale' };
        if (prepared?.status === 'idle') {
          state = runtime.getState(); feedback = '当前聊天尚未开始记录，继续对话后可开始记录'; render(state); return { status: 'uninitialized' };
        }
        if (prepared?.status !== 'ready') return prepared;
      }
      const result = await runtime.refresh({ refreshMemory: false }); if (!active || mine !== epoch) return { status: 'stale' }; state = result; resetForChat(result.chatId ?? null); feedback = readFeedback(result); render(result); return result;
    }
    catch (error) { if (!active || mine !== epoch) return { status: 'stale' }; state = runtime.getState(); resetForChat(state.chatId ?? null); feedback = `${preparingIdentity ? '聊天身份准备失败' : '读取失败'}：${publicErrorMessage(error, { fallback: preparingIdentity ? '请到“记忆管理”页点击“复制状态诊断”反馈。' : '人物资料暂时无法读取，请重试。' })}`; render(state); return { status: 'error', error }; }
  }
  function deactivate() { active = false; epoch += 1; closeCrop(); operationMenus.deactivate(); renderedState = null; renderedNodes = null; busyControls = []; generationButtons = []; switcherNode = null; unsubscribe?.(); unsubscribe = null; }
  return Object.freeze({ mount, activate, deactivate, render });
}
