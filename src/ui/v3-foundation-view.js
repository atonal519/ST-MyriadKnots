function text(value, fallback = '—') { return value === null || value === undefined || value === '' ? fallback : String(value); }
function statusCopy(value) {
  return ({ uninitialized: '等待首个稳定 AI 楼', ready: '可用', running: '正在处理', empty: '完成 · 无需注入', skipped: '本轮已跳过', idle: '尚无生成记录', conflict: '并发冲突，未覆盖新数据', error: '处理失败，可重试', needsReview: '待复核', disabled: '插件已关闭', stale: '状态暂未收敛，正在等待最新结果', unprocessed: '未处理', failed: '失败可重试', pending: '待分析', noChange: '无实质变化', notApplicable: '尚无 FloorMemory' })[value] ?? text(value, '尚未初始化');
}
const effectiveStatus = state => state.status === 'idle' ? state.foundationStatus : state.status;
const generationTypeCopy = value => ({
  normal: '正常生成',
  regenerate: '重 Roll（regenerate）',
  swipe: '重 Roll（swipe）',
  continue: '继续生成（continue）',
})[value] ?? text(value, '旧记录未提供');
const userFloorCopy = value => Number.isSafeInteger(value) && value >= 0 ? `第 ${value + 1} 楼（user，宿主索引 ${value}）` : '旧记录未提供';
const localTimeCopy = value => {
  if (!value || !Number.isFinite(Date.parse(value))) return '旧记录未提供';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
};

