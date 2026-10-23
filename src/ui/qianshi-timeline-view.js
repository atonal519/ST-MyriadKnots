import { publicErrorMessage } from '../public-error.js';
import { createOperationMenuController } from './operation-menu-controller.js';
import { createInlineSelect } from './inline-select.js';
import { formatStoryTimeFields, storyTimeFields } from '../v3/time-engine.js';

const VALID_STATUS = new Set(['planned', 'inProgress', 'completed', 'cancelled', 'occurred', 'unknown']);
const STATUS_COPY = Object.freeze({ planned: '已计划 / 尚未记录完成', inProgress: '进行中 / 尚未记录完成', completed: '已完成', cancelled: '已取消', occurred: '已发生', unknown: '状态未明' });
const STATUS_BADGE_COPY = Object.freeze({ planned: '待办', inProgress: '进行中', completed: '已完成', cancelled: '已取消', occurred: '已发生', unknown: '状态未明' });
const HISTORY_START_PENDING_FEEDBACK = '计划已确认；正在启动补齐…';
const REJUDGE_START_PENDING_FEEDBACK = '范围已确认；正在启动重判…';
const validMessageIndex = value => Number.isSafeInteger(value) && value >= 0;
const text = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('zh-CN');
const searchText = event => text([event.title, event.description, event.object, event.storyTime, event.scheduledTime,
  ...(event.people ?? []).map(person => person.name)].filter(Boolean).join(' '));

function coverageProjection(snapshot) {
  if (snapshot?.status !== 'ready') return { tone: 'error', copy: snapshot?.message || '当前聊天还没有可用的千事快照。' };
  const coverage = snapshot.coverage ?? {};
  const processable = coverage.processable ?? coverage;
  const complete = Number(processable.completeFloors) || 0, eligible = Number(processable.eligibleFloors) || 0;
  const pending = Number(processable.pendingFloors) || 0;
  const actionEligible = eligible;
  const frozenFloors = Number(processable.frozenFloors) || 0;
  const degraded = Number(processable.degradedFloors) || 0, unavailable = Number(processable.unavailableFloors) || 0;
  if (frozenFloors && actionEligible === 0) return { tone: 'checking', copy: '当前没有可处理楼' };
  if (degraded > 0) return { tone: 'checking', copy: '部分关联需核对' };
  const uniqueIncomplete = Math.max(0, eligible - complete) + unavailable;
  if (uniqueIncomplete > 0 && pending === uniqueIncomplete) return { tone: 'checking', copy: `待覆盖 ${pending} 楼` };
  if (uniqueIncomplete > 0) return { tone: 'checking', copy: `有 ${uniqueIncomplete} 楼未确认完成` };
  return { tone: 'healthy', copy: '覆盖完整' };
}

