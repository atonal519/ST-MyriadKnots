import { publicErrorMessage } from '../public-error.js';

const VALID_STATUS = new Set(['planned', 'inProgress', 'completed', 'cancelled', 'occurred', 'unknown']);
const STATUS_COPY = Object.freeze({ planned: '已计划 / 尚未记录完成', inProgress: '进行中 / 尚未记录完成', completed: '已完成', cancelled: '已取消', occurred: '已发生', unknown: '状态未明' });
const STATUS_BADGE_COPY = Object.freeze({ planned: '待办', inProgress: '进行中', completed: '已完成', cancelled: '已取消', occurred: '已发生', unknown: '状态未明' });
const HISTORY_STATUS_COPY = Object.freeze({ running: '正在补齐历史事件', completed: '历史补齐完成', partial: '历史补齐部分完成', stopped: '历史补齐已停止', failed: '历史补齐未完成' });
const HISTORY_OUTCOME_COPY = Object.freeze({ failed: '本楼未能完成，原记录已保留。', skipped: '本楼已跳过，原记录保持不变。' });
const HISTORY_START_PENDING_FEEDBACK = '计划已确认；正在启动补齐…';
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
  if (!runtime || ['getState', 'getQianshiSnapshot', 'prepareQianshiHistory', 'startQianshiHistory', 'stopQianshiHistory', 'subscribe']
    .some(name => typeof runtime[name] !== 'function')) throw new TypeError('千事时间线 runtime 无效');
  if (!documentRef?.createElement) throw new TypeError('千事时间线 documentRef 无效');
  let container = null, active = false, unsubscribe = null, epoch = 0;
  let snapshot = runtime.getQianshiSnapshot(), runtimeState = runtime.getState(), chatId = snapshot?.identity?.qqjChatId ?? null;
  let query = '', reverse = true, feedback = '';
  const openIds = new Set(), nestedOpenIds = new Set(), matterOpenIds = new Set();
  const element = (tag, className = '', copy = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (copy !== '') node.textContent = copy;
    return node;
  };
  const resetForChat = nextChatId => {
    if (chatId === nextChatId) return;
    epoch += 1; chatId = nextChatId; query = ''; reverse = true; feedback = ''; openIds.clear(); nestedOpenIds.clear(); matterOpenIds.clear();
  };
  const visibleEvents = () => {
    const needle = text(query).trim();
    return (snapshot?.events ?? []).filter(event => !needle || searchText(event).includes(needle));
  };
  const historyBusy = () => snapshot?.history?.status === 'running' || runtimeState?.qianshiHistoryActive === true;
  const otherWorkBusy = () => runtimeState?.memoryWorkBusy === true || Boolean(runtimeState?.activeExtraction || runtimeState?.activeCse);
  const sourceCopy = event => validMessageIndex(event.sourceMessageIndex) ? `第 ${event.sourceMessageIndex} 楼` : `AI 记录 ${event.sourceAssistantSeq ?? '未明'}`;
  const statusBadge = event => {
    const status = VALID_STATUS.has(event.status) ? event.status : 'unknown';
    const badge = element('small', `qqj-qianshi-state status-${status}`, STATUS_BADGE_COPY[status]);
    badge.title = `当时状态：${STATUS_BADGE_COPY[status]}`;
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
    body.append(element('p', 'qqj-qianshi-description', event.description));
    const meta = element('dl', 'qqj-qianshi-meta');
    const row = (label, value, valueClass = '') => {
      if (!value) return;
      const dt = element('dt', '', label), dd = element('dd', valueClass, value); meta.append(dt, dd);
    };
    row('人物', (event.people ?? []).map(person => person.name).filter(Boolean).join('、'));
    row('对象', event.object);
    row('当时', VALID_STATUS.has(event.status) ? STATUS_COPY[event.status] : '状态未明');
    row('约定', event.scheduledTime ? `${event.scheduledTime}（约定 / 预计）` : '');
    row('来源', sourceCopy(event), 'source');
    body.append(meta);
    return body;
  }

  function sameDayHistory(events, representativeId) {
    const section = element('section', 'qqj-qianshi-day-progress');
    section.append(element('p', 'qqj-qianshi-day-progress-title', `当天过程 · ${events.length} 条`));
    const list = element('div', 'qqj-qianshi-matter-list');
    for (const item of events) {
      const rowKey = `day:${representativeId}:${item.id}`, row = element('details', `qqj-qianshi-matter-event${item.id === representativeId ? ' current' : ''}`);
      row.open = nestedOpenIds.has(rowKey);
      const status = VALID_STATUS.has(item.status) ? STATUS_COPY[item.status] : '状态未明';
      const suffix = [item.updatesMatter === false ? '背景 / 补充' : '', status ? `当时：${status}` : ''].filter(Boolean).join(' · ');
      const summary = element('summary');
      summary.append(element('span', '', `${item.storyTime || '时间未明'} · ${item.title}${suffix ? `（${suffix}）` : ''}`), statusBadge(item));
      row.append(summary);
      let built = false;
      row.addEventListener('toggle', () => {
        if (row.open) nestedOpenIds.add(rowKey); else nestedOpenIds.delete(rowKey);
        if (!row.open || built) return;
        row.append(eventDetails(item, 'qqj-qianshi-day-event-detail')); built = true;
      });
      if (row.open) { row.append(eventDetails(item, 'qqj-qianshi-day-event-detail')); built = true; }
      list.append(row);
    }
    section.append(list);
    return section;
  }

  function expandedContent(event, matterEvents, dayEvents) {
    const body = element('div', 'qqj-qianshi-expanded');
    if (dayEvents.length > 1) body.append(sameDayHistory(dayEvents, event.id));
    else body.append(eventDetails(event, 'qqj-qianshi-event-detail'));
    const history = matterHistory(event, matterEvents); if (history) body.append(history);
    return body;
  }

  function eventNode(event, matterEvents, { cardId = event.id, dayEvents = [event] } = {}) {
    const details = element('details', 'qqj-qianshi-event'); details.dataset.eventId = event.id;
    details.dataset.cardId = cardId; details.open = openIds.has(cardId);
    const summary = element('summary', 'qqj-qianshi-event-summary');
    if (event.storyTime) summary.append(element('span', 'qqj-qianshi-event-time', event.storyTime));
    const title = element('span', 'qqj-qianshi-event-title', event.title);
    if (dayEvents.length > 1) title.append(element('small', 'qqj-qianshi-event-status', `当天 ${dayEvents.length} 条`));
    title.append(statusBadge(event));
    summary.append(title);
    summary.append(element('p', 'qqj-qianshi-preview', event.description));
    details.append(summary);
    const ensureBody = () => {
      if (!details.children || [...details.children].some(node => String(node.className).includes('qqj-qianshi-expanded'))) return;
      details.append(expandedContent(event, matterEvents, dayEvents));
    };
    if (details.open) ensureBody();
    details.addEventListener('toggle', () => {
      if (details.open) { openIds.add(cardId); ensureBody(); } else openIds.delete(cardId);
    });
    return details;
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
    for (const [segmentIndex, segment] of (timeline.segments ?? []).entries()) {
      let groups = (segment.groups ?? []).map(group => ({ ...group, eventIds: [...group.eventIds] })).filter(group => group.eventIds.some(id => visibleIds.has(id)));
      if (!groups.length) continue;
      const yearBoundaryAmbiguous = segment.id === 'month-day'
        && groups.some(group => group.period === '1月') && groups.some(group => group.period === '12月');
      if (reverse && !yearBoundaryAmbiguous) groups = groups.reverse();
      const block = element('section', 'qqj-qianshi-segment');
      if ((timeline.segments ?? []).length > 1) block.append(element('p', 'qqj-qianshi-segment-label', `${segment.label || (segmentIndex ? '另一组时间' : '时间')} · 不依据其他组推断先后`));
      for (const group of groups) {
        const latest = !yearBoundaryAmbiguous && group.id === segment.latestGroupId;
        const day = element('section', `qqj-qianshi-day${latest ? ' latest' : ''}`); day.id = group.id;
        const date = element('div', 'qqj-qianshi-date'); date.title = group.full;
        date.append(element('span', 'qqj-qianshi-day-name', group.day), element('span', 'qqj-qianshi-period', group.period));
        if (latest) date.append(element('span', 'qqj-qianshi-latest-tag', timeline.hasGlobalLatest ? '最近' : '该段最近'));
        const dot = element('i', 'qqj-qianshi-dot'); dot.setAttribute('aria-hidden', 'true');
        const eventList = element('div', 'qqj-qianshi-events');
        let cards = groupedDayCards(group.id, group.eventIds, eventById).filter(card => card.events.some(event => visibleIds.has(event.id)));
        if (reverse) cards = cards.reverse();
        groupCount += cards.length;
        for (const card of cards) eventList.append(eventNode(card.representative, matterEvents, { cardId: card.id, dayEvents: card.events }));
        day.append(date, dot, eventList); block.append(day);
      }
      wrapper.append(block);
    }
    const undated = (timeline.undatedEventIds ?? []).filter(id => visibleIds.has(id)).map(id => eventById.get(id)).filter(Boolean);
    if (undated.length) {
      const details = element('details', 'qqj-qianshi-undated'); if (query) details.open = true;
      const summary = element('summary', '', `无法确定单一发生时间 · ${undated.length} 件`), list = element('div', 'qqj-qianshi-undated-list');
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
        body: `将处理 ${plan.totalFloors} 楼，其中 ${modelFloors} 楼进入模型补齐，分 ${plan.batchCount} 批，预计调用摘要 API ${plan.apiCalls} 次；保守估算输入 ${plan.estimatedInputTokens} token。${budgetSkipped ? `另有 ${budgetSkipped} 楼超出预算，本次不会调用模型。` : ''}${aggregateSkipped ? `${aggregateSkipped} 楼由多个正文楼聚合，跳过模型补齐以保留成员来源。` : ''}`,
        note: `${unavailable ? `另有 ${unavailable} 楼缺少唯一有效摘要，当前计划不会处理。` : ''}打开计划和取消均不会写入或调用 API；确认后才会执行模型补齐。${modelFloors ? '成功批次会立即保留，可随时停止后重新规划继续。' : '当前没有可发送给模型的楼。'}`,
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

  function render() {
    if (!container) return;
    const currentChatId = snapshot?.identity?.qqjChatId ?? null;
    const previousChatId = chatId;
    const previousResults = container.querySelector?.('.qqj-qianshi-history-results');
    const preserveResults = previousChatId === currentChatId && previousResults;
    const resultsScrollTop = preserveResults ? previousResults.scrollTop : 0;
    const resultsHadFocus = preserveResults && (previousResults === documentRef.activeElement
      || previousResults.contains?.(documentRef.activeElement));
    resetForChat(currentChatId);
    const page = element('section', 'qqj-qianshi-page');
    const coverage = coverageProjection(snapshot), coverageBox = element('section', `qqj-qianshi-coverage ${coverage.kind}`);
    const coverageText = element('div'); coverageText.append(element('strong', '', coverage.label), element('p', '', coverage.copy));
    const history = snapshot?.history ?? {}, historyAction = element('button', 'secondary-action', historyBusy() ? '停止' : '补齐旧楼'); historyAction.type = 'button';
    historyAction.disabled = !historyBusy() && otherWorkBusy(); historyAction.addEventListener('click', () => { void (historyBusy() ? stopHistory() : prepareHistory()); });
    coverageBox.append(coverageText, historyAction);
    if (history.status && history.status !== 'idle') {
      const outcomes = history.outcomes ?? [];
      const progress = history.status === 'running'
        ? `已处理 ${history.processedFloors ?? 0}/${history.totalFloors ?? 0} 楼；失败 ${history.failedFloors ?? 0} 楼；跳过 ${history.skippedFloors ?? 0} 楼 · 模型任务 ${history.calls ?? 0} 次${history.message ? ` · ${history.message}` : ''}`
        : `${history.message || HISTORY_STATUS_COPY[history.status] || '历史补齐状态待核对。'}${history.attemptedFloors !== undefined
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
    const input = element('input', 'settings-input qqj-history-search-input'); input.type = 'search'; input.value = query; input.placeholder = '搜索事件、说明、人物、对象或时间'; input.setAttribute('aria-label', input.placeholder);
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
      const order = element('button', '', reverse ? '由晚到早' : '由早到晚'); order.type = 'button'; order.addEventListener('click', () => { reverse = !reverse; render(); });
      tools.append(order); toolbar.append(tools); page.append(toolbar, renderedTimeline.node);
    }
    container.replaceChildren(page);
    if (preserveResults) {
      const nextResults = container.querySelector?.('.qqj-qianshi-history-results');
      if (nextResults) {
        nextResults.scrollTop = resultsScrollTop;
        if (resultsHadFocus) nextResults.focus();
      }
    }
  }

  function subscribe() {
    unsubscribe?.();
    unsubscribe = runtime.subscribe(next => {
      runtimeState = next; snapshot = runtime.getQianshiSnapshot();
      if (feedback === HISTORY_START_PENDING_FEEDBACK && snapshot?.history?.status === 'running') feedback = '';
      if (active) render();
    });
  }
  function mount(target) { unsubscribe?.(); unsubscribe = null; container = target; active = true; snapshot = runtime.getQianshiSnapshot(); runtimeState = runtime.getState(); render(); subscribe(); return target; }
  async function activate() { active = true; snapshot = runtime.getQianshiSnapshot(); runtimeState = runtime.getState(); render(); subscribe(); return { status: snapshot?.status ?? 'unavailable' }; }
  function deactivate() { active = false; epoch += 1; unsubscribe?.(); unsubscribe = null; }
  return Object.freeze({ mount, activate, deactivate, render });
}