export function createV3FoundationView({ runtime, recallRuntime = null, documentRef = globalThis.document, navigatorRef = globalThis.navigator, confirmImpl = message => globalThis.confirm?.(message) === true } = {}) {
  if (!runtime || ['getState', 'refreshStatus', 'confirmLatest'].some(name => typeof runtime[name] !== 'function')) throw new TypeError('V3 foundation view runtime 无效');
  if (recallRuntime && typeof recallRuntime.getState !== 'function') throw new TypeError('V3 recall view runtime 无效');
  if (!documentRef?.createElement) throw new TypeError('V3 foundation view documentRef 无效');
  let container = null, active = false, epoch = 0, feedback = '', receiptFeedback = '', fallbackText = '', unsubscribe = null, foundationState = runtime.getState(), recallState = recallRuntime?.getState?.() ?? null;
  const element = (tag, className = '', value = '') => { const node = documentRef.createElement(tag); if (className) node.className = className; if (value !== '') node.textContent = value; return node; };
  const row = (label, value) => { const node = element('div', 'v3-foundation-row'); node.append(element('dt', '', label), element('dd', '', text(value))); return node; };
  async function copy(value) {
    if (navigatorRef?.clipboard?.writeText) { await navigatorRef.clipboard.writeText(value); fallbackText = ''; return '已复制。'; }
    fallbackText = value; return '浏览器不允许直接复制，请在下方文本框长按全选复制。';
  }
  async function run(label, task) {
    const mine = ++epoch; feedback = `${label}…`; render(runtime.getState());
    try { const next = await task(); if (!active || mine !== epoch) return next; if (!feedback || feedback.endsWith('…')) feedback = next?.status === 'ready' ? `${label}完成。` : `${label}结束：${statusCopy(next?.status)}`; render(next); return next; }
    catch (error) { if (!active || mine !== epoch) return { status: 'stale' }; feedback = `${label}失败：${error?.message || '未知错误'}`; render(runtime.getState()); return { status: 'error', error }; }
  }

  function renderFloor(floor, state, rerender) {
    const workBusy = Boolean(state.memoryWorkBusy || state.activeAutoMemory || state.activeExtraction || state.activeCse);
    const card = element('details', `v3-memory-floor status-${floor.status}`);
    const summary = element('summary', 'v3-memory-floor-summary');
    summary.append(element('strong', '', `AI #${floor.assistantSeq} · 宿主楼 ${floor.messageIndex}`), element('span', 'v3-memory-status', statusCopy(floor.status)));
    const body = element('div', 'v3-memory-floor-body');
    body.append(element('p', 'v3-memory-effective', floor.summary || (floor.status === 'unprocessed' ? '尚未提取这一楼。' : '暂无摘要')));
    if (floor.cse) body.append(row('CSE 状态', statusCopy(floor.cse.status)), ...(floor.cse.deltaId ? [row('StateDelta', floor.cse.deltaId)] : []));
    if (floor.memoryId) {
      body.append(row('摘要来源', floor.summarySource === 'user' ? '用户修订' : 'AI 原摘要'), row('API', floor.api ? `${floor.api.sourceLabel} · ${floor.api.model}` : '历史记录未带来源'), row('Extractor', floor.extractorVersion), row('定位 ID', `${floor.floorId} / ${floor.memoryId}`));
      const total = Object.values(floor.counts ?? {}).reduce((sum, value) => sum + Number(value || 0), 0);
      body.append(element('p', 'v3-memory-counts', `结构化条目 ${total} · 证据 ${floor.memory?.summaryEvidenceRefs?.length ?? 0} · 歧义 ${floor.counts?.ambiguities ?? 0}`));
      body.append(element('pre', 'v3-memory-json', JSON.stringify({ summaryEvidence: floor.memory.summaryEvidenceRefs, chronology: floor.memory.chronology, locations: floor.memory.locations, participants: floor.memory.participants, actions: floor.memory.actions, observations: floor.memory.observations, informationTransfers: floor.memory.informationTransfers, privateCognition: floor.memory.privateCognition, commitments: floor.memory.commitments, eventFragments: floor.memory.eventFragments, exactAnchors: floor.memory.exactAnchors, openLoops: floor.memory.openLoops, ambiguities: floor.memory.ambiguities, cseSignals: floor.memory.cseSignals }, null, 2)));
      const editBox = element('div', 'v3-memory-edit');
      const input = element('textarea', 'settings-input'); input.value = floor.summary; input.placeholder = '输入用户修订摘要';
      const note = element('input', 'settings-input'); note.value = ''; note.placeholder = '修订说明（可选）';
      const save = element('button', 'primary-action', '保存摘要'); save.type = 'button';
      const cancel = element('button', 'secondary-action', '取消'); cancel.type = 'button';
      save.disabled = workBusy; cancel.disabled = workBusy;
      save.addEventListener('click', () => { void run('保存摘要', () => runtime.editSummary(floor.floorId, input.value, note.value)); });
      cancel.addEventListener('click', () => { input.value = floor.summary; note.value = ''; feedback = '已取消编辑。'; rerender(); });
      editBox.append(input, note, save, cancel); body.append(editBox);
    }
    const actions = element('div', 'v3-foundation-actions');
    const extract = element('button', 'primary-action', floor.memoryId ? '重新提取' : '提取这一楼'); extract.type = 'button'; extract.disabled = workBusy || typeof runtime.extractFloor !== 'function'; if (typeof runtime.extractFloor === 'function') extract.addEventListener('click', () => { void run(floor.memoryId ? '重新提取' : '提取', () => runtime.extractFloor(floor.floorId)); }); actions.append(extract);
    if (floor.memoryId) {
      const restore = element('button', 'secondary-action', '恢复 AI'); restore.type = 'button'; restore.disabled = workBusy || floor.summarySource === 'ai'; restore.addEventListener('click', () => { void run('恢复 AI', () => runtime.restoreAi(floor.floorId)); });
      const mark = element('button', 'secondary-action', '标记错误'); mark.type = 'button'; mark.disabled = workBusy; mark.addEventListener('click', () => { void run('标记错误', () => runtime.markError(floor.floorId)); });
      actions.append(restore, mark);
      if (typeof runtime.retryStateAnalysis === 'function' && ['pending', 'failed'].includes(floor.cse?.status)) {
        const analyze = element('button', floor.cse.status === 'failed' ? 'primary-action' : 'secondary-action', floor.cse.status === 'failed' ? '重试状态分析' : '分析本楼状态'); analyze.type = 'button'; analyze.disabled = workBusy; analyze.addEventListener('click', () => { void run(floor.cse.status === 'failed' ? '重试状态分析' : '分析本楼状态', () => runtime.retryStateAnalysis(floor.floorId)); }); actions.append(analyze);
      }
    }
    if (typeof runtime.copySafeDiagnostic === 'function' && typeof runtime.copyFullDiagnostic === 'function') {
      const safe = element('button', 'secondary-action', '复制安全诊断 JSON'); safe.type = 'button'; safe.addEventListener('click', () => { void run('复制安全诊断', async () => { feedback = await copy(runtime.copySafeDiagnostic(floor.floorId)); return runtime.getState(); }); });
      const full = element('button', 'secondary-action', '复制完整诊断 JSON'); full.type = 'button'; full.addEventListener('click', () => { void run('复制完整诊断', async () => { if (!confirmImpl('完整诊断包含本楼 canonicalContent 与证据原文。确认复制吗？')) { feedback = '已取消完整诊断复制。'; return runtime.getState(); } feedback = await copy(runtime.copyFullDiagnostic(floor.floorId)); return runtime.getState(); }); });
      actions.append(safe, full);
    }
    body.append(actions); if (floor.error) body.append(element('p', 'v3-foundation-feedback error', floor.error)); if (floor.cse?.error) body.append(element('p', 'v3-foundation-feedback error', `CSE：${floor.cse.error}`)); card.append(summary, body); return card;
  }

  function renderCseState(state) {
    const section = element('section', 'v3-cse-current');
    const heading = element('div', 'v3-cse-heading'); heading.append(element('h3', '', 'CSE 当前状态'), element('span', `v3-memory-status status-${state.cseReady ? 'ready' : 'pending'}`, state.cseReady ? '全部已分析' : `待分析 ${state.csePendingCount ?? 0}`)); section.append(heading);
    if (state.cseReplayDiagnostic?.message) section.append(element('p', 'v3-foundation-feedback error', state.cseReplayDiagnostic.message));
    if (!state.cseSubjects?.length) { section.append(element('p', 'settings-hint', state.baselineId ? '基线已冻结；完成状态分析后会在这里显示人物投影。' : '首次状态分析前会先冻结本聊天基线。')); return section; }
    const groups = element('div', 'v3-cse-subjects');
    const item = value => {
      const node = element('li', 'v3-cse-item');
      const source = value.sourceAssistantSeq ? `来源 AI #${value.sourceAssistantSeq}` : value.origin === 'baseline' ? '来源：聊天基线' : '来源：本地重放';
      node.append(element('span', 'v3-cse-item-text', value.text), element('small', 'v3-cse-item-meta', `${value.reason} · ${source} · ${value.visibility}`));
      return node;
    };
    for (const subject of state.cseSubjects) {
      const card = element('article', 'v3-cse-subject'); card.append(element('h4', '', subject.displayName));
      const addGroup = (label, values, groupByTarget = false) => {
        const block = element('div', 'v3-cse-group'); block.append(element('h5', '', label));
        if (!values.length) { block.append(element('p', 'settings-hint', '暂无')); card.append(block); return; }
        if (groupByTarget) {
          const grouped = new Map(); for (const value of values) { const key = value.towardDisplayName || '未指定对象'; grouped.set(key, [...(grouped.get(key) ?? []), value]); }
          for (const [target, targetItems] of grouped) { block.append(element('h6', '', `对 ${target}`)); const ul = element('ul', 'v3-cse-items'); targetItems.forEach(value => ul.append(item(value))); block.append(ul); }
        } else { const ul = element('ul', 'v3-cse-items'); values.forEach(value => ul.append(item(value))); block.append(ul); }
        card.append(block);
      };
      addGroup('Core · 核心', subject.core); addGroup('Adaptive · 长期适应', subject.adaptive, true); addGroup('Situational · 当前情境', subject.situational); groups.append(card);
    }
    section.append(groups); return section;
  }

  function renderRecallPreview(state = recallState) {
    const section = element('section', 'v3-recall-preview');
    const record = state?.lastRecall ?? null;
    const status = state?.recallStatus ?? 'idle';
    const skipReasons = record?.skipReasons ?? [];
    const statusLabel = record?.legacyReadOnly
      ? '旧版只读记录 · 不代表本轮已注入'
      : record?.restoredReceipt
      ? '已落盘回执 · 恢复显示'
      : record?.status === 'skipped' && skipReasons.includes('sourceStale')
      ? '来源更新中，已安全跳过'
      : record?.status === 'skipped' && skipReasons.includes('memoryRebuilding')
      ? '记忆正在重建 · 本轮未注入'
      : record?.status === 'skipped' && skipReasons.includes('memoryNotReady')
      ? '记忆尚未就绪 · 本轮未注入'
      : record?.status === 'skipped' && skipReasons.includes('sourceUnavailable')
        ? '来源不可用，已安全跳过'
        : statusCopy(status);
    const heading = element('div', 'v3-cse-heading');
    heading.append(element('h3', '', record?.restoredReceipt ? '轻量召回 · 最近一次召回结果' : '轻量召回 · 本轮召回结果'), element('span', `v3-memory-status status-${status}`, statusLabel));
    section.append(heading);
    if (receiptFeedback) section.append(element('p', 'v3-foundation-feedback error', receiptFeedback));
    if (!record) {
      section.append(element('p', 'settings-hint', state?.activeRecall ? `正在处理 ${state.activeRecall.generationType} · ${state.activeRecall.phase}` : '下一次正文生成时会在这里显示实际召回与注入结果。'));
      return section;
    }
    const coverage = record.coverage;
    const stages = record.stages;
    const timings = record.timings;
    const sourceReads = timings?.sourceReadAttempts;
    const sourceExitCopy = { ready: '读取成功', stale: '读取时已失效', unavailable: '来源不可用' };
    const sourceReadCopy = sourceReads ? [
      `完整快照 ${sourceReads.reachableReads} 次`,
      `退出 ${sourceExitCopy[sourceReads.exitPoint] ?? '未知'}`,
    ].join(' · ') : null;
    const floors = (record.selectedFloors ?? []).map(value => `AI #${value.assistantSeq}`).join('、') || '无';
    const states = (record.selectedStates ?? []).map(value => `${value.subject} / ${value.layer}`).join('、') || '无';
    const details = element('dl', 'v3-foundation-grid');
    details.append(
      row('触发 user 楼', userFloorCopy(record.userMessageIndex)),
      row('生成时间', localTimeCopy(record.createdAt)),
      row('生成类型', generationTypeCopy(record.generationType)),
      row('收据', record.legacyReadOnly ? '旧版只读记录 · 仅供历史查看，不代表本轮已注入' : record.restoredReceipt ? '已落盘回执 · 仅恢复历史展示，不会再次注入' : `${record.reusedReceipt ? '复用' : '新算'} · ${record.receiptPersistence}`),
      row('召回旧楼', floors),
      row('人物状态', states),
      row('覆盖范围', coverage ? `记忆 ${coverage.rememberedAiFloors}/${coverage.stableAiFloors} · CSE 到 AI #${coverage.cseThroughAssistantSeq || 0}` : '本轮未读取'),
      row('筛选阶段', stages ? `输入 ${stages.input} → 候选 ${stages.candidates} → 去近期 ${stages.dropRecent} → 去常驻重复 ${stages.dropPersistent ?? 0} → 去越界 ${stages.dropVisibility} → 选中 ${stages.selected}` : '收据复用或未执行'),
      row('耗时', timings ? `${Number(timings.totalMs || 0).toFixed(1)} ms` : record.reusedReceipt ? '复用收据' : '未记录'),
      row('来源读取', sourceReadCopy ?? (record.restoredReceipt ? '历史回执不重新读取来源' : '未记录')),
      row('跳过原因', (record.skipReasons ?? []).join('、') || '无'),
    );
    section.append(details);
    const safeError = state?.lastRecallError?.message || record.error?.message;
    if (safeError) section.append(element('p', 'v3-foundation-feedback error', safeError));
    if (record.legacyReadOnly) section.append(element('p', 'settings-hint', '这是旧版只读记录，只说明该 user 楼曾保存过这段召回文本；不会复用、注入或升级为当前 Schema 5 回执。'));
    if (record.injectionText) section.append(element('pre', 'v3-recall-injection', record.injectionText));
    else if (record.status === 'empty') section.append(element('p', 'settings-hint', '本轮没有需要注入的记忆。'));
    else if (skipReasons.includes('sourceStale')) section.append(element('p', 'settings-hint', '记忆来源正在更新，本轮已安全跳过召回注入。'));
    else if (skipReasons.includes('sourceUnavailable')) section.append(element('p', 'settings-hint', '记忆来源暂不可用，本轮已安全跳过召回注入。'));
    else if (skipReasons.includes('memoryRebuilding')) section.append(element('p', 'settings-hint', '历史记忆正在后台重建；本轮没有注入不完整的千千结记忆，酒馆主生成仍会正常继续。'));
    else if (skipReasons.includes('memoryNotReady')) section.append(element('p', 'settings-hint', skipReasons.includes('memoryRebuildFailed') ? '历史重建已停在失败位置；请在地基页点击“继续重建”。本轮没有注入不完整的千千结记忆。' : skipReasons.includes('historicalRebuildRequired') ? '当前存在历史记忆缺口；请在地基页手动开始或继续重建。本轮没有注入不完整的千千结记忆。' : '当前可达记忆覆盖尚未确认；本轮没有注入不完整的千千结记忆。'));
    else section.append(element('p', 'settings-hint', '本轮没有向生成上下文注入召回内容。'));
    return section;
  }

  function render(state = runtime.getState()) {
    if (!container) return;
    foundationState = state;
    recallState = recallRuntime?.getState?.() ?? recallState;
    const page = element('section', 'v3-foundation');
    const heading = element('div', 'v3-foundation-heading'); heading.append(element('h2', '', '千结 · V3 地基、记忆与状态'), element('p', '', '正文始终是最高事实源；FloorMemory 保存证据，CSE 只派生人物当前状态。本页不会挤占酒馆正文区。'));
    const rebuildCopy = ({ rebuilding: '正在重建', paused: '已暂停，可继续', waitingRealtime: '历史已追平，等待新楼', failed: '失败，可继续重建', caughtUp: '历史记忆已完整', pendingRebuild: '记忆未完整，等待手动开始', notReady: '覆盖暂未确认' })[state.rebuildStatus] ?? '尚未判断';
    const details = element('dl', 'v3-foundation-grid'); details.append(row('宿主兼容', state.compatibilityMode === 'enhanced' ? '增强模式' : '标准模式'), row('当前 chat', state.chatId), row('地基状态', statusCopy(effectiveStatus(state))), row('自动维护新楼', state.autoMemoryEnabled ? `已开启 · 每 ${state.autoMemoryBatchSize ?? 2} 楼` : '已关闭'), row('历史重建状态', `${rebuildCopy} · ${state.rebuildCompletedCount ?? 0}/${state.rebuildTotalCount ?? state.stableCount ?? 0}${state.rebuildNextAssistantSeq ? ` · 最早缺口 AI #${state.rebuildNextAssistantSeq}` : ''}`), row('稳定 AI 楼', state.stableCount), row('已记忆', state.rememberedCount ?? 0), row('未处理', state.unprocessedCount ?? state.stableCount), row('待确认', state.pending ? `AI #${state.pending.assistantSeq}（宿主楼 ${state.pending.messageIndex}）` : '无'), row('记忆失败 / 待复核', `${state.failedCount ?? 0} / ${state.reviewCount ?? 0}`), row('CSE 待分析 / 失败', `${state.csePendingCount ?? 0} / ${state.cseFailedCount ?? 0}`), row('Head checkpoint', state.headCheckpointId), row('当前运行', state.activeAutoMemory ? `${state.activeAutoMemory.phase} · ${state.activeAutoMemory.mode === 'historical' ? '历史重建' : '新楼维护'}` : state.activeCse ? `${state.activeCse.phase} · ${state.activeCse.floorId}` : state.activeExtraction ? `${state.activeExtraction.phase} · ${state.activeExtraction.floorId}` : (state.activeRun ? `${state.activeRun.phase} · ${state.activeRun.reason}` : '无')), row('最近记忆任务', state.lastAutoMemory?.status === 'completed' ? `已完成 AI #${state.lastAutoMemory.fromAssistantSeq}–${state.lastAutoMemory.toAssistantSeq}` : state.lastAutoMemory?.status === 'failed' ? state.lastAutoMemory.message : state.lastAutoMemory?.status === 'paused' ? '历史重建已暂停' : state.lastAutoMemory?.status === 'authorizationRequired' ? '历史欠账等待手动授权' : state.lastAutoMemory?.status === 'waiting' ? `等待凑齐 ${state.lastAutoMemory.batchSize} 个新楼` : state.lastAutoMemory?.status === 'caughtUp' ? '历史已追平' : '无'), row('最近记忆错误', state.lastExtractorError?.message || state.lastError || '无'), row('最近 CSE 错误', state.lastCseError?.message || '无'));
    const metrics = element('p', 'v3-foundation-metrics', state.metrics?.assistantFloors === undefined ? '尚无本轮扫描数据。' : `${state.metrics.assistantFloors} 个 AI 楼 · ${state.metrics.canonicalCharacters} 字符 · ${Number(state.metrics.scanMs || 0).toFixed(1)} ms · ${state.metrics.algorithm}`);
    const actions = element('div', 'v3-foundation-actions');
    const workBusy = Boolean(state.memoryWorkBusy || state.activeAutoMemory || state.activeExtraction || state.activeCse);
    const refresh = element('button', 'secondary-action', '刷新地基状态'); refresh.type = 'button'; refresh.disabled = workBusy; refresh.addEventListener('click', () => { void run('刷新', () => runtime.refreshStatus()); });
    const confirm = element('button', 'secondary-action', '确认最新 AI 楼'); confirm.type = 'button'; confirm.disabled = !state.pending || state.pluginEnabled === false || workBusy; confirm.addEventListener('click', () => { void run('确认', () => runtime.confirmLatest()); });
    const next = element('button', 'primary-action', '提取下一楼'); next.type = 'button'; next.disabled = typeof runtime.extractNext !== 'function' || !state.unprocessedCount || workBusy; if (typeof runtime.extractNext === 'function') next.addEventListener('click', () => { void run('提取下一楼', () => runtime.extractNext()); });
    const nextState = element('button', 'primary-action', '分析下一楼状态'); nextState.type = 'button'; nextState.disabled = typeof runtime.analyzeNextState !== 'function' || !state.csePendingCount || workBusy; if (typeof runtime.analyzeNextState === 'function') nextState.addEventListener('click', () => { void run('分析下一楼状态', () => runtime.analyzeNextState()); }); actions.append(refresh, confirm, next, nextState);
    if (state.rebuildStatus === 'rebuilding' && typeof runtime.pauseHistoricalRebuild === 'function') { const pause = element('button', 'secondary-action', '暂停重建'); pause.type = 'button'; pause.disabled = !state.activeAutoMemory; pause.addEventListener('click', () => { void run('暂停重建', () => runtime.pauseHistoricalRebuild()); }); actions.append(pause); }
    else if (typeof (runtime.startHistoricalRebuild ?? runtime.retryAutomation) === 'function') { const begin = runtime.startHistoricalRebuild ?? runtime.retryAutomation; const startLabel = state.rebuildCompletedCount > 0 || state.rememberedCount > 0 || ['paused', 'failed'].includes(state.rebuildStatus) ? '继续重建' : '开始重建现有聊天'; const rebuild = element('button', 'primary-action', startLabel); rebuild.type = 'button'; rebuild.disabled = workBusy || !['pendingRebuild', 'paused', 'failed'].includes(state.rebuildStatus); rebuild.addEventListener('click', () => { void run(startLabel, () => begin.call(runtime)); }); actions.append(rebuild); }
    const result = element('p', `v3-foundation-feedback${state.lastError || state.lastExtractorError || state.lastCseError ? ' error' : ''}`, feedback || (state.lastCseError?.message || state.lastExtractorError?.message || state.lastError || '状态已显示。'));
    page.append(heading);
    if (['pendingRebuild', 'paused', 'failed'].includes(state.rebuildStatus)) page.append(element('p', 'settings-hint', '记忆未完整，本轮不会注入千千结记忆。只有点击下方按钮才会开始或继续调用 Extractor / CSE；刷新页面不会自动续跑。'));
    page.append(renderRecallPreview(), renderCseState(state), details, metrics, actions, result);
    const list = element('div', 'v3-memory-list'); for (const floor of state.floors ?? []) list.append(renderFloor(floor, state, () => render(runtime.getState()))); page.append(list);
    if (fallbackText) { const fallback = element('textarea', 'v3-diagnostic-fallback'); fallback.value = fallbackText; fallback.textContent = fallbackText; fallback.readOnly = true; page.append(element('p', 'settings-hint', '诊断文本（长按全选复制）'), fallback); }
    container.replaceChildren(page);
  }
  function subscribe() {
    if (!active || !container || unsubscribe) return;
    const releases = [];
    if (typeof runtime.subscribe === 'function') {
      const release = runtime.subscribe(snapshot => {
        foundationState = snapshot;
        if (snapshot?.status === 'ready' && feedback === statusCopy('stale')) feedback = '地基与记忆状态已刷新。';
        if (active && container) render(snapshot);
      });
      if (typeof release === 'function') releases.push(release);
    }
    if (typeof recallRuntime?.subscribe === 'function') {
      const release = recallRuntime.subscribe(snapshot => { recallState = snapshot; if (active && container) render(foundationState); });
      if (typeof release === 'function') releases.push(release);
    }
    unsubscribe = () => { for (const release of releases) { try { release(); } catch { /* listener cleanup isolation */ } } };
  }
  function stopSubscription() { const release = unsubscribe; unsubscribe = null; try { release?.(); } catch { /* runtime listener cleanup is isolated from view lifecycle */ } }
  function mount(target) { stopSubscription(); container = target; active = true; feedback = '诊断壳已显示，正在等待读取。'; foundationState = runtime.getState(); recallState = recallRuntime?.getState?.() ?? null; render(foundationState); subscribe(); }
  async function activate() {
    if (!container) throw new Error('V3 foundation view 尚未挂载');
    active = true; subscribe();
    const mine = ++epoch;
    feedback = '正在读取并对账 V3 地基…'; receiptFeedback = '';
    render(runtime.getState());
    const [foundationOutcome, receiptOutcome] = await Promise.allSettled([
      runtime.refreshStatus(),
      recallRuntime?.restorePersistedReceipt?.(),
    ]);
    if (!active || mine !== epoch) return { status: 'stale' };
    if (receiptOutcome.status === 'rejected') receiptFeedback = `历史召回回执恢复失败：${receiptOutcome.reason?.message || '未知错误'}；不影响地基读取。`;
    if (foundationOutcome.status === 'rejected') {
      feedback = `地基读取失败：${foundationOutcome.reason?.message || '未知错误'}；历史召回回执已独立处理。`;
      const result = runtime.getState(); render(result);
      return { status: 'error', error: foundationOutcome.reason };
    }
    const result = foundationOutcome.value;
    feedback = result?.status === 'ready' ? '地基与记忆状态已刷新。' : statusCopy(result?.status);
    render(result);
    return result;
  }
  function deactivate() { active = false; epoch += 1; stopSubscription(); }
  return Object.freeze({ mount, activate, deactivate, render });
}
