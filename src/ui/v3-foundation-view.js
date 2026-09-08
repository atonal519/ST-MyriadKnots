import { createInlineSelect } from './inline-select.js';

function text(value, fallback = '—') { return value === null || value === undefined || value === '' ? fallback : String(value); }

function statusCopy(value) {
  return ({
    uninitialized: '等待首个稳定 AI 楼', ready: '可用', running: '正在处理', empty: '完成 · 无需注入',
    skipped: '本轮已跳过', idle: '尚无生成记录', conflict: '并发冲突，未覆盖新数据', error: '处理失败，可重试',
    needsReview: '待复核', disabled: '插件已关闭', stale: '正在等待最新结果', unprocessed: '未处理',
    failed: '失败可重试', pending: '待分析', noChange: '无实质变化', notApplicable: '尚无摘要',
  })[value] ?? text(value, '尚未初始化');
}

const effectiveStatus = state => state.status === 'idle' ? state.foundationStatus : state.status;
const validMessageIndex = value => Number.isSafeInteger(value) && value >= 0;
const messageIndexFor = (state, reference = {}) => {
  if (validMessageIndex(reference.messageIndex)) return reference.messageIndex;
  const floors = state?.floors ?? [];
  if (reference.floorId !== undefined && reference.floorId !== null) {
    const floor = floors.find(value => value.floorId === reference.floorId);
    return validMessageIndex(floor?.messageIndex) ? floor.messageIndex : null;
  }
  if (Number.isSafeInteger(reference.assistantSeq) && reference.assistantSeq > 0) {
    const floor = floors.find(value => value.assistantSeq === reference.assistantSeq);
    return validMessageIndex(floor?.messageIndex) ? floor.messageIndex : null;
  }
  return null;
};
const floorCopy = (state, reference, fallback = '楼号未提供') => {
  const messageIndex = messageIndexFor(state, reference);
  return messageIndex === null ? fallback : `第 ${messageIndex} 楼`;
};
const sourceFloorCopy = (state, reference) => {
  const value = floorCopy(state, reference.sourceFloorId
    ? { floorId: reference.sourceFloorId }
    : { assistantSeq: reference.sourceAssistantSeq }, '');
  return value ? `来源：${value}` : '来源楼号未提供';
};
const userFloorCopy = value => validMessageIndex(value) ? `第 ${value} 楼` : '旧记录未提供';
const localTimeCopy = value => {
  if (!value || !Number.isFinite(Date.parse(value))) return '旧记录未提供';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
};
const generationTypeCopy = value => ({ normal: '正常生成', regenerate: '重 Roll（regenerate）', swipe: '重 Roll（swipe）', continue: '继续生成（continue）' })[value] ?? text(value, '旧记录未提供');
const workBusy = state => Boolean(state.memoryWorkBusy || state.activeAutoMemory || state.activeExtraction || state.activeCse);
const memoryBusy = state => Boolean(state.activeExtraction || ['revising', 'extracting', 'reconciling', 'committing'].includes(state.activeMemoryWork?.phase) || state.activeAutoMemory?.phase === 'extracting');
const cseBusy = state => Boolean(state.activeCse || state.activeMemoryWork?.phase === 'analyzingCse' || state.activeAutoMemory?.phase === 'analyzingCse');
const workPhaseCopy = state => ({ reconciling: '正在核对稳定楼', extracting: '正在提取摘要', analyzingCse: '正在分析人物状态', revisingCse: '正在保存人物状态', committing: '正在保存结果', resetting: '正在重建地基', revising: '正在保存修订' })[state.activeMemoryWork?.phase ?? state.activeAutoMemory?.phase ?? state.activeExtraction?.phase ?? state.activeCse?.phase] ?? '正在处理';
const splitPeople = value => [...new Set(String(value ?? '').split(/[、,，\n]/u).map(item => item.trim()).filter(Boolean))];
const timeDisplay = chronology => [...new Set((chronology ?? []).map(item => item?.time?.sourceText || item?.time?.normalized || item?.description).map(item => String(item ?? '').trim()).filter(Boolean))].join('；');
const comparableLocations = locations => (locations ?? []).map(item => ({ itemId: item?.itemId ?? null, name: String(item?.name ?? '').trim() })).filter(item => item.name);
const sameList = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const unchangedDraft = (draft, payload) => String(payload.summary ?? '').trim() === String(draft.originalSummary ?? '').trim()
  && String(payload.timeText ?? '').trim() === String(draft.originalTimeText ?? '').trim()
  && sameList(comparableLocations(payload.locations), comparableLocations(draft.originalLocations))
  && sameList(payload.participantNames, draft.originalParticipantNames)
  && !String(payload.revisionNote ?? '').trim();
const CSE_VISIBILITY_OPTIONS = Object.freeze([['private', '私密'], ['expressed', '已表达'], ['observable', '可观察'], ['shared', '共享'], ['authorial', '作者设定']]);
const visibilityCopy = value => Object.fromEntries(CSE_VISIBILITY_OPTIONS)[value] ?? text(value);
const originCopy = value => ({ baseline: '聊天基线', floor: '本楼分析', reasonableProgression: '合理进展', manual: '用户纠正' })[value] ?? '本地重放';