export function createQianshiTimelineView({ runtime, dialog = null, documentRef = globalThis.document } = {}) {
  if (!runtime || ['getState', 'getQianshiSnapshot', 'prepareQianshiHistory', 'startQianshiHistory', 'stopQianshiHistory', 'canEditQianshiEventText', 'editQianshiEventText', 'subscribe']
    .some(name => typeof runtime[name] !== 'function')) throw new TypeError('千事时间线 runtime 无效');
  if (!documentRef?.createElement) throw new TypeError('千事时间线 documentRef 无效');
  let container = null, active = false, unsubscribe = null, epoch = 0;
  let snapshot = runtime.getQianshiSnapshot(), runtimeState = runtime.getState(), chatId = snapshot?.identity?.qqjChatId ?? null;
  let query = '', feedback = '', todoCount = 0, todoDialog = null;
  let todoSourceEvents, todoSourceMatters, todoProjectionEntries = [];
  let runtimeRenderKey = null;
  // 只比较界面消费的投影、任务与忙态；无关通知不重建整页，权限缓存随投影变化失效。
  const renderKey = (nextSnapshot, nextState) => Number.isSafeInteger(nextSnapshot?.projectionRevision)
    ? JSON.stringify([nextSnapshot.projectionRevision, nextSnapshot.status, nextSnapshot.history,
      nextState?.memoryWorkBusy === true || Boolean(nextState?.activeExtraction || nextState?.activeCse), nextState?.qianshiHistoryActive === true])
    : null;
  const textEditors = new Map();
  const statusSaves = new Map();
  const editableEvents = new Map();
  const operationMenus = createOperationMenuController(documentRef);
  const unregisterMenusWithin = node => {
    if (String(node?.className ?? '').split(/\s+/u).includes('qqj-qianshi-event-menu')) operationMenus.unregister(node);
    for (const child of node?.children ?? []) unregisterMenusWithin(child);
  };
  const openIds = new Set(), nestedOpenIds = new Set(), matterOpenIds = new Set();
  const openDayStates = new Map();
  let anomalyContent = null;
  let pageNode = null, healthNode = null, toolbarActionsNode = null, feedbackNode = null;
  const anomalyOpenFloorIds = new Set();
  let undatedOpenState = false;
  const element = (tag, className = '', copy = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (copy !== '') node.textContent = copy;
    return node;
  };
  const findDescendant = (root, predicate) => {
    const stack = Array.from(root?.children ?? []).reverse();
    while (stack.length) {
      const node = stack.pop();
      if (predicate(node)) return node;
      const children = Array.from(node?.children ?? []);
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    }
    return null;
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
    epoch += 1; chatId = nextChatId; query = ''; feedback = ''; textEditors.clear(); statusSaves.clear(); editableEvents.clear(); openIds.clear(); nestedOpenIds.clear(); matterOpenIds.clear(); openDayStates.clear(); undatedOpenState = false; anomalyOpenFloorIds.clear();
    if (anomalyContent) dialog?.cancelTop?.();
  };
  const canEditEvent = eventId => {
    if (!editableEvents.has(eventId)) editableEvents.set(eventId, runtime.canEditQianshiEventText(eventId));
    return editableEvents.get(eventId);
  };
  const visibleEvents = () => {
    const needle = text(query).trim();
    return (snapshot?.events ?? []).filter(event => !needle || searchText(event).includes(needle));
  };
  const todoEntries = () => {
    if (snapshot?.events === todoSourceEvents && snapshot?.matters === todoSourceMatters) return todoProjectionEntries;
    todoSourceEvents = snapshot?.events;
    todoSourceMatters = snapshot?.matters;
    const events = new Map((snapshot?.events ?? []).map(event => [event.id, event]));
    const entries = [];
    for (const matter of snapshot?.matters ?? []) {
      if (matter.synthetic === true) continue;
      const current = matter.currentEventId ? events.get(matter.currentEventId) : null;
      if (current?.matterId === matter.matterId && current.updatesMatter === true) {
        if (['planned', 'inProgress'].includes(matter.status)) entries.push({ eventId: current.id, title: matter.title || current.title, status: matter.status,
          sourceAssistantSeq: current.sourceAssistantSeq ?? matter.sourceAssistantSeq ?? 0 });
        continue;
      }
      // 没有推进事件时，matter.status只是代表记录状态；沿原事件卡按动作状态逐条列待办。
      const recordIds = Array.isArray(matter.eventIds) ? matter.eventIds : matter.recordIds ?? [];
      for (const eventId of recordIds) {
        const event = events.get(eventId);
        const status = event?.actionStatus ?? event?.status;
        if (event?.matterId === matter.matterId && event.updatesMatter === false && event.statusManuallyEdited === true && ['planned', 'inProgress'].includes(status)) {
          entries.push({ eventId: event.id, title: event.title, status, sourceAssistantSeq: event.sourceAssistantSeq ?? 0 });
        }
      }
    }
    for (const event of snapshot?.events ?? []) {
      if (event.matterId || event.statusManuallyEdited !== true || !['planned', 'inProgress'].includes(event.actionStatus ?? event.status)) continue;
      entries.push({ eventId: event.id, title: event.title, status: event.actionStatus ?? event.status, sourceAssistantSeq: event.sourceAssistantSeq ?? 0 });
    }
    todoProjectionEntries = entries;
    return todoProjectionEntries;
  };
  const dayStateId = (segment, group) => JSON.stringify([segment.id, group.key ?? [group.period ?? '', group.day ?? '']]);
  function timelineDisplayProjection(visibleIds) {
    const compareSourceRank = (left, right) => left[0] - right[0] || left[1] - right[1];
    const sourceRank = new Map((snapshot.events ?? []).map((event, index) => [event.id, [
      Number.isSafeInteger(event.sourceAssistantSeq) ? event.sourceAssistantSeq
        : Number.isSafeInteger(event.assistantSeq) ? event.assistantSeq : index, index,
    ]]));
    const segments = (snapshot.timeline?.segments ?? []).map(segment => {
      const rankedGroups = (segment.groups ?? []).filter(group => group.eventIds.some(id => visibleIds.has(id))).map(group => ({
        group, latestSource: group.eventIds.reduce((latest, id) => {
          const rank = sourceRank.get(id);
          return visibleIds.has(id) && rank && compareSourceRank(rank, latest) > 0 ? rank : latest;
        }, [-1, -1]),
      }));
      if (segment.preserveSourceOrder) rankedGroups.sort((left, right) => compareSourceRank(right.latestSource, left.latestSource));
      else rankedGroups.reverse();
      const latestSource = rankedGroups.reduce((latest, entry) => compareSourceRank(entry.latestSource, latest) > 0 ? entry.latestSource : latest, [-1, -1]);
      return { ...segment, groups: rankedGroups.map(entry => entry.group), latestSource };
    }).filter(segment => segment.groups.length).sort((left, right) => compareSourceRank(right.latestSource, left.latestSource));
    const eventIds = [];
    for (const segment of segments) for (const group of segment.groups) {
      for (const id of [...group.eventIds].reverse()) if (visibleIds.has(id)) eventIds.push(id);
    }
    const undated = (snapshot.timeline?.undatedEventIds ?? []).filter(id => visibleIds.has(id))
      .sort((left, right) => compareSourceRank(sourceRank.get(right) ?? [-1, -1], sourceRank.get(left) ?? [-1, -1]));
    eventIds.push(...undated);
    return { segments, sourceRank, eventIds };
  }
  const historyBusy = () => snapshot?.history?.status === 'running' || runtimeState?.qianshiHistoryActive === true;
  const otherWorkBusy = () => runtimeState?.memoryWorkBusy === true || Boolean(runtimeState?.activeExtraction || runtimeState?.activeCse)
    || [...statusSaves.values()].some(value => value.pending);
  const statusSaveNote = eventId => {
    const saving = statusSaves.get(eventId);
    if (!saving) return null;
    const note = element('p', `qqj-qianshi-save-note${saving.error ? ' error' : ''}`, saving.pending ? '正在保存…' : `保存失败：${saving.error}`);
    note.setAttribute('role', saving.error ? 'alert' : 'status');
    return note;
  };
  const sourceCopy = event => event.frozen === true && validMessageIndex(event.sourceOrigin?.sourceMessageIndex)
    ? `来源聊天第 ${event.sourceOrigin.sourceMessageIndex} 楼`
    : validMessageIndex(event.sourceMessageIndex) ? `第 ${event.sourceMessageIndex} 楼` : `AI 记录 ${event.sourceAssistantSeq ?? '未明'}`;
  const statusBadge = (event, { currentMatter = false } = {}) => {
    const matter = currentMatter && event.updatesMatter && event.matterId
      ? snapshot?.matters?.find(item => item.matterId === event.matterId && !item.synthetic) : null;
    // 外层卡片与“修改状态”使用同一整件事状态；历史过程仍显示当时动作，不改写旧记录。
    const wholeLine = matter && VALID_STATUS.has(matter.status);
    const value = wholeLine ? matter.status : event.actionStatus ?? event.status;
    const status = VALID_STATUS.has(value) ? value : 'unknown';
    const badge = element('small', `qqj-qianshi-state status-${status}`, STATUS_BADGE_COPY[status]);
    badge.title = `${wholeLine ? '整件事状态' : '本条动作状态'}：${STATUS_BADGE_COPY[status]}`;
    badge.setAttribute('aria-label', badge.title);
    return badge;
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
        const ensureRow = () => { if (!rowBuilt) { row.append(eventDetails(item, 'qqj-qianshi-day-event-detail')); rowBuilt = true; } };
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

  function eventDetails(event, className = 'qqj-qianshi-expanded') {
    const body = element('div', className);
    if (event.frozen === true) body.append(element('p', 'qqj-qianshi-readonly-note', '来源于搬家前存档，只读'));
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
    const section = element('form', 'qqj-editor-dialog qqj-qianshi-text-editor qqj-qianshi-text-form');
    const label = (copy, control) => { const row = element('label', 'qqj-qianshi-text-label'); row.append(element('span', '', copy), control); return row; };
    const textGroup = element('details', 'qqj-editor-group'); textGroup.open = true; textGroup.append(element('summary', 'qqj-editor-group-summary', '事件内容'));
    const title = element('input', 'settings-input qqj-qianshi-title-input'); title.value = state.title; title.maxLength = 500;
    const description = element('textarea', 'settings-input qqj-qianshi-description-input'); description.value = state.description; description.maxLength = 4000; description.rows = 5;
    const object = element('input', 'settings-input qqj-qianshi-object-input'); object.value = state.object; object.maxLength = 1000;
    title.addEventListener('input', () => { state.title = title.value; }); description.addEventListener('input', () => { state.description = description.value; }); object.addEventListener('input', () => { state.object = object.value; });
    textGroup.append(label('标题', title), label('经过说明', description), label('涉及物品', object), element('small', 'qqj-qianshi-object-hint', '只填对后续有用的具体物品；多个用顿号分隔；没有可留空。')); section.append(textGroup);
    const timeGroup = element('details', 'qqj-editor-group'); timeGroup.append(element('summary', 'qqj-editor-group-summary', '时间'));
    const timeFields = (field, initial, raw, titleText) => {
      const group = element('fieldset', 'qqj-qianshi-time-editor'); group.append(element('legend', '', titleText));
      const fields = element('div', 'qqj-qianshi-time-fields'), preview = element('p', 'qqj-qianshi-time-preview'), controls = [];
      const clearFlag = field === 'timeDraft' ? 'clearTime' : 'clearScheduledTime';
      const dirty = () => state[clearFlag] === true || Object.keys(state[initial]).some(key => state[field][key] !== state[initial][key]);
      const valueKey = field === 'timeDraft' ? 'storyTime' : 'scheduledTime';
      const update = () => { try { preview.textContent = dirty() ? `保存后：${formatStoryTimeFields(state[field]) || '时间未知'}` : `${titleText}：${raw || '时间未知'}`; } catch (error) { preview.textContent = error.message; } };
      for (const [key, labelText, placeholder] of [['prefix', '前缀', '可留空'], ['year', '年', '2027'], ['month', '月', '3 / 夏月'], ['day', '日', '5'], ['clock', '时间', '07:45']]) {
        const input = element('input', 'settings-input qqj-qianshi-time-input'); input.value = state[field][key]; input.placeholder = placeholder; input.setAttribute('aria-label', `${titleText}${labelText}`);
        input.addEventListener('input', () => { state[field][key] = input.value; update(); }); fields.append(label(labelText, input)); controls.push(input);
      }
      const clear = element('button', 'secondary-action qqj-qianshi-time-clear', '清空'); clear.type = 'button';
      clear.addEventListener('click', () => { for (const key of Object.keys(state[field])) state[field][key] = ''; state[valueKey === 'storyTime' ? 'clearTime' : 'clearScheduledTime'] = true; for (const input of controls) input.value = ''; update(); });
      group.children[0].append(clear); group.append(fields, preview); update(); return { node: group, dirty };
    };
    const storyTimeEditor = timeFields('timeDraft', 'initialTimeDraft', event.storyTime, '发生时间'); timeGroup.append(storyTimeEditor.node);
    let scheduled = null;
    if (event.scheduledTime) { scheduled = timeFields('scheduledTimeDraft', 'initialScheduledTimeDraft', event.scheduledTime, '约定 / 预计时间'); timeGroup.append(scheduled.node); }
    else {
      const addTime = element('button', 'secondary-action', '添加约定时间'); addTime.type = 'button';
      addTime.addEventListener('click', () => { if (scheduled) return; scheduled = timeFields('scheduledTimeDraft', 'initialScheduledTimeDraft', event.scheduledTime, '约定 / 预计时间'); timeGroup.append(scheduled.node); addTime.hidden = true; });
      timeGroup.append(addTime);
    }
    section.append(timeGroup);
    const peopleGroup = element('details', 'qqj-editor-group'); peopleGroup.append(element('summary', 'qqj-editor-group-summary', '人物（可多选）'));
    const peopleSearch = element('input', 'settings-input qqj-qianshi-people-search');
    peopleSearch.type = 'search'; peopleSearch.setAttribute('aria-label', '搜索姓名或别名'); peopleSearch.placeholder = '搜索姓名或别名';
    peopleSearch.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); event.stopPropagation();
    });
    const peopleChoices = element('div', 'qqj-qianshi-people-choices');
    const peopleRows = [];
    for (const person of state.peopleCandidates) {
      const row = element('label', 'qqj-qianshi-person-choice'), input = element('input'); input.type = 'checkbox'; input.checked = state.selectedPersonIds.has(person.entityId);
      input.addEventListener('change', event => { if (event.target.checked) state.selectedPersonIds.add(person.entityId); else state.selectedPersonIds.delete(person.entityId); });
      row.append(input, element('span', '', person.name)); if (person.aliases?.length) row.append(element('small', '', person.aliases.join('、'))); peopleChoices.append(row);
      peopleRows.push({ row, searchable: text([person.name, ...(person.aliases ?? [])].join(' ')) });
    }
    const noPeopleMatch = element('p', 'qqj-qianshi-people-empty', '没有匹配的人物。'); noPeopleMatch.hidden = true;
    peopleSearch.addEventListener('input', () => {
      const needle = text(peopleSearch.value).trim(); let matches = 0;
      for (const { row, searchable } of peopleRows) {
        row.hidden = Boolean(needle) && !searchable.includes(needle);
        if (!row.hidden) matches += 1;
      }
      noPeopleMatch.hidden = matches > 0;
    });
    noPeopleMatch.textContent = peopleRows.length ? '没有匹配的人物。' : '暂无可选人物。';
    noPeopleMatch.hidden = peopleRows.length > 0;
    peopleChoices.append(noPeopleMatch);
    peopleGroup.append(peopleSearch, peopleChoices);
    const retained = element('div', 'qqj-qianshi-retained-people');
    const drawRetained = () => { retained.replaceChildren(); state.retainedPeople.forEach((person, index) => { const row = element('div', 'qqj-qianshi-retained-person'); row.append(element('span', '', `${person.name}（原记录）`)); const remove = element('button', 'secondary-action', '移除'); remove.type = 'button'; remove.addEventListener('click', () => { state.retainedPeople.splice(index, 1); drawRetained(); }); row.append(remove); retained.append(row); }); };
    drawRetained(); peopleGroup.append(retained); section.append(peopleGroup);
    const statusGroup = element('details', 'qqj-editor-group'); statusGroup.append(element('summary', 'qqj-editor-group-summary', '状态'));
    const statusPickerRow = (labelText, key) => { const row = element('label', 'qqj-qianshi-text-label'); row.append(element('span', '', labelText), statusPicker(state[key], labelText, false, value => { state[key] = value; })); return row; };
    statusGroup.append(statusPickerRow('本条动作状态', 'actionStatus')); if (event.matterId && event.updatesMatter) statusGroup.append(statusPickerRow('这次进展后的整线状态', 'status')); section.append(statusGroup);
    const peopleDirty = () => state.selectedPersonIds.size !== state.initialPersonIds.size || [...state.initialPersonIds].some(id => !state.selectedPersonIds.has(id)) || JSON.stringify(state.retainedPeople) !== JSON.stringify(state.initialRetainedPeople);
    section.submit = async () => {
      let storyTimeValue, scheduledTimeValue;
      if (storyTimeEditor.dirty()) storyTimeValue = formatStoryTimeFields(state.timeDraft);
      if (scheduled?.dirty()) scheduledTimeValue = formatStoryTimeFields(state.scheduledTimeDraft);
      const clean = value => String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      const next = { title: clean(state.title).slice(0, 500), description: clean(state.description).slice(0, 4000), object: clean(state.object).slice(0, 1000) || null,
        status: state.status, actionStatus: state.actionStatus, ...(storyTimeValue !== undefined ? { storyTime: storyTimeValue } : {}), ...(scheduledTimeValue !== undefined ? { scheduledTime: scheduledTimeValue } : {}),
        ...(peopleDirty() ? { people: [...state.retainedPeople.map(person => ({ ...person })), ...state.peopleCandidates.filter(person => state.selectedPersonIds.has(person.entityId)).map(person => ({ entityId: person.entityId, name: person.name }))] } : {}) };
      if (!next.title || !next.description) throw new Error('标题和经过说明都不能为空。');
      if (next.title === clean(state.baseline.title).slice(0, 500) && next.description === clean(state.baseline.description).slice(0, 4000) && next.object === (clean(state.baseline.object).slice(0, 1000) || null) && next.status === state.baseline.status && next.actionStatus === state.baseline.actionStatus && !storyTimeEditor.dirty() && !(scheduled?.dirty()) && !peopleDirty()) {
        textEditors.delete(event.id); feedback = '内容没有变化，没有写入新版本。'; render(); return true;
      }
      state.pending = true; state.error = '';
      try {
        const result = await runtime.editQianshiEventText({ eventId: event.id, expected: state.baseline, ...next });
        textEditors.delete(event.id); feedback = result?.status === 'unchanged' ? '内容没有变化，没有写入新版本。' : '事件修改已保存。'; render(); return true;
      } catch (error) { state.pending = false; state.error = publicErrorMessage(error?.message, { fallback: '保存失败，请检查当前记录后重试。' }); throw new Error(state.error); }
    };
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
    // 弹窗只确认选择，关窗后沿原事务保存；期间可浏览，未获落盘确认不提前改状态。
    try {
      const choice = await dialog.custom({ title: '修改状态', content, confirmText: '保存', cancelText: '取消', submit: async () => {
        if (!active || epoch !== operationEpoch || chatId !== operationChatId
          || runtime.getQianshiSnapshot()?.identity?.qqjChatId !== operationChatId) throw new Error('聊天已变化，请重新打开状态修改。');
        runtimeState = runtime.getState();
        if (otherWorkBusy() || historyBusy()) throw new Error('请等待当前任务结束后再保存。');
        if (!selected) throw new Error('请选择状态。');
        return selected;
      } });
      if (!active || epoch !== operationEpoch || chatId !== operationChatId || !choice) return;
      const saving = { pending: true, error: '' };
      statusSaves.set(event.id, saving); render();
      // 页面离开不取消已确认的原事务；结果只回到同聊天的这条记录，切聊天不显示迟到提示。
      void (async () => {
        try {
          if (wholeLine) await runtime.setQianshiMatterStatus({ matterId: matter.matterId,
            status: choice === 'automatic' ? null : choice, expectedStatus: matter.status,
            expectedManualStatus: matter.manualStatusOverride ?? null });
          else await runtime.editQianshiEventText({ eventId: event.id, expected: { memoryId: event.sourceFloorMemoryId,
            title: event.title, description: event.description, object: event.object ?? null,
            status: event.status, actionStatus: event.actionStatus ?? event.status }, title: event.title,
            description: event.description, object: event.object ?? null, actionStatus: choice, confirmActionStatus: true,
            ...(!event.matterId ? { status: choice } : {}) });
          if (statusSaves.get(event.id) === saving) statusSaves.delete(event.id);
        } catch (error) {
          saving.pending = false;
          saving.error = publicErrorMessage(error, { fallback: '请稍后重试。' });
        } finally {
          if (runtime.getQianshiSnapshot()?.identity?.qqjChatId === operationChatId && chatId === operationChatId) {
            snapshot = runtime.getQianshiSnapshot(); runtimeState = runtime.getState();
            if (active) render();
          } else if (statusSaves.get(event.id) === saving) statusSaves.delete(event.id);
        }
      })();
    } catch (error) {
      if (active && epoch === operationEpoch && chatId === operationChatId) {
        feedback = `状态修改失败：${publicErrorMessage(error, { fallback: '请稍后重试。' })}`; render();
      }
    }
  }

  async function deleteEvent(event) {
    const operationEpoch = epoch, operationChatId = chatId;
    try {
      const confirmed = await dialog.confirm({ title: '删除这条千事', body: `删除“${event.title}”？`,
        note: '只移除这条事件，其他进展仍保留；删空后整条事项线消失。正文、摘要和双丝网保留，不调用模型。', confirmText: '删除', cancelText: '取消' });
      if (!active || epoch !== operationEpoch || chatId !== operationChatId
        || runtime.getQianshiSnapshot()?.identity?.qqjChatId !== operationChatId || !confirmed) return;
      runtimeState = runtime.getState();
      if (otherWorkBusy() || historyBusy()) throw new Error('请等待当前任务结束后再删除。');
      // 确认针对所见版本，弹窗期间发生编辑/重判时由原事务拒绝，不能删除变化后的另一版。
      const result = await runtime.deleteQianshiEvent({ eventId: event.id, expected: {
        memoryId: event.sourceFloorMemoryId, title: event.title, description: event.description, object: event.object ?? null,
        status: event.status, actionStatus: event.actionStatus ?? event.status, storyTime: event.storyTime } });
      if (!active || epoch !== operationEpoch || chatId !== operationChatId) return;
      textEditors.delete(event.id);
      feedback = result?.status === 'unchanged' ? '这条事件已移除。' : '事件已删除。';
      snapshot = runtime.getQianshiSnapshot(); render();
    } catch (error) {
      if (active && epoch === operationEpoch && chatId === operationChatId) {
        feedback = `删除未完成：${publicErrorMessage(error, { fallback: '请刷新后核对当前记录。' })}`; render();
      }
    }
  }

  function runEventDialog(menu, action) {
    const reopen = anomalyContent?.contains?.(menu), operationEpoch = epoch, operationChatId = chatId;
    void action().finally(() => {
      // 状态/删除确认沿用单弹窗管理器；结束后回到异常列表，不叠第二套编辑事务。
      if (reopen && active && epoch === operationEpoch && chatId === operationChatId) void openAnomalies();
    });
  }

  function eventOperationMenu(event, { cardId = event.id, nestedRowKey = null, currentMatter = () => false } = {}) {
    if (!canEditEvent(event.id) || textEditors.get(event.id)?.editing) return null;
    const menu = operationMenus.register(element('details', 'qqj-profile-menu qqj-qianshi-event-menu'));
    menu.dataset.qianshiEventId = event.id;
    const toggle = element('summary', 'qqj-profile-menu-toggle', '⋮');
    toggle.setAttribute?.('aria-label', `${event.title}操作`); toggle.setAttribute?.('title', `${event.title}操作`);
    const menuBody = element('div', 'qqj-profile-menu-pop');
    const matter = event.matterId ? snapshot?.matters?.find(item => item.matterId === event.matterId) : null;
    const edit = element('button', 'qqj-profile-menu-action', '编辑详情'); edit.type = 'button'; edit.disabled = typeof dialog?.custom !== 'function';
    edit.addEventListener('click', () => {
      menu.open = false;
      if ((snapshot?.timeline?.undatedEventIds ?? []).includes(event.id)) undatedOpenState = true;
      const timeDraft = storyTimeFields(event.storyTime);
      const scheduledTimeDraft = storyTimeFields(event.scheduledTime);
      // 目录包含当前已识别的全部人物；无法归入目录的旧参与者只按原记录保留，不按姓名猜身份。
      const peopleCandidates = typeof runtime.getQianshiEditPeople === 'function' ? runtime.getQianshiEditPeople() : [];
      const candidateIds = new Set(peopleCandidates.map(person => person.entityId));
      const selectedPersonIds = new Set((event.people ?? []).map(person => person.entityId).filter(id => candidateIds.has(id)));
      const retainedPeople = (event.people ?? []).filter(person => !person.entityId || !candidateIds.has(person.entityId)).map(person => ({ entityId: person.entityId ?? null, name: person.name }));
      const draft = { editing: true, title: event.title, description: event.description, timeDraft, initialTimeDraft: { ...timeDraft },
        scheduledTimeDraft, initialScheduledTimeDraft: { ...scheduledTimeDraft }, selectedPersonIds, initialPersonIds: new Set(selectedPersonIds),
        retainedPeople, initialRetainedPeople: structuredClone(retainedPeople), peopleCandidates,
        object: event.object ?? '', status: event.status, actionStatus: event.actionStatus ?? event.status,
        baseline: { memoryId: event.sourceFloorMemoryId, title: event.title, description: event.description, object: event.object ?? null,
          status: event.status, actionStatus: event.actionStatus ?? event.status, storyTime: event.storyTime,
          scheduledTime: event.scheduledTime, people: structuredClone(event.people ?? []) }, error: '', pending: false };
      textEditors.set(event.id, draft);
      const content = eventTextEditor(event);
      const reopenAnomalies = Boolean(anomalyContent?.contains?.(menu));
      void Promise.resolve(dialog.custom({ title: `编辑千事 · ${event.title}`, content, confirmText: '保存', cancelText: '取消', submit: () => content.submit(), onClose: () => { if (textEditors.get(event.id) === draft) { textEditors.delete(event.id); render(); } } }))
        .then(() => { if (reopenAnomalies && active) void openAnomalies(); });
    });
    // 删除只接正式事件的原人工事务，确认取消不写档；旧审核只读沿用编辑权限。
    const remove = element('button', 'qqj-profile-menu-action danger', '删除'); remove.type = 'button';
    remove.disabled = otherWorkBusy() || historyBusy() || typeof dialog?.confirm !== 'function' || typeof runtime.deleteQianshiEvent !== 'function';
    if (otherWorkBusy() || historyBusy()) remove.title = '后台记忆任务进行中，请结束后再删除。';
    remove.addEventListener('click', () => { menu.open = false; runEventDialog(menu, () => deleteEvent(event)); });
    const change = element('button', 'qqj-profile-menu-action', '修改状态'); change.type = 'button';
    // 每条正式事件卡沿用原事件菜单合同；事项更新与单条动作仍由原保存接口区分。
    const statusMatter = () => currentMatter() && event.updatesMatter && matter && !matter.synthetic ? matter : null;
    const updateStatusAvailability = () => {
      change.disabled = otherWorkBusy() || historyBusy() || typeof dialog?.custom !== 'function'
        || Boolean(statusMatter() && typeof runtime.setQianshiMatterStatus !== 'function');
    };
    menu.refreshQianshiAvailability = () => {
      const busy = otherWorkBusy() || historyBusy();
      remove.disabled = busy || typeof dialog?.confirm !== 'function' || typeof runtime.deleteQianshiEvent !== 'function';
      remove.title = busy ? '后台记忆任务进行中，请结束后再删除。' : '';
      updateStatusAvailability();
    };
    updateStatusAvailability();
    menu.addEventListener('toggle', updateStatusAvailability);
    change.addEventListener('click', () => { menu.open = false; runEventDialog(menu, () => changeEventStatus(event, statusMatter())); });
    menuBody.append(edit, remove, change); menu.append(toggle, menuBody);
    return menu;
  }

  function expandedContent(event, matterEvents) {
    const body = element('div', 'qqj-qianshi-expanded');
    body.append(eventDetails(event, 'qqj-qianshi-event-detail'));
    const history = matterHistory(event, matterEvents); if (history) body.append(history);
    return body;
  }

  function eventNode(event, matterEvents) {
    const itemRow = element('div', 'qqj-qianshi-event-row');
    const details = element('details', 'qqj-qianshi-event'); details.dataset.eventId = event.id; details.dataset.cardId = event.id;
    details.open = openIds.has(event.id);
    const summary = element('summary', 'qqj-qianshi-event-summary');
    if (event.storyTime) summary.append(element('span', 'qqj-qianshi-event-time', event.storyTime));
    const title = element('span', 'qqj-qianshi-event-title', event.title);
    title.append(statusBadge(event, { currentMatter: true }));
    summary.append(title);
    summary.append(element('p', 'qqj-qianshi-preview', event.description));
    details.append(summary);
    const menu = eventOperationMenu(event, { cardId: event.id, currentMatter: () => true });
    const ensureBody = () => {
      if (!details.children || [...details.children].some(node => String(node.className).includes('qqj-qianshi-expanded'))) return;
      details.append(expandedContent(event, matterEvents));
    };
    details.addEventListener('toggle', () => {
      if (details.open) { openIds.add(event.id); ensureBody(); }
      else openIds.delete(event.id);
    });
    itemRow.append(details); if (menu) itemRow.append(menu);
    if (details.open) ensureBody();
    const note = statusSaveNote(event.id); if (note) itemRow.append(note);
    return itemRow;
  }

  function timelineContent(events) {
    const eventById = new Map((snapshot.events ?? []).map(event => [event.id, event]));
    const matterEvents = new Map();
    for (const matter of snapshot.matters ?? []) {
      const records = (matter.recordIds ?? matter.eventIds ?? []).map(id => eventById.get(id)).filter(Boolean).reverse();
      matterEvents.set(matter.matterId, records);
    }
    const visibleIds = new Set(events.map(event => event.id)), timeline = snapshot.timeline ?? { segments: [], undatedEventIds: [] };
    const display = timelineDisplayProjection(visibleIds);
    const wrapper = element('div', 'qqj-qianshi-timeline');
    let displayedEventCount = 0;
    const visibleSegments = display.segments;
    const orderedVisibleGroups = visibleSegments.flatMap(segment => segment.groups);
    const defaultGroupId = timeline.hasGlobalLatest && orderedVisibleGroups.some(group => group.id === timeline.globalLatestGroupId)
      ? timeline.globalLatestGroupId : orderedVisibleGroups[0]?.id;
    for (const [segmentIndex, segment] of visibleSegments.entries()) {
      const { groups } = segment;
      const block = element('section', 'qqj-qianshi-segment');
      if ((timeline.segments ?? []).length > 1) block.append(element('p', 'qqj-qianshi-segment-label', `${segment.label || (segmentIndex ? '另一组时间' : '时间')} · 不依据其他组推断先后`));
      for (const [groupIndex, group] of groups.entries()) {
        const latest = timeline.hasGlobalLatest === true && group.id === timeline.globalLatestGroupId;
        const stateId = dayStateId(segment, group);
        const axisPosition = groups.length === 1 ? 'single' : groupIndex === 0 ? 'first' : groupIndex === groups.length - 1 ? 'last' : 'middle';
        const day = element('div', `qqj-qianshi-day qqj-qianshi-day-${axisPosition}${latest ? ' latest' : ''}`); day.id = group.id; day.dataset.dayStateId = stateId;
        const searchExpanded = Boolean(query.trim());
        const defaultExpanded = group.id === defaultGroupId;
        const dayOpen = searchExpanded || (openDayStates.has(stateId) ? openDayStates.get(stateId) : defaultExpanded);
        const visibleEventCount = group.eventIds.filter(id => visibleIds.has(id)).length;
        const date = element('div', 'qqj-qianshi-date'); date.title = group.full;
        date.append(element('span', 'qqj-qianshi-day-name', group.day), element('span', 'qqj-qianshi-period', group.period), element('span', 'qqj-qianshi-day-count', `${visibleEventCount} 件`));
        if (latest) date.append(element('span', 'qqj-qianshi-latest-tag', '最近'));
        const disclosure = element('details', 'qqj-qianshi-day-disclosure'); disclosure.open = dayOpen;
        const summary = element('summary', 'qqj-qianshi-day-summary'); summary.dataset.dayStateId = stateId; summary.setAttribute('aria-label', `${group.full || `${group.period ?? ''}${group.day ?? ''}`}，${visibleEventCount} 件，${dayOpen ? '收起' : '展开'}`);
        summary.append(date);
        summary.addEventListener('click', event => {
          if (event.isTrusted === true && !query.trim()) openDayStates.set(stateId, !disclosure.open);
        });
        const updateDayLabel = () => {
          summary?.setAttribute('aria-label', `${group.full || `${group.period ?? ''}${group.day ?? ''}`}，${visibleEventCount} 件，${disclosure.open ? '收起' : '展开'}`);
        };
        const dayEvents = group.eventIds.filter(id => visibleIds.has(id)).map(id => eventById.get(id)).filter(Boolean).reverse();
        if (dayOpen && dayEvents.length > 1) day.className += ' qqj-qianshi-day-has-card-axis';
        const lastEvent = [...group.eventIds].reverse().map(id => eventById.get(id)).find(event => event && visibleIds.has(event.id));
        const preview = element('button', 'qqj-qianshi-day-preview'); preview.type = 'button'; preview.hidden = dayOpen;
        preview.setAttribute('aria-label', `展开 ${group.full || `${group.period ?? ''}${group.day ?? ''}`} 的 ${visibleEventCount} 件千事`);
        // 折叠预览也是展开入口；沿用原日期状态和事件菜单，避免旧日看似可点却毫无响应。
        preview.addEventListener('click', () => {
          if (!query.trim()) openDayStates.set(stateId, true);
          disclosure.open = true;
          summary.focus?.({ preventScroll: true });
        });
        if (lastEvent) {
          if (lastEvent.storyTime) preview.append(element('span', 'qqj-qianshi-event-time', lastEvent.storyTime));
          const previewTitle = element('span', 'qqj-qianshi-day-preview-title', lastEvent.title);
          previewTitle.append(statusBadge(lastEvent, { currentMatter: true }));
          preview.append(previewTitle, element('span', 'qqj-qianshi-preview', lastEvent.description));
        }
        const eventList = element('div', 'qqj-qianshi-events');
        eventList.hidden = !dayOpen;
        displayedEventCount += dayEvents.length;
        let dayCardsBuilt = false;
        const buildDayCards = () => {
          if (dayCardsBuilt) return;
          for (const event of dayEvents) eventList.append(eventNode(event, matterEvents));
          dayCardsBuilt = true;
        };
        const clearDayCards = () => {
          if (!dayCardsBuilt) return;
          if (eventList.contains?.(documentRef.activeElement)) summary.focus?.({ preventScroll: true });
          unregisterMenusWithin(eventList);
          eventList.replaceChildren();
          dayCardsBuilt = false;
        };
        if (dayOpen) buildDayCards();
        disclosure.addEventListener('toggle', () => {
          preview.hidden = disclosure.open;
          eventList.hidden = !disclosure.open;
          day.className = day.className.replace(/\s+qqj-qianshi-day-has-card-axis/u, '')
            + (disclosure.open && dayEvents.length > 1 ? ' qqj-qianshi-day-has-card-axis' : '');
          if (disclosure.open) buildDayCards(); else clearDayCards();
          updateDayLabel();
        });
        disclosure.append(summary);
        const dot = element('i', 'qqj-qianshi-dot'); dot.setAttribute('aria-hidden', 'true');
        day.append(disclosure, dot, preview, eventList); block.append(day);
      }
      wrapper.append(block);
    }
    const undatedIds = new Set(timeline.undatedEventIds ?? []);
    const undated = display.eventIds.filter(id => undatedIds.has(id)).map(id => eventById.get(id)).filter(Boolean);
    if (undated.length) {
      const details = element('details', 'qqj-qianshi-undated'); details.open = Boolean(query.trim()) || undatedOpenState;
      const summary = element('summary', '', `无法确定单一发生时间 · ${undated.length} 件`), list = element('div', 'qqj-qianshi-undated-list');
      let cardsBuilt = false;
      summary.addEventListener('click', event => {
        if (event.isTrusted === true && !query.trim()) undatedOpenState = !details.open;
      });
      const buildCards = () => {
        if (cardsBuilt) return;
        for (const event of undated) list.append(eventNode(event, matterEvents));
        cardsBuilt = true;
      };
      const clearCards = () => {
        if (!cardsBuilt) return;
        if (list.contains?.(documentRef.activeElement)) summary.focus?.({ preventScroll: true });
        unregisterMenusWithin(list);
        list.replaceChildren(); cardsBuilt = false;
      };
      if (details.open) buildCards();
      details.addEventListener('toggle', () => {
        if (details.open) buildCards(); else clearCards();
      });
      displayedEventCount += undated.length;
      details.append(summary, element('p', 'qqj-qianshi-undated-hint', '这里没有可确定的日期，按来源从近到远列出；相对时间和时间范围保留原文。'), list); wrapper.append(details);
    }
    if (!wrapper.children?.length) wrapper.append(element('div', 'qqj-qianshi-empty', query ? '没有找到对应事件。' : '当前没有可显示的千事记录。'));
    return { node: wrapper, visibleEventCount: displayedEventCount };
  }

  function navigateToTodo(entry) {
    dialog?.cancelTop?.();
    query = ''; feedback = ''; openIds.add(entry.eventId);
    for (const segment of snapshot?.timeline?.segments ?? []) {
      const group = (segment.groups ?? []).find(item => item.eventIds?.includes(entry.eventId));
      if (group) { openDayStates.set(dayStateId(segment, group), true); break; }
    }
    if ((snapshot?.timeline?.undatedEventIds ?? []).includes(entry.eventId)) undatedOpenState = true;
    render();
    const card = findDescendant(container, node => node.className === 'qqj-qianshi-event' && node.dataset?.eventId === entry.eventId);
    const summary = Array.from(card?.children ?? []).find(child => child.className === 'qqj-qianshi-event-summary');
    summary?.focus?.({ preventScroll: true });
    summary?.scrollIntoView?.({ block: 'center' });
  }

  function openTodos() {
    if (typeof dialog?.custom !== 'function') return;
    let allEntries = [...todoProjectionEntries].sort((left, right) => right.sourceAssistantSeq - left.sourceAssistantSeq), searchTextValue = '', page = 0;
    todoCount = allEntries.length;
    const content = element('section', 'qqj-editor-dialog qqj-qianshi-todo');
    const search = element('input', 'settings-input qqj-qianshi-todo-search');
    search.type = 'search'; search.placeholder = '搜索待办事项'; search.setAttribute('aria-label', '搜索待办事项');
    const list = element('div', 'qqj-qianshi-todo-scroll');
    const pager = element('div', 'qqj-qianshi-todo-pager');
    const refresh = nextEntries => {
      if (Array.isArray(nextEntries)) allEntries = [...nextEntries].sort((left, right) => right.sourceAssistantSeq - left.sourceAssistantSeq);
      const needle = text(searchTextValue).trim();
      const matches = allEntries.filter(entry => text(`${entry.title} ${STATUS_BADGE_COPY[entry.status]}`).includes(needle));
      todoCount = allEntries.length;
      page = Math.min(page, Math.max(0, Math.ceil(matches.length / 50) - 1));
      const start = page * 50;
      list.replaceChildren();
      list.scrollTop = 0;
      for (const entry of matches.slice(start, start + 50)) {
        const row = element('button', 'qqj-qianshi-todo-row'); row.type = 'button';
        row.append(element('span', 'qqj-qianshi-todo-title', entry.title), element('span', 'qqj-qianshi-todo-status', STATUS_BADGE_COPY[entry.status]));
        row.setAttribute('aria-label', `${entry.title}，${STATUS_BADGE_COPY[entry.status]}`);
        row.addEventListener('click', () => navigateToTodo(entry));
        list.append(row);
      }
      if (!matches.length) list.append(element('p', 'qqj-qianshi-todo-empty', '没有待办事项。'));
      pager.replaceChildren();
      if (matches.length > 50) {
        const previous = element('button', 'secondary-action', '上一页'); previous.type = 'button'; previous.disabled = page === 0;
        previous.addEventListener('click', () => { page -= 1; refresh(); });
        const next = element('button', 'secondary-action', '下一页'); next.type = 'button'; next.disabled = start + 50 >= matches.length;
        next.addEventListener('click', () => { page += 1; refresh(); });
        pager.append(previous, next);
      }
    };
    search.addEventListener('input', event => { searchTextValue = event.target.value; page = 0; refresh(); });
    content.append(search, list, pager); refresh();
    const refreshFromSnapshot = entries => refresh(entries);
    todoDialog = { refresh: refreshFromSnapshot };
    void dialog.custom({ title: '待办事项', content, confirmText: '关闭', cancelText: '', submit: () => true,
      onClose: () => { if (todoDialog?.refresh === refreshFromSnapshot) todoDialog = null; } });
  }

  async function prepareHistory() {
    if (historyBusy() || otherWorkBusy()) return;
    const operationEpoch = ++epoch, targetIdentity = runtime.captureBusinessIdentity?.() ?? null;
    feedback = '正在准备补齐计划…'; render();
    try {
      const coverage = snapshot?.coverage ?? {}, processable = coverage.processable ?? coverage;
      const hasUnprocessed = (Number(processable.pendingFloors) || 0) + (Number(processable.partialFloors) || 0) > 0;
      const hasEmpty = (Number(processable.emptyFloors) || 0) > 0;
      let includeEmptyFloors = false;
      if (hasUnprocessed && hasEmpty && typeof dialog?.choose === 'function') {
        const unprocessedCount = (Number(processable.pendingFloors) || 0) + (Number(processable.partialFloors) || 0);
        // 混合范围默认只处理未完成楼，重查已判空楼由用户主动选择。
        const choice = await dialog.choose({ title: '选择补齐范围',
          body: `当前有 ${unprocessedCount} 楼未完成，另有 ${Number(processable.emptyFloors) || 0} 楼已判定为空。`,
          note: '可仅补未处理楼，或把无事件楼加入计划；后者可能增加模型调用，最终次数以预览为准。',
          choices: [
            { value: 'cancel', label: '取消' },
            { value: 'pendingOnly', label: '仅补未处理', primary: true },
            { value: 'includeEmpty', label: '含无事件楼' },
          ] });
        if (!active) return;
        if (!['pendingOnly', 'includeEmpty'].includes(choice)) { feedback = '已取消；没有调用模型。'; render(); return; }
        includeEmptyFloors = choice === 'includeEmpty';
      } else {
        includeEmptyFloors = !hasUnprocessed && hasEmpty;
      }
      const plan = await runtime.prepareQianshiHistory({ includeEmptyFloors, ...(targetIdentity ? { targetIdentity } : {}) });
      if (!active) return;
      if (plan.status === 'empty') { feedback = plan.aggregateSkippedFloors?.length
        ? `${plan.aggregateSkippedFloors.length} 楼由多个正文楼聚合；为保留成员事件来源，当前跳过模型替换。`
        : includeEmptyFloors ? '没有符合条件的空结果楼可重查；现有记录未改动。'
        : plan.unavailableFloors?.length ? `当前没有可补齐的摘要楼；${plan.unavailableFloors.length} 楼缺少摘要来源。` : '现有可处理楼都已完成千事整理。'; render(); return; }
      const unavailable = plan.unavailableFloors?.length ?? 0;
      const modelFloors = Number(plan.modelFloors) || 0;
      const aggregateSkipped = plan.aggregateSkippedFloors?.length ?? 0;
      const budgetSkipped = plan.budgetSkippedFloors?.length ?? 0;
      const recheckedEmpty = Number(plan.recheckedEmptyFloors) || 0;
      const confirmed = await dialog?.confirm?.({ title: '补齐旧楼千事',
        body: `${modelFloors} 楼进入模型补齐，分 ${plan.batchCount} 批；预计 API ${plan.apiCalls} 次，输入约 ${plan.estimatedInputTokens} token。${recheckedEmpty ? `其中重查已判空楼 ${recheckedEmpty} 楼。` : ''}${budgetSkipped ? `跳过超预算 ${budgetSkipped} 楼。` : ''}${aggregateSkipped ? `跳过聚合记忆 ${aggregateSkipped} 楼。` : ''}`,
        note: `${includeEmptyFloors ? '本次包含符合条件的无事件楼重查；重查结果只替换千事增量。' : ''}${unavailable ? `另有 ${unavailable} 楼缺少有效摘要。` : ''}确认后才调用 API；取消不调用模型或写入。${modelFloors ? '成功批次立即保存，可停止后继续。' : '暂无可发给模型的楼。'}`,
        confirmText: '开始补齐', cancelText: '取消' });
      if (!active) return;
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
    const operationEpoch = ++epoch, targetIdentity = runtime.captureBusinessIdentity?.() ?? null;
    try {
      const latestMessageIndex = (snapshot?.events ?? []).reduce((latest, event) => Number.isSafeInteger(event.sourceMessageIndex)
        ? Math.max(latest, event.sourceMessageIndex) : latest, -1);
      const input = await dialog.prompt({ title: '重新整理已存千事', body: `留空或填 0，从第 0 楼整理到最新；也可填 12~30 指定范围（按酒馆显示的楼号）。${latestMessageIndex >= 0 ? `当前最新为第 ${latestMessageIndex} 楼。` : ''}`,
        placeholder: '留空整理全部，或填 12~30', maxLength: 32, confirmText: '预览范围' });
      if (!active || input === null) return;
      // 一次输入同时选择两端；省略终点保留开放边界，由实际存档解析，不能转成第 0 楼。
      const value = String(input).trim(), range = value.match(/^(\d+)(?:\s*[~～-]\s*(\d*))?$/u);
      if (value && !range) { feedback = '请输入楼号范围，例如 12~30；留空或填 0 可整理全部。'; render(); return; }
      const plan = await runtime.prepareQianshiRejudge({ ...(targetIdentity ? { targetIdentity } : {}), fromMessageIndex: range ? Number(range[1]) : 0,
        toMessageIndex: range?.[2] ? Number(range[2]) : null });
      if (!active) return;
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
      if (!active) return;
      if (!confirmed) { feedback = '已取消；没有调用模型或写入。'; render(); return; }
      runtimeState = runtime.getState();
      if (otherWorkBusy() || historyBusy()) { feedback = '后台任务状态已经变化，请等待后重新准备范围。'; render(); return; }
      feedback = REJUDGE_START_PENDING_FEEDBACK; render();
      await runtime.startQianshiRejudge(plan.planId);
    } catch (error) {
      if (active && operationEpoch === epoch) { feedback = `重判未开始：${publicErrorMessage(error, { fallback: '请稍后重试。' })}`; render(); }
    }
  }

  function renderAnomalies() {
    if (!anomalyContent) return;
    const scrollTop = anomalyContent.scrollTop;
    const floors = snapshot?.diagnostics?.anomalyFloors ?? [], eventById = new Map((snapshot?.events ?? []).map(event => [event.id, event]));
    const eventOrder = new Map(timelineDisplayProjection(new Set(eventById.keys())).eventIds.map((id, index) => [id, index]));
    const intro = element('p', 'qqj-qianshi-anomaly-intro', floors.length
      ? `${floors.length} 个异常楼。事件仍已收录，只是部分关联失效；编辑、删除和状态修改沿用千事原入口。文字编辑不修复关联，需要时可关闭后用“整理”重判对应楼。`
      : '当前没有异常楼。');
    const list = element('div', 'qqj-qianshi-anomaly-list');
    for (const floor of [...floors].sort((left, right) => (right.assistantSeq ?? -1) - (left.assistantSeq ?? -1))) {
      const section = element('details', 'qqj-qianshi-anomaly-floor'); section.dataset.floorId = floor.floorId;
      section.open = anomalyOpenFloorIds.has(floor.floorId);
      const summary = element('summary', '', validMessageIndex(floor.messageIndex) ? `第 ${floor.messageIndex} 楼` : `AI 记录 ${floor.assistantSeq ?? '未明'}`);
      summary.append(element('small', '', floor.reasons.join('；'))); section.append(summary);
      let built = false;
      const build = () => {
        if (built) return;
        for (const id of [...floor.eventIds].sort((left, right) => (eventOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (eventOrder.get(right) ?? Number.MAX_SAFE_INTEGER))) {
          const event = eventById.get(id);
          if (event) section.append(eventNode(event, new Map()));
        }
        if (!floor.eventIds.length) section.append(element('p', '', '关联端点已不在当前有效千事中；可用“整理”重新核对这一楼。'));
        built = true;
      };
      section.addEventListener('toggle', () => { if (section.open) { anomalyOpenFloorIds.add(floor.floorId); build(); }
        else anomalyOpenFloorIds.delete(floor.floorId); });
      if (section.open) build(); list.append(section);
    }
    anomalyContent.replaceChildren(intro, list, ...(feedback ? [element('p', 'qqj-qianshi-feedback', feedback)] : []));
    anomalyContent.scrollTop = scrollTop;
  }

  async function openAnomalies() {
    if (typeof dialog?.custom !== 'function') return;
    snapshot = runtime.getQianshiSnapshot(); runtimeState = runtime.getState();
    const content = element('section', 'qqj-qianshi-anomalies'); anomalyContent = content;
    renderAnomalies();
    await dialog.custom({ title: '处理异常', content, confirmText: '关闭', cancelText: '', submit: () => true,
      onClose: () => { if (anomalyContent === content) anomalyContent = null; } });
  }

  function renderHealth() {
    const coverage = coverageProjection(snapshot);
    const history = snapshot?.history ?? {};
    const health = element('p', `qqj-page-health ${coverage.tone}`, coverage.copy);
    health.setAttribute('role', 'status');
    if (history.status === 'running') {
      health.textContent = `${history.mode === 'rejudge' ? '正在整理已存事项' : '正在补齐历史'}：${history.committing
        ? '整组正在提交，提交中不能停止' : `已处理 ${history.processedFloors ?? 0}/${history.totalFloors ?? 0} 楼`}`;
      health.className = 'qqj-page-health checking';
    } else if (['failed', 'partial'].includes(history.status)) {
      health.textContent = '有任务未完成，请到设置复制状态诊断。';
      health.className = 'qqj-page-health error';
    }
    return health;
  }

  function renderToolbarActions() {
    const history = snapshot?.history ?? {}, historyRunning = historyBusy();
    const processableCounts = snapshot?.coverage?.processable ?? snapshot?.coverage ?? {};
    const hasHistoryToComplete = snapshot?.status === 'ready'
      && ((Number(processableCounts.pendingFloors) || 0) + (Number(processableCounts.partialFloors) || 0) > 0
        || (Number(processableCounts.emptyFloors) || 0) > 0);
    const actions = element('div', 'qqj-qianshi-toolbar-actions');
    if (historyRunning || hasHistoryToComplete) {
      const historyAction = element('button', 'secondary-action', historyRunning ? history.committing ? '提交中…' : '停止' : '补齐旧楼'); historyAction.type = 'button';
      historyAction.dataset.focusKey = 'qianshi-history-action';
      historyAction.disabled = historyRunning ? Boolean(history.committing) : otherWorkBusy();
      historyAction.addEventListener('click', () => { void (historyRunning ? stopHistory() : prepareHistory()); });
      actions.append(historyAction);
    }
    if (!historyRunning && snapshot?.events?.length && typeof runtime.prepareQianshiRejudge === 'function') {
      const rejudge = element('button', 'secondary-action', '整理'); rejudge.type = 'button'; rejudge.dataset.focusKey = 'qianshi-rejudge-action';
      rejudge.disabled = otherWorkBusy(); rejudge.addEventListener('click', () => { void prepareRejudge(); }); actions.append(rejudge);
    }
    if (snapshot?.status === 'ready') {
      const todos = element('button', 'secondary-action', `待办事项（${todoCount}）`); todos.type = 'button'; todos.dataset.focusKey = 'qianshi-todos-action';
      todos.disabled = typeof dialog?.custom !== 'function'; todos.addEventListener('click', openTodos); actions.append(todos);
    }
    if (snapshot?.diagnostics?.anomalyFloors?.length) {
      const anomalies = element('button', 'secondary-action', '处理异常'); anomalies.type = 'button'; anomalies.dataset.focusKey = 'qianshi-anomalies-action';
      anomalies.disabled = typeof dialog?.custom !== 'function'; anomalies.addEventListener('click', () => { void openAnomalies(); });
      actions.append(anomalies);
    }
    return actions;
  }

  function updateProgressView() {
    if (!pageNode || !healthNode || !toolbarActionsNode || !container) { render(); return; }
    const focusKey = toolbarActionsNode.contains?.(documentRef.activeElement) ? documentRef.activeElement?.dataset?.focusKey : null;
    const nextHealth = renderHealth();
    healthNode.className = nextHealth.className;
    healthNode.textContent = nextHealth.textContent;
    toolbarActionsNode.replaceChildren(...renderToolbarActions().children);
    if (focusKey) {
      const stack = [...(toolbarActionsNode.children ?? [])];
      while (stack.length) {
        const node = stack.pop();
        if (node.dataset?.focusKey === focusKey) { node.focus?.({ preventScroll: true }); break; }
        stack.push(...(node.children ?? []));
      }
    }
    if (feedbackNode && feedback) feedbackNode.textContent = feedback;
    else if (feedbackNode && !feedback) { feedbackNode.remove?.(); feedbackNode = null; }
    else if (!feedbackNode && feedback) {
      feedbackNode = element('p', 'qqj-qianshi-feedback', feedback); feedbackNode.setAttribute('role', 'status');
      const search = pageNode.querySelector?.('.qqj-history-search');
      if (search?.after) search.after(feedbackNode); else pageNode.append(feedbackNode);
    }
    const refreshMenus = root => {
      const stack = root ? [root] : [];
      while (stack.length) {
        const node = stack.pop(); node.refreshQianshiAvailability?.();
        stack.push(...(node.children ?? []));
      }
    };
    refreshMenus(container);
    refreshMenus(anomalyContent);
  }

  function render() {
    if (!container) return;
    const currentChatId = snapshot?.identity?.qqjChatId ?? null;
    const previousChatId = chatId;
    const outerScrollPositions = [];
    for (let ancestor = container.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.scrollTop) outerScrollPositions.push([ancestor, ancestor.scrollTop]);
    }
    const focusedControlKey = documentRef.activeElement?.dataset?.focusKey ?? null;
    const focusedDayStateId = documentRef.activeElement?.className === 'qqj-qianshi-day-summary' ? documentRef.activeElement.dataset?.dayStateId : null;
    resetForChat(currentChatId);
    const todoSourceChanged = snapshot?.events !== todoSourceEvents || snapshot?.matters !== todoSourceMatters;
    if (todoSourceChanged) {
      const currentTodoEntries = todoEntries();
      todoCount = currentTodoEntries.length;
      todoDialog?.refresh?.(currentTodoEntries);
    }
    operationMenus.reset();
    const page = element('section', 'qqj-qianshi-page'); pageNode = page;
    healthNode = renderHealth();
    page.append(healthNode);
    const search = element('div', 'qqj-history-search');
    const input = element('input', 'settings-input qqj-history-search-input'); input.type = 'search'; input.value = query; input.placeholder = '搜索事件、说明、人物、涉及物品或时间'; input.setAttribute('aria-label', input.placeholder);
    input.addEventListener('input', event => {
      query = event.target.value; const cursor = event.target.selectionStart; render();
      const next = container.querySelector?.('.qqj-history-search-input'); next?.focus?.(); next?.setSelectionRange?.(cursor, cursor);
    });
    const clear = element('button', 'secondary-action qqj-history-search-clear', '清除'); clear.type = 'button'; clear.hidden = !query;
    clear.addEventListener('click', () => { query = ''; render(); container.querySelector?.('.qqj-history-search-input')?.focus?.(); });
    search.append(input, clear); page.append(search);
    feedbackNode = null;
    if (feedback) { feedbackNode = element('p', 'qqj-qianshi-feedback', feedback); feedbackNode.setAttribute('role', 'status'); page.append(feedbackNode); }
    const visible = visibleEvents(), renderedTimeline = snapshot?.status === 'ready' ? timelineContent(visible) : null;
    const toolbar = element('div', 'qqj-qianshi-toolbar');
    toolbar.append(element('span', '', renderedTimeline && query ? `匹配 ${visible.length} 件事件 · 显示 ${renderedTimeline.visibleEventCount} 条` : '沿着时间，回看故事'));
    toolbarActionsNode = renderToolbarActions(); toolbar.append(toolbarActionsNode);
    page.append(toolbar);
    if (renderedTimeline) page.append(renderedTimeline.node);
    container.replaceChildren(page);
    if (focusedControlKey) {
      const nextControl = findDescendant(container, node => node.dataset?.focusKey === focusedControlKey);
      nextControl?.focus?.({ preventScroll: true });
    }
    if (focusedDayStateId) {
      const nextSummary = findDescendant(container, node => node.className === 'qqj-qianshi-day-summary' && node.dataset?.dayStateId === focusedDayStateId);
      nextSummary?.focus?.({ preventScroll: true });
    }
    for (const [ancestor, scrollTop] of outerScrollPositions) ancestor.scrollTop = scrollTop;
    renderAnomalies();
  }

  function subscribe() {
    unsubscribe?.();
    unsubscribe = runtime.subscribe(next => {
      const header = typeof runtime.getQianshiSnapshotVersion === 'function' ? runtime.getQianshiSnapshotVersion() : null;
      const headerKey = header ? renderKey(header, next) : null;
      const unchanged = headerKey !== null && headerKey === runtimeRenderKey;
      const sameContentProjection = Number.isSafeInteger(header?.projectionRevision)
        && header.projectionRevision === snapshot?.projectionRevision && header.status === snapshot?.status;
      const progressOnly = !unchanged && sameContentProjection;
      const nextSnapshot = unchanged ? snapshot : progressOnly ? { ...snapshot, history: header.history ?? null } : runtime.getQianshiSnapshot();
      const nextKey = unchanged ? headerKey : renderKey(nextSnapshot, next);
      const previousFeedback = feedback;
      if (header?.projectionRevision === undefined || header.projectionRevision !== snapshot?.projectionRevision) editableEvents.clear();
      runtimeState = next; snapshot = nextSnapshot; runtimeRenderKey = nextKey;
      // 启动提示只覆盖任务尚未接管进度的间隙；运行或最终状态到达后移除，避免保存成功仍显示“将暂存”。
      const history = snapshot?.history;
      if (history?.status && history.status !== 'idle'
        && (feedback === REJUDGE_START_PENDING_FEEDBACK && history.mode === 'rejudge'
          || feedback === HISTORY_START_PENDING_FEEDBACK && history.mode !== 'rejudge')) feedback = '';
      if (active && progressOnly) updateProgressView();
      else if (active && !unchanged) render();
      else if (active && feedback !== previousFeedback) updateProgressView();
    });
  }
  function mount(target) { unsubscribe?.(); unsubscribe = null; operationMenus.deactivate(); container = target; active = true; snapshot = runtime.getQianshiSnapshot(); runtimeState = runtime.getState(); runtimeRenderKey = renderKey(snapshot, runtimeState); editableEvents.clear(); render(); operationMenus.activate(); subscribe(); return target; }
  async function activate() {
    // mount 已完成首次渲染和订阅；处于激活状态时直接复用当前页面。
    if (active) return { status: snapshot?.status ?? 'unavailable' };
    active = true; operationMenus.activate(); snapshot = runtime.getQianshiSnapshot(); runtimeState = runtime.getState(); runtimeRenderKey = renderKey(snapshot, runtimeState); editableEvents.clear(); render(); subscribe(); return { status: snapshot?.status ?? 'unavailable' };
  }
  function deactivate() { active = false; epoch += 1; if (anomalyContent || todoDialog) dialog?.cancelTop?.(); operationMenus.deactivate(); unsubscribe?.(); unsubscribe = null; pageNode = null; healthNode = null; toolbarActionsNode = null; feedbackNode = null; todoSourceEvents = undefined; todoSourceMatters = undefined; todoProjectionEntries = []; }
  return Object.freeze({ mount, activate, deactivate, render });
}
