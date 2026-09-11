import { createInlineSelect } from './inline-select.js';
import { createOperationMenuController } from './operation-menu-controller.js';

function text(value, fallback = '—') { return value === null || value === undefined || value === '' ? fallback : String(value); }

function statusCopy(value) {
  return ({
    uninitialized: '等待下一条用户消息', ready: '可用', running: '正在处理', empty: '完成 · 无需注入',
    skipped: '本轮已跳过', idle: '尚无生成记录', conflict: '并发冲突，未覆盖新数据', error: '处理失败，可重试',
    disabled: '插件已关闭', stale: '正在等待最新结果', needsReview: '需要核对当前聊天记忆', unprocessed: '未处理',
    failed: '失败可重试', partial: '部分完成，可继续补齐', pending: '待分析', noChange: '无实质变化', notApplicable: '尚无摘要',
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
const selectorModeCopy = value => ({ llm: 'LLM 明确排除', fallback: '默认保留兜底', local: '本地直接处理' })[value] ?? '未记录';
const cseActionCopy = value => ({ add: '新增', remove: '移除', update: '更新', refine: '调整' })[value] ?? text(value);
const waitingFloorCopy = value => ({
  waitingNextUser: '等待下一条用户消息',
  waitingEarlierFloor: '等待前面楼层处理',
  consecutiveAssistant: '连续 AI，尚待确认',
  registrationNeedsReview: '消息对应关系待核对',
})[value] ?? '尚待确认';
const waitingFloorExplanation = value => ({
  waitingNextUser: '这一楼尚未摘要。发送下一条用户消息后会重新检查。',
  waitingEarlierFloor: '这一楼尚未摘要。前面的 AI 楼尚未确认，当前不会进入摘要处理。',
  consecutiveAssistant: '这一楼尚未摘要。检测到连续 AI 消息，现有规则尚不能确认这楼。',
  registrationNeedsReview: '这一楼尚未摘要。消息与已有记忆的对应关系需要先核对。',
})[value] ?? '这一楼尚未摘要，正在等待确认。';
const reviewReasonCopy = value => {
  if (!value?.code) return '无';
  const label = ({
    indexNeedsReseal: '索引需要整理', stableCountMismatch: '稳定楼数量不符', candidateCountMismatch: '当前聊天楼数量不符',
    locatorMismatch: '楼位置已变化', markerMismatch: '消息记忆标识不一致', fingerprintMismatch: '楼正文指纹不一致', missingRoot: '记忆根记录缺失',
  })[value.code] ?? '记忆图与当前聊天不一致';
  const floor = validMessageIndex(value.messageIndex) ? ` · 实际第 ${value.messageIndex} 楼` : '';
  const counts = Number.isSafeInteger(value.expectedCount) && Number.isSafeInteger(value.actualCount) ? ` · 记录 ${value.expectedCount} / 当前 ${value.actualCount}` : '';
  const marker = Object.hasOwn(value, 'markerStatus')
    ? ` · 消息标识：${({ none: '无', valid: '有效', foreign: '来自其他聊天', invalid: '无效' })[value.markerStatus] ?? '未知'}`
    : '';
  const fingerprintLabels = [
    ['rawFingerprintMatches', 'raw'],
    ['canonicalFingerprintMatches', 'canonical'],
    ['sanitizerFingerprintMatches', 'sanitizer'],
  ];
  const mismatches = fingerprintLabels.filter(([key]) => value[key] === false).map(([, copy]) => copy);
  const fingerprints = mismatches.length ? ` · 不一致：${mismatches.join('、')}` : '';
  return `${label}${floor}${counts}${marker}${fingerprints}`;
};
const selectorFailureCopy = value => ({
  QQJ_TIMEOUT: 'API 请求超时', QQJ_RATE_LIMIT: 'API 请求过于频繁', QQJ_SERVER: 'API 服务暂时异常', QQJ_NETWORK: '无法连接 API',
  QQJ_AUTH: 'API 认证失败', QQJ_CONFIG: 'API 配置不完整', QQJ_PRESET_INVALID: '所选 API 预设已失效',
  QQJ_COMPLETION_JSON: '模型输出格式无效', QQJ_OUTPUT_TRUNCATED: '模型输出疑似截断',
  V3_RECALL_LLM_SCHEMA_INVALID: '选材结果结构无效', V3_RECALL_LLM_KEYS_INVALID: '选材结果没有合法候选项', V3_RECALL_LLM_UNAVAILABLE: '智能选材路由不可用',
})[value] ?? text(value, '无');
const skipReasonCopy = value => ({
  coreBodyDuplicate: '已排除当前正文覆盖的摘要', noReliableMemoryMatch: '未找到可靠的远期匹配', persistentStateDuplicate: '已去除重复材料',
  dynamicStateCoverageIncomplete: '当前人物状态覆盖不完整，本轮只参考可信历史变化', cseReplayUnavailable: '人物状态重放不可用',
  memoryNotReady: '当前记忆仍有缺口', coverageUnconfirmed: '记忆与正文对应关系尚未确认', memoryRebuildFailed: '上次记忆补齐未完成',
  historicalRebuildRequired: '仍有历史摘要缺口', memoryPreparationTimeout: '记忆准备超时，本轮正文已继续', memoryPreparationFailed: '记忆准备失败，本轮正文已继续',
})[value] ?? text(value);
const workBusy = state => Boolean(state.memoryWorkBusy || state.activeAutoMemory || state.activeExtraction || state.activeCse);
const memoryBusy = state => Boolean(state.activeExtraction || ['revising', 'extracting', 'reconciling', 'committing'].includes(state.activeMemoryWork?.phase) || state.activeAutoMemory?.phase === 'extracting');
const cseBusy = state => Boolean(state.activeCse || state.activeMemoryWork?.phase === 'analyzingCse' || state.activeAutoMemory?.phase === 'analyzingCse');
const workPhaseCopy = state => ({ reconciling: '正在同步楼层', extracting: '正在提取摘要', analyzingCse: '正在分析人物状态', revisingCse: '正在保存人物状态', committing: '正在保存结果', resetting: '正在重建地基', revising: '正在保存修订' })[state.activeMemoryWork?.phase ?? state.activeAutoMemory?.phase ?? state.activeExtraction?.phase ?? state.activeCse?.phase] ?? '正在处理';
const DIAGNOSTIC_STATUS = new Set(['idle', 'preparing', 'ready', 'error', 'disabled', 'suspended', 'running', 'uninitialized', 'stale', 'needsReview', 'conflict', 'empty', 'skipped', 'failed', 'partial', 'pending', 'noChange', 'notApplicable', 'unavailable', 'syncing', 'caughtUp', 'waitingRealtime', 'pendingRebuild', 'rebuilding', 'paused', 'completed', 'deleting', 'historicalDebt', 'realtimeTail', 'notReady', 'unknown']);
const DIAGNOSTIC_PHASE = new Set(['capturing', 'completed', 'stale', 'retryableError', 'anchor', 'load', 'foundation', 'extracting', 'validating', 'committing', 'resetting', 'reconciling', 'analyzingCse', 'revisingCse', 'revising', 'baseline', 'analyzing', 'correcting', 'pending', 'input', 'source', 'selecting', 'receipt', 'starting', 'restoringVisibility', 'deletingRecords', 'deletingBinding', 'clearingHost', 'unknown']);
const DIAGNOSTIC_KIND = new Set(['manual', 'auto', 'unknown']);
const STANDARD_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'AggregateError', 'AbortError', 'DOMException', 'TimeoutError']);
const enumDiagnostic = (value, allowed) => allowed.has(value) ? value : 'unknown';
const booleanDiagnostic = value => typeof value === 'boolean' ? value : 'unknown';
const countDiagnostic = value => Number.isSafeInteger(value) && value >= 0 ? value : 'unknown';
const presenceDiagnostic = (source, key) => source && Object.hasOwn(source, key) ? Boolean(source[key]) : 'unknown';
const operationDiagnostic = (value, { kind = false } = {}) => value
  ? { present: true, ...(kind ? { kind: enumDiagnostic(value.kind, DIAGNOSTIC_KIND) } : {}), phase: enumDiagnostic(value.phase, DIAGNOSTIC_PHASE) }
  : { present: false, ...(kind ? { kind: null } : {}), phase: null };
function errorDiagnostic(value, sourceKnown = true) {
  if (!sourceKnown) return { present: 'unknown' };
  if (!value) return { present: false };
  const result = { present: true };
  if (value && typeof value === 'object') {
    if (STANDARD_ERROR_NAMES.has(value.name)) result.name = value.name;
    if (typeof value.code === 'string' && (/^(?:QQJ|V3|CHAT_SESSION)_[A-Z0-9_]{1,80}$/.test(value.code) || value.code === 'BACKEND_TIMEOUT')) result.code = value.code;
    const httpStatus = value.httpStatus ?? value.status;
    if (Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) result.httpStatus = httpStatus;
  }
  return result;
}
const diagnosticVersion = value => typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/.test(value) ? value : 'unknown';
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

export function createV3FoundationView({ runtime, recallRuntime = null, peopleRuntime = null, memoryManagement = null, sessionStateProvider = null, pluginVersion = 'unknown', uiDiagnosticProvider = null, documentRef = globalThis.document, navigatorRef = globalThis.navigator, confirmImpl = options => globalThis.confirm?.(typeof options === 'string' ? options : `${options?.title ?? '请确认'}\n\n${options?.body ?? ''}`) === true, infoImpl = () => Promise.resolve(true) } = {}) {
  if (!runtime || ['getState', 'refreshStatus', 'confirmLatest'].some(name => typeof runtime[name] !== 'function')) throw new TypeError('V3 foundation view runtime 无效');
  if (recallRuntime && typeof recallRuntime.getState !== 'function') throw new TypeError('V3 recall view runtime 无效');
  if (peopleRuntime && typeof peopleRuntime.getState !== 'function') throw new TypeError('V3 people workspace runtime 无效');
  if (memoryManagement && (typeof memoryManagement.getState !== 'function' || typeof memoryManagement.deleteCurrent !== 'function')) throw new TypeError('当前聊天记忆管理器无效');
  if (sessionStateProvider !== null && typeof sessionStateProvider !== 'function') throw new TypeError('聊天身份状态 provider 无效');
  if (uiDiagnosticProvider !== null && typeof uiDiagnosticProvider !== 'function') throw new TypeError('界面诊断 provider 无效');
  if (!documentRef?.createElement) throw new TypeError('V3 foundation view documentRef 无效');

  let container = null, active = false, epoch = 0, feedback = '', receiptFeedback = '', fallbackText = '', unsubscribe = null;
  let page = 'management';
  let peopleMode = 'current', selectedCsePersonId = null, showMoreCsePeople = false;
  let foundationState = runtime.getState(), recallState = recallRuntime?.getState?.() ?? null, peopleState = peopleRuntime?.getState?.() ?? null, managementState = memoryManagement?.getState?.() ?? null, chatId = foundationState?.chatId ?? null, healthNode = null;
  let syncingChatId = null;
  let relationSwitcherNode = null, relationSwitcherSignature = null, relationSwitcherChatId = chatId, relationSwitcherScrollLeft = 0;
  const drafts = new Map();
  const cseDrafts = new Map();
  const openState = new Map();
  const peopleScroll = new Map([['current', 0], ['history', 0]]);
  const operationMenus = createOperationMenuController(documentRef);

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
    chatId = nextChatId; drafts.clear(); cseDrafts.clear(); openState.clear(); peopleMode = 'current'; selectedCsePersonId = null; showMoreCsePeople = false; peopleScroll.set('current', 0); peopleScroll.set('history', 0); relationSwitcherNode = null; relationSwitcherSignature = null; relationSwitcherChatId = nextChatId; relationSwitcherScrollLeft = 0; fallbackText = ''; feedback = '';
    return true;
  };
  const sourceChanged = (previous, next) => (previous?.chatId ?? null) !== (next?.chatId ?? null);
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
    if (state.memorySnapshotStatus === 'syncing' && !(state.floors ?? []).length) return '正在读取当前聊天记忆';
    if (page === 'memories') {
      if (memoryBusy(state)) return `正在处理摘要 · ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼`;
      const error = errorCopy(state); if (error) return state.lastExtractorError?.phase === 'anchor'
        ? `消息标识保存待重试 · ${error}`
        : state.lastExtractorError?.floorId === null ? `记忆读取失败 · ${error}` : `摘要提取失败 · ${error}`;
      const waiting = state.unregisteredCandidates?.length ?? 0;
      return `已记忆 ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼 · 待摘要 ${state.unprocessedCount ?? 0} 楼${waiting ? ` · 另有 ${waiting} 楼尚未摘要，正在等待确认` : ''}${state.memorySyncStatus === 'syncing' ? ' · 后台同步中' : ''}`;
    }
    if (page === 'people') {
      if (cseBusy(state)) return `正在分析人物状态 · 待分析 ${state.csePendingCount ?? 0} 楼`;
      const error = errorCopy(state); if (error) return `人物状态需要处理 · ${error}`;
      const complete = Math.max(0, (state.rememberedCount ?? 0) - (state.csePendingCount ?? 0) - (state.cseFailedCount ?? 0));
      return `人物状态 ${complete}/${state.rememberedCount ?? 0} 楼 · 待分析 ${state.csePendingCount ?? 0} 楼${state.memorySyncStatus === 'syncing' ? ' · 后台同步中' : ''}`;
    }
    if (workBusy(state) || state.status === 'running') return `${workPhaseCopy(state)} · ${state.rebuildCompletedCount ?? state.rememberedCount ?? 0}/${state.rebuildTotalCount ?? state.stableCount ?? 0} 楼`;
    const error = errorCopy(state); if (error) return `需要处理 · ${error}`;
    return `已记忆 ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼 · 人物状态 ${state.cseReady ? '已跟上' : `待分析 ${state.csePendingCount ?? 0} 楼`}`;
  };
  const healthClass = state => {
    if (errorCopy(state)) return 'qqj-page-health error';
    const checking = state.pluginEnabled === false || state.memorySnapshotStatus === 'syncing'
      || workBusy(state) || state.status === 'running'
      || (page === 'memories' && (state.unregisteredCandidates?.length ?? 0) > 0)
      || !['ready', 'uninitialized'].includes(effectiveStatus(state));
    return `qqj-page-health ${checking ? 'checking' : 'healthy'}`;
  };
  const updateHealth = state => {
    if (!healthNode) return;
    healthNode.textContent = healthCopy(state);
    healthNode.className = healthClass(state);
  };
  const pageStatus = state => {
    const block = element('div', 'qqj-page-status');
    healthNode = element('p', healthClass(state), healthCopy(state));
    const copy = feedback || errorCopy(state) || '记忆状态已显示。';
    block.append(healthNode, element('p', `v3-foundation-feedback${copy.includes('失败') || (!feedback && errorCopy(state)) ? ' error' : ''}`, copy));
    return block;
  };
  const heading = (title, description, state) => {
    const block = element('header', 'qqj-view-heading');
    block.append(element('h2', '', title), element('p', '', description));
    healthNode = element('p', healthClass(state), healthCopy(state));
    block.append(healthNode); return block;
  };

  async function copy(value) {
    if (navigatorRef?.clipboard?.writeText) {
      try { await navigatorRef.clipboard.writeText(value); fallbackText = ''; return '已复制。'; }
      catch { /* 浏览器或壳层拒绝剪贴板权限时改用只读文本框。 */ }
    }
    fallbackText = value; return '浏览器不允许直接复制，请在下方文本框长按全选复制。';
  }
  const readDiagnosticState = provider => { try { return provider?.() ?? null; } catch { return null; } };
  const stateDiagnostic = () => {
    const memory = readDiagnosticState(() => runtime.getState());
    const identity = readDiagnosticState(sessionStateProvider);
    const recall = readDiagnosticState(() => recallRuntime?.getState?.());
    const management = readDiagnosticState(() => memoryManagement?.getState?.());
    const memoryKnown = memory !== null, identityKnown = identity !== null, recallKnown = recall !== null, managementKnown = management !== null;
    const deleting = management?.status === 'deleting', deletePending = management?.status === 'failed';
    return {
      formatVersion: 1,
      pluginVersion: diagnosticVersion(pluginVersion),
      capturedAt: new Date().toISOString(),
      identity: {
        status: identityKnown ? enumDiagnostic(identity.status, DIAGNOSTIC_STATUS) : 'unknown',
        identityPresent: identityKnown ? Boolean(identity.identity) : 'unknown',
        error: errorDiagnostic(identity?.error, identityKnown),
      },
      foundation: {
        status: enumDiagnostic(memory?.status, DIAGNOSTIC_STATUS),
        foundationStatus: enumDiagnostic(memory?.foundationStatus, DIAGNOSTIC_STATUS),
        pluginEnabled: booleanDiagnostic(memory?.pluginEnabled),
        chatIdPresent: presenceDiagnostic(memory, 'chatId'),
        headCheckpointPresent: presenceDiagnostic(memory, 'headCheckpointId'),
        activeRun: memoryKnown ? operationDiagnostic(memory.activeRun) : { present: 'unknown', phase: 'unknown' },
        lastError: errorDiagnostic(memory?.lastError, memoryKnown),
      },
      memory: {
        snapshotStatus: enumDiagnostic(memory?.memorySnapshotStatus, DIAGNOSTIC_STATUS),
        syncStatus: enumDiagnostic(memory?.memorySyncStatus, DIAGNOSTIC_STATUS),
        rebuildStatus: enumDiagnostic(memory?.rebuildStatus, DIAGNOSTIC_STATUS),
        rememberedCount: countDiagnostic(memory?.rememberedCount),
        stableCount: countDiagnostic(memory?.stableCount),
        memoryWorkBusy: booleanDiagnostic(memory?.memoryWorkBusy),
        activeMemoryWork: memoryKnown ? operationDiagnostic(memory.activeMemoryWork, { kind: true }) : { present: 'unknown', kind: 'unknown', phase: 'unknown' },
        activeExtraction: memoryKnown ? operationDiagnostic(memory.activeExtraction) : { present: 'unknown', phase: 'unknown' },
        activeAutoMemory: memoryKnown ? operationDiagnostic(memory.activeAutoMemory) : { present: 'unknown', phase: 'unknown' },
        syncError: errorDiagnostic(memory?.memorySyncError, memoryKnown),
        lastExtractorError: errorDiagnostic(memory?.lastExtractorError, memoryKnown),
      },
      cse: {
        active: memoryKnown ? operationDiagnostic(memory.activeCse) : { present: 'unknown', phase: 'unknown' },
        rebuildStatus: enumDiagnostic(memory?.cseRebuildStatus, DIAGNOSTIC_STATUS),
        lastError: errorDiagnostic(memory?.lastCseError, memoryKnown),
      },
      recall: {
        status: recallKnown ? enumDiagnostic(recall.recallStatus, DIAGNOSTIC_STATUS) : 'unknown',
        active: recallKnown ? operationDiagnostic(recall.activeRecall) : { present: 'unknown', phase: 'unknown' },
        lastError: errorDiagnostic(recall?.lastRecallError, recallKnown),
      },
      management: {
        status: managementKnown ? enumDiagnostic(management.status, DIAGNOSTIC_STATUS) : 'unknown',
        phase: managementKnown && management.phase !== null ? enumDiagnostic(management.phase, DIAGNOSTIC_PHASE) : managementKnown ? null : 'unknown',
        workBusy: managementKnown ? booleanDiagnostic(management.workBusy) : 'unknown',
        blockedByOtherChat: managementKnown ? booleanDiagnostic(management.blockedByOtherChat) : 'unknown',
        error: errorDiagnostic(management?.error, managementKnown),
      },
      ui: {
        syncingOverlayActive: Boolean(syncingChatId && syncingChatId === foundationState?.chatId),
        workBusy: memoryKnown ? workBusy(memory) : 'unknown',
        deleting,
        deletePending,
      },
    };
  };
  const copyStateDiagnostic = async () => {
    const value = JSON.stringify(stateDiagnostic(), null, 2);
    feedback = await copy(value);
    if (active && container) render(runtime.getState());
  };
  async function run(label, task, { after, failed, resultCopy } = {}) {
    const mine = ++epoch; feedback = `${label}…`; updateHealth(foundationState);
    const beforeState = runtime.getState?.() ?? foundationState;
    try {
      const next = await task();
      const nextState = runtime.getState?.() ?? next;
      const settledRender = after?.(nextState) === true;
      if (!active) return next;
      if (mine !== epoch) { if (settledRender) { feedback = `${label}完成。`; render(nextState); } return next; }
      if (!feedback || feedback.endsWith('…')) feedback = resultCopy?.(nextState, beforeState) || (nextState?.status === 'ready' ? `${label}完成。` : `${label}结束：${statusCopy(nextState?.status)}`);
      render(nextState); return next;
    } catch (error) {
      const settledRender = failed?.(error) === true;
      if (!active) return { status: 'stale' };
      if (mine !== epoch && !settledRender) return { status: 'stale' };
      feedback = `${label}失败：${error?.message || '未知错误'}`; render(runtime.getState());
      return { status: 'error', error };
    }
  }
  const floorActionResult = (label, floorId, kind = 'extract') => (state, beforeState) => {
    const floor = state?.floors?.find(item => item.floorId === floorId);
    const beforeFloor = beforeState?.floors?.find(item => item.floorId === floorId);
    const targetFloor = floorCopy(state, floor ?? { floorId }, '目标楼');
    if (kind === 'cse') {
      const changed = Boolean(floor?.cse?.deltaId && floor.cse.deltaId !== beforeFloor?.cse?.deltaId);
      if (!changed || !['ready', 'noChange'].includes(floor?.cse?.status)) return `${label}未完成：${targetFloor} · ${state?.lastCseError?.message || floor?.cse?.error || '人物状态尚未保存。'}`;
      return `${label}完成：${targetFloor}人物状态已保存。`;
    }
    const changed = Boolean(floor?.memoryId && floor.memoryId !== beforeFloor?.memoryId);
    if (!changed || floor.status !== 'ready') return `${label}未完成：${targetFloor} · ${state?.lastExtractorError?.message || floor?.error || '没有保存新的摘要。'}`;
    if (['ready', 'noChange'].includes(floor.cse?.status)) return `${label}完成：${targetFloor}摘要和人物状态均已保存。`;
    return `${label}部分完成：${targetFloor}摘要已保存；人物状态${floor.cse?.status === 'failed' ? '分析失败，可单独重试' : '仍待分析'}。`;
  };
  const automaticResult = label => state => {
    const result = state?.lastAutoMemory;
    const targetFloor = floorCopy(state, { messageIndex: result?.messageIndex, floorId: result?.floorId, assistantSeq: result?.assistantSeq }, '目标楼');
    if (result?.status === 'partial') return result.phase === 'analyzingCse'
      ? `${label}部分完成：新增摘要 ${result.processed ?? 0} 楼，补齐人物状态 ${result.cseProcessed ?? 0} 楼；${targetFloor}人物状态未完成。`
      : `${label}部分完成：新增摘要 ${result.processed ?? 0} 楼，补齐人物状态 ${result.cseProcessed ?? 0} 楼；${result.failedItems?.map(item => item.floorLabel).filter(Boolean).join('、') || `${result.available ?? 0} 楼`}摘要仍需重试。`;
    if (result?.status === 'failed') {
      const failedFloors = result.failedItems?.map(item => item.floorLabel).filter(Boolean).join('、');
      return `${label}未完成：${failedFloors || (result.floorId ? targetFloor : '')}${failedFloors || result.floorId ? ' · ' : ''}${result.message || '本次没有保存新结果，请重试。'}`;
    }
    if (result?.status === 'paused') return `${label}已暂停：已保存的结果不会丢失。`;
    if (['completed', 'caughtUp'].includes(result?.status)) return `${label}完成：新增摘要 ${result.processed ?? 0} 楼，补齐人物状态 ${result.cseProcessed ?? 0} 楼。`;
    return `${label}结束：${statusCopy(state?.rebuildStatus ?? state?.status)}`;
  };
  const cseRebuildResult = label => state => {
    const status = state?.cseRebuildStatus;
    if (status === 'completed') return `${label}完成：人物状态 ${state.cseRebuildCompletedCount ?? 0}/${state.cseRebuildTotalCount ?? 0} 楼。`;
    if (status === 'paused') return `${label}已暂停：已完成 ${state.cseRebuildCompletedCount ?? 0}/${state.cseRebuildTotalCount ?? 0} 楼，可继续。`;
    if (status === 'failed') return `${label}未完成：${floorCopy(state, { assistantSeq: state.cseRebuildNextAssistantSeq }, '目标楼')} · ${state.cseRebuildError || state.lastCseError?.message || '可继续重试。'}`;
    return `${label}结束：CSE ${statusCopy(status)}`;
  };
  function validateDrafts(state) {
    let valid = true;
    const floors = new Map((state.floors ?? []).map(floor => [floor.floorId, floor]));
    for (const [key, draft] of drafts) {
      const floor = floors.get(draft.floorId);
      if (!floor) { drafts.delete(key); valid = false; }
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
    const memory = floor.memory;
    const times = timeDisplay(memory?.chronology) || floor.timeFallback || '时间未明确';
    const timeNode = element('span', 'qqj-floor-time', times); timeNode.setAttribute('title', times);
    const floorStatus = floor.summarySource === 'user' && floor.status === 'ready' ? '人工修订' : statusCopy(floor.status);
    const statusNode = element('span', `v3-memory-status${floor.summarySource === 'user' && floor.status === 'ready' ? ' is-user' : ''}`, floorStatus);
    const chevron = element('span', 'qqj-memory-chevron', '›'); chevron.setAttribute('aria-hidden', 'true');
    head.append(element('strong', 'qqj-floor-number', floorCopy(state, floor)), timeNode, statusNode, chevron);
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
          return drafts.get(key) === draft && draft.saveIdentity === saveIdentity && latest?.chatId === state.chatId && latestFloor?.floorId === draft.floorId;
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
      if (memory) {
        const locations = (memory.locations ?? []).map(item => item.name).filter(Boolean).join('、') || '未提取';
        const names = new Map((state.memoryEntities ?? []).map(entity => [entity.entityId, entity.displayName]));
        for (const [entityId, displayName] of Object.entries(floor.memoryEntityNames ?? {})) names.set(entityId, displayName);
        const people = (memory.participants ?? []).map(item => names.get(item.entityId) ?? '未知人物').join('、') || '未提取';
        body.append(element('p', 'qqj-memory-main', floor.summary || '暂无摘要。'));
        const meta = element('div', 'qqj-memory-meta');
        const metaItem = (label, value) => { const item = element('span', 'qqj-memory-meta-item'); item.append(element('strong', '', label), element('span', '', value)); return item; };
        meta.append(metaItem('人物', people), metaItem('地点', locations)); body.append(meta);
      } else body.append(element('p', 'qqj-memory-main is-empty', floor.summary || (floor.status === 'unprocessed' ? '这一楼尚未生成摘要。' : '暂无摘要。')));
      const actions = operationMenus.register(element('details', 'qqj-memory-menu'));
      const menuToggle = element('summary', 'qqj-memory-menu-toggle', '⋮');
      menuToggle.setAttribute('aria-label', `${floorCopy(state, floor)}操作`); menuToggle.setAttribute('title', '本楼操作');
      const menuBody = element('div', 'qqj-memory-menu-pop');
      if (floor.memoryId) {
        const edit = element('button', 'qqj-memory-menu-action', '编辑'); edit.type = 'button'; edit.disabled = workBusy(state);
        edit.addEventListener('click', () => { const memory = floor.memory; const names = new Map((state.memoryEntities ?? []).map(entity => [entity.entityId, entity.displayName])); const originalTimeText = timeDisplay(memory?.chronology) || floor.timeFallback || ''; const locations = (memory?.locations ?? []).map(item => ({ itemId: item.itemId, name: item.name ?? '' })); const participantNames = (memory?.participants ?? []).map(item => names.get(item.entityId)).filter(Boolean); drafts.set(key, { floorId: floor.floorId, canonicalFingerprint: floor.canonicalFingerprint, rawFingerprint: floor.rawFingerprint, summary: floor.summary, originalSummary: floor.summary, timeText: originalTimeText, originalTimeText, locations, originalLocations: locations.map(item => ({ ...item })), peopleText: participantNames.join('、'), originalParticipantNames: participantNames, note: '', saving: false, saveError: '' }); render(foundationState); });
        const extract = element('button', 'qqj-memory-menu-action', '重新提取'); extract.type = 'button'; extract.disabled = workBusy(state) || typeof runtime.extractFloor !== 'function';
        extract.addEventListener('click', async () => { if (!await Promise.resolve(confirmImpl({ title: '重新提取本楼摘要', body: '重新提取会替换本楼摘要，并重新衔接本楼及后续人物状态，也可能覆盖之后的人工纠正。', confirmText: '重新提取', cancelText: '取消' }))) { feedback = '已取消重新提取。'; render(foundationState); return; } void run('重新提取', () => runtime.extractFloor(floor.floorId), { resultCopy: floorActionResult('重新提取', floor.floorId) }); });
        menuBody.append(edit, extract);
      } else {
        const extract = element('button', 'qqj-memory-menu-action', '提取摘要'); extract.type = 'button'; extract.disabled = workBusy(state) || typeof runtime.extractFloor !== 'function';
        extract.addEventListener('click', () => { void run('提取摘要', () => runtime.extractFloor(floor.floorId), { resultCopy: floorActionResult('提取摘要', floor.floorId) }); });
        menuBody.append(extract);
      }
      actions.append(menuToggle, menuBody); body.append(actions);
    }
    if (floor.error) body.append(element('p', 'v3-foundation-feedback error', floor.error));
    card.append(body);
    return card;
  }
  function renderWaitingMemoryFloor(candidate, state) {
    const key = `${state.chatId ?? 'no-chat'}:waiting:${candidate.messageIndex}`;
    const card = setDetailsState(element('details', 'qqj-memory-card status-pending'), `memory:${key}`, false);
    const head = element('summary', 'qqj-memory-card-head');
    const statusNode = element('span', 'v3-memory-status', waitingFloorCopy(candidate.reason));
    const chevron = element('span', 'qqj-memory-chevron', '›'); chevron.setAttribute('aria-hidden', 'true');
    head.append(element('strong', 'qqj-floor-number', floorCopy(state, candidate)), element('span', 'qqj-floor-time', '未提取'), statusNode, chevron);
    const body = element('div', 'qqj-memory-card-body');
    body.append(element('p', 'qqj-memory-main is-empty', waitingFloorExplanation(candidate.reason)));
    card.append(head, body);
    return card;
  }
  function renderMemories(state) {
    const pageNode = element('section', 'qqj-page qqj-memories-page');
    pageNode.append(pageStatus(state));
    const list = element('div', 'v3-memory-list');
    const floors = [...(state.floors ?? [])];
    const registeredMessageIndexes = new Set(floors.map(floor => floor.messageIndex).filter(validMessageIndex));
    const waiting = (state.unregisteredCandidates ?? []).filter(candidate => validMessageIndex(candidate?.messageIndex) && !registeredMessageIndexes.has(candidate.messageIndex));
    const rows = [
      ...floors.map(value => ({ kind: 'registered', value })),
      ...waiting.map(value => ({ kind: 'waiting', value })),
    ].sort((left, right) => (right.value.messageIndex ?? right.value.assistantSeq ?? 0) - (left.value.messageIndex ?? left.value.assistantSeq ?? 0));
    for (const row of rows) list.append(row.kind === 'registered' ? renderMemoryFloor(row.value, state) : renderWaitingMemoryFloor(row.value, state));
    if (!rows.length) list.append(element('div', 'qqj-inline-empty', '这里还没有已保存摘要。最新 AI 楼将在下一条用户消息发出后开始摘要。'));
    pageNode.append(list); return pageNode;
  }

  const appendSubjectGroups = (card, subject, state, { core = subject.core ?? [], adaptive = subject.adaptive ?? [], situational = subject.situational ?? [], empty = true, showMeta = true, groupAdaptiveByTarget = true } = {}) => {
    const item = value => { const node = element('li', 'v3-cse-item'); node.append(element('span', 'v3-cse-item-text', value.text)); if (showMeta) { const source = value.sourceFloorId || value.sourceAssistantSeq ? sourceFloorCopy(state, value) : value.origin === 'baseline' ? '来源：聊天基线' : '来源：本地重放'; node.append(element('small', 'v3-cse-item-meta', [...new Set([value.reason, originCopy(value.origin), source, visibilityCopy(value.visibility)])].join(' · '))); } return node; };
    const addGroup = (label, values, groupByTarget = false) => {
      const block = element('div', 'v3-cse-group'); block.append(element('h5', '', label));
      if (!values.length) { if (empty) { block.append(element('p', 'settings-hint', '暂无')); card.append(block); } return; }
      if (groupByTarget) {
        const grouped = new Map(); for (const value of values) { const key = value.towardDisplayName || '未指定对象'; grouped.set(key, [...(grouped.get(key) ?? []), value]); }
        for (const [target, targetItems] of grouped) { block.append(element('h6', '', `对 ${target}`)); const ul = element('ul', 'v3-cse-items'); targetItems.forEach(value => ul.append(item(value))); block.append(ul); }
      } else { const ul = element('ul', 'v3-cse-items'); values.forEach(value => ul.append(item(value))); block.append(ul); }
      card.append(block);
    };
    addGroup('核心特质', core); addGroup('长期倾向', adaptive, groupAdaptiveByTarget); addGroup('当前情境', situational);
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
    editor.append(category('core', '核心特质'), category('adaptive', '长期倾向', { toward: true }), category('situational', '当前情境', { toward: true }));
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
  function renderSubject(subject, state, { person = null, defaultOpen = false, ownOnly = false, title = null, relationNote = false, actionsContainer = null } = {}) {
    const entityId = subject?.subjectEntityId ?? person?.entityId;
    const displayName = person?.displayName || subject?.displayName || '未知人物';
    const key = `${state.chatId ?? 'no-chat'}:${entityId}`;
    const card = relationNote ? element('section', 'qqj-relation-note') : setDetailsState(element('details', 'v3-cse-subject'), `subject:${entityId}`, defaultOpen);
    if (relationNote) card.setAttribute('aria-label', `${displayName}自身状态`);
    else { const summary = element('summary', 'qqj-person-summary'); summary.append(element('strong', '', title ?? displayName), element('span', 'v3-memory-status', subject ? '人物状态' : '暂无状态')); card.append(summary); }
    const body = element('div', relationNote ? 'qqj-relation-note-body' : 'qqj-person-body');
    const actions = actionsContainer ?? body;
    const draft = cseDrafts.get(key);
    if (subject && draft) renderCseEditor(body, draft, state, key);
    else if (subject) appendSubjectGroups(body, subject, state, ownOnly ? { adaptive: (subject.adaptive ?? []).filter(item => !item.towardEntityId), situational: (subject.situational ?? []).filter(item => !item.towardEntityId), showMeta: false, groupAdaptiveByTarget: false, empty: !relationNote } : {});
    else body.append(element('p', 'settings-hint', '这个重要人物还没有已保存的状态分析；后台摘要与 CSE 会继续正常处理。'));
    if (subject && !draft) {
      const edit = element('button', actionsContainer ? 'qqj-memory-menu-action' : 'secondary-action', '编辑状态'); edit.type = 'button'; edit.disabled = workBusy(state) || typeof runtime.correctSubjectState !== 'function' || !state.currentStateId || !state.currentStateFingerprint;
      edit.addEventListener('click', () => {
        const copyItems = values => (values ?? []).map(item => ({ itemId: item.id, text: item.text, visibility: item.visibility, towardEntityId: item.towardEntityId ?? null }));
        cseDrafts.set(key, { chatId: state.chatId, subjectEntityId: entityId, expectedCurrentStateId: state.currentStateId, expectedCurrentStateFingerprint: state.currentStateFingerprint, core: copyItems(subject.core), adaptive: copyItems(subject.adaptive), situational: copyItems(subject.situational), saving: false, saveError: '' });
        openState.set(`subject:${entityId}`, true); render(foundationState);
      });
      actions.append(edit);
    }
    if (!draft && peopleRuntime && person) {
      const actionClass = actionsContainer ? `qqj-memory-menu-action${person.selected ? ' danger' : ''}` : 'secondary-action';
      const selected = new Set(peopleState?.selectedEntityIds ?? []), action = element('button', actionClass, person.selected ? '移出重要' : '设为重要');
      action.type = 'button'; action.disabled = Boolean(peopleState?.active && peopleState.active.kind !== 'generating');
      action.addEventListener('click', () => {
        if (person.selected) selected.delete(person.entityId); else selected.add(person.entityId);
        void run(person.selected ? '移出重要人物' : '加入重要人物', () => peopleRuntime.setSelectedEntityIds([...selected]));
      });
      actions.append(action);
    }
    card.append(body); return card;
  }
  function cseActionFor(floor, state) {
    if (!floor.memoryId || typeof runtime.retryStateAnalysis !== 'function') return null;
    const status = floor.cse?.status; if (!['pending', 'failed', 'ready', 'noChange'].includes(status)) return null;
    const completed = ['ready', 'noChange'].includes(status); const label = completed ? '重新分析' : status === 'failed' ? '重试分析' : '分析本楼';
    const button = element('button', completed ? 'secondary-action' : 'primary-action', label); button.type = 'button'; button.disabled = workBusy(state);
    button.addEventListener('click', async () => { if (completed && !await Promise.resolve(confirmImpl({ title: '重新分析人物状态', body: '成功后，后续楼层人物状态需依次重算，也可能覆盖之后的人工纠正；本楼摘要保持不变。', confirmText: '重新分析', cancelText: '取消' }))) { feedback = '已取消重新分析人物状态。'; render(foundationState); return; } void run(label, () => runtime.retryStateAnalysis(floor.floorId), { resultCopy: floorActionResult(label, floor.floorId, 'cse') }); });
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
    const section = element('section', 'qqj-page qqj-cse-history-page');
    section.append(pageStatus(state));
    const headingNode = element('header', 'qqj-cse-page-heading');
    headingNode.append(element('strong', '', '分析记录'), element('span', 'v3-memory-status', `${state.csePendingCount ?? 0} 待分析 · ${state.cseFailedCount ?? 0} 失败`));
    const back = element('button', 'secondary-action qqj-cse-view-toggle', '返回当前状态'); back.type = 'button'; back.addEventListener('click', () => switchPeopleMode('current')); headingNode.append(back); section.append(headingNode);
    const list = element('div', 'qqj-cse-history-list');
    const floors = [...(state.floors ?? [])].filter(floor => floor.memoryId).sort((left, right) => (right.messageIndex ?? 0) - (left.messageIndex ?? 0));
    for (const floor of floors) {
      const rowNode = setDetailsState(element('details', 'qqj-cse-history-row'), `cse-floor:${floor.floorId}`, false);
      const rowSummary = element('summary', 'qqj-cse-floor-summary'); rowSummary.append(element('span', '', floorCopy(state, floor)), element('span', 'v3-memory-status', statusCopy(floor.cse?.status))); rowNode.append(rowSummary);
      const body = element('div', 'qqj-cse-floor-body'), record = floor.cse?.record;
      if (record) {
        const changes = (record.subjects ?? []).flatMap(subject => (subject.changes ?? []).map(change => ({ ...change, displayName: subject.displayName })));
        const visibleChanges = changes.filter(change => change.action !== 'remove');
        const resultNode = element('section', 'qqj-cse-floor-result'); resultNode.append(element('strong', 'qqj-cse-floor-result-title', '本楼新增与调整'));
        const resultBody = element('div', 'qqj-cse-floor-state-body');
        for (const subject of record.subjects ?? []) {
          const subjectChanges = (subject.changes ?? []).filter(change => change.action !== 'remove');
          if (!subjectChanges.length) continue;
          const subjectNode = element('section', 'qqj-cse-record-subject'), listNode = element('ul', 'v3-cse-items'); subjectNode.append(element('strong', '', subject.displayName));
          for (const change of subjectChanges) {
            const after = change.after ?? { text: change.afterText }, item = element('li', `v3-cse-item qqj-cse-change is-${change.action ?? 'add'}`);
            item.append(element('span', 'v3-cse-item-text', `${categoryCopy[change.category] ?? '人物状态'}：${after?.text ?? '状态内容未提供'}`));
            listNode.append(item);
          }
          subjectNode.append(listNode); resultBody.append(subjectNode);
        }
        if (!visibleChanges.length) resultBody.append(element('p', 'settings-hint', changes.some(change => change.action === 'remove') ? '本楼有状态移除，展开变更详情查看。' : '本楼没有新增或调整的人物状态。'));
        resultNode.append(resultBody); body.append(resultNode);

        const changesNode = setDetailsState(element('details', 'qqj-cse-floor-changes'), `cse-floor-changes:${floor.floorId}`, false);
        const changesSummary = element('summary', 'qqj-cse-floor-state-summary', `变更详情 · ${changes.length} 项`); changesNode.append(changesSummary);
        const changesBody = element('div', 'qqj-cse-floor-changes-body');
        for (const subject of record.subjects ?? []) {
          const subjectNode = element('section', 'qqj-cse-record-subject'); subjectNode.append(element('strong', '', subject.displayName));
          if (subject.changes?.length) {
            const listNode = element('ul', 'v3-cse-items');
            for (const value of subject.changes) { const copy = changeCopy(value), item = element('li', `v3-cse-item qqj-cse-change is-${value.action ?? 'add'}`); item.append(element('span', 'v3-cse-item-text', copy.main)); if (copy.details.length) item.append(element('small', 'v3-cse-item-meta', copy.details.join(' · '))); listNode.append(item); }
            subjectNode.append(listNode);
          } else subjectNode.append(element('p', 'settings-hint', '这个人物本楼没有记录到变化。'));
          changesBody.append(subjectNode);
        }
        if (!changes.length) changesBody.append(element('p', 'settings-hint', '本楼无实质人物状态变化。'));
        if (record.isolationSummary) changesBody.append(element('p', 'qqj-cse-isolation-hint', record.noMaterialChange
          ? `有内容未通过校验；本楼未产生人物状态变化（${record.isolationSummary.count} 项校验记录）。`
          : `部分内容未通过校验，已保留有效结果（${record.isolationSummary.count} 项校验记录）。`));
        changesNode.append(changesBody); body.append(changesNode);
        if (record.endStateSubjects) {
          const stateNode = setDetailsState(element('details', 'qqj-cse-floor-state'), `cse-floor-state:${floor.floorId}`, false);
          stateNode.append(element('summary', 'qqj-cse-floor-state-summary', '查看本楼完整状态'));
          const stateBody = element('div', 'qqj-cse-floor-state-body');
          for (const subject of record.endStateSubjects) {
            const subjectNode = element('section', 'qqj-cse-record-subject'); subjectNode.append(element('strong', '', subject.displayName));
            appendSubjectGroups(subjectNode, subject, state); stateBody.append(subjectNode);
          }
          if (!record.endStateSubjects.length) stateBody.append(element('p', 'settings-hint', '本楼结束时没有已保存状态。'));
          stateNode.append(stateBody); body.append(stateNode);
        }
      }
      if (!record && !floor.cse?.error) body.append(element('p', 'settings-hint', '本楼还没有已保存的状态分析记录。'));
      if (floor.cse?.error) body.append(element('p', 'v3-foundation-feedback error', floor.cse.error)); const action = cseActionFor(floor, state); if (action) body.append(action); rowNode.append(body); list.append(rowNode);
    }
    if (!floors.length) list.append(element('p', 'settings-hint', '生成摘要后，这里会显示逐楼人物状态分析记录。'));
    section.append(list); if (state.cseReplayDiagnostic?.message) section.append(element('p', 'v3-foundation-feedback error', state.cseReplayDiagnostic.message)); return section;
  }
  function peopleScrollHost() { return container?.parentElement ?? container; }
  function switchPeopleMode(next) {
    if (!['current', 'history'].includes(next) || next === peopleMode) return;
    const scrollHost = peopleScrollHost(); peopleScroll.set(peopleMode, scrollHost?.scrollTop || 0); peopleMode = next; render(foundationState); if (scrollHost) scrollHost.scrollTop = peopleScroll.get(next) || 0;
  }
  const relationItem = (value, state, { showMeta = false } = {}) => {
    const item = element('li', 'qqj-relation-item');
    item.append(element('span', 'v3-cse-item-text', value.text));
    if (showMeta) { const source = value.sourceFloorId || value.sourceAssistantSeq ? sourceFloorCopy(state, value) : value.origin === 'baseline' ? '来源：聊天基线' : '来源：本地重放'; item.append(element('small', 'v3-cse-item-meta', [...new Set([value.reason, originCopy(value.origin), source, visibilityCopy(value.visibility)])].join(' · '))); } return item;
  };
  function appendRelationLayers(container, { situational = [], adaptive = [] }, state) {
    let count = 0;
    for (const [label, values] of [['当前态度', situational], ['长期相处方式', adaptive]]) {
      if (!values.length) continue;
      const group = element('div', 'qqj-relation-layer'); group.append(element('strong', 'qqj-relation-layer-title', label));
      const list = element('ul', 'qqj-relation-items'); for (const value of values) list.append(relationItem(value, state)); group.append(list); container.append(group); count += values.length;
    }
    return count;
  }
  function renderRelationLane(label, values, state, side) {
    const lane = element('section', `qqj-relation-lane ${side}`); lane.append(element('strong', 'qqj-relation-lane-title', label));
    if (!appendRelationLayers(lane, values, state)) lane.append(element('p', 'settings-hint', '暂无已保存的关系状态。'));
    return lane;
  }
  function renderUserAnchor(userSubject, userEntity, state) {
    const anchor = element('section', 'qqj-user-anchor');
    const title = element('div', 'qqj-user-anchor-title'); title.append(element('strong', '', userEntity?.displayName || userSubject?.displayName || '你')); anchor.append(title);
    if (!userSubject) { anchor.append(element('p', 'settings-hint', '还没有已保存的用户状态。')); return anchor; }
    const key = `${state.chatId ?? 'no-chat'}:${userSubject.subjectEntityId}`, draft = cseDrafts.get(key);
    if (draft) renderCseEditor(anchor, draft, state, key);
    else {
      appendSubjectGroups(anchor, userSubject, state, { adaptive: (userSubject.adaptive ?? []).filter(item => !item.towardEntityId), situational: (userSubject.situational ?? []).filter(item => !item.towardEntityId), showMeta: false, groupAdaptiveByTarget: false });
      const edit = element('button', 'secondary-action qqj-cse-edit-action', '编辑我的状态'); edit.type = 'button'; edit.disabled = workBusy(state) || typeof runtime.correctSubjectState !== 'function' || !state.currentStateId || !state.currentStateFingerprint;
      edit.addEventListener('click', () => { const copyItems = values => (values ?? []).map(item => ({ itemId: item.id, text: item.text, visibility: item.visibility, towardEntityId: item.towardEntityId ?? null })); cseDrafts.set(key, { chatId: state.chatId, subjectEntityId: userSubject.subjectEntityId, expectedCurrentStateId: state.currentStateId, expectedCurrentStateFingerprint: state.currentStateFingerprint, core: copyItems(userSubject.core), adaptive: copyItems(userSubject.adaptive), situational: copyItems(userSubject.situational), saving: false, saveError: '' }); render(foundationState); });
      anchor.append(edit);
    }
    return anchor;
  }
  function renderPeople(state) {
    if (peopleMode === 'history') return renderCseHistory(state);
    const pageNode = element('section', 'qqj-page qqj-people-page');
    pageNode.append(pageStatus(state));
    const subjects = state.cseSubjects ?? [], subjectById = new Map(subjects.map(subject => [subject.subjectEntityId, subject]));
    const userEntity = (state.memoryEntities ?? []).find(entity => entity.specialRole === 'user'), userSubject = userEntity ? subjectById.get(userEntity.entityId) : null;
    const candidates = (peopleState?.people ?? []).filter(person => person.entityId !== userEntity?.entityId), important = candidates.filter(person => person.selected), more = candidates.filter(person => !person.selected);
    if (!selectedCsePersonId || !important.some(person => person.entityId === selectedCsePersonId)) selectedCsePersonId = important[0]?.entityId ?? null;
    pageNode.append(renderUserAnchor(userSubject, userEntity, state));
    const sectionHeading = element('header', 'qqj-cse-page-heading'); sectionHeading.append(element('strong', '', '关系往来'));
    const history = element('button', 'secondary-action qqj-cse-view-toggle', '分析记录'); history.type = 'button'; history.addEventListener('click', () => switchPeopleMode('history')); sectionHeading.append(history); pageNode.append(sectionHeading);
    const switchRow = element('div', 'qqj-relation-switch-row'), switcher = element('div', 'qqj-relation-switcher'); relationSwitcherNode = switcher;
    for (const person of important) { const button = element('button', `qqj-relation-person${person.entityId === selectedCsePersonId ? ' active' : ''}`, person.displayName); button.type = 'button'; button.setAttribute('aria-pressed', String(person.entityId === selectedCsePersonId)); button.addEventListener('click', () => { selectedCsePersonId = person.entityId; showMoreCsePeople = false; render(foundationState); }); switcher.append(button); }
    if (!important.length) switcher.append(element('span', 'qqj-profile-switch-empty', peopleRuntime ? '尚未选择重要人物' : '暂无人物状态'));
    const moreToggle = element('button', `secondary-action qqj-relation-more-toggle${showMoreCsePeople ? ' active' : ''}`, showMoreCsePeople ? '返回关系' : `更多人物（${more.length}）`); moreToggle.type = 'button'; moreToggle.setAttribute('aria-pressed', String(showMoreCsePeople)); moreToggle.addEventListener('click', () => { showMoreCsePeople = !showMoreCsePeople; render(foundationState); });
    switchRow.append(switcher, moreToggle); pageNode.append(switchRow);
    const selectedPerson = important.find(person => person.entityId === selectedCsePersonId), selectedSubject = selectedPerson ? subjectById.get(selectedPerson.entityId) : null;
    if (showMoreCsePeople) {
      const picker = element('section', 'qqj-profile-picker qqj-cse-more'), pickerHeading = element('header', 'qqj-profile-picker-heading');
      pickerHeading.append(element('strong', '', '更多人物'), element('span', 'v3-memory-status', `${more.length} 位`)); picker.append(pickerHeading);
      const moreList = element('div', 'qqj-more-people-list');
      for (const person of more) moreList.append(renderSubject(subjectById.get(person.entityId), state, { person, ownOnly: true }));
      if (!more.length) moreList.append(element('p', 'settings-hint', '当前没有其他已识别人物。'));
      picker.append(moreList); pageNode.append(picker);
    } else if (selectedPerson) {
      const pair = element('section', 'qqj-relation-card');
      const pairHead = element('header', 'qqj-relation-head'), pairMenu = element('details', 'qqj-memory-menu qqj-relation-menu');
      const pairMenuToggle = element('summary', 'qqj-memory-menu-toggle', '⋮'); pairMenuToggle.setAttribute('aria-label', '关系操作'); pairMenuToggle.setAttribute('title', '关系操作');
      const pairActions = element('div', 'qqj-memory-menu-pop'); pairHead.append(element('strong', '', selectedPerson.displayName), element('span', '', '⇄ 你')); pair.append(pairHead);
      const dual = element('div', 'qqj-relation-dual');
      const userToward = { situational: (userSubject?.situational ?? []).filter(item => item.towardEntityId === selectedPerson.entityId), adaptive: (userSubject?.adaptive ?? []).filter(item => item.towardEntityId === selectedPerson.entityId) };
      const personToward = { situational: (selectedSubject?.situational ?? []).filter(item => item.towardEntityId === userEntity?.entityId), adaptive: (selectedSubject?.adaptive ?? []).filter(item => item.towardEntityId === userEntity?.entityId) };
      const relationNote = renderSubject(selectedSubject, state, { person: selectedPerson, ownOnly: true, relationNote: true, actionsContainer: pairActions });
      if (pairActions.children.length) { pairMenu.append(pairMenuToggle, pairActions); pairHead.append(operationMenus.register(pairMenu)); }
      dual.append(renderRelationLane(`你 → ${selectedPerson.displayName}`, userToward, state, 'from-user'), element('span', 'qqj-relation-divider'), renderRelationLane(`${selectedPerson.displayName} → 你`, personToward, state, 'toward-user')); pair.append(dual, relationNote); pageNode.append(pair);
      const otherRelations = ['situational', 'adaptive'].flatMap(category => (selectedSubject?.[category] ?? []).filter(item => item.towardEntityId && item.towardEntityId !== userEntity?.entityId && item.towardEntityId !== selectedPerson.entityId).map(item => ({ category, item })));
      if (otherRelations.length) {
        const others = setDetailsState(element('details', 'qqj-other-relations'), `other-relations:${selectedPerson.entityId}`, false);
        const otherSummary = element('summary', 'qqj-section-summary'); otherSummary.append(element('strong', '', `${selectedPerson.displayName}与其他人物`), element('span', 'v3-memory-status', `${otherRelations.length} 条`)); others.append(otherSummary);
        const otherBody = element('div', 'qqj-other-relations-body'), entityNames = new Map((state.memoryEntities ?? []).map(entity => [entity.entityId, entity.displayName]));
        const grouped = new Map();
        for (const { category, item } of otherRelations) { const group = grouped.get(item.towardEntityId) ?? { situational: [], adaptive: [], displayName: entityNames.get(item.towardEntityId) ?? item.towardDisplayName ?? '未知人物' }; group[category].push(item); grouped.set(item.towardEntityId, group); }
        for (const group of grouped.values()) { const rowNode = element('section', 'qqj-other-relation'); rowNode.append(element('strong', '', `${selectedPerson.displayName} → ${group.displayName}`)); appendRelationLayers(rowNode, group, state); otherBody.append(rowNode); }
        others.append(otherBody); pageNode.append(others);
      }
    }
    if (state.cseReplayDiagnostic?.message) pageNode.append(element('p', 'v3-foundation-feedback error', state.cseReplayDiagnostic.message)); return pageNode;
  }

  function renderRecallDetails(state = recallState) {
    const drawer = setDetailsState(element('details', 'qqj-management-drawer'), 'recall-details', false), record = state?.lastRecall ?? null, status = state?.recallStatus ?? 'idle';
    const recallStatus = record?.legacyReadOnly ? '旧版只读记录 · 不代表本轮已注入' : record?.restoredReceipt ? '已落盘回执 · 恢复显示' : statusCopy(status);
    const summary = element('summary', 'qqj-section-summary'); summary.append(element('strong', '', record?.restoredReceipt ? '最近一次召回结果' : '最近召回回执'), element('span', 'v3-memory-status', recallStatus)); drawer.append(summary);
    const body = element('div', 'qqj-management-drawer-body'); if (receiptFeedback) body.append(element('p', 'v3-foundation-feedback error', receiptFeedback));
    if (!record) { body.append(element('p', 'settings-hint', state?.activeRecall ? `正在处理 ${state.activeRecall.generationType} · ${state.activeRecall.phase}` : '下一次正文生成后，这里会保留最近一次召回结果。')); drawer.append(body); return drawer; }
    const coverage = record.coverage, stages = record.stages, timings = record.timings, sourceReads = timings?.sourceReadAttempts;
    const sourceExitCopy = { ready: '读取成功', validatedSnapshot: '已使用完成校验的快照', memoryPreparation: '记忆准备未完成', memoryPreparationTimeout: '记忆准备超时', memoryPreparationFailed: '记忆准备失败', stale: '读取时已失效', unavailable: '来源不可用' };
    const sourceReadCopy = sourceReads ? `完整快照 ${sourceReads.reachableReads} 次 · 退出 ${sourceExitCopy[sourceReads.exitPoint] ?? '未知'}` : record.restoredReceipt ? '历史回执不重新读取来源' : '未记录';
    const floors = (record.selectedFloors ?? []).map(value => floorCopy(foundationState, value, '来源楼号未提供')).join('、') || '无', states = (record.selectedStates ?? []).map(value => `${value.subject} / ${value.layer}`).join('、') || '无';
    const changes = (record.selectedCseChanges ?? []).map(value => `${value.subject} / ${value.layer} / ${cseActionCopy(value.action)} / ${floorCopy(foundationState, value, '来源楼号未提供')}`).join('、') || '无';
    const stageCopy = stages && [stages.recentSummaryCount, stages.distantHistoryItemCount, stages.stateCount].every(Number.isSafeInteger)
      ? `输入 ${stages.input} → 记忆楼 ${stages.candidates} → 近期摘要 ${stages.recentSummaryCount} → 远期旧事 ${stages.distantHistoryItemCount}${Number.isSafeInteger(stages.linkedHistoryItemCount) ? `（关联补入 ${stages.linkedHistoryItemCount}）` : ''} → 当前态 ${stages.currentStateCount ?? stages.stateCount} → 历史变化 ${stages.cseChangeCount ?? 0}${Number.isSafeInteger(stages.linkedCseChangeCount) ? `（关联补入 ${stages.linkedCseChangeCount}）` : ''}${Number.isSafeInteger(stages.storylineCount) ? ` → 剧情线 ${stages.storylineCount}` : ''}${Number.isSafeInteger(stages.budgetDroppedCount) ? ` → 预算舍弃 ${stages.budgetDroppedCount} → 最终材料 ${stages.finalInjectionItemCount}` : ''}${Number.isSafeInteger(stages.estimatedTokenCount) && Number.isSafeInteger(stages.estimatedTokenBudget) ? ` · Token 保守估算 ${stages.estimatedTokenCount}/${stages.estimatedTokenBudget}` : ''}`
      : stages ? `输入 ${stages.input} → 记忆楼 ${stages.candidates} → 去近期 ${stages.dropRecent} → 去常驻重复 ${stages.dropPersistent ?? 0} → 去越界 ${stages.dropVisibility} → 选中楼 ${stages.selected}` : '收据复用或未执行';
    const selector = record.selectorDiagnostic;
    const selectorCount = value => Number.isSafeInteger(value) ? String(value) : '未知';
    const hasExclusionCounts = ['historyExcludedCount', 'stateExcludedCount', 'historyRetainedCount', 'stateRetainedCount'].some(key => Number.isSafeInteger(selector?.[key]));
    const selectorCountCopy = hasExclusionCounts
      ? `历史候选 ${selectorCount(selector?.historyCandidateCount)} → 模型排除 ${selectorCount(selector?.historyExcludedCount)} → 保留 ${selectorCount(selector?.historyRetainedCount)} → 关联补入 ${selectorCount(stages?.linkedHistoryItemCount)} → 最终远期 ${selectorCount(stages?.distantHistoryItemCount)} · 人物候选 ${selectorCount(selector?.stateCandidateCount)} → 模型排除 ${selectorCount(selector?.stateExcludedCount)} → 保留 ${selectorCount(selector?.stateRetainedCount)} → 关联补入 ${selectorCount(stages?.linkedCseChangeCount)} → 最终注入 ${Number.isSafeInteger(stages?.currentStateCount) && Number.isSafeInteger(stages?.cseChangeCount) ? stages.currentStateCount + stages.cseChangeCount : '未知'}`
      : `历史候选 ${selectorCount(selector?.historyCandidateCount)} → 模型选择 ${selectorCount(selector?.historyModelSelectedCount)} → 最终远期 ${selectorCount(stages?.distantHistoryItemCount)} · 人物候选 ${selectorCount(selector?.stateCandidateCount)} → 模型选择 ${selectorCount(selector?.stateModelSelectedCount)} → 最终注入 ${Number.isSafeInteger(stages?.currentStateCount) && Number.isSafeInteger(stages?.cseChangeCount) ? stages.currentStateCount + stages.cseChangeCount : '未知'}`;
    const timingCopy = timings ? (Number.isFinite(timings.totalMs)
      ? `本轮实时总耗时 ${Number(timings.totalMs).toFixed(1)} ms · 选材 ${Number(timings.selectorMs || 0).toFixed(1)} ms · 读取 ${Number(timings.sourceMs || 0).toFixed(1)} ms`
      : `落盘阶段：选材 ${Number(timings.selectorMs || 0).toFixed(1)} ms · 读取 ${Number(timings.sourceMs || 0).toFixed(1)} ms`) : record.reusedReceipt ? '复用收据' : '未记录';
    const filterReasons = (record.skipReasons ?? []).filter(value => value !== 'historySelectionFallback').map(skipReasonCopy);
    const details = element('dl', 'v3-foundation-grid'); details.append(row('触发用户楼', userFloorCopy(record.userMessageIndex)), row('生成时间', localTimeCopy(record.createdAt)), row('生成类型', generationTypeCopy(record.generationType)), row('收据', record.legacyReadOnly ? '旧版只读记录' : record.restoredReceipt ? '已落盘回执 · 仅恢复历史展示，不会再次注入' : `${record.reusedReceipt ? '复用' : '新算'} · ${record.receiptPersistence ?? 'none'}`), row('召回旧楼', floors), row('当前人物状态', states), row('人物状态历史变化', changes), row('覆盖范围', coverage ? `记忆 ${coverage.rememberedAiFloors}/${coverage.stableAiFloors} · ${coverage.cseThroughAssistantSeq ? `CSE 到${floorCopy(foundationState, { assistantSeq: coverage.cseThroughAssistantSeq }, '终点楼号未提供')}` : 'CSE 尚未覆盖'}` : '本轮未读取'), row('筛选阶段', stageCopy), row('选材方式', selectorModeCopy(selector?.mode)), row('智能选材计数', selectorCountCopy), ...(selector?.mode === 'fallback' ? [row('选材失败原因', `${selectorFailureCopy(selector.code)}${selector.httpStatus ? `（HTTP ${selector.httpStatus}）` : ''}`)] : []), row('耗时', timingCopy), row('来源读取', sourceReadCopy), row('普通过滤说明', filterReasons.join('、') || '无'));
    body.append(details); const safeError = state?.lastRecallError?.message || record.error?.message; if (safeError) body.append(element('p', 'v3-foundation-feedback error', safeError));
    if (record.legacyReadOnly) body.append(element('p', 'settings-hint', '这是旧版只读记录，不会复用、注入或升级为当前回执。'));
    if (record.injectionText) {
      body.append(element('pre', 'v3-recall-injection', record.injectionText));
      if ((record.skipReasons ?? []).includes('memoryNotReady')) body.append(element('p', 'settings-hint', '当前仍有摘要或人物状态缺口；本轮已注入能确认归属的已保存部分，正文继续生成。'));
    }
    else if (record.status === 'empty' || record.status === 'completed-empty') body.append(element('p', 'settings-hint', '本轮没有需要注入的记忆。'));
    else if ((record.skipReasons ?? []).includes('sourceStale')) body.append(element('p', 'settings-hint', '记忆来源正在更新，本轮已安全跳过召回注入。'));
    else if ((record.skipReasons ?? []).includes('sourceUnavailable')) body.append(element('p', 'settings-hint', '记忆来源暂不可用，本轮已安全跳过召回注入。'));
    else if ((record.skipReasons ?? []).includes('memoryPreparationTimeout')) body.append(element('p', 'settings-hint', '记忆在 5 秒内未准备完成；本轮未注入记忆，正文已继续生成。'));
    else if ((record.skipReasons ?? []).includes('memoryPreparationFailed')) body.append(element('p', 'settings-hint', '记忆准备失败；本轮未注入记忆，正文已继续生成。'));
    else if ((record.skipReasons ?? []).includes('memoryRebuilding')) body.append(element('p', 'settings-hint', '历史记忆正在后台重建；本轮没有注入不完整的记忆。'));
    else if ((record.skipReasons ?? []).includes('memoryNotReady')) body.append(element('p', 'settings-hint', (record.skipReasons ?? []).includes('coverageUnconfirmed') ? '当前记忆与正文对应关系尚未确认；本轮未注入记忆，正文已继续生成。' : '当前存在历史记忆缺口；本轮没有找到可注入的已保存记忆，正文已继续生成。'));
    drawer.append(body); return drawer;
  }
  function renderDiagnostics(state) {
    const drawer = setDetailsState(element('details', 'qqj-management-drawer'), 'diagnostics', false), summary = element('summary', 'qqj-section-summary'); summary.append(element('strong', '', '详细诊断'), element('span', 'v3-memory-status', '按需展开')); drawer.append(summary);
    const body = element('div', 'qqj-management-drawer-body'), details = element('dl', 'v3-foundation-grid');
    const rebuildCopy = ({ rebuilding: '正在重建', paused: '已暂停', waitingRealtime: '等待新楼', failed: '失败', caughtUp: '已追平', pendingRebuild: '等待开始', notReady: '覆盖待确认' })[state.rebuildStatus] ?? '尚未判断';
    details.append(row('当前 chat', state.chatId), row('地基状态', statusCopy(effectiveStatus(state))), row('待核对原因', reviewReasonCopy(state.reviewReason)), row('自动维护新楼', state.autoMemoryEnabled ? '已开启 · 每楼更新' : '已关闭'), row('历史重建', `${rebuildCopy} · ${state.rebuildCompletedCount ?? 0}/${state.rebuildTotalCount ?? state.stableCount ?? 0}`), row('CSE 待分析 / 失败', `${state.csePendingCount ?? 0} / ${state.cseFailedCount ?? 0}`), row('Head checkpoint', state.headCheckpointId), row('最近记忆错误', state.lastExtractorError?.message || state.lastError || '无'), row('最近 CSE 错误', state.lastCseError?.message || '无')); body.append(details);
    const stateDiagnosticAction = element('div', 'qqj-ui-diagnostic-action');
    const copyState = element('button', 'secondary-action', '复制状态诊断'); copyState.type = 'button';
    copyState.addEventListener('click', () => { void copyStateDiagnostic(); });
    stateDiagnosticAction.append(copyState, element('span', 'settings-hint', '只含运行状态与错误代码，不含聊天正文、身份编号或 API 配置。'));
    body.append(stateDiagnosticAction);
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
    if (['pendingRebuild', 'paused', 'failed', 'partial'].includes(state.rebuildStatus) || (state.rebuildStatus === 'waitingRealtime' && state.rebuildHasActionableWork)) pageNode.append(element('p', 'qqj-management-notice', '记忆尚未完整。“补齐缺失”会保留已有结果，只处理摘要或人物状态缺口；刷新页面不会自动续跑旧档。'));
    const deleting = managementState?.status === 'deleting', deletePending = managementState?.status === 'failed';
    const actions = element('div', 'v3-foundation-actions qqj-management-actions'), busy = workBusy(state) || deleting || deletePending;
    const refresh = element('button', 'secondary-action', '刷新状态'); refresh.type = 'button'; refresh.disabled = busy;
    refresh.addEventListener('click', () => { void run('刷新记忆状态', () => runtime.refreshStatus({ preferCached: false })); });
    actions.append(refresh);
    const rebuildActionable = state.rebuildHasActionableWork ?? !['caughtUp', 'waitingRealtime'].includes(state.rebuildStatus);
    if (state.rebuildStatus === 'rebuilding' && typeof runtime.pauseHistoricalRebuild === 'function') { const pause = element('button', 'primary-action', '暂停补齐'); pause.type = 'button'; pause.disabled = !state.activeAutoMemory; pause.addEventListener('click', () => { void run('暂停补齐', () => runtime.pauseHistoricalRebuild(), { resultCopy: automaticResult('补齐缺失') }); }); actions.append(pause); }
    else if (!['paused', 'failed'].includes(state.cseRebuildStatus)) { const begin = runtime.startHistoricalRebuild ?? runtime.retryAutomation; const proceedLabel = ['paused', 'failed', 'partial'].includes(state.rebuildStatus) ? '继续补齐' : '补齐缺失'; const proceed = element('button', 'primary-action', busy ? workPhaseCopy(state) : proceedLabel); proceed.type = 'button'; proceed.disabled = busy || typeof begin !== 'function' || !rebuildActionable; proceed.addEventListener('click', () => { void run(proceedLabel, () => begin.call(runtime, state.chatId), { resultCopy: automaticResult(proceedLabel) }); }); actions.append(proceed); }
    const reset = element('button', 'secondary-action', '完全重构'); reset.type = 'button'; reset.disabled = busy || typeof runtime.fullRebuild !== 'function'; reset.addEventListener('click', async () => { if (!await Promise.resolve(confirmImpl({ title: '完全重构当前聊天记忆', body: '当前聊天的摘要及人物状态将从头重新生成，人工修订也会被替换；聊天正文和插件设置保留。', confirmText: '完全重构', cancelText: '取消' }))) { feedback = '已取消完全重构。'; render(foundationState); return; } void run('完全重构', () => runtime.fullRebuild(state.chatId), { resultCopy: automaticResult('完全重构') }); }); actions.append(reset);
    const cseRunning = state.cseRebuildStatus === 'running' && state.activeAutoMemory?.mode === 'cseRebuild';
    const cseResume = ['paused', 'failed'].includes(state.cseRebuildStatus);
    const cseAction = element('button', 'secondary-action', cseRunning ? '暂停 CSE 重构' : cseResume ? '继续 CSE 重构' : 'CSE 重构'); cseAction.type = 'button';
    cseAction.disabled = cseRunning ? typeof runtime.pauseCseRebuild !== 'function' || deleting : busy || typeof runtime.rebuildCse !== 'function' || (state.rememberedCount ?? 0) < 1;
    cseAction.addEventListener('click', async () => {
      if (cseRunning) { void run('暂停 CSE 重构', () => runtime.pauseCseRebuild(), { resultCopy: cseRebuildResult('CSE 重构') }); return; }
      if (cseResume) { void run('继续 CSE 重构', () => runtime.resumeCseRebuild(state.chatId), { resultCopy: cseRebuildResult('CSE 重构') }); return; }
      if (!await Promise.resolve(confirmImpl({ title: '重构当前聊天 CSE', body: '所有摘要及摘要人工修订都会保留；已有摘要对应的人物状态将从头重新生成，CSE 人工纠正也会被覆盖。未摘要楼不会处理。', confirmText: 'CSE 重构', cancelText: '取消' }))) { feedback = '已取消 CSE 重构。'; render(foundationState); return; }
      void run('CSE 重构', () => runtime.rebuildCse(state.chatId), { resultCopy: cseRebuildResult('CSE 重构') });
    });
    actions.append(cseAction);
    if (state.cseRebuildStatus !== 'idle') actions.append(element('span', 'settings-hint', `CSE ${state.cseRebuildStatus === 'completed' ? '已完成' : state.cseRebuildStatus === 'failed' ? '失败' : state.cseRebuildStatus === 'paused' ? '已暂停' : '重构中'} · ${state.cseRebuildCompletedCount ?? 0}/${state.cseRebuildTotalCount ?? 0}`));
    const pendingCopy = `摘要待补 ${state.unprocessedCount ?? 0} 楼 · CSE 待分析 ${state.csePendingCount ?? 0} 楼`;
    const nextStepCopy = deletePending ? '上次删除尚未完成，请先继续删除当前聊天记忆。'
      : busy ? `${workPhaseCopy(state)}，完成后可继续操作。`
        : !state.chatId ? '当前聊天尚未建立记忆身份。'
          : ['needsReview', 'error'].includes(effectiveStatus(state)) ? `当前${statusCopy(effectiveStatus(state))}；请先点击“刷新状态”。若仍无法确认真实归属，现有记忆会保留、正文可继续，可复制诊断反馈。`
            : !rebuildActionable ? '当前没有需要补齐的稳定楼。'
              : '可用“补齐缺失”保留已有结果；“完全重构”会替换全部摘要与人物状态。';
    actions.append(element('span', 'settings-hint', `${pendingCopy}。${nextStepCopy}`));
    if (memoryManagement) {
      const remove = element('button', 'secondary-action', deleting ? '删除中…' : deletePending ? '继续删除当前聊天记忆' : '删除当前聊天记忆');
      remove.type = 'button'; remove.disabled = deleting || managementState?.blockedByOtherChat === true || (!deletePending && (managementState?.workBusy === true || !state.chatId));
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
    if (relationSwitcherNode) relationSwitcherScrollLeft = Number(relationSwitcherNode.scrollLeft) || 0;
    const previousSignature = relationSwitcherSignature, previousChatId = relationSwitcherChatId;
    relationSwitcherNode = null;
    operationMenus.reset();
    recallState = recallRuntime?.getState?.() ?? recallState; peopleState = peopleRuntime?.getState?.() ?? peopleState; managementState = memoryManagement?.getState?.() ?? managementState; healthNode = null;
    container.replaceChildren(page === 'memories' ? renderMemories(state) : page === 'people' ? renderPeople(state) : renderManagement(state));
    if (relationSwitcherNode) {
      const userEntityId = (state.memoryEntities ?? []).find(entity => entity.specialRole === 'user')?.entityId ?? null;
      const nextSignature = JSON.stringify((peopleState?.people ?? []).filter(person => person.entityId !== userEntityId && person.selected).map(person => person.entityId));
      const preserveScroll = previousChatId === (state.chatId ?? null) && previousSignature === nextSignature;
      relationSwitcherNode.scrollLeft = preserveScroll ? relationSwitcherScrollLeft : 0;
      relationSwitcherSignature = nextSignature; relationSwitcherChatId = state.chatId ?? null; relationSwitcherScrollLeft = relationSwitcherNode.scrollLeft;
    }
  }
  const syncingDisplayState = state => syncingChatId && syncingChatId === state?.chatId
    ? { ...state, memorySnapshotStatus: 'syncing', memorySyncStatus: 'syncing', memoryWorkBusy: true }
    : state;
  const applySyncingPresentation = () => {
    const safeButtons = new Set(['取消', '分析记录', '返回当前状态', '复制安全诊断', '复制完整诊断', '复制界面诊断', '复制状态诊断']);
    const visit = node => {
      for (const child of Array.from(node?.children ?? [])) {
        const tag = String(child?.tagName ?? child?.tag ?? '').toLowerCase();
        const diagnosticFallback = tag === 'textarea' && child.readOnly === true && String(child.className ?? '').split(/\s+/).includes('v3-diagnostic-fallback');
        if ((['input', 'select', 'textarea'].includes(tag) && !diagnosticFallback) || (tag === 'button' && !safeButtons.has(child.textContent))) child.disabled = true;
        visit(child);
      }
    };
    visit(container);
    updateHealth(syncingDisplayState(foundationState));
  };
  function render(state = runtime.getState()) {
    const adopted = adoptFoundationState(state).state;
    renderAdopted(syncingDisplayState(adopted));
    if (syncingChatId === adopted?.chatId) applySyncingPresentation();
  }
  function receiveFoundation(snapshot) {
    if (snapshot?.memorySnapshotStatus === 'syncing' && snapshot?.chatId && snapshot.chatId === foundationState?.chatId) {
      syncingChatId = snapshot.chatId;
      applySyncingPresentation();
      return;
    }
    syncingChatId = null;
    const { state, mustReplace } = adoptFoundationState(snapshot);
    if (page === 'memories' && drafts.size && !mustReplace) {
      for (const draft of drafts.values()) for (const control of draft.controls ?? []) control.disabled = draft.saving === true || workBusy(state);
      updateHealth(state); return;
    }
    if (page === 'people' && peopleMode === 'current' && cseDrafts.size && !mustReplace) {
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
  function mount(target) { stopSubscription(); operationMenus.deactivate(); container = target; active = true; recallState = recallRuntime?.getState?.() ?? null; render(runtime.getState()); operationMenus.activate(); subscribe(); }
  async function activate() {
    if (!container) throw new Error('V3 foundation view 尚未挂载');
    active = true; operationMenus.activate(); subscribe(); const mine = ++epoch; feedback = '正在读取最新状态…'; receiptFeedback = ''; updateHealth(runtime.getState());
    const prepare = page === 'management' || typeof runtime.prepareCurrent !== 'function'
      ? runtime.refreshStatus({ preferCached: page !== 'management' })
      : runtime.prepareCurrent({ preferCached: true }).then(() => runtime.getState());
    const [foundationOutcome, receiptOutcome] = await Promise.allSettled([prepare, recallRuntime?.restorePersistedReceipt?.()]);
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
  function deactivate() { active = false; epoch += 1; operationMenus.deactivate(); stopSubscription(); }
  function setPage(next) { if (!['memories', 'people', 'management'].includes(next)) throw new TypeError('V3 view page 无效'); page = next; if (container) render(foundationState); }
  return Object.freeze({ mount, activate, deactivate, render, setPage, getPage: () => page });
}