export function createV3FoundationView({ runtime, recallRuntime = null, peopleRuntime = null, memoryManagement = null, uiDiagnosticProvider = null, documentRef = globalThis.document, navigatorRef = globalThis.navigator, confirmImpl = options => globalThis.confirm?.(typeof options === 'string' ? options : `${options?.title ?? '请确认'}\n\n${options?.body ?? ''}`) === true, infoImpl = () => Promise.resolve(true) } = {}) {
  if (!runtime || ['getState', 'refreshStatus', 'confirmLatest'].some(name => typeof runtime[name] !== 'function')) throw new TypeError('V3 foundation view runtime 无效');
  if (recallRuntime && typeof recallRuntime.getState !== 'function') throw new TypeError('V3 recall view runtime 无效');
  if (peopleRuntime && typeof peopleRuntime.getState !== 'function') throw new TypeError('V3 people workspace runtime 无效');
  if (memoryManagement && (typeof memoryManagement.getState !== 'function' || typeof memoryManagement.deleteCurrent !== 'function')) throw new TypeError('当前聊天记忆管理器无效');
  if (uiDiagnosticProvider !== null && typeof uiDiagnosticProvider !== 'function') throw new TypeError('界面诊断 provider 无效');
  if (!documentRef?.createElement) throw new TypeError('V3 foundation view documentRef 无效');

  let container = null, active = false, epoch = 0, feedback = '', receiptFeedback = '', fallbackText = '', unsubscribe = null;
  let page = 'management';
  let foundationState = runtime.getState(), recallState = recallRuntime?.getState?.() ?? null, peopleState = peopleRuntime?.getState?.() ?? null, managementState = memoryManagement?.getState?.() ?? null, chatId = foundationState?.chatId ?? null, healthNode = null;
  const drafts = new Map();
  const cseDrafts = new Map();
  const openState = new Map();

  const element = (tag, className = '', value = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (value !== '') node.textContent = value;
    return node;
  };
  const row = (label, value) => { const node = element('div', 'v3-foundation-row'); node.append(element('dt', '', label), element('dd', '', text(value))); return node; };
  const setDetailsState = (node, key, defaultOpen = false) => {
    node.open = openState.has(key) ? openState.get(key) : defaultOpen;
    node.addEventListener('toggle', () => openState.set(key, node.open === true));
    return node;
  };
  const resetForChat = nextChatId => {
    if (nextChatId === chatId) return false;
    chatId = nextChatId; drafts.clear(); cseDrafts.clear(); openState.clear(); fallbackText = ''; feedback = '';
    return true;
  };
  const sourceChanged = (previous, next) => {
    if ((previous?.chatId ?? null) !== (next?.chatId ?? null)) return true;
    const previousFloors = new Map((previous?.floors ?? []).map(floor => [floor.floorId, `${floor.canonicalFingerprint ?? ''}:${floor.rawFingerprint ?? ''}`]));
    const nextFloors = new Map((next?.floors ?? []).map(floor => [floor.floorId, `${floor.canonicalFingerprint ?? ''}:${floor.rawFingerprint ?? ''}`]));
    if (previousFloors.size !== nextFloors.size) return true;
    for (const [floorId, fingerprint] of previousFloors) if (!nextFloors.has(floorId) || nextFloors.get(floorId) !== fingerprint) return true;
    return false;
  };
  const errorMessage = value => typeof value === 'string' ? value : value?.message || '';
  const peopleSharedError = state => {
    if (state.pluginEnabled === false) return '';
    const foundationError = errorMessage(state.lastError); if (foundationError) return `共享记忆：${foundationError}`;
    const foundationStatus = effectiveStatus(state);
    if (!['ready', 'running'].includes(foundationStatus)) return `共享记忆${statusCopy(foundationStatus)}`;
    const workspaceError = errorMessage(peopleState?.lastError); if (workspaceError) return `重要人物选择：${workspaceError}`;
    if (peopleState && ['idle', 'stale', 'error', 'disabled'].includes(peopleState.status)) return `重要人物选择${statusCopy(peopleState.status)}`;
    return '';
  };
  const errorCopy = state => page === 'memories' ? state.lastExtractorError?.message || errorMessage(state.lastError)
    : page === 'people' ? peopleSharedError(state) || state.lastCseError?.message || ''
      : state.lastCseError?.message || state.lastExtractorError?.message || errorMessage(state.lastError);
  const healthCopy = state => {
    if (state.pluginEnabled === false) return '千千结已关闭';
    if (page === 'memories') {
      if (memoryBusy(state)) return `正在处理摘要 · ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼`;
      const error = errorCopy(state); if (error) return `摘要需要处理 · ${error}`;
      return `已记忆 ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼 · 待摘要 ${state.unprocessedCount ?? 0} 楼`;
    }
    if (page === 'people') {
      if (cseBusy(state)) return `正在分析人物状态 · 待分析 ${state.csePendingCount ?? 0} 楼`;
      const error = errorCopy(state); if (error) return `人物状态需要处理 · ${error}`;
      const complete = Math.max(0, (state.rememberedCount ?? 0) - (state.csePendingCount ?? 0) - (state.cseFailedCount ?? 0));
      return `人物状态 ${complete}/${state.rememberedCount ?? 0} 楼 · 待分析 ${state.csePendingCount ?? 0} 楼`;
    }
    if (workBusy(state) || state.status === 'running') return `${workPhaseCopy(state)} · ${state.rebuildCompletedCount ?? state.rememberedCount ?? 0}/${state.rebuildTotalCount ?? state.stableCount ?? 0} 楼`;
    const error = errorCopy(state); if (error) return `需要处理 · ${error}`;
    return `已记忆 ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼 · 人物状态 ${state.cseReady ? '已跟上' : `待分析 ${state.csePendingCount ?? 0} 楼`}`;
  };
  const updateHealth = state => {
    if (!healthNode) return;
    healthNode.textContent = healthCopy(state);
    healthNode.className = `qqj-page-health${errorCopy(state) ? ' error' : ''}`;
  };
  const heading = (title, description, state) => {
    const block = element('header', 'qqj-view-heading');
    block.append(element('h2', '', title), element('p', '', description));
    healthNode = element('p', `qqj-page-health${errorCopy(state) ? ' error' : ''}`, healthCopy(state));
    block.append(healthNode); return block;
  };

  async function copy(value) {
    if (navigatorRef?.clipboard?.writeText) {
      try { await navigatorRef.clipboard.writeText(value); fallbackText = ''; return '已复制。'; }
      catch { /* 浏览器或壳层拒绝剪贴板权限时改用只读文本框。 */ }
    }
    fallbackText = value; return '浏览器不允许直接复制，请在下方文本框长按全选复制。';
  }
  async function run(label, task, { after, failed } = {}) {
    const mine = ++epoch; feedback = `${label}…`; updateHealth(foundationState);
    try {
      const next = await task();
      const nextState = runtime.getState?.() ?? next;
      const settledRender = after?.(nextState) === true;
      if (!active) return next;
      if (mine !== epoch) { if (settledRender) { feedback = `${label}完成。`; render(nextState); } return next; }
      if (!feedback || feedback.endsWith('…')) feedback = nextState?.status === 'ready' ? `${label}完成。` : `${label}结束：${statusCopy(nextState?.status)}`;
      render(nextState); return next;
    } catch (error) {
      const settledRender = failed?.(error) === true;
      if (!active) return { status: 'stale' };
      if (mine !== epoch && !settledRender) return { status: 'stale' };
      feedback = `${label}失败：${error?.message || '未知错误'}`; render(runtime.getState());
      return { status: 'error', error };
    }
  }
  function validateDrafts(state) {
    let valid = true;
    const floors = new Map((state.floors ?? []).map(floor => [floor.floorId, floor]));
    for (const [key, draft] of drafts) {
      const floor = floors.get(draft.floorId);
      if (!floor || floor.canonicalFingerprint !== draft.canonicalFingerprint || (draft.rawFingerprint && floor.rawFingerprint !== draft.rawFingerprint)) { drafts.delete(key); valid = false; }
    }
    return valid;
  }
  function adoptFoundationState(state = runtime.getState()) {
    if (sourceChanged(foundationState, state)) { epoch += 1; cseDrafts.clear(); }
    const chatChanged = resetForChat(state?.chatId ?? null);
    const draftsValid = validateDrafts(state);
    foundationState = state;
    return { state, mustReplace: chatChanged || state?.pluginEnabled === false || !draftsValid };
  }

  function renderMemoryFloor(floor, state) {
    const key = `${state.chatId ?? 'no-chat'}:${floor.floorId}`;
    const card = setDetailsState(element('details', `qqj-memory-card status-${floor.status}`), `memory:${key}`, false);
    const head = element('summary', 'qqj-memory-card-head');
    head.append(element('strong', 'qqj-floor-number', floorCopy(state, floor)), element('span', 'v3-memory-status', floor.summarySource === 'user' ? '人工修订' : statusCopy(floor.status)));
    card.append(head);
    const body = element('div', 'qqj-memory-card-body');
    const draft = drafts.get(key);
    if (draft) {
      const editBox = element('div', 'v3-memory-edit');
      const label = (copy, control) => { const node = element('label', 'qqj-memory-edit-field'); node.append(element('span', '', copy), control); return node; };
      const timeInput = element('input', 'settings-input'); timeInput.value = draft.timeText; timeInput.placeholder = '日期、时间范围或相对时间'; timeInput.addEventListener('input', () => { draft.timeText = timeInput.value; });
      editBox.append(label('时间', timeInput));
      const collection = (title, items, fields, addLabel, addValue) => {
        const block = element('div', 'qqj-memory-edit-group'); block.append(element('strong', '', title));
        items.forEach((item, index) => {
          const rowNode = element('div', 'qqj-memory-edit-row');
          for (const [field, placeholder] of fields) { const control = element('input', 'settings-input'); control.value = item[field] ?? ''; control.placeholder = placeholder; control.addEventListener('input', () => { item[field] = control.value; }); rowNode.append(control); }
          const remove = element('button', 'secondary-action', '删除'); remove.type = 'button'; remove.addEventListener('click', () => { items.splice(index, 1); render(foundationState); }); rowNode.append(remove); block.append(rowNode);
        });
        const add = element('button', 'secondary-action', addLabel); add.type = 'button'; add.addEventListener('click', () => { items.push({ ...addValue }); render(foundationState); }); block.append(add); return block;
      };
      editBox.append(collection('地点', draft.locations, [['name', '地点名称']], '添加地点', { itemId: null, name: '' }));
      const peopleInput = element('textarea', 'settings-input'); peopleInput.value = draft.peopleText; peopleInput.placeholder = '张三、李四、路人甲'; peopleInput.addEventListener('input', () => { draft.peopleText = peopleInput.value; });
      editBox.append(label('人物', peopleInput));
      const input = element('textarea', 'settings-input'); input.value = draft.summary; input.placeholder = '输入用户修订摘要'; input.addEventListener('input', () => { draft.summary = input.value; });
      editBox.append(label('摘要', input));
      const note = element('input', 'settings-input'); note.value = draft.note; note.placeholder = '修订说明（可选）'; note.addEventListener('input', () => { draft.note = note.value; });
      const actions = element('div', 'v3-foundation-actions');
      if (draft.saveError) editBox.append(element('p', 'v3-foundation-feedback error', draft.saveError));
      const save = element('button', 'primary-action', draft.saving ? '保存中…' : '保存'); save.type = 'button'; save.disabled = draft.saving === true || workBusy(state);
      const cancel = element('button', 'secondary-action', '取消'); cancel.type = 'button'; cancel.disabled = draft.saving === true || workBusy(state);
      draft.controls = [save, cancel];
      save.addEventListener('click', () => {
        const payload = { summary: draft.summary, timeText: draft.timeText, originalTimeText: draft.originalTimeText, timeChanged: String(draft.timeText ?? '').trim() !== String(draft.originalTimeText ?? '').trim(), locations: draft.locations, participantNames: splitPeople(draft.peopleText), revisionNote: draft.note };
        if (unchangedDraft(draft, payload)) { drafts.delete(key); feedback = '未修改内容。'; render(foundationState); return; }
        const saveIdentity = {}; draft.saveIdentity = saveIdentity; draft.saving = true; draft.saveError = '';
        save.textContent = '保存中…'; save.disabled = true; cancel.disabled = true;
        const currentDraft = () => {
          const latest = runtime.getState?.() ?? foundationState;
          const latestFloor = latest?.floors?.find(item => item.floorId === floor.floorId);
          return drafts.get(key) === draft && draft.saveIdentity === saveIdentity && latest?.chatId === state.chatId && latestFloor?.canonicalFingerprint === draft.canonicalFingerprint && (!draft.rawFingerprint || latestFloor?.rawFingerprint === draft.rawFingerprint);
        };
        const task = typeof runtime.editMemory === 'function' ? () => runtime.editMemory(floor.floorId, payload) : () => runtime.editSummary(floor.floorId, payload.summary, payload.revisionNote);
        void run('保存本楼记忆', task, {
          after: () => { if (!currentDraft()) return false; drafts.delete(key); return true; },
          failed: error => { if (!currentDraft()) return false; draft.saving = false; draft.saveError = `保存失败：${error?.message || '未知错误'}`; return true; },
        });
      });
      cancel.addEventListener('click', () => { drafts.delete(key); feedback = '已取消编辑。'; render(foundationState); });
      actions.append(save, cancel); editBox.append(label('修订说明（可选）', note), actions); body.append(editBox); input.focus?.();
    } else {
      const memory = floor.memory;
      if (memory) {
        const facts = element('dl', 'qqj-memory-facts');
        const times = floor.manualTime ? timeDisplay(memory.chronology) || '时间未明确' : floor.metadataStale ? '时间戳已变化，请重新提取' : timeDisplay(memory.chronology) || floor.timeFallback || '时间未明确';
        const locations = (memory.locations ?? []).map(item => item.name).filter(Boolean).join('、') || '未提取';
        const names = new Map((state.memoryEntities ?? []).map(entity => [entity.entityId, entity.displayName]));
        const people = (memory.participants ?? []).map(item => names.get(item.entityId) ?? '未知人物').join('、') || '未提取';
        facts.append(row('时间', times), row('地点', locations), row('人物', people), row('摘要', floor.summary || '暂无摘要。')); body.append(facts);
      } else body.append(element('p', 'v3-memory-effective', floor.summary || (floor.status === 'unprocessed' ? '这一楼尚未生成摘要。' : '暂无摘要。')));
      const actions = element('div', 'qqj-card-actions');
      if (floor.memoryId) {
        const edit = element('button', 'secondary-action', '编辑'); edit.type = 'button'; edit.disabled = workBusy(state);
        edit.addEventListener('click', () => { const memory = floor.memory; const names = new Map((state.memoryEntities ?? []).map(entity => [entity.entityId, entity.displayName])); const originalTimeText = timeDisplay(memory?.chronology) || floor.timeFallback || ''; const locations = (memory?.locations ?? []).map(item => ({ itemId: item.itemId, name: item.name ?? '' })); const participantNames = (memory?.participants ?? []).map(item => names.get(item.entityId)).filter(Boolean); drafts.set(key, { floorId: floor.floorId, canonicalFingerprint: floor.canonicalFingerprint, rawFingerprint: floor.rawFingerprint, summary: floor.summary, originalSummary: floor.summary, timeText: originalTimeText, originalTimeText, locations, originalLocations: locations.map(item => ({ ...item })), peopleText: participantNames.join('、'), originalParticipantNames: participantNames, note: '', saving: false, saveError: '' }); render(foundationState); });
        const extract = element('button', 'secondary-action', '重新提取'); extract.type = 'button'; extract.disabled = workBusy(state) || typeof runtime.extractFloor !== 'function';
        extract.addEventListener('click', async () => { if (!await Promise.resolve(confirmImpl({ title: '重新提取本楼摘要', body: '重新提取会替换本楼摘要，并重新衔接本楼及后续人物状态，也可能覆盖之后的人工纠正。', confirmText: '重新提取', cancelText: '取消' }))) { feedback = '已取消重新提取。'; render(foundationState); return; } void run('重新提取', () => runtime.extractFloor(floor.floorId)); });
        actions.append(edit, extract);
      } else {
        const extract = element('button', 'secondary-action', '提取摘要'); extract.type = 'button'; extract.disabled = workBusy(state) || typeof runtime.extractFloor !== 'function';
        extract.addEventListener('click', () => { void run('提取摘要', () => runtime.extractFloor(floor.floorId)); });
        actions.append(extract);
      }
      body.append(actions);
    }
    if (floor.error) body.append(element('p', 'v3-foundation-feedback error', floor.error));
    card.append(body);
    return card;
  }
  function renderMemories(state) {
    const pageNode = element('section', 'qqj-page qqj-memories-page'); pageNode.append(heading('千结', '逐楼校对故事摘要；最新楼在前。', state));
    if (feedback) pageNode.append(element('p', `v3-foundation-feedback${feedback.includes('失败') ? ' error' : ''}`, feedback));
    const list = element('div', 'v3-memory-list');
    const floors = [...(state.floors ?? [])].sort((left, right) => (right.messageIndex ?? right.assistantSeq ?? 0) - (left.messageIndex ?? left.assistantSeq ?? 0));
    for (const floor of floors) list.append(renderMemoryFloor(floor, state));
    if (!floors.length) list.append(element('div', 'qqj-inline-empty', '这里还没有稳定 AI 楼。新楼稳定后，摘要会出现在这里。'));
    pageNode.append(list); return pageNode;
  }

  const appendSubjectGroups = (card, subject, state) => {
    const item = value => { const node = element('li', 'v3-cse-item'); const source = value.sourceFloorId || value.sourceAssistantSeq ? sourceFloorCopy(state, value) : value.origin === 'baseline' ? '来源：聊天基线' : '来源：本地重放'; node.append(element('span', 'v3-cse-item-text', value.text), element('small', 'v3-cse-item-meta', [...new Set([value.reason, originCopy(value.origin), source, visibilityCopy(value.visibility)])].join(' · '))); return node; };
    const addGroup = (label, values, groupByTarget = false) => {
      const block = element('div', 'v3-cse-group'); block.append(element('h5', '', label));
      if (!values.length) { block.append(element('p', 'settings-hint', '暂无')); card.append(block); return; }
      if (groupByTarget) {
        const grouped = new Map(); for (const value of values) { const key = value.towardDisplayName || '未指定对象'; grouped.set(key, [...(grouped.get(key) ?? []), value]); }
        for (const [target, targetItems] of grouped) { block.append(element('h6', '', `对 ${target}`)); const ul = element('ul', 'v3-cse-items'); targetItems.forEach(value => ul.append(item(value))); block.append(ul); }
      } else { const ul = element('ul', 'v3-cse-items'); values.forEach(value => ul.append(item(value))); block.append(ul); }
      card.append(block);
    };
    addGroup('核心特质', subject.core ?? []); addGroup('长期倾向', subject.adaptive ?? [], true); addGroup('当前情境', subject.situational ?? []);
  };
  function renderCseEditor(body, draft, state, key) {
    const editor = element('div', 'qqj-cse-edit');
    const controls = [], disabled = draft.saving === true || workBusy(state);
    editor.append(element('p', 'settings-hint', '修改会直接成为当前人物状态。重新提取或重算较早楼层时，之后的人工纠正可能被覆盖。'));
    const scopeHeading = element('div', 'qqj-cse-scope-heading');
    const scopeHelp = element('button', 'qqj-cse-help', '?'); scopeHelp.type = 'button'; scopeHelp.disabled = disabled; scopeHelp.setAttribute('aria-label', '查看信息范围说明');
    scopeHelp.addEventListener('click', () => { void Promise.resolve(infoImpl({ title: '信息范围', body: '信息范围用于描述人物状态在故事里的可知程度，不是上传或隐私权限，也不表示所有人物都知道。', note: '私密：本人内心或私有认知\n已表达：已经说出或表现，不代表人人收到\n可观察：剧情中外表、动作等可观察状态，不等于读心\n共享：已向相关人传达或共同知晓，不代表全员知情\n作者设定：塑造人物的参考，不代表角色知道', confirmText: '知道了' })); });
    scopeHeading.append(element('span', '', '信息范围'), scopeHelp); editor.append(scopeHeading); controls.push(scopeHelp);
    const category = (field, label, { toward = false } = {}) => {
      const group = element('section', 'qqj-cse-edit-group');
      group.append(element('strong', '', label));
      draft[field].forEach((item, index) => {
        const rowNode = element('div', `qqj-cse-edit-row${toward ? ' has-toward' : ''}`);
        const input = element('textarea', 'settings-input'); input.value = item.text; input.placeholder = `${label}内容`; input.disabled = disabled; input.addEventListener('input', () => { item.text = input.value; }); controls.push(input);
        const visibility = createInlineSelect({ documentRef, options: CSE_VISIBILITY_OPTIONS.map(([value, optionLabel]) => ({ value, label: optionLabel })), value: item.visibility, ariaLabel: `${label}信息范围`, onChange: value => { item.visibility = value; } }).node;
        visibility.disabled = disabled; controls.push(visibility);
        const meta = element('div', 'qqj-cse-edit-meta'); meta.append(visibility);
        rowNode.append(input, meta);
        if (toward) {
          const target = createInlineSelect({ documentRef, options: [{ value: '', label: '未指定对象' }, ...(state.cseTowardCandidates ?? []).map(candidate => ({ value: candidate.entityId, label: candidate.displayName }))], value: item.towardEntityId ?? '', ariaLabel: `${label}对象`, onChange: value => { item.towardEntityId = value || null; } }).node;
          target.disabled = disabled; controls.push(target); meta.append(target);
        }
        const remove = element('button', 'secondary-action', '删除'); remove.type = 'button'; remove.disabled = disabled; remove.addEventListener('click', () => { draft[field].splice(index, 1); render(foundationState); }); controls.push(remove); meta.append(remove); group.append(rowNode);
      });
      const add = element('button', 'secondary-action', `添加${label}`); add.type = 'button'; add.disabled = disabled; add.addEventListener('click', () => { draft[field].push({ itemId: null, text: '', visibility: field === 'core' ? 'authorial' : 'private', towardEntityId: null }); render(foundationState); }); controls.push(add); group.append(add); return group;
    };
    editor.append(category('core', '核心特质'), category('adaptive', '长期倾向', { toward: true }), category('situational', '当前情境'));
    if (draft.saveError) editor.append(element('p', 'v3-foundation-feedback error', draft.saveError));
    const actions = element('div', 'v3-foundation-actions');
    const save = element('button', 'primary-action', draft.saving ? '保存中…' : '保存'); save.type = 'button'; save.disabled = draft.saving === true || workBusy(state) || typeof runtime.correctSubjectState !== 'function';
    const cancel = element('button', 'secondary-action', '取消'); cancel.type = 'button'; cancel.disabled = draft.saving === true || workBusy(state);
    draft.controls = [...controls, save, cancel];
    save.addEventListener('click', () => {
      const saveIdentity = {}; draft.saveIdentity = saveIdentity; draft.saving = true; draft.saveError = ''; save.textContent = '保存中…';
      for (const control of draft.controls) control.disabled = true;
      const currentDraft = () => cseDrafts.get(key) === draft && draft.saveIdentity === saveIdentity && (runtime.getState?.() ?? foundationState)?.chatId === draft.chatId;
      const cloneItems = items => items.map(item => ({ ...item }));
      const payload = { expectedCurrentStateId: draft.expectedCurrentStateId, expectedCurrentStateFingerprint: draft.expectedCurrentStateFingerprint, core: cloneItems(draft.core), adaptive: cloneItems(draft.adaptive), situational: cloneItems(draft.situational) };
      void run('保存人物状态', () => runtime.correctSubjectState(draft.subjectEntityId, payload), {
        after: () => { if (!currentDraft()) return false; cseDrafts.delete(key); openState.set(`subject:${draft.subjectEntityId}`, true); return true; },
        failed: error => { if (!currentDraft()) return false; draft.saving = false; draft.saveError = `保存失败：${error?.message || '未知错误'}`; return true; },
      });
    });
    cancel.addEventListener('click', () => { cseDrafts.delete(key); feedback = '已取消编辑人物状态。'; render(foundationState); });
    actions.append(save, cancel); editor.append(actions); body.append(editor);
  }
  function renderSubject(subject, state, { person = null, defaultOpen = false } = {}) {
    const entityId = subject?.subjectEntityId ?? person?.entityId;
    const displayName = person?.displayName || subject?.displayName || '未知人物';
    const key = `${state.chatId ?? 'no-chat'}:${entityId}`;
    const card = setDetailsState(element('details', 'v3-cse-subject'), `subject:${entityId}`, defaultOpen);
    const summary = element('summary', 'qqj-person-summary'); summary.append(element('strong', '', displayName), element('span', 'v3-memory-status', subject ? '人物状态' : '暂无状态')); card.append(summary);
    const body = element('div', 'qqj-person-body');
    const draft = cseDrafts.get(key);
    if (subject && draft) renderCseEditor(body, draft, state, key);
    else if (subject) appendSubjectGroups(body, subject, state);
    else body.append(element('p', 'settings-hint', '这个重要人物还没有已保存的状态分析；后台摘要与 CSE 会继续正常处理。'));
    if (subject && !draft) {
      const edit = element('button', 'secondary-action', '编辑状态'); edit.type = 'button'; edit.disabled = workBusy(state) || typeof runtime.correctSubjectState !== 'function' || !state.currentStateId || !state.currentStateFingerprint;
      edit.addEventListener('click', () => {
        const copyItems = values => (values ?? []).map(item => ({ itemId: item.id, text: item.text, visibility: item.visibility, towardEntityId: item.towardEntityId ?? null }));
        cseDrafts.set(key, { chatId: state.chatId, subjectEntityId: entityId, expectedCurrentStateId: state.currentStateId, expectedCurrentStateFingerprint: state.currentStateFingerprint, core: copyItems(subject.core), adaptive: copyItems(subject.adaptive), situational: copyItems(subject.situational), saving: false, saveError: '' });
        openState.set(`subject:${entityId}`, true); render(foundationState);
      });
      body.append(edit);
    }
    if (!draft && peopleRuntime && person) {
      const selected = new Set(peopleState?.selectedEntityIds ?? []), action = element('button', 'secondary-action', person.selected ? '移出重要' : '设为重要');
      action.type = 'button'; action.disabled = Boolean(peopleState?.active && peopleState.active.kind !== 'generating');
      action.addEventListener('click', () => {
        if (person.selected) selected.delete(person.entityId); else selected.add(person.entityId);
        void run(person.selected ? '移出重要人物' : '加入重要人物', () => peopleRuntime.setSelectedEntityIds([...selected]));
      });
      body.append(action);
    }
    card.append(body); return card;
  }
  function cseActionFor(floor, state) {
    if (!floor.memoryId || typeof runtime.retryStateAnalysis !== 'function') return null;
    const status = floor.cse?.status; if (!['pending', 'failed', 'ready', 'noChange'].includes(status)) return null;
    const completed = ['ready', 'noChange'].includes(status); const label = completed ? '重新分析' : status === 'failed' ? '重试分析' : '分析本楼';
    const button = element('button', completed ? 'secondary-action' : 'primary-action', label); button.type = 'button'; button.disabled = workBusy(state);
    button.addEventListener('click', async () => { if (completed && !await Promise.resolve(confirmImpl({ title: '重新分析人物状态', body: '成功后，后续楼层人物状态需依次重算，也可能覆盖之后的人工纠正；本楼摘要保持不变。', confirmText: '重新分析', cancelText: '取消' }))) { feedback = '已取消重新分析人物状态。'; render(foundationState); return; } void run(label, () => runtime.retryStateAnalysis(floor.floorId)); });
    return button;
  }
  function renderCseHistory(state) {
    const categoryCopy = { core: '核心特质', adaptive: '长期倾向', situational: '当前情境' };
    const changeCopy = change => {
      const category = categoryCopy[change.category] ?? '人物状态', before = change.before ?? { text: change.beforeText }, after = change.after ?? { text: change.afterText };
      let main;
      if (before?.text && before.text === after?.text) main = `${category}属性更新：${after.text}`;
      else if (change.action === 'refine') main = `${category}调整：${before?.text} → ${after?.text}`;
      else if (change.action === 'update') main = `${category}更新：${before?.text} → ${after?.text}`;
      else if (change.action === 'remove') main = `移除${category}：${before?.text}`;
      else main = `新增${category}：${after?.text}`;
      const details = [], changed = (field, copy, label) => {
        const left = copy(before?.[field]), right = copy(after?.[field]);
        if (change.action === 'add' && right) details.push(`${label}：${right}`);
        else if (change.action === 'remove' && left) details.push(`${label}：${left}`);
        else if (left !== right) details.push(`${label}：${left || '未指定'} → ${right || '未指定'}`);
      };
      changed('towardDisplayName', value => value ?? '', '对象');
      changed('visibility', value => value ? visibilityCopy(value) : '', '信息范围');
      changed('reason', value => value ?? '', '依据');
      changed('origin', value => value ? originCopy(value) : '', '来源');
      return { main, details };
    };
    const section = setDetailsState(element('details', 'qqj-cse-history'), 'cse-history', false);
    const summary = element('summary', 'qqj-section-summary'); summary.append(element('strong', '', '状态分析记录'), element('span', 'v3-memory-status', `${state.csePendingCount ?? 0} 待分析 · ${state.cseFailedCount ?? 0} 失败`)); section.append(summary);
    const list = element('div', 'qqj-cse-history-list');
    const floors = [...(state.floors ?? [])].filter(floor => floor.memoryId).sort((left, right) => (right.messageIndex ?? 0) - (left.messageIndex ?? 0));
    for (const floor of floors) {
      const rowNode = setDetailsState(element('details', 'qqj-cse-history-row'), `cse-floor:${floor.floorId}`, false);
      const rowSummary = element('summary', 'qqj-cse-floor-summary'); rowSummary.append(element('span', '', floorCopy(state, floor)), element('span', 'v3-memory-status', statusCopy(floor.cse?.status))); rowNode.append(rowSummary);
      const body = element('div', 'qqj-cse-floor-body'), record = floor.cse?.record;
      if (record?.noMaterialChange) body.append(element('p', 'settings-hint', '本楼无实质人物状态变化。'));
      for (const subject of record?.subjects ?? []) {
        const subjectNode = element('section', 'qqj-cse-record-subject'); subjectNode.append(element('strong', '', subject.displayName));
        const changes = subject.changes ?? [];
        if (changes.length) { const listNode = element('ul', 'v3-cse-items'); for (const value of changes) { const copy = changeCopy(value), item = element('li', 'v3-cse-item'); item.append(element('span', 'v3-cse-item-text', copy.main)); if (copy.details.length) item.append(element('small', 'v3-cse-item-meta', copy.details.join(' · '))); listNode.append(item); } subjectNode.append(listNode); }
        else subjectNode.append(element('p', 'settings-hint', '这个人物本楼没有记录到变化。'));
        body.append(subjectNode);
      }
      if (record?.isolationSummary) body.append(element('p', 'qqj-cse-isolation-hint', record.noMaterialChange
        ? `有内容未通过校验；本楼未产生人物状态变化（${record.isolationSummary.count} 项校验记录）。`
        : `部分内容未通过校验，已保留有效结果（${record.isolationSummary.count} 项校验记录）。`));
      if (record?.endStateSubjects) {
        const stateNode = setDetailsState(element('details', 'qqj-cse-floor-state'), `cse-floor-state:${floor.floorId}`, false);
        const stateSummary = element('summary', 'qqj-cse-floor-state-summary', '查看本楼结束状态'); stateNode.append(stateSummary);
        const stateBody = element('div', 'qqj-cse-floor-state-body');
        for (const subject of record.endStateSubjects) {
          const subjectNode = element('section', 'qqj-cse-record-subject'); subjectNode.append(element('strong', '', subject.displayName));
          appendSubjectGroups(subjectNode, subject, state);
          stateBody.append(subjectNode);
        }
        if (!record.endStateSubjects.length) stateBody.append(element('p', 'settings-hint', '本楼结束时没有已保存状态。'));
        stateNode.append(stateBody); body.append(stateNode);
      }
      if (!record && !floor.cse?.error) body.append(element('p', 'settings-hint', '本楼还没有已保存的状态分析记录。'));
      if (floor.cse?.error) body.append(element('p', 'v3-foundation-feedback error', floor.cse.error)); const action = cseActionFor(floor, state); if (action) body.append(action); rowNode.append(body); list.append(rowNode);
    }
    if (!floors.length) list.append(element('p', 'settings-hint', '生成摘要后，这里会显示逐楼人物状态分析记录。'));
    section.append(list); return section;
  }
  function renderPeople(state) {
    const pageNode = element('section', 'qqj-page qqj-people-page'); pageNode.append(heading('双丝网', '查看人物在当前故事节点的状态。', state));
    if (feedback) pageNode.append(element('p', `v3-foundation-feedback${feedback.includes('失败') ? ' error' : ''}`, feedback));
    const subjects = state.cseSubjects ?? [], subjectById = new Map(subjects.map(subject => [subject.subjectEntityId, subject]));
    const userEntity = (state.memoryEntities ?? []).find(entity => entity.specialRole === 'user'), userSubject = userEntity ? subjectById.get(userEntity.entityId) : null;
    const candidates = (peopleState?.people ?? []).filter(person => person.entityId !== userEntity?.entityId), important = candidates.filter(person => person.selected), more = candidates.filter(person => !person.selected);
    const list = element('div', 'v3-cse-subjects');
    if (userSubject) list.append(renderSubject(userSubject, state, { defaultOpen: true }));
    for (const person of important) list.append(renderSubject(subjectById.get(person.entityId), state, { person, defaultOpen: true }));
    if (!userSubject && !important.length) list.append(element('div', 'qqj-inline-empty', peopleRuntime ? '尚未选择重要人物。千人页的选择会同步显示在这里。' : '暂无人物状态。'));
    pageNode.append(list);
    const drawer = setDetailsState(element('details', 'qqj-more-people qqj-cse-more'), 'cse-more-people', false);
    const summary = element('summary', 'qqj-section-summary'); summary.append(element('strong', '', '更多人物'), element('span', 'v3-memory-status', `${more.length} 位`)); drawer.append(summary);
    const moreList = element('div', 'qqj-more-people-list');
    for (const person of more) moreList.append(renderSubject(subjectById.get(person.entityId), state, { person }));
    if (!more.length) moreList.append(element('p', 'settings-hint', '当前没有其他已识别人物。'));
    drawer.append(moreList); pageNode.append(drawer, renderCseHistory(state));
    if (state.cseReplayDiagnostic?.message) pageNode.append(element('p', 'v3-foundation-feedback error', state.cseReplayDiagnostic.message)); return pageNode;
  }

  function renderRecallDetails(state = recallState) {
    const drawer = setDetailsState(element('details', 'qqj-management-drawer'), 'recall-details', false), record = state?.lastRecall ?? null, status = state?.recallStatus ?? 'idle';
    const recallStatus = record?.legacyReadOnly ? '旧版只读记录 · 不代表本轮已注入' : record?.restoredReceipt ? '已落盘回执 · 恢复显示' : statusCopy(status);
    const summary = element('summary', 'qqj-section-summary'); summary.append(element('strong', '', record?.restoredReceipt ? '最近一次召回结果' : '最近召回回执'), element('span', 'v3-memory-status', recallStatus)); drawer.append(summary);
    const body = element('div', 'qqj-management-drawer-body'); if (receiptFeedback) body.append(element('p', 'v3-foundation-feedback error', receiptFeedback));
    if (!record) { body.append(element('p', 'settings-hint', state?.activeRecall ? `正在处理 ${state.activeRecall.generationType} · ${state.activeRecall.phase}` : '下一次正文生成后，这里会保留最近一次召回结果。')); drawer.append(body); return drawer; }
    const coverage = record.coverage, stages = record.stages, timings = record.timings, sourceReads = timings?.sourceReadAttempts;
    const sourceExitCopy = { ready: '读取成功', stale: '读取时已失效', unavailable: '来源不可用' };
    const sourceReadCopy = sourceReads ? `完整快照 ${sourceReads.reachableReads} 次 · 退出 ${sourceExitCopy[sourceReads.exitPoint] ?? '未知'}` : record.restoredReceipt ? '历史回执不重新读取来源' : '未记录';
    const floors = (record.selectedFloors ?? []).map(value => floorCopy(foundationState, value, '来源楼号未提供')).join('、') || '无', states = (record.selectedStates ?? []).map(value => `${value.subject} / ${value.layer}`).join('、') || '无';
    const details = element('dl', 'v3-foundation-grid'); details.append(row('触发用户楼', userFloorCopy(record.userMessageIndex)), row('生成时间', localTimeCopy(record.createdAt)), row('生成类型', generationTypeCopy(record.generationType)), row('收据', record.legacyReadOnly ? '旧版只读记录' : record.restoredReceipt ? '已落盘回执 · 仅恢复历史展示，不会再次注入' : `${record.reusedReceipt ? '复用' : '新算'} · ${record.receiptPersistence ?? 'none'}`), row('召回旧楼', floors), row('人物状态', states), row('覆盖范围', coverage ? `记忆 ${coverage.rememberedAiFloors}/${coverage.stableAiFloors} · ${coverage.cseThroughAssistantSeq ? `CSE 到${floorCopy(foundationState, { assistantSeq: coverage.cseThroughAssistantSeq }, '终点楼号未提供')}` : 'CSE 尚未覆盖'}` : '本轮未读取'), row('筛选阶段', stages ? `输入 ${stages.input} → 候选 ${stages.candidates} → 去近期 ${stages.dropRecent} → 去常驻重复 ${stages.dropPersistent ?? 0} → 去越界 ${stages.dropVisibility} → 选中 ${stages.selected}` : '收据复用或未执行'), row('耗时', timings ? `${Number(timings.totalMs || 0).toFixed(1)} ms` : record.reusedReceipt ? '复用收据' : '未记录'), row('来源读取', sourceReadCopy), row('跳过原因', (record.skipReasons ?? []).join('、') || '无'));
    body.append(details); const safeError = state?.lastRecallError?.message || record.error?.message; if (safeError) body.append(element('p', 'v3-foundation-feedback error', safeError));
    if (record.legacyReadOnly) body.append(element('p', 'settings-hint', '这是旧版只读记录，不会复用、注入或升级为当前 Schema 6 回执。'));
    if (record.injectionText) body.append(element('pre', 'v3-recall-injection', record.injectionText));
    else if (record.status === 'empty' || record.status === 'completed-empty') body.append(element('p', 'settings-hint', '本轮没有需要注入的记忆。'));
    else if ((record.skipReasons ?? []).includes('sourceStale')) body.append(element('p', 'settings-hint', '记忆来源正在更新，本轮已安全跳过召回注入。'));
    else if ((record.skipReasons ?? []).includes('sourceUnavailable')) body.append(element('p', 'settings-hint', '记忆来源暂不可用，本轮已安全跳过召回注入。'));
    else if ((record.skipReasons ?? []).includes('memoryRebuilding')) body.append(element('p', 'settings-hint', '历史记忆正在后台重建；本轮没有注入不完整的记忆。'));
    else if ((record.skipReasons ?? []).includes('memoryNotReady')) body.append(element('p', 'settings-hint', (record.skipReasons ?? []).includes('historicalRebuildRequired') ? '当前存在历史记忆缺口；请在记忆管理中开始或继续重建。' : '当前记忆覆盖尚未确认；本轮没有注入不完整的记忆。'));
    drawer.append(body); return drawer;
  }
  function renderDiagnostics(state) {
    const drawer = setDetailsState(element('details', 'qqj-management-drawer'), 'diagnostics', false), summary = element('summary', 'qqj-section-summary'); summary.append(element('strong', '', '详细诊断'), element('span', 'v3-memory-status', '按需展开')); drawer.append(summary);
    const body = element('div', 'qqj-management-drawer-body'), details = element('dl', 'v3-foundation-grid');
    const rebuildCopy = ({ rebuilding: '正在重建', paused: '已暂停', waitingRealtime: '等待新楼', failed: '失败', caughtUp: '已追平', pendingRebuild: '等待开始', notReady: '覆盖待确认' })[state.rebuildStatus] ?? '尚未判断';
    details.append(row('当前 chat', state.chatId), row('地基状态', statusCopy(effectiveStatus(state))), row('自动维护新楼', state.autoMemoryEnabled ? '已开启 · 每楼更新' : '已关闭'), row('历史重建', `${rebuildCopy} · ${state.rebuildCompletedCount ?? 0}/${state.rebuildTotalCount ?? state.stableCount ?? 0}`), row('CSE 待分析 / 失败', `${state.csePendingCount ?? 0} / ${state.cseFailedCount ?? 0}`), row('Head checkpoint', state.headCheckpointId), row('最近记忆错误', state.lastExtractorError?.message || state.lastError || '无'), row('最近 CSE 错误', state.lastCseError?.message || '无')); body.append(details);
    if (uiDiagnosticProvider) {
      const uiDiagnostic = element('div', 'qqj-ui-diagnostic-action');
      const copyUi = element('button', 'secondary-action', '复制界面诊断'); copyUi.type = 'button';
      copyUi.addEventListener('click', () => { void run('复制界面诊断', async () => { const value = uiDiagnosticProvider(); feedback = await copy(typeof value === 'string' ? value : JSON.stringify(value, null, 2)); return runtime.getState(); }); });
      uiDiagnostic.append(copyUi, element('span', 'settings-hint', '只含界面滚动状态，不含聊天正文或输入内容。'));
      body.append(uiDiagnostic);
    }
    if (typeof runtime.copySafeDiagnostic === 'function' && typeof runtime.copyFullDiagnostic === 'function') {
      for (const floor of [...(state.floors ?? [])].reverse()) {
        const diagnostic = element('div', 'qqj-diagnostic-row'); diagnostic.append(element('span', '', floorCopy(state, floor)));
        const safe = element('button', 'secondary-action', '复制安全诊断'); safe.type = 'button'; safe.addEventListener('click', () => { void run('复制安全诊断', async () => { feedback = await copy(runtime.copySafeDiagnostic(floor.floorId)); return runtime.getState(); }); });
        const full = element('button', 'secondary-action', '复制完整诊断'); full.type = 'button'; full.addEventListener('click', () => { void run('复制完整诊断', async () => { if (!await Promise.resolve(confirmImpl({ title: '复制完整诊断', body: '完整诊断包含本楼正文与证据原文。确认复制吗？', confirmText: '复制', cancelText: '取消' }))) { feedback = '已取消完整诊断复制。'; return runtime.getState(); } feedback = await copy(runtime.copyFullDiagnostic(floor.floorId)); return runtime.getState(); }); });
        diagnostic.append(safe, full); body.append(diagnostic);
      }
    }
    if (fallbackText) { const fallback = element('textarea', 'v3-diagnostic-fallback'); fallback.value = fallbackText; fallback.textContent = fallbackText; fallback.readOnly = true; body.append(element('p', 'settings-hint', '诊断文本（长按全选复制）'), fallback); }
    drawer.append(body); return drawer;
  }
  function renderManagement(state) {
    const pageNode = element('section', 'qqj-page qqj-management-page'); pageNode.append(heading('记忆管理', '管理当前聊天的现有记忆任务。', state));
    if (['pendingRebuild', 'paused', 'failed'].includes(state.rebuildStatus) || (state.rebuildStatus === 'waitingRealtime' && state.rebuildHasActionableWork)) pageNode.append(element('p', 'qqj-management-notice', '记忆尚未完整。点击继续会从最早的摘要或人物状态缺口按顺序恢复；刷新页面不会自动续跑旧档。'));
    const deleting = managementState?.status === 'deleting', deletePending = managementState?.status === 'failed';
    const actions = element('div', 'v3-foundation-actions qqj-management-actions'), busy = workBusy(state) || deleting || deletePending;
    if (state.rebuildStatus === 'rebuilding' && typeof runtime.pauseHistoricalRebuild === 'function') { const pause = element('button', 'primary-action', '暂停'); pause.type = 'button'; pause.disabled = !state.activeAutoMemory; pause.addEventListener('click', () => { void run('暂停', () => runtime.pauseHistoricalRebuild()); }); actions.append(pause); }
    else { const begin = runtime.startHistoricalRebuild ?? runtime.retryAutomation; const actionable = state.rebuildHasActionableWork ?? !['caughtUp', 'waitingRealtime'].includes(state.rebuildStatus); const proceed = element('button', 'primary-action', busy ? workPhaseCopy(state) : '继续'); proceed.type = 'button'; proceed.disabled = busy || typeof begin !== 'function' || !actionable; proceed.addEventListener('click', () => { void run('继续', () => begin.call(runtime)); }); actions.append(proceed); }
    const reset = element('button', 'secondary-action', '完全重构'); reset.type = 'button'; reset.disabled = busy || typeof runtime.fullRebuild !== 'function'; reset.addEventListener('click', async () => { if (!await Promise.resolve(confirmImpl({ title: '完全重构当前聊天记忆', body: '当前聊天的摘要及人物状态将从头重新生成，人工修订也会被替换；聊天正文和插件设置保留。', confirmText: '完全重构', cancelText: '取消' }))) { feedback = '已取消完全重构。'; render(foundationState); return; } void run('完全重构', () => runtime.fullRebuild(state.chatId)); }); actions.append(reset);
    if (memoryManagement) {
      const remove = element('button', 'secondary-action', deleting ? '删除中…' : deletePending ? '继续删除当前聊天记忆' : '删除当前聊天记忆');
      remove.type = 'button'; remove.disabled = deleting || managementState?.blockedByOtherChat === true || (!deletePending && (workBusy(state) || !state.chatId));
      remove.addEventListener('click', async () => {
        if (!await Promise.resolve(confirmImpl({ title: '删除当前聊天记忆', body: '将删除本聊天的摘要、人物状态、人物资料、召回记录及历史派生版本。聊天正文和全局 API、提示词设置会保留；下次建档需要从头开始。', note: '后端数据会移入回收站；这不代表永久擦除。', confirmText: deletePending ? '继续删除' : '删除记忆', cancelText: '取消' }))) { feedback = '已取消删除当前聊天记忆。'; render(foundationState); return; }
        void run(deletePending ? '继续删除当前聊天记忆' : '删除当前聊天记忆', () => memoryManagement.deleteCurrent(), { after: () => { managementState = memoryManagement.getState(); feedback = '当前聊天记忆已删除；聊天正文与全局设置均已保留。'; return true; }, failed: () => { managementState = memoryManagement.getState(); return true; } });
      });
      actions.append(remove);
    }
    if (deletePending && managementState.error) pageNode.append(element('p', 'v3-foundation-feedback error', `上次删除未完成：${managementState.error} 已保留原聊天身份，可继续删除剩余记录。`));
    else if (managementState?.status === 'completed') pageNode.append(element('p', 'v3-foundation-feedback', '当前聊天记忆已清空；聊天正文和全局设置仍保留。'));
    pageNode.append(actions, element('p', `v3-foundation-feedback${errorCopy(state) ? ' error' : ''}`, feedback || errorCopy(state) || '状态已显示。'), renderRecallDetails(), renderDiagnostics(state)); return pageNode;
  }

  function renderAdopted(state) {
    if (!container) return;
    recallState = recallRuntime?.getState?.() ?? recallState; peopleState = peopleRuntime?.getState?.() ?? peopleState; managementState = memoryManagement?.getState?.() ?? managementState; healthNode = null;
    container.replaceChildren(page === 'memories' ? renderMemories(state) : page === 'people' ? renderPeople(state) : renderManagement(state));
  }
  function render(state = runtime.getState()) { renderAdopted(adoptFoundationState(state).state); }
  function receiveFoundation(snapshot) {
    const { state, mustReplace } = adoptFoundationState(snapshot);
    if (page === 'memories' && drafts.size && !mustReplace) {
      for (const draft of drafts.values()) for (const control of draft.controls ?? []) control.disabled = draft.saving === true || workBusy(state);
      updateHealth(state); return;
    }
    if (page === 'people' && cseDrafts.size && !mustReplace) {
      for (const draft of cseDrafts.values()) for (const control of draft.controls ?? []) control.disabled = draft.saving === true || workBusy(state);
      updateHealth(state); return;
    }
    renderAdopted(state);
  }
  function subscribe() {
    if (!active || !container || unsubscribe) return;
    const releases = [];
    if (typeof runtime.subscribe === 'function') { const release = runtime.subscribe(snapshot => { if (snapshot?.status === 'ready' && feedback === statusCopy('stale')) feedback = '记忆状态已刷新。'; if (active && container) receiveFoundation(snapshot); }); if (typeof release === 'function') releases.push(release); }
    if (typeof recallRuntime?.subscribe === 'function') { const release = recallRuntime.subscribe(snapshot => { recallState = snapshot; if (active && container && page === 'management') render(foundationState); }); if (typeof release === 'function') releases.push(release); }
    if (typeof peopleRuntime?.subscribe === 'function') { const release = peopleRuntime.subscribe(snapshot => { peopleState = snapshot; if (active && container && page === 'people') render(foundationState); }); if (typeof release === 'function') releases.push(release); }
    if (typeof memoryManagement?.subscribe === 'function') { const release = memoryManagement.subscribe(snapshot => { managementState = snapshot; if (active && container && page === 'management') render(foundationState); }); if (typeof release === 'function') releases.push(release); }
    unsubscribe = () => { for (const release of releases) { try { release(); } catch { /* listener cleanup isolation */ } } };
  }
  function stopSubscription() { const release = unsubscribe; unsubscribe = null; try { release?.(); } catch { /* runtime listener cleanup is isolated from view lifecycle */ } }
  function mount(target) { stopSubscription(); container = target; active = true; recallState = recallRuntime?.getState?.() ?? null; render(runtime.getState()); subscribe(); }
  async function activate() {
    if (!container) throw new Error('V3 foundation view 尚未挂载');
    active = true; subscribe(); const mine = ++epoch; feedback = '正在读取最新状态…'; receiptFeedback = ''; updateHealth(runtime.getState());
    const [foundationOutcome, receiptOutcome] = await Promise.allSettled([runtime.refreshStatus(), recallRuntime?.restorePersistedReceipt?.()]);
    if (!active || mine !== epoch) return { status: 'stale' };
    const peopleOutcome = page === 'people' && peopleRuntime?.refresh
      ? await Promise.resolve(peopleRuntime.refresh({ refreshMemory: false })).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))
      : { status: 'fulfilled', value: null };
    if (!active || mine !== epoch) return { status: 'stale' };
    if (receiptOutcome.status === 'rejected') receiptFeedback = `历史召回回执恢复失败：${receiptOutcome.reason?.message || '未知错误'}；不影响记忆读取。`;
    const peopleFeedback = peopleOutcome.status === 'rejected' ? `重要人物选择读取失败：${peopleOutcome.reason?.message || '未知错误'}；人物状态仍可查看。` : '';
    if (foundationOutcome.status === 'rejected') { feedback = `记忆读取失败：${foundationOutcome.reason?.message || '未知错误'}；历史召回回执已独立处理。`; const result = runtime.getState(); render(result); return { status: 'error', error: foundationOutcome.reason }; }
    const result = foundationOutcome.value; feedback = peopleFeedback || (result?.status === 'ready' ? '记忆状态已刷新。' : statusCopy(result?.status)); render(result); return result;
  }
  function deactivate() { active = false; epoch += 1; stopSubscription(); }
  function setPage(next) { if (!['memories', 'people', 'management'].includes(next)) throw new TypeError('V3 view page 无效'); page = next; if (container) render(foundationState); }
  return Object.freeze({ mount, activate, deactivate, render, setPage, getPage: () => page });
}
