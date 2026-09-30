import { publicErrorMessage } from '../public-error.js';
import { createOperationMenuController } from './operation-menu-controller.js';
import { createInlineSelect } from './inline-select.js';
import { formatStoryTimeFields, storyTimeFields } from '../v3/time-engine.js';

const VALID_STATUS = new Set(['planned', 'inProgress', 'completed', 'cancelled', 'occurred', 'unknown']);
const STATUS_COPY = Object.freeze({ planned: '已计划 / 尚未记录完成', inProgress: '进行中 / 尚未记录完成', completed: '已完成', cancelled: '已取消', occurred: '已发生', unknown: '状态未明' });
const STATUS_BADGE_COPY = Object.freeze({ planned: '待办', inProgress: '进行中', completed: '已完成', cancelled: '已取消', occurred: '已发生', unknown: '状态未明' });
const HISTORY_STATUS_COPY = Object.freeze({ running: '正在补齐历史事件', completed: '历史补齐完成', partial: '历史补齐部分完成', stopped: '历史补齐已停止', failed: '历史补齐未完成' });
const REJUDGE_STATUS_COPY = Object.freeze({ running: '正在暂存已存千事重判结果', completed: '已存千事重判完成', partial: '已存千事重判部分完成', stopped: '已存千事重判已取消', failed: '已存千事重判未完成' });
const HISTORY_OUTCOME_COPY = Object.freeze({ failed: '本楼未能完成，原记录已保留。', skipped: '本楼已跳过，原记录保持不变。' });
const HISTORY_START_PENDING_FEEDBACK = '计划已确认；正在启动补齐…';
const REJUDGE_START_PENDING_FEEDBACK = '范围已确认；正在启动重判…';
const validMessageIndex = value => Number.isSafeInteger(value) && value >= 0;
const text = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('zh-CN');
const searchText = event => text([event.title, event.description, event.object, event.storyTime, event.scheduledTime,
  ...(event.people ?? []).map(person => person.name)].filter(Boolean).join(' '));

function coverageProjection(snapshot) {
  if (snapshot?.status !== 'ready') return { kind: 'unavailable', label: '当前不可用', copy: snapshot?.message || '当前聊天还没有可用的千事快照。' };
  const coverage = snapshot.coverage ?? {}, events = snapshot.events ?? [];
  const complete = Number(coverage.completeFloors) || 0, eligible = Number(coverage.eligibleFloors) || 0;
  const pending = Number(coverage.pendingFloors) || 0, partial = Number(coverage.partialFloors) || 0;
  const degraded = Number(coverage.degradedFloors) || 0, unavailable = Number(coverage.unavailableFloors) || 0;
  const suffix = unavailable ? `无唯一有效摘要 ${unavailable} 楼` : '';
  const breakdown = `已完成 ${complete} 楼；待补 ${pending} 楼；部分整理 ${partial} 楼；断链 ${degraded} 楼${suffix ? `；${suffix}` : ''}。分母是 ${eligible} 个有唯一有效摘要的楼。`;
  if (degraded) return { kind: 'degraded', label: '部分关系失效', copy: `${breakdown}断链楼的既有事件和摘要仍显示；补齐旧楼只处理尚未存档的楼，不会重算已存事件。` };
  if (partial) return { kind: 'partial', label: '尚有其他楼未完成', copy: `${breakdown}已有事件的楼按已存档计入完成；尚有其他楼待补。` };
  if (pending) return { kind: complete ? 'partial' : 'pending', label: complete ? '尚有其他楼未完成' : '等待补齐',
    copy: `${breakdown}${complete ? '已有事件的楼按已存档计入完成；尚有其他楼待补。' : '有摘要的楼尚未完成千事整理。'}` };
  if (unavailable) return { kind: 'partial', label: '覆盖不完整', copy: `${breakdown}这些楼当前不能进入千事计划。` };
  if (!events.length) return { kind: 'empty', label: '已检查为空', copy: `${breakdown}目前没有保存的剧情事件。` };
  return { kind: 'ready', label: '覆盖就绪', copy: `${breakdown}共保存 ${events.length} 件事件。` };
}

export function createQianshiTimelineView({ runtime, dialog = null, documentRef = globalThis.document } = {}) {
  if (!runtime || ['getState', 'getQianshiSnapshot', 'prepareQianshiHistory', 'startQianshiHistory', 'stopQianshiHistory', 'canEditQianshiEventText', 'editQianshiEventText', 'subscribe']
    .some(name => typeof runtime[name] !== 'function')) throw new TypeError('千事时间线 runtime 无效');
  if (!documentRef?.createElement) throw new TypeError('千事时间线 documentRef 无效');
  let container = null, active = false, unsubscribe = null, epoch = 0;
  let snapshot = runtime.getQianshiSnapshot(), runtimeState = runtime.getState(), chatId = snapshot?.identity?.qqjChatId ?? null;
  let query = '', reverse = true, feedback = '';
  const textEditors = new Map();
  const editableEvents = new Map();
  const operationMenus = createOperationMenuController(documentRef);
  const openIds = new Set(), nestedOpenIds = new Set(), matterOpenIds = new Set();
  const openDayStates = new Map();
  let undatedOpenState = false;
  const element = (tag, className = '', copy = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (copy !== '') node.textContent = copy;
    return node;
  };
  const statusPicker = (value, ariaLabel, disabled, onChange = null) => {
    // 状态选择复用插件内控件，手机点击不会打开系统选择弹窗；人工保存仍由原按钮显式执行。
    const allowed = ['planned', 'inProgress', 'completed', 'occurred'];
    const options = allowed.map(value => ({ value, label: STATUS_BADGE_COPY[value] }));
    if (!allowed.includes(value)) options.unshift({ value: '', label: '保持原状态' });
    const picker = createInlineSelect({ documentRef, options,
      value: allowed.includes(value) ? value : '', ariaLabel, onChange: next => onChange?.(next || value) });
    picker.node.className += ' qqj-qianshi-status-select'; picker.setDisabled(disabled); return picker.node;
  };
  const resetForChat = nextChatId => {
    if (chatId === nextChatId) return;
    epoch += 1; chatId = nextChatId; query = ''; reverse = true; feedback = ''; textEditors.clear(); editableEvents.clear(); openIds.clear(); nestedOpenIds.clear(); matterOpenIds.clear(); openDayStates.clear(); undatedOpenState = false;
  };
  const canEditEvent = eventId => {
    if (!editableEvents.has(eventId)) editableEvents.set(eventId, runtime.canEditQianshiEventText(eventId));
    return editableEvents.get(eventId);
  };
  const visibleEvents = () => {
    const needle = text(query).trim();
    return (snapshot?.events ?? []).filter(event => !needle || searchText(event).includes(needle));
  };
  const dayStateId = (segment, group) => JSON.stringify([segment.id, group.key ?? [group.period ?? '', group.day ?? '']]);
  const historyBusy = () => snapshot?.history?.status === 'running' || runtimeState?.qianshiHistoryActive === true;
  const otherWorkBusy = () => runtimeState?.memoryWorkBusy === true || Boolean(runtimeState?.activeExtraction || runtimeState?.activeCse);
  const sourceCopy = event => validMessageIndex(event.sourceMessageIndex) ? `第 ${event.sourceMessageIndex} 楼` : `AI 记录 ${event.sourceAssistantSeq ?? '未明'}`;
  const statusBadge = event => {
    const status = VALID_STATUS.has(event.actionStatus ?? event.status) ? event.actionStatus ?? event.status : 'unknown';
    const badge = element('small', `qqj-qianshi-state status-${status}`, STATUS_BADGE_COPY[status]);
    badge.title = `本条动作状态：${STATUS_BADGE_COPY[status]}`;
    badge.setAttribute('aria-label', badge.title);
    return badge;
  };
  const groupedDayCards = (groupId, eventIds, eventById) => {
    const cards = [], byMatter = new Map();
    for (const [index, id] of eventIds.entries()) {
      const event = eventById.get(id);
      if (!event) continue;
      if (!event.matterId) { cards.push({ id: event.id, representative: event, events: [event], order: index }); continue; }
      let card = byMatter.get(event.matterId);
      if (!card) {
        card = { id: `${groupId}:${event.matterId}`, representative: event, events: [], order: index };
        byMatter.set(event.matterId, card); cards.push(card);
      }
      card.events.push(event); card.representative = event; card.order = index;
    }
    return cards.sort((left, right) => left.order - right.order);
  };

  function matterHistory(event, matterEvents) {
    if (!event.matterId) return null;
    const events = matterEvents.get(event.matterId) ?? [];
    if (!events.length) return null;
    const section = element('details', 'qqj-qianshi-matter');
    const summary = element('summary', 'qqj-qianshi-matter-summary', `这件事的经过 · ${events.length} 条`);
    const sectionKey = `matter:${event.id}`; section.open = matterOpenIds.has(sectionKey);
    let built = false;
    section.append(summary);
    const build = () => {
      if (built) return;
      const list = element('div', 'qqj-qianshi-matter-list');
      for (const item of events) {
        const rowKey = `${sectionKey}:${item.id}`, row = element('details', `qqj-qianshi-matter-event${item.id === event.id ? ' current' : ''}`);
        row.open = nestedOpenIds.has(rowKey);
        const head = element('summary');
        head.append(element('span', '', `${item.storyTime || '时间未明'} · ${item.title}${item.updatesMatter === false ? '（背景 / 补充）' : ''}`), statusBadge(item));
        row.append(head);
        let rowBuilt = false;
        const ensureRow = () => { if (!rowBuilt) { row.append(eventDetails(item, 'qqj-qianshi-day-event-detail', false)); rowBuilt = true; } };
        if (row.open) ensureRow();
        row.addEventListener('toggle', () => { if (row.open) { nestedOpenIds.add(rowKey); ensureRow(); } else nestedOpenIds.delete(rowKey); });
        list.append(row);
      }
      section.append(list); built = true;
    };
    section.addEventListener('toggle', () => {
      if (section.open) { matterOpenIds.add(sectionKey); build(); } else matterOpenIds.delete(sectionKey);
    });
    if (section.open) build();
    return section;
  }

  function eventDetails(event, className = 'qqj-qianshi-expanded', allowEdit = true) {
    const body = element('div', className);
    // 与千结行内编辑一致：编辑表单替代阅读正文，避免原文、元信息与表单同时堆成长框。
    if (allowEdit && canEditEvent(event.id) && textEditors.get(event.id)?.editing) {
      body.append(eventTextEditor(event)); return body;
    }
    body.append(element('p', 'qqj-qianshi-description', event.description));
    const meta = element('dl', 'qqj-qianshi-meta');
    const row = (label, value, valueClass = '') => {
      if (!value) return;
      const dt = element('dt', '', label), dd = element('dd', valueClass, value); meta.append(dt, dd);
    };
    row('人物', (event.people ?? []).map(person => person.name).filter(Boolean).join('、'));
    row('涉及物品', event.object);
    row('本条动作状态', VALID_STATUS.has(event.actionStatus ?? event.status) ? STATUS_COPY[event.actionStatus ?? event.status] : '状态未明');
    if (event.matterId && event.updatesMatter) row('这次进展后的整线状态', VALID_STATUS.has(event.status) ? STATUS_COPY[event.status] : '状态未明');
    row('约定', event.scheduledTime ? `${event.scheduledTime}（约定 / 预计）` : '');
    row('来源', sourceCopy(event), 'source');
    body.append(meta);
    return body;
  }

  function eventTextEditor(event) {
    const state = textEditors.get(event.id);
    const section = element('section', 'qqj-qianshi-text-editor');
    const form = element('form', 'qqj-qianshi-text-form');
    const titleLabel = element('label', 'qqj-qianshi-text-label', '标题');
    const title = element('input', 'settings-input qqj-qianshi-title-input'); title.value = state.title; title.maxLength = 500; title.disabled = state.pending;
    titleLabel.append(title);
    const descriptionLabel = element('label', 'qqj-qianshi-text-label', '经过说明');
    const description = element('textarea', 'settings-input qqj-qianshi-description-input'); description.value = state.description; description.maxLength = 4000; description.rows = 3; description.disabled = state.pending;
    descriptionLabel.append(description);
    const objectLabel = element('label', 'qqj-qianshi-text-label', '涉及物品');
    const object = element('input', 'settings-input qqj-qianshi-object-input'); object.value = state.object; object.maxLength = 1000; object.disabled = state.pending;
    objectLabel.append(object, element('small', 'qqj-qianshi-object-hint', '只填对后续有用的具体物品；多个用顿号分隔；没有可留空。'));
    const statusSelect = (labelText, key) => {
      const label = element('div', 'qqj-qianshi-text-label');
      label.append(element('span', '', labelText), statusPicker(state[key], labelText, state.pending, value => { state[key] = value; }));
      return label;
    };
    title.addEventListener('input', event => { state.title = event.target.value; });
    description.addEventListener('input', event => { state.description = event.target.value; });
    object.addEventListener('input', event => { state.object = event.target.value; });
    form.append(titleLabel, descriptionLabel, objectLabel);
    const timeGroup = element('fieldset', 'qqj-qianshi-time-editor');
    const timeTitle = element('legend', '', '发生时间');
    const clearTime = element('button', 'qqj-qianshi-time-clear', '清空'); clearTime.type = 'button'; clearTime.disabled = state.pending;
    clearTime.addEventListener('click', () => { for (const key of Object.keys(state.timeDraft)) state.timeDraft[key] = '';
      state.clearTime = true; render(); });
    timeTitle.append(clearTime); timeGroup.append(timeTitle);
    const timeFields = element('div', 'qqj-qianshi-time-fields');
    const timeHint = element('p', 'qqj-qianshi-time-preview');
    const timeDirty = () => state.clearTime || Object.keys(state.timeDraft).some(key => state.timeDraft[key] !== state.initialTimeDraft[key]);
    const updateTimePreview = () => {
      if (timeDirty()) {
        try { timeHint.textContent = `保存后：${formatStoryTimeFields(state.timeDraft) || '时间未知'}`; }
        catch (error) { timeHint.textContent = error.message; }
      } else timeHint.textContent = `原时间：${event.storyTime || '时间未知'}`;
      save.disabled = state.pending;
    };
    for (const [key, labelText, placeholder] of [['prefix', '前缀', '可留空'], ['year', '年', '2027'],
      ['month', '月', '3 / 夏月'], ['day', '日', '5'], ['clock', '时间', '07:45']]) {
      const label = element('label', `qqj-qianshi-text-label qqj-qianshi-time-${key}`);
      const input = element('input', 'settings-input qqj-qianshi-time-input'); input.type = 'text';
      input.value = state.timeDraft[key]; input.placeholder = placeholder; input.disabled = state.pending;
      input.setAttribute('aria-label', `发生时间${labelText}`);
      input.addEventListener('input', () => { state.timeDraft[key] = input.value; updateTimePreview(); });
      label.append(element('span', '', labelText), input); timeFields.append(label);
    }
    timeGroup.append(timeFields, timeHint); form.append(timeGroup);
    const states = element('div', 'qqj-qianshi-edit-states');
    states.append(statusSelect('本条动作状态', 'actionStatus'));
    if (event.matterId && event.updatesMatter) states.append(statusSelect('这次进展后的整线状态', 'status'));
    form.append(states);
    if (state.error) form.append(element('p', 'qqj-qianshi-edit-error', state.error));
    const actions = element('div', 'qqj-qianshi-edit-actions');
    const save = element('button', 'primary-action', state.pending ? '正在保存…' : '保存'); save.type = 'submit'; save.disabled = state.pending;
    const cancel = element('button', 'secondary-action', '取消'); cancel.type = 'button'; cancel.disabled = state.pending;
    cancel.addEventListener('click', () => { textEditors.delete(event.id); render(); });
    actions.append(save, cancel); form.append(actions); updateTimePreview();
    form.addEventListener('submit', async submission => {
      submission.preventDefault?.();
      // 未动时间时逐字保留原值；五格清空是明确人工未知，不能再由来源楼时间补回。
      let storyTime;
      if (timeDirty()) {
        try { storyTime = formatStoryTimeFields(state.timeDraft); }
        catch (error) { state.error = error.message; render(); return; }
      }
      const clean = value => String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      const next = { title: clean(state.title).slice(0, 500), description: clean(state.description).slice(0, 4000), object: clean(state.object).slice(0, 1000) || null,
        status: state.status, actionStatus: state.actionStatus, ...(timeDirty() ? { storyTime } : {}) };
      state.title = next.title; state.description = next.description; state.object = next.object ?? '';
      if (!next.title || !next.description) { state.error = '标题和经过说明都不能为空。'; render(); return; }
      if (next.title === clean(state.baseline.title).slice(0, 500) && next.description === clean(state.baseline.description).slice(0, 4000)
        && next.object === (clean(state.baseline.object).slice(0, 1000) || null) && next.status === state.baseline.status
        && next.actionStatus === state.baseline.actionStatus && !timeDirty()) { textEditors.delete(event.id); feedback = '内容没有变化，没有写入新版本。'; render(); return; }
      state.pending = true; state.error = ''; render();
      const saveEpoch = epoch, saveChatId = chatId;
      try {
        const result = await runtime.editQianshiEventText({ eventId: event.id, expected: state.baseline, ...next });
        if (epoch !== saveEpoch || chatId !== saveChatId) return;
        textEditors.delete(event.id);
        feedback = result?.status === 'unchanged' ? '内容没有变化，没有写入新版本。' : '事件修改已保存。';
      } catch (error) {
        if (epoch !== saveEpoch || chatId !== saveChatId) return;
        state.pending = false;
        state.error = publicErrorMessage(error?.message, { fallback: '保存失败，请检查当前记录后重试。' });
      }
      render();
    });
    section.append(form);
    return section;
  }

  async function changeEventStatus(event, matter) {
    const operationEpoch = epoch, operationChatId = chatId;
    const wholeLine = Boolean(event.updatesMatter && matter && !matter.synthetic);
    const currentStatus = wholeLine ? matter.status : event.actionStatus ?? event.status;
    const content = element('section', 'qqj-qianshi-status-dialog');
    content.append(element('p', 'qqj-qianshi-status-intro', `${wholeLine ? '整件事' : '本条记录'}：${wholeLine ? matter.title : event.title}`),
      element('p', 'qqj-qianshi-status-current', `当前：${STATUS_BADGE_COPY[currentStatus] || '状态未明'}`));
    const choices = [
      ['planned', '待办', '已经安排，尚未开始。'], ['inProgress', '进行中', '已经开始，后面还有进展。'],
      ['completed', '已完成', wholeLine ? '整件事已经结束，无需继续跟进。' : '这条动作已经完成。'], ['occurred', '已发生', '一次性的事情已经发生，无需等待后续。'],
      ...(wholeLine ? [['automatic', '恢复自动判断', '清除整线人工状态，按已存进展判断；不调用模型。']] : []),
    ];
    let selected = wholeLine && matter.manualStatusOverride == null ? 'automatic'
      : choices.some(([value]) => value === currentStatus) ? currentStatus : '';
    const name = `qqj-status-${event.id}`, list = element('div', 'qqj-qianshi-status-choices');
    const inputs = [];
    for (const [value, labelText, description] of choices) {
      const row = element('label', 'qqj-qianshi-status-choice'), input = element('input');
      input.type = 'radio'; input.name = name; input.value = value; input.checked = selected === value;
      input.addEventListener('change', () => { selected = value; for (const radio of inputs) radio.checked = radio.value === value; });
      const copy = element('span'); copy.append(element('strong', '', labelText), element('span', '', description));
      inputs.push(input); row.append(input, copy); list.append(row);
    }
    content.append(list);
    // 沿用现有整线人工覆盖；独立事件只改本条。弹窗取消零写，确认时复核聊天与任务状态。
    try {
      const result = await dialog.custom({ title: '修改状态', content, confirmText: '保存', cancelText: '取消', submit: async () => {
        if (!active || epoch !== operationEpoch || chatId !== operationChatId
          || runtime.getQianshiSnapshot()?.identity?.qqjChatId !== operationChatId) throw new Error('聊天已变化，请重新打开状态修改。');
        runtimeState = runtime.getState();
        if (otherWorkBusy() || historyBusy()) throw new Error('请等待当前任务结束后再保存。');
        if (!selected) throw new Error('请选择状态。');
        if (wholeLine) return runtime.setQianshiMatterStatus({ matterId: matter.matterId,
          status: selected === 'automatic' ? null : selected, expectedStatus: matter.status,
          expectedManualStatus: matter.manualStatusOverride ?? null });
        if (selected === currentStatus) return { status: 'unchanged' };
        return runtime.editQianshiEventText({ eventId: event.id, expected: { memoryId: event.sourceFloorMemoryId,
          title: event.title, description: event.description, object: event.object ?? null,
          status: event.status, actionStatus: event.actionStatus ?? event.status }, title: event.title,
          description: event.description, object: event.object ?? null, actionStatus: selected,
          ...(!event.matterId ? { status: selected } : {}) });
      } });
      if (!active || epoch !== operationEpoch || chatId !== operationChatId || !result) return;
      feedback = result.status === 'unchanged' ? '状态没有变化。' : selected === 'automatic' ? '已恢复自动判断。' : '状态已保存。';
      render();
    } catch (error) {
      if (active && epoch === operationEpoch && chatId === operationChatId) {
        feedback = `状态修改失败：${publicErrorMessage(error, { fallback: '请稍后重试。' })}`; render();
      }
    }
  }

  function eventOperationMenu(event, { cardId = event.id, nestedRowKey = null } = {}) {
    if (!canEditEvent(event.id) || textEditors.get(event.id)?.editing) return null;
    const menu = operationMenus.register(element('details', 'qqj-profile-menu qqj-qianshi-event-menu'));
    menu.dataset.qianshiEventId = event.id;
    const toggle = element('summary', 'qqj-profile-menu-toggle', '⋮');
    toggle.setAttribute?.('aria-label', `${event.title}操作`); toggle.setAttribute?.('title', `${event.title}操作`);
    const menuBody = element('div', 'qqj-profile-menu-pop');
    const matter = event.matterId ? snapshot?.matters?.find(item => item.matterId === event.matterId) : null;
    const edit = element('button', 'qqj-profile-menu-action', '编辑详情'); edit.type = 'button';
    edit.addEventListener('click', () => {
      menu.open = false;
      if ((snapshot?.timeline?.undatedEventIds ?? []).includes(event.id)) undatedOpenState = true;
      openIds.add(cardId);
      if (nestedRowKey) nestedOpenIds.add(nestedRowKey);
      const timeDraft = storyTimeFields(event.storyTime);
      textEditors.set(event.id, { editing: true, title: event.title, description: event.description, timeDraft, initialTimeDraft: { ...timeDraft },
        object: event.object ?? '', status: event.status, actionStatus: event.actionStatus ?? event.status,
        baseline: { memoryId: event.sourceFloorMemoryId, title: event.title, description: event.description, object: event.object ?? null,
          status: event.status, actionStatus: event.actionStatus ?? event.status, storyTime: event.storyTime }, error: '', pending: false });
      render();
    });
    // 菜单仅承载入口；状态的说明与选择放入插件弹窗，删除在接口完成前不可执行。
    const remove = element('button', 'qqj-profile-menu-action danger', '删除'); remove.type = 'button';
    remove.disabled = true; remove.title = '删除功能尚未开放。';
    const change = element('button', 'qqj-profile-menu-action', '修改状态'); change.type = 'button';
    change.disabled = otherWorkBusy() || historyBusy() || typeof dialog?.custom !== 'function'
      || Boolean(event.updatesMatter && matter && typeof runtime.setQianshiMatterStatus !== 'function');
    change.addEventListener('click', () => { menu.open = false; void changeEventStatus(event, matter); });
    menuBody.append(edit, remove, change); menu.append(toggle, menuBody);
    return menu;
  }

  function sameDayHistory(events, representativeId, cardId, representativeMenu, setRepresentativeRow) {
    const section = element('section', 'qqj-qianshi-day-progress');
    section.append(element('p', 'qqj-qianshi-day-progress-title', `当天过程 · ${events.length} 条`));
    const list = element('div', 'qqj-qianshi-matter-list');
    for (const item of events) {
      const itemRow = element('div', 'qqj-qianshi-day-event-row');
      const rowKey = `day:${representativeId}:${item.id}`, row = element('details', `qqj-qianshi-matter-event${item.id === representativeId ? ' current' : ''}`);
      row.dataset.qianshiEventId = item.id;
      row.open = nestedOpenIds.has(rowKey);
      const summary = element('summary');
      summary.append(element('span', '', `${item.storyTime || '时间未明'} · ${item.title}`));
      if (item.updatesMatter === false) summary.append(element('small', 'qqj-qianshi-event-role', '背景 / 补充'));
      summary.append(statusBadge(item));
      row.append(summary);
      if (item.id === representativeId) {
        setRepresentativeRow(itemRow);
        if (representativeMenu) itemRow.append(representativeMenu);
      } else {
        const menu = eventOperationMenu(item, { cardId, nestedRowKey: rowKey });
        if (menu) itemRow.append(menu);
      }
      let built = false;
      row.addEventListener('toggle', () => {
        if (row.open) nestedOpenIds.add(rowKey); else nestedOpenIds.delete(rowKey);
        if (!row.open || built) return;
        row.append(eventDetails(item, 'qqj-qianshi-day-event-detail')); built = true;
      });
      if (row.open) { row.append(eventDetails(item, 'qqj-qianshi-day-event-detail')); built = true; }
      itemRow.append(row); list.append(itemRow);
    }
    section.append(list);
    return section;
  }

  function expandedContent(event, matterEvents, dayEvents, cardId, representativeMenu, setRepresentativeRow) {
    const body = element('div', 'qqj-qianshi-expanded');
    if (dayEvents.length > 1) body.append(sameDayHistory(dayEvents, event.id, cardId, representativeMenu, setRepresentativeRow));
    else body.append(eventDetails(event, 'qqj-qianshi-event-detail'));
    const history = matterHistory(event, matterEvents); if (history) body.append(history);
    return body;
  }

  function eventNode(event, matterEvents, { cardId = event.id, dayEvents = [event] } = {}) {
    const itemRow = element('div', 'qqj-qianshi-event-row');
    const details = element('details', 'qqj-qianshi-event'); details.dataset.eventId = event.id; details.dataset.cardId = cardId;
    details.open = openIds.has(cardId);
    const summary = element('summary', 'qqj-qianshi-event-summary');
    if (event.storyTime) summary.append(element('span', 'qqj-qianshi-event-time', event.storyTime));
    const title = element('span', 'qqj-qianshi-event-title', event.title);
    if (dayEvents.length > 1) title.append(element('small', 'qqj-qianshi-event-status', `当天 ${dayEvents.length} 条`));
    title.append(statusBadge(event));
    summary.append(title);
    summary.append(element('p', 'qqj-qianshi-preview', event.description));
    details.append(summary);
    const nestedRowKey = dayEvents.length > 1 ? `day:${event.id}:${event.id}` : null;
    const menu = eventOperationMenu(event, { cardId, nestedRowKey });
    let representativeRow = null;
    const placeRepresentativeMenu = expanded => {
      if (!menu || !representativeRow) return;
      const activeInsideMenu = menu.contains?.(documentRef.activeElement);
      menu.open = false;
      if (expanded) representativeRow.append(menu);
      else itemRow.append(menu);
      if (!expanded && activeInsideMenu) menu.querySelector?.('.qqj-profile-menu-toggle')?.focus?.({ preventScroll: true });
    };
    const ensureBody = () => {
      if (!details.children || [...details.children].some(node => String(node.className).includes('qqj-qianshi-expanded'))) return;
      details.append(expandedContent(event, matterEvents, dayEvents, cardId, menu, row => { representativeRow = row; }));
    };
    details.addEventListener('toggle', () => {
      if (details.open) { openIds.add(cardId); ensureBody(); placeRepresentativeMenu(true); }
      else { openIds.delete(cardId); placeRepresentativeMenu(false); }
    });
    itemRow.append(details); if (menu) itemRow.append(menu);
    if (details.open) { ensureBody(); placeRepresentativeMenu(true); }
    return itemRow;
  }

  function timelineContent(events) {
    const eventById = new Map((snapshot.events ?? []).map(event => [event.id, event]));
    const matterEvents = new Map();
    for (const event of snapshot.events ?? []) if (event.matterId) {
      const values = matterEvents.get(event.matterId);
      if (values) values.push(event); else matterEvents.set(event.matterId, [event]);
    }
    const visibleIds = new Set(events.map(event => event.id)), timeline = snapshot.timeline ?? { segments: [], undatedEventIds: [] };
    const wrapper = element('div', 'qqj-qianshi-timeline');
    let groupCount = 0;
    const orderedVisibleGroups = (timeline.segments ?? []).flatMap(segment => {
      let groups = (segment.groups ?? []).filter(group => group.eventIds.some(id => visibleIds.has(id)));
      const ambiguous = segment.id === 'month-day' && groups.some(group => group.period === '1月') && groups.some(group => group.period === '12月');
      if (reverse && !ambiguous) groups = groups.reverse();
      return groups;
    });
    const defaultGroupId = timeline.hasGlobalLatest && orderedVisibleGroups.some(group => group.id === timeline.globalLatestGroupId)
      ? timeline.globalLatestGroupId : orderedVisibleGroups[0]?.id;
    for (const [segmentIndex, segment] of (timeline.segments ?? []).entries()) {
      let groups = (segment.groups ?? []).map(group => ({ ...group, eventIds: [...group.eventIds] })).filter(group => group.eventIds.some(id => visibleIds.has(id)));
      if (!groups.length) continue;
      const yearBoundaryAmbiguous = segment.id === 'month-day'
        && groups.some(group => group.period === '1月') && groups.some(group => group.period === '12月');
      if (reverse && !yearBoundaryAmbiguous) groups = groups.reverse();
      const block = element('section', 'qqj-qianshi-segment');
      if ((timeline.segments ?? []).length > 1) block.append(element('p', 'qqj-qianshi-segment-label', `${segment.label || (segmentIndex ? '另一组时间' : '时间')} · 不依据其他组推断先后`));
      for (const [groupIndex, group] of groups.entries()) {
        const latest = !yearBoundaryAmbiguous && group.id === segment.latestGroupId;
        const stateId = dayStateId(segment, group);
        const axisPosition = groups.length === 1 ? 'single' : groupIndex === 0 ? 'first' : groupIndex === groups.length - 1 ? 'last' : 'middle';
        const day = element('div', `qqj-qianshi-day qqj-qianshi-day-${axisPosition}${latest ? ' latest' : ''}`); day.id = group.id; day.dataset.dayStateId = stateId;
        const searchExpanded = Boolean(query.trim());
        const defaultExpanded = group.id === defaultGroupId;
        const dayOpen = searchExpanded || (openDayStates.has(stateId) ? openDayStates.get(stateId) : defaultExpanded);
        const visibleEventCount = group.eventIds.filter(id => visibleIds.has(id)).length;
        const date = element('div', 'qqj-qianshi-date'); date.title = group.full;
        date.append(element('span', 'qqj-qianshi-day-name', group.day), element('span', 'qqj-qianshi-period', group.period), element('span', 'qqj-qianshi-day-count', `${visibleEventCount} 件`));
        if (latest) date.append(element('span', 'qqj-qianshi-latest-tag', timeline.hasGlobalLatest ? '最近' : '该段最近'));
        const disclosure = element('details', 'qqj-qianshi-day-disclosure'); disclosure.open = dayOpen;
        const summary = element('summary', 'qqj-qianshi-day-summary'); summary.dataset.dayStateId = stateId; summary.setAttribute('aria-label', `${group.full || `${group.period ?? ''}${group.day ?? ''}`}，${visibleEventCount} 件，${dayOpen ? '收起' : '展开'}`);
        summary.append(date);
        summary.addEventListener('click', event => {
          if (event.isTrusted === true && !query.trim()) openDayStates.set(stateId, !disclosure.open);
        });
        const updateDayLabel = () => {
          summary?.setAttribute('aria-label', `${group.full || `${group.period ?? ''}${group.day ?? ''}`}，${visibleEventCount} 件，${disclosure.open ? '收起' : '展开'}`);
        };
        let cards = groupedDayCards(group.id, group.eventIds, eventById).filter(card => card.events.some(event => visibleIds.has(event.id)));
        if (reverse) cards = cards.reverse();
        if (dayOpen && cards.length > 1) day.className += ' qqj-qianshi-day-has-card-axis';
        const lastEvent = [...group.eventIds].reverse().map(id => eventById.get(id)).find(event => event && visibleIds.has(event.id));
        const preview = element('div', 'qqj-qianshi-day-preview'); preview.hidden = dayOpen;
        if (lastEvent) {
          if (lastEvent.storyTime) preview.append(element('span', 'qqj-qianshi-event-time', lastEvent.storyTime));
          const previewTitle = element('div', 'qqj-qianshi-day-preview-title', lastEvent.title);
          previewTitle.append(statusBadge(lastEvent));
          preview.append(previewTitle, element('p', 'qqj-qianshi-preview', lastEvent.description));
        }
        const eventList = element('div', 'qqj-qianshi-events');
        eventList.hidden = !dayOpen;
        groupCount += cards.length;
        for (const card of cards) eventList.append(eventNode(card.representative, matterEvents, { cardId: card.id, dayEvents: card.events }));
        disclosure.addEventListener('toggle', () => {
          preview.hidden = disclosure.open;
          eventList.hidden = !disclosure.open;
          day.className = day.className.replace(/\s+qqj-qianshi-day-has-card-axis/u, '')
            + (disclosure.open && cards.length > 1 ? ' qqj-qianshi-day-has-card-axis' : '');
          updateDayLabel();
        });
        disclosure.append(summary);
        const dot = element('i', 'qqj-qianshi-dot'); dot.setAttribute('aria-hidden', 'true');
        day.append(disclosure, dot, preview, eventList); block.append(day);
      }
      wrapper.append(block);
    }
    const undated = (timeline.undatedEventIds ?? []).filter(id => visibleIds.has(id)).map(id => eventById.get(id)).filter(Boolean);
    if (undated.length) {
      const details = element('details', 'qqj-qianshi-undated'); details.open = Boolean(query.trim()) || undatedOpenState;
      const summary = element('summary', '', `无法确定单一发生时间 · ${undated.length} 件`), list = element('div', 'qqj-qianshi-undated-list');
      summary.addEventListener('click', event => {
        if (event.isTrusted === true && !query.trim()) undatedOpenState = !details.open;
      });
      for (const event of undated) list.append(eventNode(event, matterEvents));
      groupCount += undated.length;
      details.append(summary, element('p', 'qqj-qianshi-undated-hint', '缺少可靠日期、属于相对时间或时间范围的事项，不参与精确排序；此处保留原顺序与原文时间。'), list); wrapper.append(details);
    }
    if (!wrapper.children?.length) wrapper.append(element('div', 'qqj-qianshi-empty', query ? '没有找到对应事件。' : '当前没有可显示的千事记录。'));
    return { node: wrapper, groupCount };
  }

  async function prepareHistory() {
    if (historyBusy() || otherWorkBusy()) return;
    const operationEpoch = ++epoch, operationChatId = chatId; feedback = '正在准备补齐计划…'; render();
    try {
      const plan = await runtime.prepareQianshiHistory();
      if (!active || operationEpoch !== epoch || runtime.getQianshiSnapshot()?.identity?.qqjChatId !== operationChatId) return;
      if (plan.status === 'empty') { feedback = plan.aggregateSkippedFloors?.length
        ? `${plan.aggregateSkippedFloors.length} 楼由多个正文楼聚合；为保留成员事件来源，当前跳过模型替换。`
        : plan.unavailableFloors?.length ? `当前没有可补齐的摘要楼；${plan.unavailableFloors.length} 楼缺少摘要来源。` : '现有可处理楼都已完成千事整理。'; render(); return; }
      const unavailable = plan.unavailableFloors?.length ?? 0;
      const modelFloors = Number(plan.modelFloors) || 0;
      const aggregateSkipped = plan.aggregateSkippedFloors?.length ?? 0;
      const budgetSkipped = plan.budgetSkippedFloors?.length ?? 0;
      const confirmed = await dialog?.confirm?.({ title: '补齐旧楼千事',
        body: `${modelFloors} 楼进入模型补齐，分 ${plan.batchCount} 批；预计 API ${plan.apiCalls} 次，输入约 ${plan.estimatedInputTokens} token。${budgetSkipped ? `跳过超预算 ${budgetSkipped} 楼。` : ''}${aggregateSkipped ? `跳过聚合记忆 ${aggregateSkipped} 楼。` : ''}`,
        note: `${unavailable ? `另有 ${unavailable} 楼缺少有效摘要。` : ''}确认后才调用 API；取消不调用模型或写入。${modelFloors ? '成功批次立即保存，可停止后继续。' : '暂无可发给模型的楼。'}`,
        confirmText: '开始补齐', cancelText: '取消' });
      if (!active || operationEpoch !== epoch || runtime.getQianshiSnapshot()?.identity?.qqjChatId !== operationChatId) return;
      if (!confirmed) { feedback = '已取消；没有调用模型。'; render(); return; }
      runtimeState = runtime.getState();
      if (otherWorkBusy() || historyBusy()) { feedback = '后台任务状态已经变化，请等待当前任务结束后重新准备补齐计划。'; render(); return; }
      feedback = HISTORY_START_PENDING_FEEDBACK; render();
      await runtime.startQianshiHistory(plan.planId);
    } catch (error) {
      if (active && operationEpoch === epoch) { feedback = `历史补齐未开始：${publicErrorMessage(error, { fallback: '请稍后重试。' })}`; render(); }
    }
  }

  async function stopHistory() {
    if (!historyBusy()) return;
    const operationEpoch = ++epoch; feedback = '正在停止历史补齐…'; render();
    try { await runtime.stopQianshiHistory(); }
    catch (error) { if (active && operationEpoch === epoch) feedback = `停止失败：${publicErrorMessage(error, { fallback: '请稍后重试。' })}`; }
    if (active && operationEpoch === epoch) render();
  }

  async function prepareRejudge() {
    if (historyBusy() || otherWorkBusy() || typeof runtime.prepareQianshiRejudge !== 'function'
      || typeof runtime.startQianshiRejudge !== 'function' || typeof dialog?.prompt !== 'function') return;
    const operationEpoch = ++epoch, operationChatId = chatId;
    try {
      const latestMessageIndex = (snapshot?.events ?? []).reduce((latest, event) => Number.isSafeInteger(event.sourceMessageIndex)
        ? Math.max(latest, event.sourceMessageIndex) : latest, -1);
      const input = await dialog.prompt({ title: '重新整理已存千事', body: `留空或填 0，从第 0 楼整理到最新；也可填 12~30 指定范围（按酒馆显示的楼号）。${latestMessageIndex >= 0 ? `当前最新为第 ${latestMessageIndex} 楼。` : ''}`,
        placeholder: '留空整理全部，或填 12~30', maxLength: 32, confirmText: '预览范围' });
      if (!active || operationEpoch !== epoch || input === null || runtime.getQianshiSnapshot()?.identity?.qqjChatId !== operationChatId) return;
      // 一次输入同时选择两端；省略终点保留开放边界，由实际存档解析，不能转成第 0 楼。
      const value = String(input).trim(), range = value.match(/^(\d+)(?:\s*[~～-]\s*(\d*))?$/u);
      if (value && !range) { feedback = '请输入楼号范围，例如 12~30；留空或填 0 可整理全部。'; render(); return; }
      const plan = await runtime.prepareQianshiRejudge({ fromMessageIndex: range ? Number(range[1]) : 0,
        toMessageIndex: range?.[2] ? Number(range[2]) : null });
      if (!active || operationEpoch !== epoch || runtime.getQianshiSnapshot()?.identity?.qqjChatId !== operationChatId) return;
      if (plan.status !== 'ready') { feedback = '所选范围没有可重判的单楼千事存档。'; render(); return; }
      // 大范围确认只概括首尾与数量；逐楼结果仍在任务列表中显示，不能让弹窗随楼数增长。
      const firstFloor = plan.floors?.[0], lastFloor = plan.floors?.at(-1);
      const rangeCopy = Number.isSafeInteger(firstFloor?.messageIndex) && Number.isSafeInteger(lastFloor?.messageIndex)
        ? firstFloor.messageIndex === lastFloor.messageIndex ? `第 ${firstFloor.messageIndex} 楼`
          : `第 ${firstFloor.messageIndex}–${lastFloor.messageIndex} 楼` : '已选范围';
      const recordCount = (plan.floors ?? []).reduce((sum, item) => sum + (Number(item.recordCount) || 0), 0);
      const confirmed = await dialog.confirm({ title: '确认重判已存千事',
        body: `${rangeCopy}：${plan.totalFloors} 个 AI 楼、${recordCount} 条旧记录；预计 API ${plan.apiCalls} 次。`,
        note: '只重判千事的归线和状态，保留原文字、人物、物品、时间、摘要、双丝网及人工修订。确认后才调用 API，全部处理后统一保存；提交前取消或失败不改原档，关联冲突则不保存。',
        confirmText: '开始重判', cancelText: '取消' });
      if (!active || operationEpoch !== epoch || runtime.getQianshiSnapshot()?.identity?.qqjChatId !== operationChatId) return;
      if (!confirmed) { feedback = '已取消；没有调用模型或写入。'; render(); return; }
      runtimeState = runtime.getState();
      if (otherWorkBusy() || historyBusy()) { feedback = '后台任务状态已经变化，请等待后重新准备范围。'; render(); return; }
      feedback = REJUDGE_START_PENDING_FEEDBACK; render();
      await runtime.startQianshiRejudge(plan.planId);
    } catch (error) {
      if (active && operationEpoch === epoch) { feedback = `重判未开始：${publicErrorMessage(error, { fallback: '请稍后重试。' })}`; render(); }
    }
  }

  function render() {
    if (!container) return;
    const currentChatId = snapshot?.identity?.qqjChatId ?? null;
    const previousChatId = chatId;
    const previousResults = container.querySelector?.('.qqj-qianshi-history-results');
    const preserveResults = previousChatId === currentChatId && previousResults;
    const resultsScrollTop = preserveResults ? previousResults.scrollTop : 0;
    const outerScrollPositions = [];
    for (let ancestor = container.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.scrollTop) outerScrollPositions.push([ancestor, ancestor.scrollTop]);
    }
    const resultsHadFocus = preserveResults && (previousResults === documentRef.activeElement
      || previousResults.contains?.(documentRef.activeElement));
    const focusedControlKey = documentRef.activeElement?.dataset?.focusKey ?? null;
    const focusedDayStateId = documentRef.activeElement?.className === 'qqj-qianshi-day-summary' ? documentRef.activeElement.dataset?.dayStateId : null;
    resetForChat(currentChatId);
    operationMenus.reset();
    const page = element('section', 'qqj-qianshi-page');
    const coverage = coverageProjection(snapshot), coverageBox = element('section', `qqj-qianshi-coverage ${coverage.kind}`);
    const coverageText = element('div'); coverageText.append(element('strong', '', coverage.label), element('p', '', coverage.copy));
    const history = snapshot?.history ?? {}, historyRunning = historyBusy();
    const coverageCounts = snapshot?.coverage ?? {};
    const hasHistoryToComplete = snapshot?.status === 'ready'
      && (Number(coverageCounts.pendingFloors) || 0) + (Number(coverageCounts.partialFloors) || 0) > 0;
    if (historyRunning || hasHistoryToComplete) {
      const historyAction = element('button', 'secondary-action', historyRunning ? history.committing ? '提交中…' : '停止' : '补齐旧楼'); historyAction.type = 'button';
      historyAction.disabled = historyRunning ? Boolean(history.committing) : otherWorkBusy();
      historyAction.addEventListener('click', () => { void (historyRunning ? stopHistory() : prepareHistory()); });
      coverageBox.append(coverageText, historyAction);
    } else coverageBox.append(coverageText);
    if (!historyRunning && snapshot?.events?.length && typeof runtime.prepareQianshiRejudge === 'function') {
      const rejudge = element('button', 'secondary-action', '重新整理已存千事'); rejudge.type = 'button';
      rejudge.disabled = otherWorkBusy(); rejudge.addEventListener('click', () => { void prepareRejudge(); }); coverageBox.append(rejudge);
    }
    if (history.status && history.status !== 'idle') {
      const outcomes = history.outcomes ?? [];
      const isRejudge = history.mode === 'rejudge';
      const statusCopy = isRejudge ? REJUDGE_STATUS_COPY : HISTORY_STATUS_COPY;
      const progress = history.status === 'running'
        ? `${history.committing ? '整组正在提交' : `${isRejudge ? '已暂存' : '已处理'} ${history.processedFloors ?? 0}/${history.totalFloors ?? 0} 楼`}${history.committing ? '；此阶段不能取消' : `；失败 ${history.failedFloors ?? 0} 楼；跳过 ${history.skippedFloors ?? 0} 楼 · 模型任务 ${history.calls ?? 0} 次`}${history.message ? ` · ${history.message}` : ''}`
        : `${history.message || statusCopy[history.status] || '历史补齐状态待核对。'}${history.attemptedFloors !== undefined
          ? ` 已处理 ${history.processedFloors} 楼；失败 ${history.failedFloors ?? 0} 楼；跳过 ${history.skippedFloors ?? 0} 楼。` : ''}`;
      coverageBox.append(element('p', 'qqj-qianshi-history-status', progress));
      const results = element('div', 'qqj-qianshi-history-results');
      results.setAttribute('role', 'region'); results.setAttribute('aria-label', '历史补齐逐楼结果'); results.setAttribute('tabindex', '0');
      for (const outcome of outcomes.filter(item => item.status !== 'saved-complete' && (item.reasonCode || item.message))) {
        const reason = String(outcome.message ?? '').trim() || HISTORY_OUTCOME_COPY[outcome.status] || '本楼暂未完成，原记录已保留。';
        const floorCopy = Number.isSafeInteger(outcome.assistantSeq) && outcome.assistantSeq > 0
          ? `第 ${outcome.assistantSeq} 楼：${reason}` : `目标楼已不存在或楼层已变化：${reason}`;
        results.append(element('p', 'qqj-qianshi-history-status', floorCopy));
      }
      if (results.children.length) coverageBox.append(results);
    }
    page.append(coverageBox);
    const search = element('div', 'qqj-history-search');
    const input = element('input', 'settings-input qqj-history-search-input'); input.type = 'search'; input.value = query; input.placeholder = '搜索事件、说明、人物、涉及物品或时间'; input.setAttribute('aria-label', input.placeholder);
    input.addEventListener('input', event => {
      query = event.target.value; const cursor = event.target.selectionStart; render();
      const next = container.querySelector?.('.qqj-history-search-input'); next?.focus?.(); next?.setSelectionRange?.(cursor, cursor);
    });
    const clear = element('button', 'secondary-action qqj-history-search-clear', '清除'); clear.type = 'button'; clear.hidden = !query;
    clear.addEventListener('click', () => { query = ''; render(); container.querySelector?.('.qqj-history-search-input')?.focus?.(); });
    search.append(input, clear); page.append(search);
    if (feedback) { const note = element('p', 'qqj-qianshi-feedback', feedback); note.setAttribute('role', 'status'); page.append(note); }
    if (snapshot?.status === 'ready') {
      const visible = visibleEvents(), renderedTimeline = timelineContent(visible);
      const toolbar = element('div', 'qqj-qianshi-toolbar');
      toolbar.append(element('span', '', query ? `匹配 ${visible.length} 件事件 · 显示 ${renderedTimeline.groupCount} 组` : '沿着时间，回看故事'));
      const tools = element('div');
      const order = element('button', '', reverse ? '由晚到早' : '由早到晚'); order.type = 'button'; order.dataset.focusKey = 'timeline-order'; order.addEventListener('click', () => { reverse = !reverse; render(); });
      tools.append(order); toolbar.append(tools); page.append(toolbar, renderedTimeline.node);
    }
    container.replaceChildren(page);
    if (focusedControlKey) {
      const nextControl = [...(container.children ?? [])].flatMap(node => {
        const visit = current => [current, ...(current.children ?? []).flatMap(visit)];
        return visit(node);
      }).find(node => node.dataset?.focusKey === focusedControlKey);
      nextControl?.focus?.({ preventScroll: true });
    }
    if (preserveResults) {
      const nextResults = container.querySelector?.('.qqj-qianshi-history-results');
      if (nextResults) {
        nextResults.scrollTop = resultsScrollTop;
        if (resultsHadFocus) nextResults.focus();
      }
    }
    if (focusedDayStateId) {
      const nextSummary = [...(container.children ?? [])].flatMap(node => {
        const visit = current => [current, ...(current.children ?? []).flatMap(visit)];
        return visit(node);
      }).find(node => node.className === 'qqj-qianshi-day-summary' && node.dataset?.dayStateId === focusedDayStateId);
      nextSummary?.focus?.({ preventScroll: true });
    }
    for (const [ancestor, scrollTop] of outerScrollPositions) ancestor.scrollTop = scrollTop;
  }

  function subscribe() {
    unsubscribe?.();
    unsubscribe = runtime.subscribe(next => {
      runtimeState = next; snapshot = runtime.getQianshiSnapshot(); editableEvents.clear();
      // 启动提示只覆盖任务尚未接管进度的间隙；运行或最终状态到达后移除，避免保存成功仍显示“将暂存”。
      const history = snapshot?.history;
      if (history?.status && history.status !== 'idle'
        && (feedback === REJUDGE_START_PENDING_FEEDBACK && history.mode === 'rejudge'
          || feedback === HISTORY_START_PENDING_FEEDBACK && history.mode !== 'rejudge')) feedback = '';
      if (active) render();
    });
  }
  function mount(target) { unsubscribe?.(); unsubscribe = null; operationMenus.deactivate(); container = target; active = true; snapshot = runtime.getQianshiSnapshot(); runtimeState = runtime.getState(); editableEvents.clear(); render(); operationMenus.activate(); subscribe(); return target; }
  async function activate() { active = true; operationMenus.activate(); snapshot = runtime.getQianshiSnapshot(); runtimeState = runtime.getState(); editableEvents.clear(); render(); subscribe(); return { status: snapshot?.status ?? 'unavailable' }; }
  function deactivate() { active = false; epoch += 1; operationMenus.deactivate(); unsubscribe?.(); unsubscribe = null; }
  return Object.freeze({ mount, activate, deactivate, render });
}
