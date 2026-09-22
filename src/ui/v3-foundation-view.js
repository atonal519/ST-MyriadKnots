import { createInlineSelect } from './inline-select.js';
import { createOperationMenuController } from './operation-menu-controller.js';
import { bindHorizontalStrip, openPeopleOrderDialog } from './people-interactions.js';
import { scrollManualEditorToTop } from './manual-editor-scroll.js';
import { publicErrorMessage } from '../public-error.js';

function text(value, fallback = '—') { return value === null || value === undefined || value === '' ? fallback : String(value); }

function statusCopy(value) {
  return ({
    uninitialized: '尚未开始记录', ready: '可用', running: '正在处理', empty: '完成 · 无需注入',
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
  const range = Array.isArray(reference?.sourceMessageIndexes) ? reference.sourceMessageIndexes.filter(validMessageIndex) : [];
  if (range.length > 1) return `第 ${range[0]}–${range.at(-1)} 楼`;
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
const generationTypeCopy = value => ({ normal: '正常生成', regenerate: '重新生成', swipe: '切换候选回复', continue: '继续生成' })[value] ?? text(value, '旧记录未提供');
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
  consecutiveAssistant: '这一楼尚未摘要。可在记忆页确认后，将连续 AI 回复分别登记并按顺序摘要。',
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
    ['rawFingerprintMatches', '原始正文'],
    ['canonicalFingerprintMatches', '清洗后正文'],
    ['sanitizerFingerprintMatches', '清洗规则'],
  ];
  const mismatches = fingerprintLabels.filter(([key]) => value[key] === false).map(([, copy]) => copy);
  const fingerprints = mismatches.length ? ` · 不一致：${mismatches.join('、')}` : '';
  const binding = value.bindingIssue === 'markerConflict' ? ' · 绑定冲突：消息标识指向当前记录之外的楼'
    : ['duplicateMarker', 'duplicateBinding'].includes(value.bindingIssue) ? ' · 绑定冲突：多楼共用同一标识' : '';
  return `${label}${floor}${counts}${marker}${binding}${fingerprints}`;
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
const workPhaseCopy = state => ({ reconciling: '正在同步楼层', extracting: '正在提取摘要', analyzingCse: '正在分析人物状态', revisingCse: '正在保存人物状态', committing: '正在保存结果', resetting: '正在重建后端数据', revising: '正在保存修订' })[state.activeMemoryWork?.phase ?? state.activeAutoMemory?.phase ?? state.activeExtraction?.phase ?? state.activeCse?.phase] ?? '正在处理';
const DIAGNOSTIC_STATUS = new Set(['idle', 'preparing', 'ready', 'error', 'disabled', 'suspended', 'running', 'uninitialized', 'stale', 'needsReview', 'conflict', 'empty', 'skipped', 'failed', 'partial', 'pending', 'noChange', 'notApplicable', 'unavailable', 'syncing', 'caughtUp', 'waitingRealtime', 'pendingRebuild', 'rebuilding', 'paused', 'completed', 'deleting', 'historicalDebt', 'realtimeTail', 'notReady', 'unknown']);
const DIAGNOSTIC_PHASE = new Set(['capturing', 'completed', 'stale', 'retryableError', 'anchor', 'load', 'foundation', 'extracting', 'validating', 'committing', 'resetting', 'reconciling', 'analyzingCse', 'revisingCse', 'revising', 'baseline', 'analyzing', 'correcting', 'pending', 'input', 'source', 'selecting', 'receipt', 'starting', 'deletingRecords', 'deletingBinding', 'clearingHost', 'unknown']);
const DIAGNOSTIC_KIND = new Set(['manual', 'auto', 'unknown']);
const DIAGNOSTIC_REVIEW_REASON = new Set(['missingRoot', 'indexNeedsReseal', 'stableCountMismatch', 'candidateCountMismatch', 'locatorMismatch', 'markerMismatch', 'fingerprintMismatch']);
const DIAGNOSTIC_MARKER_STATUS = new Set(['none', 'valid', 'foreign', 'invalid']);
const DIAGNOSTIC_BINDING_ISSUE = new Set(['markerConflict', 'duplicateMarker', 'duplicateBinding', 'markerRejected']);
const STANDARD_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'AggregateError', 'AbortError', 'DOMException', 'TimeoutError']);
const enumDiagnostic = (value, allowed) => allowed.has(value) ? value : 'unknown';
const booleanDiagnostic = value => typeof value === 'boolean' ? value : 'unknown';
const countDiagnostic = value => Number.isSafeInteger(value) && value >= 0 ? value : 'unknown';
const presenceDiagnostic = (source, key) => source && Object.hasOwn(source, key) ? Boolean(source[key]) : 'unknown';
const operationDiagnostic = (value, { kind = false } = {}) => value
  ? { present: true, ...(kind ? { kind: enumDiagnostic(value.kind, DIAGNOSTIC_KIND) } : {}), phase: enumDiagnostic(value.phase, DIAGNOSTIC_PHASE) }
  : { present: false, ...(kind ? { kind: null } : {}), phase: null };
function reviewReasonDiagnostic(value, sourceKnown = true) {
  if (!sourceKnown) return { present: 'unknown' };
  if (!value) return { present: false };
  const numberOrNull = (candidate, { zero = false } = {}) => Number.isSafeInteger(candidate) && candidate >= (zero ? 0 : 1) ? candidate : null;
  return {
    present: true,
    code: enumDiagnostic(value.code, DIAGNOSTIC_REVIEW_REASON),
    assistantSeq: numberOrNull(value.assistantSeq),
    messageIndex: numberOrNull(value.messageIndex, { zero: true }),
    expectedCount: numberOrNull(value.expectedCount, { zero: true }),
    actualCount: numberOrNull(value.actualCount, { zero: true }),
    markerStatus: value.markerStatus === undefined ? null : enumDiagnostic(value.markerStatus, DIAGNOSTIC_MARKER_STATUS),
    bindingIssue: value.bindingIssue === undefined ? null : enumDiagnostic(value.bindingIssue, DIAGNOSTIC_BINDING_ISSUE),
  };
}
function errorDiagnostic(value, sourceKnown = true) {
  if (!sourceKnown) return { present: 'unknown' };
  if (!value) return { present: false };
  const result = { present: true };
  if (value && typeof value === 'object') {
    if (STANDARD_ERROR_NAMES.has(value.name)) result.name = value.name;
    else if (STANDARD_ERROR_NAMES.has(value.code)) result.name = value.code;
    if (typeof value.code === 'string' && (/^(?:QQJ|V3|CHAT_SESSION)_[A-Z0-9_]{1,80}$/.test(value.code) || value.code === 'BACKEND_TIMEOUT')) result.code = value.code;
    if (typeof value.phase === 'string') result.phase = enumDiagnostic(value.phase, DIAGNOSTIC_PHASE);
    if (Number.isSafeInteger(value.count) && value.count > 0) result.count = value.count;
    const httpStatus = value.httpStatus ?? value.status;
    if (Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) result.httpStatus = httpStatus;
  }
  return result;
}
const diagnosticVersion = value => typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/.test(value) ? value : 'unknown';
const splitPeople = value => [...new Set(String(value ?? '').split(/[、,，\n]/u).map(item => item.trim()).filter(Boolean))];
const timeDisplay = chronology => [...new Set((chronology ?? []).map(item => item?.time?.sourceText || item?.time?.normalized || item?.description).map(item => String(item ?? '').trim()).filter(Boolean))].join('；');
const hasInternalTimeFields = value => /\|\s*(?:date|weekday|time)\s*=/iu.test(String(value ?? ''));
const floorTimeDisplay = (chronology, fallback) => {
  const saved = timeDisplay(chronology), extracted = String(fallback ?? '').trim();
  return saved && extracted && hasInternalTimeFields(saved) ? extracted : saved || extracted;
};
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
const plainSearchIncludes = (value, query) => String(value ?? '').toLocaleLowerCase().includes(String(query ?? '').trim().toLocaleLowerCase());
const searchSnippet = (value, query, limit = 110) => {
  const source = String(value ?? ''), needle = String(query ?? '').trim();
  const index = source.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (index < 0 || source.length <= limit) return source.replace(/\s+/gu, ' ').trim();
  const start = Math.max(0, index - Math.floor((limit - needle.length) / 2));
  const end = Math.min(source.length, Math.max(index + needle.length, start + limit));
  return `${start > 0 ? '…' : ''}${source.slice(start, end).replace(/\s+/gu, ' ').trim()}${end < source.length ? '…' : ''}`;
};

export function createV3FoundationView({ runtime, recallRuntime = null, peopleRuntime = null, timeRuntime = null, memoryManagement = null, sessionStateProvider = null, backendDiagnosticProvider = null, pluginVersion = 'unknown', uiDiagnosticProvider = null, documentRef = globalThis.document, navigatorRef = globalThis.navigator, confirmImpl = options => globalThis.confirm?.(typeof options === 'string' ? options : `${options?.title ?? '请确认'}\n\n${options?.body ?? ''}`) === true, chooseImpl = null, infoImpl = () => Promise.resolve(true), customImpl = null } = {}) {
  if (!runtime || ['getState', 'refreshStatus', 'confirmLatest'].some(name => typeof runtime[name] !== 'function')) throw new TypeError('V3 foundation view runtime 无效');
  if (recallRuntime && typeof recallRuntime.getState !== 'function') throw new TypeError('V3 recall view runtime 无效');
  if (peopleRuntime && typeof peopleRuntime.getState !== 'function') throw new TypeError('V3 people workspace runtime 无效');
  if (memoryManagement && (typeof memoryManagement.getState !== 'function' || typeof memoryManagement.deleteCurrent !== 'function')) throw new TypeError('当前聊天记忆管理器无效');
  if (sessionStateProvider !== null && typeof sessionStateProvider !== 'function') throw new TypeError('聊天身份状态 provider 无效');
  if (uiDiagnosticProvider !== null && typeof uiDiagnosticProvider !== 'function') throw new TypeError('界面诊断 provider 无效');
  if (!documentRef?.createElement) throw new TypeError('V3 foundation view documentRef 无效');

  let container = null, active = false, epoch = 0, feedback = '', receiptFeedback = '', prequelFeedback = '', fallbackText = '', unsubscribe = null;
  let page = 'management';
  let peopleMode = 'current', selectedCsePersonId = null, showMoreCsePeople = false;
  let foundationState = runtime.getState(), recallState = recallRuntime?.getState?.() ?? null, peopleState = peopleRuntime?.getState?.() ?? null, managementState = memoryManagement?.getState?.() ?? null, chatId = foundationState?.chatId ?? null, healthNode = null, managementFeedbackNode = null;
  let syncingChatId = null;
  let recentItemsOpen = false, recentItemsUi = null, showStoppedItems = false, recentItemDraft = null, recentBatchMode = false;
  let memorySearchQuery = '', cseSearchQuery = '';
  const selectedRecentItems = new Map();
  let relationSwitcherNode = null, relationSwitcherSignature = null, relationSwitcherChatId = chatId, relationSwitcherScrollLeft = 0;
  const drafts = new Map();
  const cseDrafts = new Map();
  let prequelDraft = null;
  const openState = new Map();
  const peopleScroll = new Map([['current', 0], ['history', 0]]);
  const operationMenus = createOperationMenuController(documentRef);

  const element = (tag, className = '', value = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (value !== '') node.textContent = value;
    return node;
  };
  const confirmHistoricalMode = async ({ fullRebuild = false } = {}) => {
    const title = fullRebuild ? '完全重构当前聊天记忆' : '补齐当前聊天记忆';
    const body = fullRebuild
      ? '当前聊天的千千结记录将全部删除，包括摘要、人物状态、千人人物资料、头像、重要人物选择、时间事项、前情及所有人工修改，再从头重新生成，并按正文分批补查时间事项（每批最多20楼且受输入预算限制，会使用摘要 API；全部稳定范围完成后最多再调用一次摘要 API评估当前活跃事项，失败、部分完成或停止不自动重试）；聊天正文、其他插件数据和全局设置保留。'
      : '已有摘要和人物状态会保留，只处理缺失部分；刷新页面后不会自动续跑。';
    if (typeof chooseImpl !== 'function') {
      if (!fullRebuild) return Object.freeze({ aggregate: false });
      const confirmed = await Promise.resolve(confirmImpl({ title, body, confirmText: '完全重构', cancelText: '取消' }));
      return confirmed ? Object.freeze({ aggregate: false }) : null;
    }
    const selected = await Promise.resolve(chooseImpl({
      title,
      body,
      note: '选择“是”会把连续 10 个 AI 楼合成一份压缩记忆，并在批末分析一次人物状态，能减少请求和记忆数量，但会舍去较多枝节；选择“否”会按普通逐楼模式处理。关闭窗口不会开始任务。',
      choices: [
        { value: false, label: '否（普通逐楼模式）' },
        { value: true, label: '是（高楼压缩模式）', primary: true },
      ],
    }));
    return typeof selected === 'boolean' ? Object.freeze({ aggregate: selected }) : null;
  };
  const scrollEditorToTop = selector => scrollManualEditorToTop(container.querySelector(selector));
  const row = (label, value) => { const node = element('div', 'v3-foundation-row'); node.append(element('dt', '', label), element('dd', '', text(value))); return node; };
  const stageRow = (label, value) => {
    const node = element('div', 'v3-foundation-row'), copy = element('dd');
    copy.append(element('div', '', value.main));
    if (value.token) copy.append(element('div', '', value.token));
    node.append(element('dt', '', label), copy); return node;
  };
  const setDetailsState = (node, key, defaultOpen = false) => {
    node.open = openState.has(key) ? openState.get(key) : defaultOpen;
    node.addEventListener('toggle', () => openState.set(key, node.open === true));
    return node;
  };
  const resetForChat = nextChatId => {
    if (nextChatId === chatId) return false;
    showStoppedItems = false; recentItemDraft = null; recentBatchMode = false; selectedRecentItems.clear();
    if (chatId !== null) { prequelDraft = null; prequelFeedback = ''; }
    chatId = nextChatId; drafts.clear(); cseDrafts.clear(); openState.clear(); recentItemsOpen = false; recentItemsUi = null; memorySearchQuery = ''; cseSearchQuery = ''; peopleMode = 'current'; selectedCsePersonId = null; showMoreCsePeople = false; peopleScroll.set('current', 0); peopleScroll.set('history', 0); relationSwitcherNode = null; relationSwitcherSignature = null; relationSwitcherChatId = nextChatId; relationSwitcherScrollLeft = 0; fallbackText = ''; feedback = '';
    return true;
  };
  const sourceChanged = (previous, next) => (previous?.chatId ?? null) !== (next?.chatId ?? null);
  const searchControl = ({ value, placeholder, ariaLabel, onInput, onClear }) => {
    const control = element('div', 'qqj-history-search');
    const input = element('input', 'settings-input qqj-history-search-input'); input.type = 'search'; input.value = value; input.placeholder = placeholder; input.setAttribute('aria-label', ariaLabel);
    const clear = element('button', 'secondary-action qqj-history-search-clear', '清空'); clear.type = 'button'; clear.hidden = !String(value).trim();
    input.addEventListener('input', () => { clear.hidden = !String(input.value).trim(); onInput(input.value); });
    clear.addEventListener('click', () => { input.value = ''; clear.hidden = true; onClear(); input.focus(); });
    control.append(input, clear); return control;
  };
  const errorMessage = value => {
    if (value === null || value === undefined || value === '') return '';
    return publicErrorMessage(value, { fallback: '记忆处理失败，请稍后重试。' });
  };
  const sessionErrorCopy = () => {
    const sessionState = readDiagnosticState(sessionStateProvider);
    return sessionState?.status === 'error' ? errorMessage(sessionState.error) || '当前聊天身份准备失败，请稍后重试。' : '';
  };
  const uninitializedCopy = state => {
    if (effectiveStatus(state) !== 'uninitialized') return '';
    return state.canInitialize === true || (state.inspectedStableCount ?? 0) > 0
      ? '当前聊天尚未建立记忆，可在记忆管理中点击“补齐缺失”处理已有楼层'
      : state.autoMemoryEnabled === false
        ? '当前聊天尚未开始记录，自动摘要已关闭；后续可在记忆管理中手动“补齐缺失”'
        : '当前聊天尚未开始记录，继续对话后可开始记录';
  };
  const peopleSharedError = state => {
    if (state.pluginEnabled === false) return '';
    const foundationError = errorMessage(state.lastError); if (foundationError) return `共享记忆：${foundationError}`;
    const foundationStatus = effectiveStatus(state);
    if (!['ready', 'running', 'uninitialized'].includes(foundationStatus)) return `共享记忆${statusCopy(foundationStatus)}`;
    const workspaceError = errorMessage(peopleState?.lastError); if (workspaceError) return `重要人物选择：${workspaceError}`;
    if (foundationStatus !== 'uninitialized' && peopleState && ['idle', 'stale', 'error', 'disabled'].includes(peopleState.status)) return `重要人物选择${statusCopy(peopleState.status)}`;
    return '';
  };
  const errorCopy = state => sessionErrorCopy() || (page === 'memories' ? errorMessage(state.lastExtractorError) || errorMessage(state.lastError)
    : page === 'people' ? peopleSharedError(state) || errorMessage(state.lastCseError)
      : errorMessage(state.memorySyncError) || errorMessage(state.lastExtractorError) || errorMessage(state.lastError));
  const healthCopy = state => {
    if (state.pluginEnabled === false) return '千千结已关闭';
    const time = timeRuntime?.getState?.();
    const sessionError = sessionErrorCopy(); if (sessionError) return `记忆读取失败 · ${sessionError}`;
    if (state.memorySnapshotStatus === 'syncing' && !(state.floors ?? []).length) return '正在读取当前聊天记忆';
    if (state.activeExtraction && state.activeCse) return `摘要与人物状态并行 · 摘要 ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼 · 人物状态待分析 ${state.csePendingCount ?? 0} 楼`;
    if (!memoryBusy(state) && !cseBusy(state) && !workBusy(state) && !errorCopy(state)) {
      if (time?.active) return time.phase === 'saving' ? '正在保存时间事项' : time.phase === 'projecting' ? '正在推算时间状态' : '正在整理时间事项';
      if (page === 'management' && ['failed', 'partial'].includes(time?.status)) return time.last?.message ?? '时间事项处理失败';
    }
    if (page === 'memories') {
      if (memoryBusy(state)) return `正在处理摘要 · ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼${state.activeAutoMemory?.cseBlocked ? ' · 人物状态待重试' : ''}`;
      const error = errorCopy(state); if (error) return state.lastExtractorError?.phase === 'anchor'
        ? `消息标识保存待重试 · ${error}`
        : !state.lastExtractorError || state.lastExtractorError.floorId === null ? `记忆读取失败 · ${error}` : `摘要提取失败 · ${error}`;
      const uninitialized = uninitializedCopy(state); if (uninitialized) return uninitialized;
      const waiting = state.unregisteredCandidates?.length ?? 0;
      return `已记忆 ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼 · 待摘要 ${state.unprocessedCount ?? 0} 楼${waiting ? ` · 另有 ${waiting} 楼尚未摘要，正在等待确认` : ''}${state.memorySyncStatus === 'syncing' ? ' · 后台同步中' : ''}`;
    }
    if (page === 'people') {
      if (cseBusy(state)) return `正在分析人物状态 · 待分析 ${state.csePendingCount ?? 0} 楼`;
      const error = errorCopy(state); if (error) return `人物状态需要处理 · ${error}`;
      const uninitialized = uninitializedCopy(state); if (uninitialized) return uninitialized;
      const complete = Math.max(0, (state.rememberedCount ?? 0) - (state.csePendingCount ?? 0) - (state.cseFailedCount ?? 0));
      return `人物状态 ${complete}/${state.rememberedCount ?? 0} 楼 · 待分析 ${state.csePendingCount ?? 0} 楼${state.memorySyncStatus === 'syncing' ? ' · 后台同步中' : ''}`;
    }
    if (workBusy(state) || state.status === 'running') return `${workPhaseCopy(state)} · ${state.rebuildCompletedCount ?? state.rememberedCount ?? 0}/${state.rebuildTotalCount ?? state.stableCount ?? 0} 楼${state.activeAutoMemory?.cseBlocked ? ' · 人物状态待重试' : ''}`;
    const error = errorCopy(state); if (error) return `需要处理 · ${error}`;
    const uninitialized = uninitializedCopy(state); if (uninitialized) return uninitialized;
    return `已记忆 ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼 · 人物状态 ${state.cseReady ? '已跟上' : `待分析 ${state.csePendingCount ?? 0} 楼`}${time?.status === 'completed' ? ` · 时间推演完成 ${time.last?.items ?? 0} 项，未纳入 ${time.last?.omitted ?? 0} 项` : ''}`;
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

  async function copy(value, { local = false } = {}) {
    if (navigatorRef?.clipboard?.writeText) {
      try { await navigatorRef.clipboard.writeText(value); if (!local) fallbackText = ''; return '已复制。'; }
      catch { /* 浏览器或壳层拒绝剪贴板权限时改用只读文本框。 */ }
    }
    if (!local) fallbackText = value; return '浏览器不允许直接复制，请在下方文本框长按全选复制。';
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
      backend: readDiagnosticState(backendDiagnosticProvider),
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
        reviewReason: reviewReasonDiagnostic(memory?.reviewReason, memoryKnown),
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
        lastAutomationError: errorDiagnostic(memory?.lastAutomationError, memoryKnown),
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
    const mine = ++epoch; feedback = `${label}…`; updateManagementFeedback(foundationState); updateHealth(foundationState);
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
      feedback = `${label}失败：${publicErrorMessage(error, { fallback: '操作没有完成，请重试。' })}`; render(runtime.getState());
      return { status: 'error', error };
    }
  }
  const floorActionResult = (label, floorId, kind = 'extract') => (state, beforeState) => {
    const floor = state?.floors?.find(item => item.floorId === floorId);
    const beforeFloor = beforeState?.floors?.find(item => item.floorId === floorId);
    const targetFloor = floorCopy(state, floor ?? { floorId }, '目标楼');
    if (kind === 'cse') {
      const changed = Boolean(floor?.cse?.deltaId && floor.cse.deltaId !== beforeFloor?.cse?.deltaId);
      if (!changed || !['ready', 'noChange'].includes(floor?.cse?.status)) return `${label}未完成：${targetFloor} · ${errorMessage(state?.lastCseError) || errorMessage(floor?.cse?.error) || '人物状态尚未保存。'}`;
      return `${label}完成：${targetFloor}人物状态已保存。`;
    }
    const changed = Boolean(floor?.memoryId && floor.memoryId !== beforeFloor?.memoryId);
    if (!changed || floor.status !== 'ready') return `${label}未完成：${targetFloor} · ${errorMessage(state?.lastExtractorError) || errorMessage(floor?.error) || '没有保存新的摘要。'}`;
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
      return `${label}未完成：${failedFloors || (result.floorId ? targetFloor : '')}${failedFloors || result.floorId ? ' · ' : ''}${errorMessage(result.message) || '本次没有保存新结果，请重试。'}`;
    }
    if (result?.status === 'paused') return `${label}已暂停：已保存的结果不会丢失。`;
    if (['completed', 'caughtUp'].includes(result?.status)) return `${label}完成：新增摘要 ${result.processed ?? 0} 楼，补齐人物状态 ${result.cseProcessed ?? 0} 楼。`;
    return `${label}结束：${statusCopy(state?.rebuildStatus ?? state?.status)}`;
  };
  const cseRebuildResult = label => state => {
    const status = state?.cseRebuildStatus;
    if (status === 'completed') return `${label}完成：人物状态 ${state.cseRebuildCompletedCount ?? 0}/${state.cseRebuildTotalCount ?? 0} 楼。`;
    if (status === 'paused') return `${label}已暂停：已完成 ${state.cseRebuildCompletedCount ?? 0}/${state.cseRebuildTotalCount ?? 0} 楼，可继续。`;
    if (status === 'failed') return `${label}未完成：${floorCopy(state, { assistantSeq: state.cseRebuildNextAssistantSeq }, '目标楼')} · ${errorMessage(state.cseRebuildError) || errorMessage(state.lastCseError) || '可继续重试。'}`;
    return `${label}结束：CSE ${statusCopy(status)}`;
  };
  const refreshResult = state => {
    if (state?.memorySnapshotStatus === 'error' || state?.memorySyncStatus === 'error' || state?.status === 'error') {
      return `刷新状态未完成：${errorMessage(state?.memorySyncError) || errorCopy(state) || '当前聊天读取失败，请重试。'}`;
    }
    if (state?.memorySnapshotStatus === 'ready') return state.memorySyncStatus === 'syncing'
      ? '当前聊天已读取完成；后台校验仍在进行。'
      : '当前聊天已读取完成。';
    if (effectiveStatus(state) === 'uninitialized') return '当前聊天尚未建立记忆，状态已读取完成。';
    return `刷新状态结束：${statusCopy(effectiveStatus(state))}`;
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
    card.setAttribute('data-qqj-floor-id', floor.floorId);
    const head = element('summary', 'qqj-memory-card-head');
    const memory = floor.memory;
    const times = floorTimeDisplay(memory?.chronology, floor.timeFallback) || '时间未明确';
    const timeNode = element('span', 'qqj-floor-time', times); timeNode.setAttribute('title', times);
    const floorStatus = floor.summarySource === 'user' && floor.status === 'ready' ? '人工修订' : statusCopy(floor.status);
    const statusNode = element('span', `v3-memory-status${floor.summarySource === 'user' && floor.status === 'ready' ? ' is-user' : ''}`, floorStatus);
    const chevron = element('span', 'qqj-memory-chevron', '›'); chevron.setAttribute('aria-hidden', 'true');
    head.append(element('strong', 'qqj-floor-number', floorCopy(state, floor)), timeNode, statusNode, chevron);
    card.append(head);
    const body = element('div', 'qqj-memory-card-body');
    const draft = drafts.get(key);
    if (draft) {
      const editBox = element('div', 'v3-memory-edit qqj-manual-editor');
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
        if (unchangedDraft(draft, payload)) { drafts.delete(key); feedback = '未修改内容。'; render(foundationState); scrollEditorToTop(`[data-qqj-floor-id="${floor.floorId}"]`); return; }
        const saveIdentity = {}; draft.saveIdentity = saveIdentity; draft.saving = true; draft.saveError = '';
        save.textContent = '保存中…'; save.disabled = true; cancel.disabled = true;
        const currentDraft = () => {
          const latest = runtime.getState?.() ?? foundationState;
          const latestFloor = latest?.floors?.find(item => item.floorId === floor.floorId);
          return drafts.get(key) === draft && draft.saveIdentity === saveIdentity && latest?.chatId === state.chatId && latestFloor?.floorId === draft.floorId;
        };
        const task = typeof runtime.editMemory === 'function' ? () => runtime.editMemory(floor.floorId, payload) : () => runtime.editSummary(floor.floorId, payload.summary, payload.revisionNote);
        let saved = false;
        void run('保存本楼记忆', task, {
          after: () => { if (!currentDraft()) return false; drafts.delete(key); saved = true; return true; },
          failed: error => { if (!currentDraft()) return false; draft.saving = false; draft.saveError = `保存失败：${publicErrorMessage(error, { fallback: '本楼记忆没有保存，请重试。' })}`; return true; },
        }).then(() => { if (saved && active && container) scrollEditorToTop(`[data-qqj-floor-id="${floor.floorId}"]`); });
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
        edit.addEventListener('click', () => { const memory = floor.memory; const names = new Map((state.memoryEntities ?? []).map(entity => [entity.entityId, entity.displayName])); const originalTimeText = floorTimeDisplay(memory?.chronology, floor.timeFallback); const locations = (memory?.locations ?? []).map(item => ({ itemId: item.itemId, name: item.name ?? '' })); const participantNames = (memory?.participants ?? []).map(item => names.get(item.entityId)).filter(Boolean); drafts.set(key, { floorId: floor.floorId, canonicalFingerprint: floor.canonicalFingerprint, rawFingerprint: floor.rawFingerprint, summary: floor.summary, originalSummary: floor.summary, timeText: originalTimeText, originalTimeText, locations, originalLocations: locations.map(item => ({ ...item })), peopleText: participantNames.join('、'), originalParticipantNames: participantNames, note: '', saving: false, saveError: '' }); render(foundationState); });
        const extract = element('button', 'qqj-memory-menu-action', '重新提取'); extract.type = 'button'; extract.disabled = workBusy(state) || typeof runtime.extractFloor !== 'function';
        extract.addEventListener('click', async () => { const ranged = (floor.sourceFloorIds?.length ?? 0) > 1; if (!await Promise.resolve(confirmImpl({ title: ranged ? '重新提取整段压缩记忆' : '重新提取本楼摘要', body: ranged ? `${floorCopy(state, floor)}会作为一个整体重新压缩并替换这一张范围记忆；已保存的人物状态与其他范围记忆保持不变。` : '重新提取只会替换本楼摘要；已保存的人物状态与其他楼记录保持不变。', confirmText: '重新提取', cancelText: '取消' }))) { feedback = '已取消重新提取。'; render(foundationState); return; } void run('重新提取', () => runtime.extractFloor(floor.floorId), { resultCopy: floorActionResult('重新提取', floor.floorId) }); });
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
  function updateRecentItems() {
    if (!active || page !== 'memories' || !recentItemsUi) return;
    const { toggle, body, status, organize, retryRead, reason, list, stoppedToggle, stop, batchEntry, batchControls, batchAll, batchProblems, batchActions } = recentItemsUi;
    const state = timeRuntime?.getState?.(), result = state?.last, tracked = state?.trackedItems, annual = state?.annualItems;
    const trackedById = new Map((tracked ?? []).map(item => [item.id, item]));
    for (const [id, key] of selectedRecentItems) if (trackedById.get(id)?.observationKey !== key) selectedRecentItems.delete(id);
    toggle.textContent = `近期事项${Array.isArray(tracked) ? `（${tracked.length + (annual?.length ?? 0)}）` : ''}`;
    toggle.className = `secondary-action qqj-profile-more${recentItemsOpen ? ' active' : ''}`;
    toggle.disabled = false;
    toggle.setAttribute('aria-expanded', String(recentItemsOpen)); body.hidden = !recentItemsOpen;
    if (!recentItemsOpen) return;
    const label = state?.status === 'disabled' ? '已关闭' : state?.active ? state.phase === 'saving' ? '保存中' : '处理中' : state?.status === 'waiting' ? '等待记忆同步' : result?.status === 'completed' ? '已处理' : result?.status === 'empty' ? '已检查无适合事项' : result?.status === 'partial' ? '部分完成' : result?.status === 'failed' ? '失败' : result?.status === 'interrupted' ? '上次未完成' : '待初始化';
    status.textContent = `${label}${Array.isArray(tracked) ? ` · 追踪中事项 ${tracked.length} 条` : ''}${state?.coverage ? ` · 正文完整已检查 ${state.coverage.checkedFloors}/${state.coverage.totalFloors} 楼` : ''}${state?.progress ? ` · 本次批次 ${state.progress.completed}/${state.progress.total}` : ''}${result?.message ? `。${result.message}` : ''}`;
    status.className = ['failed', 'partial'].includes(result?.status) ? 'settings-result error' : 'settings-result';
    organize.textContent = result?.currentReview && ['failed', 'interrupted', 'partial'].includes(result?.status) ? '重新更新当前事项' : ['failed', 'interrupted', 'partial'].includes(result?.status) ? '继续补查历史' : '补查历史';
    organize.disabled = state?.canOrganize !== true || result?.reason === 'read' || Boolean(recentItemsUi.pendingAction);
    if (stop) { stop.hidden = !state?.active || state.phase === 'saving'; stop.disabled = !state?.active; }
    retryRead.hidden = result?.reason !== 'read'; retryRead.disabled = state?.active === true || state?.status === 'disabled' || state?.status === 'waiting';
    const stopped = state?.stoppedItems;
    stoppedToggle.textContent = showStoppedItems ? '返回追踪中事项' : `查看停止项${Array.isArray(stopped) ? `（${stopped.length}）` : ''}`;
    stoppedToggle.setAttribute('aria-pressed', String(showStoppedItems));
    stoppedToggle.disabled = recentItemDraft !== null || Boolean(recentItemsUi.pendingAction);
    batchEntry.hidden = showStoppedItems;
    batchEntry.textContent = recentBatchMode ? '取消批量' : '批量管理';
    batchEntry.disabled = recentItemDraft !== null || Boolean(recentItemsUi.pendingAction) || !Array.isArray(tracked);
    batchControls.hidden = !recentBatchMode || showStoppedItems;
    const batchBusy = state?.canOrganize !== true || Boolean(recentItemsUi.pendingAction);
    batchAll.disabled = batchBusy || !tracked?.length;
    batchProblems.disabled = batchBusy || !(tracked ?? []).some(item => item.failureReason || item.assessmentReason || item.reviewStatus === 'unanswered');
    for (const control of batchActions) control.disabled = batchBusy || selectedRecentItems.size === 0;
    reason.textContent = state?.disabledReason || recentItemsUi.planFeedback || `${state?.coverage?.startAssistantSeq ? `从 AI 第 ${state.coverage.startAssistantSeq} 楼开始追踪；${state.coverage.earlierUnchecked > 0 ? `此前 ${state.coverage.earlierUnchecked} 楼正文未检查` : '此前正文已检查'}。` : '等待当前 AI 楼成为追踪起点。'}${state?.coverage?.pendingFloors ? `另有 ${state.coverage.pendingFloors} 楼等待稳定绑定，正文未检查。` : ''}直接读取正文，摘要和人物状态可为空。补查历史会先确认楼数、批次与摘要 API 调用量；成功批次保留，可停止后继续。`;
    if (recentItemDraft) {
      for (const control of recentItemDraft.controls) control.disabled = recentItemDraft.saving || state?.canOrganize !== true;
      recentItemDraft.cancel.disabled = recentItemDraft.saving;
      recentItemDraft.feedback.textContent = recentItemDraft.error;
      organize.disabled = true;
      return;
    }
    const visibleItems = showStoppedItems ? stopped : tracked;
    const message = !Array.isArray(visibleItems) ? state?.status === 'disabled' ? '时间推演已关闭；已有记录保留。' : result?.reason === 'read' ? '时间清单读取失败，请点击“重试读取”。' : '等待当前聊天记忆同步与时间记录读取。' : showStoppedItems ? '当前没有停止的时间事项。' : '当前没有追踪中的时间事项。';
    const displayItems = (Array.isArray(visibleItems) ? visibleItems : []).map(item => {
      const stopped = item.status && item.status !== 'active';
      const stoppedLabel = { completed: '已完成', paused: '已暂停', cancelled: '已移除' }[item.status];
      const formatTime = value => value?.date ? `${value.date}${value.clock ? ` ${value.clock}` : ''}` : value?.raw || '时间未知';
      const elapsed = item.elapsedHours !== null && item.elapsedHours >= 0 ? `发生后已过 ${Math.round(item.elapsedHours * 10) / 10} 小时`
        : item.elapsedDays !== null && item.elapsedDays >= 0 ? `发生后已过 ${item.elapsedDays} 天`
          : item.observationElapsedHours !== null && item.observationElapsedHours >= 0 ? `观察后已过 ${Math.round(item.observationElapsedHours * 10) / 10} 小时`
            : item.observationElapsedDays !== null && item.observationElapsedDays >= 0 ? `观察后已过 ${item.observationElapsedDays} 天` : '经过时间未知';
      return [`${item.person} · ${item.label}${item.status && item.status !== 'active' ? ` · ${item.mergedInto ? '已归并' : { completed: '已完成', paused: '已暂停', cancelled: '已移除' }[item.status]}` : ''}`, `原观察：${item.observation}`,
        ...(item.mergeDescription ? [`归并经历：${item.mergeDescription}`] : []),
        `观察时间：${formatTime(item.observationTime)}${item.occurrenceTime?.date ? `；发生时间：${formatTime(item.occurrenceTime)}` : ''}；${elapsed}`,
        stopped ? item.mergedInto ? '因归并退出独立追踪，原观察保留；恢复会解除归并。' : item.retirementReason ? `已暂停自动跟进：${item.retirementReason}；这不代表已痊愈，需要时可恢复。` : `${stoppedLabel}，已停止追踪；需要时可恢复。` : item.projection ? `当前推测：${item.projection}` : item.assessmentReason ? `当前依据不足：${item.assessmentReason}` : item.reviewStatus === 'omitted' ? '本次未纳入当前评估。' : item.reviewStatus === 'unanswered' ? '本次未返回有效当前评估，请手动更新。' : '当前估计待更新，原观察仍保留。',
        ...(item.failureReason ? [`本次未更新：${item.failureReason} 原内容已保留，可编辑或移除。`] : []),
        ...(!stopped && item.projection && item.reviewStatus ? [item.reviewStatus === 'omitted' ? '本次未纳入当前评估。' : '本次未返回有效当前评估，请手动更新。'] : []),
        ...(!stopped && item.oldProjection ? [`截至 ${formatTime(item.oldProjection.applicableTime)} 的旧推测：${item.oldProjection.text}；当前待更新。`] : []),
        ...(['cycle', 'deadline'].includes(item.type) ? [`${item.type === 'cycle' ? '预计周期日' : '约定期限'}：${formatTime(item.dueTime)}${item.periodDays ? `；明确周期 ${item.periodDays} 天` : ''}${stopped ? '' : '；尚未确认发生或完成。'}`] : [])];
    });
    const titleIssues = (Array.isArray(visibleItems) ? visibleItems : []).map(item => item.status === 'active'
      && Boolean(item.failureReason || item.assessmentReason || item.reviewStatus === 'unanswered'));
    if (!showStoppedItems) for (const item of annual ?? []) displayItems.push([`${item.person} · ${item.label} · ${item.status}`, `原日期：${item.originalDate}`,
      item.nextDate ? `下次日期：${item.nextDate}${Number.isInteger(item.distance) ? item.distance === 0 ? '；已到本日' : `；还有 ${item.distance} 天` : '；当前休眠'}` : '日期待明确：保留原设定，不自动套用公历。',
      `${item.note ? `年度含义：${item.note}；` : ''}只读事项，请在千人基础资料或用户人设中修改。`]), titleIssues.push(false);
    const signature = JSON.stringify([displayItems.length ? displayItems : message, titleIssues, recentBatchMode, [...selectedRecentItems], (visibleItems ?? []).map(item => [item.id, item.observationKey]), (annual ?? []).map(item => [item.id, item.status, item.nextDate])]);
    if (recentItemsUi.listSignature === signature) { for (const control of recentItemsUi.itemControls) control.disabled = state?.canOrganize !== true || Boolean(recentItemsUi.pendingAction); return; }
    recentItemsUi.listSignature = signature;
    list.replaceChildren();
    recentItemsUi.itemControls = [];
    if (!displayItems.length) list.append(element('p', 'settings-hint', message));
    else for (const [index, [title, ...lines]] of displayItems.entries()) {
      const entry = element('div', 'settings-field');
      const head = element('div', 'qqj-recent-item-head');
      const item = visibleItems[index];
      if (recentBatchMode && !showStoppedItems && item) {
        const select = element('input', 'qqj-recent-item-select'); select.type = 'checkbox'; select.checked = selectedRecentItems.get(item.id) === item.observationKey;
        select.setAttribute('aria-label', `选择${item.label}`); select.disabled = batchBusy;
        select.addEventListener('change', () => { if (select.checked) selectedRecentItems.set(item.id, item.observationKey); else selectedRecentItems.delete(item.id); recentItemsUi.listSignature = null; updateRecentItems(); });
        head.append(select); recentItemsUi.itemControls.push(select);
      }
      head.append(element('span', `qqj-recent-item-title${titleIssues[index] ? ' error' : ''}`, title));
      entry.append(head, ...lines.map(line => element('p', 'settings-hint', line))); list.append(entry);
      if (!item) continue;
      const actions = operationMenus.register(element('details', 'qqj-profile-menu'));
      const menuToggle = element('summary', 'qqj-profile-menu-toggle', '⋮'); menuToggle.setAttribute('aria-label', `${item.label}事项操作`); menuToggle.setAttribute('title', '事项操作'); menuToggle.setAttribute('aria-haspopup', 'menu');
      const menuBody = element('div', 'qqj-profile-menu-pop'); menuBody.setAttribute('role', 'menu');
      const actionFeedback = element('p', 'settings-result error');
      const addAction = (label, callback) => { const button = element('button', `qqj-profile-menu-action${label === '移除' ? ' danger' : ''}`, label); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.disabled = state?.canOrganize !== true || Boolean(recentItemsUi.pendingAction); button.addEventListener('click', () => { if (button.disabled) return; actions.open = false; return callback(); }); menuBody.append(button); recentItemsUi.itemControls.push(button); };
      if (typeof timeRuntime?.editItem === 'function' && !recentBatchMode) {
        addAction('编辑事项', () => startRecentEdit(item, entry));
        if (item.status === 'active') for (const [label, value] of [['完成', 'completed'], ['暂停', 'paused'], ['移除', 'cancelled']]) addAction(label, () => changeRecentStatus(item, value, actionFeedback));
        else addAction('恢复追踪', () => changeRecentStatus(item, 'active', actionFeedback));
        actions.append(menuToggle, menuBody); head.append(actions); entry.append(actionFeedback);
      }
    }
  }
  async function changeRecentStatus(item, status, actionFeedback) {
    const ui = recentItemsUi, originalChatId = chatId, mine = epoch;
    const action = { completed: '完成', paused: '暂停', cancelled: '移除', active: '恢复追踪' }[status];
    const currentUi = () => active && page === 'memories' && recentItemsUi === ui && chatId === originalChatId && epoch === mine && runtime.getState()?.chatId === originalChatId;
    const canSave = () => { const state = timeRuntime.getState(); return currentUi() && !recentItemDraft && state.canOrganize === true && [...(state.trackedItems ?? []), ...(state.stoppedItems ?? [])].some(value => value.id === item.id && value.observationKey === item.observationKey); };
    if (ui.pendingAction || !canSave()) return;
    const pending = {}; ui.pendingAction = pending; actionFeedback.textContent = ''; updateRecentItems();
    try {
      const confirmed = await Promise.resolve(confirmImpl({ title: `${action}时间事项`, body: `确认${action}“${item.label}”？${status === 'active' ? item.mergedInto ? '本次解除归并，恢复独立跟进；主项当前合并描述与推测失效，原观察保留。' : '恢复后可继续追踪。' : '停止项仍可查看和恢复。'}保存不调用模型，会清除旧推测。`, confirmText: action, cancelText: '取消' }));
      if (!confirmed || !canSave()) return;
      await timeRuntime.editItem(item.id, { status }, item.observationKey);
    } catch (error) { if (currentUi()) actionFeedback.textContent = `保存失败：${publicErrorMessage(error, { fallback: '事项未保存，请重试。' })}`; }
    finally { if (ui.pendingAction === pending) ui.pendingAction = null; updateRecentItems(); }
  }
  async function changeRecentStatuses(status, actionFeedback) {
    const ui = recentItemsUi, originalChatId = chatId, mine = epoch, selected = [...selectedRecentItems].map(([itemId, observationKey]) => ({ itemId, observationKey, fields: { status } }));
    const action = { completed: '完成', paused: '暂停', cancelled: '移除' }[status];
    const currentUi = () => active && page === 'memories' && recentItemsUi === ui && chatId === originalChatId && epoch === mine && runtime.getState()?.chatId === originalChatId;
    const canSave = () => {
      const state = timeRuntime.getState(), current = new Map((state.trackedItems ?? []).map(item => [item.id, item]));
      return currentUi() && recentBatchMode && !recentItemDraft && state.canOrganize === true && selected.length > 0
        && selected.every(edit => current.get(edit.itemId)?.observationKey === edit.observationKey);
    };
    if (ui.pendingAction || typeof timeRuntime?.editItems !== 'function' || !canSave()) return;
    const pending = {}; ui.pendingAction = pending; actionFeedback.textContent = ''; updateRecentItems();
    try {
      const confirmed = await Promise.resolve(confirmImpl({ title: `批量${action}时间事项`, body: `确认${action}已选的 ${selected.length} 项？停止项仍可查看和恢复。保存不调用模型，会清除旧推测。`, confirmText: `批量${action}`, cancelText: '取消' }));
      if (!confirmed || !canSave()) return;
      await timeRuntime.editItems(selected);
      if (!currentUi()) return;
      selectedRecentItems.clear(); recentBatchMode = false;
    } catch (error) { if (currentUi()) actionFeedback.textContent = `保存失败：${publicErrorMessage(error, { fallback: '事项未保存，请重试。' })}`; }
    finally { if (ui.pendingAction === pending) ui.pendingAction = null; updateRecentItems(); }
  }
  function startRecentEdit(item, entry) {
    const timeValue = value => value?.raw || (value?.date ? `${value.date}${value.clock ? ` ${value.clock}` : ''}` : '');
    const draft = { item, chatId, foundationState, ui: recentItemsUi, fields: { label: item.label, observation: item.observation, observationTime: timeValue(item.observationTime), occurrenceTime: timeValue(item.occurrenceTime), dueTime: timeValue(item.dueTime), periodDays: item.periodDays ?? '' }, controls: [], saving: false, error: '' };
    const initialFields = { ...draft.fields };
    recentItemDraft = draft;
    const editor = element('div', 'qqj-profile-form');
    {
      const field = (name, label, multiline = false) => { const row = element('label', 'settings-field'), input = element(multiline ? 'textarea' : 'input', 'settings-input'); input.value = draft.fields[name]; input.addEventListener('input', () => { draft.fields[name] = input.value; }); input.setAttribute('aria-label', label); row.append(element('span', '', label), input); editor.append(row); draft.controls.push(input); };
      field('label', '事项名称'); field('observation', '观察描述', true); field('observationTime', '观察时间'); field('occurrenceTime', '发生时间（可空，优先用于计算经过时间）');
      if (['cycle', 'deadline'].includes(item.type)) field('dueTime', item.type === 'cycle' ? '预计周期日' : '约定期限');
      if (item.type === 'cycle') { field('periodDays', '周期天数（可空）'); editor.append(element('p', 'settings-hint', '已知发生时间与周期天数时，预计周期日由程序计算。模糊时间保留原词，不补现实年份。')); }
    }
    editor.append(element('p', 'settings-hint', '人工保存不调用模型，会清除旧推测。后续真实正文仍可更新事项，没有永久锁。'));
    const actions = element('div', 'v3-foundation-actions'), save = element('button', 'secondary-action', '保存事项'), cancel = element('button', 'secondary-action', '取消事项编辑');
    save.type = 'button'; cancel.type = 'button'; draft.controls.push(save); draft.cancel = cancel; draft.feedback = element('p', 'settings-result error');
    actions.append(save, cancel); editor.append(actions, draft.feedback); entry.append(editor);
    const finish = () => { recentItemDraft = null; draft.ui.listSignature = null; if (active && container && page === 'memories' && draft.foundationState !== foundationState) render(foundationState); else updateRecentItems(); };
    cancel.addEventListener('click', () => { if (!draft.saving) finish(); });
    save.addEventListener('click', async () => {
      if (save.disabled || draft.saving) return;
      const fields = Object.fromEntries(Object.entries(draft.fields).filter(([name, value]) => value !== initialFields[name]));
      if (!Object.keys(fields).length) { finish(); return; }
      draft.saving = true; draft.error = ''; updateRecentItems();
      try {
        await timeRuntime.editItem(item.id, fields, item.observationKey);
        if (recentItemDraft !== draft || chatId !== draft.chatId) return;
        finish();
      } catch (error) { if (recentItemDraft === draft && chatId === draft.chatId) { draft.saving = false; draft.error = `保存失败：${publicErrorMessage(error, { fallback: '事项未保存，请重试。' })}`; } }
      updateRecentItems();
    });
    for (const control of recentItemsUi.itemControls) control.disabled = true;
    updateRecentItems();
  }
  function renderRecentItems(memorySearch) {
    if (recentItemDraft) { recentItemsUi = recentItemDraft.ui; updateRecentItems(); return recentItemsUi.section; }
    const section = element('section', 'qqj-profile-toolbar');
    const actions = element('div', 'qqj-profile-toolbar-actions qqj-memory-toolbar');
    const toggle = element('button', 'secondary-action qqj-profile-more', '近期事项'); toggle.type = 'button';
    const body = element('div', 'settings-block'); body.id = 'qqj-recent-items'; toggle.setAttribute('aria-controls', body.id);
    const row = element('div', 'qqj-profile-switch-row'), copy = element('div');
    const status = element('p', 'settings-result'); status.setAttribute('role', 'status');
    const organize = element('button', 'secondary-action', '补查历史'); organize.type = 'button';
    const retryRead = element('button', 'secondary-action', '重试读取'); retryRead.type = 'button';
    const stop = element('button', 'secondary-action', '停止补查'); stop.type = 'button'; stop.hidden = true;
    stop.addEventListener('click', () => timeRuntime?.stop?.());
    const buttons = element('div', 'qqj-profile-toolbar-actions'); buttons.append(retryRead, stop, organize);
    const reason = element('p', 'settings-hint'), list = element('div', 'v3-foundation');
    const listActions = element('div', 'qqj-recent-list-actions');
    const stoppedToggle = element('button', 'secondary-action', '查看停止项'); stoppedToggle.type = 'button';
    const batchEntry = element('button', 'secondary-action', '批量管理'); batchEntry.type = 'button';
    listActions.append(stoppedToggle, batchEntry);
    const batchControls = element('div', 'qqj-recent-batch-controls'); batchControls.hidden = true;
    const batchAll = element('button', 'secondary-action', '选择当前列表'), batchProblems = element('button', 'secondary-action', '选择问题项'); batchAll.type = 'button'; batchProblems.type = 'button';
    const batchActions = [['批量完成', 'completed'], ['批量暂停', 'paused'], ['批量移除', 'cancelled']].map(([label, value]) => { const button = element('button', `secondary-action${value === 'cancelled' ? ' danger' : ''}`, label); button.type = 'button'; button.addEventListener('click', () => changeRecentStatuses(value, batchFeedback)); return button; });
    const batchFeedback = element('p', 'settings-result error');
    batchControls.append(batchAll, batchProblems, ...batchActions); listActions.append(batchControls);
    stoppedToggle.addEventListener('click', () => { if (stoppedToggle.disabled) return; showStoppedItems = !showStoppedItems; recentBatchMode = false; selectedRecentItems.clear(); updateRecentItems(); });
    batchEntry.addEventListener('click', () => { if (batchEntry.disabled) return; recentBatchMode = !recentBatchMode; if (!recentBatchMode) selectedRecentItems.clear(); recentItemsUi.listSignature = null; updateRecentItems(); });
    batchAll.addEventListener('click', () => { if (batchAll.disabled) return; selectedRecentItems.clear(); for (const item of timeRuntime.getState().trackedItems ?? []) selectedRecentItems.set(item.id, item.observationKey); recentItemsUi.listSignature = null; updateRecentItems(); });
    batchProblems.addEventListener('click', () => { if (batchProblems.disabled) return; selectedRecentItems.clear(); for (const item of timeRuntime.getState().trackedItems ?? []) if (item.failureReason || item.assessmentReason || item.reviewStatus === 'unanswered') selectedRecentItems.set(item.id, item.observationKey); recentItemsUi.listSignature = null; updateRecentItems(); });
    copy.append(status, reason); row.append(copy, buttons); body.append(row, listActions, batchFeedback, list); actions.append(memorySearch, toggle); section.append(actions, body);
    recentItemsUi = { section, toggle, body, status, organize, retryRead, reason, list, stoppedToggle, stop, batchEntry, batchControls, batchAll, batchProblems, batchActions, itemControls: [], listSignature: null };
    toggle.addEventListener('click', () => { recentItemsOpen = !recentItemsOpen; updateRecentItems(); if (recentItemsOpen) void timeRuntime?.refreshStatus?.(); });
    organize.addEventListener('click', async () => {
      if (organize.disabled) return;
      const ui = recentItemsUi, mine = epoch, originalChatId = chatId;
      const pending = {}; ui.pendingAction = pending; ui.planFeedback = ''; updateRecentItems();
      try {
        const plan = await timeRuntime?.prepareHistoryPlan?.();
        if (!plan || !active || recentItemsUi !== ui || epoch !== mine || chatId !== originalChatId) return;
        if (!plan.apiCalls) { ui.planFeedback = plan.annualSetting?.pending ? `有 ${plan.annualSetting.pending} 个年度设定来源超过单次输入预算，未截断、未标记为已处理；请缩短对应基础资料后重试。` : '当前正文与年度设定已检查，暂无需要补算的事项。'; return; }
        const confirmed = await Promise.resolve(confirmImpl({ title: plan.retryCurrentReview ? '重新更新当前事项' : plan.supplement ? '更新当前时间事项' : '补查历史正文',
          body: `本次待查 ${plan.floorCount} 个 AI 楼，正文预计 ${plan.bodyBatchCount ?? plan.batchCount} 批${plan.currentReview ? '，结束后最多追加 1 次当前事项评估' : ''}${plan.annualSetting?.shouldRequest ? '，另补读年度设定 1 次' : ''}，共最多 ${plan.apiCalls} 次摘要 API 调用。${plan.supplement ? plan.retryCurrentReview ? '上次收尾已尝试，本次明确重新授权更新一次，不自动重试。' : '正文已检查，本次只更新已登记的活跃事项一次。' : '每批最多20楼并受完整输入预算限制；长楼会分片。失败、部分完成或停止时先暂停，不做收尾；已保存结果保留。'}收尾按预算评估活跃事项，未纳入或依据不足会明确说明。`, confirmText: '开始补查', cancelText: '取消' }));
        if (confirmed && active && recentItemsUi === ui && epoch === mine && chatId === originalChatId) await timeRuntime.organize(plan);
      } catch (error) { if (recentItemsUi === ui) ui.planFeedback = publicErrorMessage(error, { fallback: '历史计划读取失败，请重试。' }); }
      finally { if (ui.pendingAction === pending) ui.pendingAction = null; updateRecentItems(); }
    });
    retryRead.addEventListener('click', async () => { if (retryRead.disabled) return; await timeRuntime?.refreshStatus?.({ force: true }); updateRecentItems(); });
    updateRecentItems();
    if (recentItemsOpen) void timeRuntime?.refreshStatus?.();
    return section;
  }
  function renderMemories(state) {
    const pageNode = element('section', 'qqj-page qqj-memories-page');
    pageNode.append(pageStatus(state));
    const list = element('div', 'v3-memory-list');
    const floors = [...(state.floors ?? [])];
    const registeredMessageIndexes = new Set(floors.map(floor => floor.messageIndex).filter(validMessageIndex));
    const waiting = (state.unregisteredCandidates ?? []).filter(candidate => validMessageIndex(candidate?.messageIndex) && !registeredMessageIndexes.has(candidate.messageIndex));
    const consecutive = waiting.filter(candidate => candidate.reason === 'consecutiveAssistant');
    const hasWaitingTail = waiting.some(candidate => candidate.reason === 'waitingNextUser');
    const confirmationScope = state.consecutiveAssistantConfirmation;
    const confirmationCandidates = Array.isArray(confirmationScope?.candidates) ? confirmationScope.candidates : [];
    if (consecutive.length && confirmationCandidates.length && typeof runtime.confirmConsecutiveAssistants === 'function') {
      const action = element('div', 'qqj-inline-panel');
      action.append(element('p', 'settings-hint', `检测到连续 AI 段，共 ${confirmationCandidates.length} 个回复可在本次确认后按原顺序分别登记并进入摘要；其中 ${consecutive.length} 个回复需要你的明确确认。${hasWaitingTail ? '当前最后一条 AI 仍等待下一条用户消息。' : '列表中的回复全部属于本次范围。'}`));
      const confirm = element('button', 'secondary-action', '确认连续 AI 并分别记录'); confirm.type = 'button'; confirm.disabled = workBusy(state);
      confirm.addEventListener('click', async () => {
        const range = confirmationCandidates.map(candidate => `第 ${candidate.messageIndex} 楼`).join('、');
        const accepted = await Promise.resolve(confirmImpl({ title: '确认连续 AI 回复',
          body: `${range} 将分别登记，并按原顺序进入摘要。正文不会删除或合并；${hasWaitingTail ? '当前最后一条 AI 不在本次范围内，仍等待下一条用户消息。' : '以上列表就是本次完整确认范围。'}`, confirmText: '确认并分别记录', cancelText: '取消' }));
        if (!accepted) { feedback = '已取消连续 AI 确认。'; render(foundationState); return; }
        void run('确认连续 AI', () => runtime.confirmConsecutiveAssistants(confirmationScope));
      });
      action.append(confirm); pageNode.append(action);
    }
    const rows = [
      ...floors.map(value => ({ kind: 'registered', value })),
      ...waiting.map(value => ({ kind: 'waiting', value })),
    ].sort((left, right) => (right.value.messageIndex ?? right.value.assistantSeq ?? 0) - (left.value.messageIndex ?? left.value.assistantSeq ?? 0));
    const fillList = () => {
      list.replaceChildren();
      const query = memorySearchQuery.trim();
      if (query) {
        const matches = floors.filter(floor => floor.memoryId && plainSearchIncludes(floor.summary, query))
          .sort((left, right) => (right.messageIndex ?? right.assistantSeq ?? 0) - (left.messageIndex ?? left.assistantSeq ?? 0));
        list.append(element('p', 'qqj-search-count', `在全部摘要中找到 ${matches.length} 条结果`));
        for (const floor of matches) {
          const result = element('article', 'qqj-history-search-result');
          result.append(element('strong', 'qqj-history-search-title', floorCopy(state, floor)), element('p', 'qqj-history-search-snippet', searchSnippet(floor.summary, query)));
          result.setAttribute('role', 'button'); result.setAttribute('tabindex', '0'); result.setAttribute('aria-label', `打开${floorCopy(state, floor)}完整摘要`);
          const openResult = () => { memorySearchQuery = ''; memorySearch.children[0].value = ''; memorySearch.children[1].hidden = true; openState.set(`memory:${state.chatId ?? 'no-chat'}:${floor.floorId}`, true); fillList(); list.querySelector?.(`[data-qqj-floor-id="${floor.floorId}"]`)?.scrollIntoView?.({ block: 'nearest' }); };
          result.addEventListener('click', openResult); result.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openResult(); } });
          list.append(result);
        }
        if (!matches.length) list.append(element('div', 'qqj-inline-empty', '没有包含该文字的摘要。'));
        return;
      }
      for (const row of rows) list.append(row.kind === 'registered' ? renderMemoryFloor(row.value, state) : renderWaitingMemoryFloor(row.value, state));
      if (!rows.length) list.append(element('div', 'qqj-inline-empty', '这里还没有已保存摘要。最新 AI 楼将在下一条用户消息发出后开始摘要。'));
    };
    const memorySearch = searchControl({ value: memorySearchQuery, placeholder: '搜索全部摘要', ariaLabel: '搜索当前聊天的全部摘要', onInput: value => { memorySearchQuery = value; fillList(); }, onClear: () => { memorySearchQuery = ''; fillList(); } });
    if (timeRuntime) pageNode.append(renderRecentItems(memorySearch));
    else { const toolbar = element('section', 'qqj-profile-toolbar'), actions = element('div', 'qqj-profile-toolbar-actions qqj-memory-toolbar'); actions.append(memorySearch); toolbar.append(actions); pageNode.append(toolbar); }
    fillList();
    pageNode.append(list); return pageNode;
  }

  const appendSubjectGroups = (card, subject, state, { core = subject.core ?? [], adaptive = subject.adaptive ?? [], situational = subject.situational ?? [], empty = true, showMeta = true, groupAdaptiveByTarget = true } = {}) => {
    const item = value => { const node = element('li', 'v3-cse-item'); node.append(element('span', 'v3-cse-item-text', value.text)); if (showMeta) { const source = value.sourceFloorId || value.sourceAssistantSeq ? sourceFloorCopy(state, value) : value.origin === 'baseline' ? '来源：聊天基线' : '来源：本地重放'; node.append(element('small', 'v3-cse-item-meta', [...new Set([value.reason, originCopy(value.origin), source, visibilityCopy(value.visibility)])].join(' · '))); } return node; };
    const addGroup = (label, values, groupByTarget = false) => {
      const block = element('div', 'v3-cse-group'); block.append(element('h5', '', label));
      if (!values.length) { if (empty) { block.append(element('p', 'settings-hint', '暂无')); card.append(block); } return; }
      if (groupByTarget) {
        const grouped = new Map(); for (const value of values) { const key = value.towardEntityId || null; grouped.set(key, [...(grouped.get(key) ?? []), value]); }
        for (const [target, targetItems] of grouped) { block.append(element('h6', '', target ? `对 ${targetItems[0].towardDisplayName || '未知人物'}` : '自身状态')); const ul = element('ul', 'v3-cse-items'); targetItems.forEach(value => ul.append(item(value))); block.append(ul); }
      } else { const ul = element('ul', 'v3-cse-items'); values.forEach(value => ul.append(item(value))); block.append(ul); }
      card.append(block);
    };
    addGroup('核心特质', core); addGroup('长期倾向', adaptive, groupAdaptiveByTarget); addGroup('当前情境', situational);
  };
  function renderCseEditor(body, draft, state, key) {
    const editor = element('div', 'qqj-cse-edit qqj-manual-editor');
    const controls = [], disabled = draft.saving === true || workBusy(state);
    editor.append(element('p', 'settings-hint', '修改会保存到对应楼层的人物状态。其他楼层的重算不会改写本楼记录。'));
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
          const target = createInlineSelect({ documentRef, options: [{ value: '', label: '自身状态' }, ...(state.cseTowardCandidates ?? []).map(candidate => ({ value: candidate.entityId, label: candidate.displayName }))], value: item.towardEntityId ?? '', ariaLabel: `${label}对象`, onChange: value => { item.towardEntityId = value || null; } }).node;
          target.disabled = disabled; controls.push(target); meta.append(target);
        }
        const remove = element('button', 'secondary-action', '删除'); remove.type = 'button'; remove.disabled = disabled; remove.addEventListener('click', () => { draft[field].splice(index, 1); render(foundationState); }); controls.push(remove); meta.append(remove); group.append(rowNode);
      });
      const add = element('button', 'secondary-action', `添加${label}`); add.type = 'button'; add.disabled = disabled; add.addEventListener('click', () => { draft[field].push({ itemId: null, text: '', visibility: field === 'core' ? 'authorial' : 'private', towardEntityId: null }); render(foundationState); }); controls.push(add); group.append(add); return group;
    };
    editor.append(category('core', '核心特质'), category('adaptive', '长期倾向', { toward: true }), category('situational', '当前情境', { toward: true }));
    if (draft.saveError) editor.append(element('p', 'v3-foundation-feedback error', draft.saveError));
    const actions = element('div', 'v3-foundation-actions qqj-manual-save-bar');
    const save = element('button', 'primary-action', draft.saving ? '保存中…' : '保存'); save.type = 'button'; save.disabled = draft.saving === true || workBusy(state) || typeof runtime.correctSubjectState !== 'function';
    const cancel = element('button', 'secondary-action', '取消'); cancel.type = 'button'; cancel.disabled = draft.saving === true || workBusy(state);
    draft.controls = [...controls, save, cancel];
    save.addEventListener('click', () => {
      const saveIdentity = {}; draft.saveIdentity = saveIdentity; draft.saving = true; draft.saveError = ''; save.textContent = '保存中…';
      for (const control of draft.controls) control.disabled = true;
      const currentDraft = () => cseDrafts.get(key) === draft && draft.saveIdentity === saveIdentity && (runtime.getState?.() ?? foundationState)?.chatId === draft.chatId;
      const cloneItems = items => items.map(item => ({ ...item }));
      const payload = { expectedCurrentStateId: draft.expectedCurrentStateId, expectedCurrentStateFingerprint: draft.expectedCurrentStateFingerprint, core: cloneItems(draft.core), adaptive: cloneItems(draft.adaptive), situational: cloneItems(draft.situational) };
      let saved = false;
      void run('保存人物状态', () => runtime.correctSubjectState(draft.subjectEntityId, payload), {
        after: () => { if (!currentDraft()) return false; cseDrafts.delete(key); openState.set(`subject:${draft.subjectEntityId}`, true); saved = true; return true; },
        failed: error => { if (!currentDraft()) return false; draft.saving = false; draft.saveError = `保存失败：${publicErrorMessage(error, { fallback: '人物状态没有保存，请重试。' })}`; return true; },
      }).then(() => { if (saved && active && container) scrollEditorToTop(`[data-qqj-cse-entity-id="${draft.subjectEntityId}"]`); });
    });
    cancel.addEventListener('click', () => { cseDrafts.delete(key); feedback = '已取消编辑人物状态。'; render(foundationState); });
    actions.append(save, cancel); editor.append(actions); body.append(editor);
  }
  function renderSubject(subject, state, { person = null, defaultOpen = false, ownOnly = false, title = null, relationNote = false, actionsContainer = null } = {}) {
    const entityId = subject?.subjectEntityId ?? person?.entityId;
    const displayName = person?.displayName || subject?.displayName || '未知人物';
    const key = `${state.chatId ?? 'no-chat'}:${entityId}`;
    const card = relationNote ? element('section', 'qqj-relation-note') : setDetailsState(element('details', 'v3-cse-subject'), `subject:${entityId}`, defaultOpen);
    card.setAttribute('data-qqj-cse-entity-id', entityId);
    if (relationNote) card.setAttribute('aria-label', `${displayName}自身状态`);
    else { const summary = element('summary', 'qqj-person-summary'); summary.append(element('strong', '', title ?? displayName), element('span', 'v3-memory-status', subject ? '人物状态' : '暂无状态')); card.append(summary); }
    const body = element('div', relationNote ? 'qqj-relation-note-body' : 'qqj-person-body');
    const actions = actionsContainer ?? body;
    const draft = cseDrafts.get(key);
    if (draft) card.className += ' qqj-manual-editor-host';
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
    button.addEventListener('click', async () => { if (completed && !await Promise.resolve(confirmImpl({ title: '重新分析人物状态', body: '成功后只会替换本楼人物状态；本楼摘要与其他楼记录保持不变。', confirmText: '重新分析', cancelText: '取消' }))) { feedback = '已取消重新分析人物状态。'; render(foundationState); return; } void run(label, () => runtime.retryStateAnalysis(floor.floorId), { resultCopy: floorActionResult(label, floor.floorId, 'cse') }); });
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
    let fillList = () => {};
    const cseSearch = searchControl({ value: cseSearchQuery, placeholder: '搜索全部分析记录', ariaLabel: '搜索当前聊天的全部人物状态历史', onInput: value => { cseSearchQuery = value; fillList(); }, onClear: () => { cseSearchQuery = ''; fillList(); } });
    const back = element('button', 'secondary-action qqj-cse-view-toggle', '返回当前状态'); back.type = 'button'; back.addEventListener('click', () => switchPeopleMode('current')); headingNode.append(cseSearch, back); section.append(headingNode);
    const list = element('div', 'qqj-cse-history-list');
    const floors = [...(state.floors ?? [])].filter(floor => floor.memoryId).sort((left, right) => (right.messageIndex ?? 0) - (left.messageIndex ?? 0));
    for (const floor of floors) {
      const rowNode = setDetailsState(element('details', 'qqj-cse-history-row'), `cse-floor:${floor.floorId}`, false);
      const rowSummary = element('summary', 'qqj-cse-floor-summary'); rowSummary.append(element('span', '', floorCopy(state, floor)), element('span', 'v3-memory-status', statusCopy(floor.cse?.status))); rowNode.append(rowSummary);
      const body = element('div', 'qqj-cse-floor-body'), record = floor.cse?.record;
      if (record) {
        if (record.fixedChangesAvailable === false) {
          const resultNode = element('section', 'qqj-cse-floor-result'); resultNode.append(element('strong', 'qqj-cse-floor-result-title', '本楼已保存状态'));
          const resultBody = element('div', 'qqj-cse-floor-state-body'), subjects = record.endStateSubjects ?? [];
          for (const subject of subjects) {
            const subjectNode = element('section', 'qqj-cse-record-subject'); subjectNode.append(element('strong', '', subject.displayName));
            appendSubjectGroups(subjectNode, subject, state); resultBody.append(subjectNode);
          }
          if (!subjects.length) resultBody.append(element('p', 'settings-hint', '本楼没有已保存的人物状态快照。'));
          resultBody.append(element('p', 'settings-hint', '旧记录未保存可核对的逐项变化；以上为本楼已保存状态快照。'));
          if (record.isolationSummary) resultBody.append(element('p', 'qqj-cse-isolation-hint', record.noMaterialChange
            ? `有内容未通过校验；本楼未产生人物状态变化（${record.isolationSummary.count} 项校验记录）。`
            : `部分内容未通过校验，已保留有效结果（${record.isolationSummary.count} 项校验记录）。`));
          resultNode.append(resultBody); body.append(resultNode);
        } else {
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
            stateNode.append(element('summary', 'qqj-cse-floor-state-summary', '查看本楼已保存状态'));
            const stateBody = element('div', 'qqj-cse-floor-state-body');
            for (const subject of record.endStateSubjects) {
              const subjectNode = element('section', 'qqj-cse-record-subject'); subjectNode.append(element('strong', '', subject.displayName));
              appendSubjectGroups(subjectNode, subject, state); stateBody.append(subjectNode);
            }
            if (!record.endStateSubjects.length) stateBody.append(element('p', 'settings-hint', '本楼结束时没有已保存状态。'));
            stateNode.append(stateBody); body.append(stateNode);
          }
        }
      }
      if (!record && !floor.cse?.error) body.append(element('p', 'settings-hint', '本楼还没有已保存的状态分析记录。'));
      if (floor.cse?.error) body.append(element('p', 'v3-foundation-feedback error', errorMessage(floor.cse.error))); const action = cseActionFor(floor, state); if (action) body.append(action); rowNode.append(body); list.append(rowNode);
    }
    if (!floors.length) list.append(element('p', 'settings-hint', '生成摘要后，这里会显示逐楼人物状态分析记录。'));
    const defaultRows = [...list.children], rowsByFloorId = new Map(floors.map((floor, index) => [floor.floorId, defaultRows[index]]));
    fillList = () => {
      const query = cseSearchQuery.trim();
      if (!query) { list.replaceChildren(...defaultRows); return; }
      const results = [];
      for (const floor of floors) {
        const seen = new Set(), record = floor.cse?.record;
        const add = (displayName, category, value) => {
          if (!value?.text) return;
          const copy = [value.text, value.towardDisplayName ? `对象：${value.towardDisplayName}` : '', value.visibility ? `信息范围：${visibilityCopy(value.visibility)}` : '', value.reason ? `依据：${value.reason}` : '', value.origin ? `来源：${originCopy(value.origin)}` : ''].filter(Boolean).join(' · ');
          const searchable = `${displayName} ${category} ${copy}`;
          if (!plainSearchIncludes(searchable, query)) return;
          const key = `${displayName}\u0000${category}\u0000${copy}`; if (seen.has(key)) return; seen.add(key);
          results.push({ floor, displayName, category, copy });
        };
        for (const subject of record?.subjects ?? []) {
          for (const change of subject.changes ?? []) {
            const category = categoryCopy[change.category] ?? '人物状态';
            add(subject.displayName, category, change.before?.text ? change.before : change.beforeText ? { ...change.before, text: change.beforeText } : null);
            add(subject.displayName, category, change.after?.text ? change.after : change.afterText ? { ...change.after, text: change.afterText } : null);
          }
        }
        for (const subject of record?.endStateSubjects ?? []) {
          for (const [key, category] of Object.entries(categoryCopy)) for (const value of subject[key] ?? []) add(subject.displayName, category, value);
        }
      }
      list.replaceChildren(element('p', 'qqj-search-count', `在全部人物状态历史中找到 ${results.length} 条结果`));
      for (const result of results) {
        const node = element('article', 'qqj-history-search-result'), title = element('div', 'qqj-history-search-title');
        title.append(element('strong', '', result.displayName), element('span', '', floorCopy(state, result.floor)), element('span', 'v3-memory-status', result.category));
        node.append(title, element('p', 'qqj-history-search-snippet', searchSnippet(result.copy, query)));
        node.setAttribute('role', 'button'); node.setAttribute('tabindex', '0'); node.setAttribute('aria-label', `打开${floorCopy(state, result.floor)}完整分析记录`);
        const openResult = () => {
          cseSearchQuery = ''; cseSearch.children[0].value = ''; cseSearch.children[1].hidden = true;
          for (const key of [`cse-floor:${result.floor.floorId}`, `cse-floor-changes:${result.floor.floorId}`, `cse-floor-state:${result.floor.floorId}`]) openState.set(key, true);
          const rowNode = rowsByFloorId.get(result.floor.floorId);
          const openDetails = parent => { for (const child of parent?.children ?? []) { if (child.tag === 'details' || child.tagName === 'DETAILS') child.open = true; openDetails(child); } };
          if (rowNode) { rowNode.open = true; openDetails(rowNode); }
          fillList(); rowNode?.scrollIntoView?.({ block: 'nearest' });
        };
        node.addEventListener('click', openResult); node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openResult(); } });
        list.append(node);
      }
      if (!results.length) list.append(element('div', 'qqj-inline-empty', '没有包含该文字的人物状态历史。'));
    };
    fillList();
    section.append(list); if (state.cseReplayDiagnostic?.message) section.append(element('p', 'v3-foundation-feedback error', errorMessage(state.cseReplayDiagnostic))); return section;
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
  function appendRelationLayers(container, { situational = [], adaptive = [] }, state, { situationalLabel = '当前态度' } = {}) {
    let count = 0;
    for (const [label, values] of [[situationalLabel, situational], ['长期相处方式', adaptive]]) {
      if (!values.length) continue;
      const group = element('div', 'qqj-relation-layer'); group.append(element('strong', 'qqj-relation-layer-title', label));
      const list = element('ul', 'qqj-relation-items'); for (const value of values) list.append(relationItem(value, state)); group.append(list); container.append(group); count += values.length;
    }
    return count;
  }
  function lastHistoricalRelation(state, subjectEntityId, towardEntityId) {
    if (!subjectEntityId || !towardEntityId) return null;
    const floors = [...(state.floors ?? [])]
      .filter(floor => Array.isArray(floor.cse?.record?.endStateSubjects))
      .sort((left, right) => (messageIndexFor(state, right) ?? -1) - (messageIndexFor(state, left) ?? -1)
        || (right.assistantSeq ?? 0) - (left.assistantSeq ?? 0));
    for (const floor of floors) {
      const subject = floor.cse.record.endStateSubjects.find(value => value.subjectEntityId === subjectEntityId);
      const values = {
        situational: (subject?.situational ?? []).filter(item => item.towardEntityId === towardEntityId),
        adaptive: (subject?.adaptive ?? []).filter(item => item.towardEntityId === towardEntityId),
      };
      if (values.situational.length || values.adaptive.length) return { floor, values };
    }
    return null;
  }
  function renderRelationLane(label, values, state, side, historical = null) {
    const lane = element('section', `qqj-relation-lane ${side}`); lane.append(element('strong', 'qqj-relation-lane-title', label));
    if (!appendRelationLayers(lane, values, state)) {
      if (historical) {
        lane.append(element('span', 'v3-memory-status', `最后关系记录 · ${floorCopy(state, historical.floor)}`));
        appendRelationLayers(lane, historical.values, state, { situationalLabel: '当时态度' });
      } else lane.append(element('p', 'settings-hint', '暂无已保存的关系状态。'));
    }
    return lane;
  }
  function renderUserAnchor(userSubject, userEntity, state) {
    const anchor = element('section', 'qqj-user-anchor');
    const title = element('div', 'qqj-user-anchor-title'); title.append(element('strong', '', userEntity?.displayName || userSubject?.displayName || '你')); anchor.append(title);
    if (!userSubject) { anchor.append(element('p', 'settings-hint', '还没有已保存的用户状态。')); return anchor; }
    const key = `${state.chatId ?? 'no-chat'}:${userSubject.subjectEntityId}`, draft = cseDrafts.get(key);
    anchor.setAttribute('data-qqj-cse-entity-id', userSubject.subjectEntityId); if (draft) anchor.className += ' qqj-manual-editor-host';
    if (draft) renderCseEditor(anchor, draft, state, key);
    else {
      appendSubjectGroups(anchor, userSubject, state, { situational: (userSubject.situational ?? []).filter(item => !item.towardEntityId), showMeta: false, groupAdaptiveByTarget: true });
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
    const switchRow = element('div', 'qqj-relation-switch-row'), switcher = bindHorizontalStrip(element('div', 'qqj-relation-switcher')); relationSwitcherNode = switcher;
    for (const person of important) { const button = element('button', `qqj-relation-person${person.entityId === selectedCsePersonId ? ' active' : ''}`, person.displayName); button.type = 'button'; button.setAttribute('aria-pressed', String(person.entityId === selectedCsePersonId)); button.addEventListener('click', () => { selectedCsePersonId = person.entityId; showMoreCsePeople = false; render(foundationState); }); switcher.append(button); }
    if (!important.length) switcher.append(element('span', 'qqj-profile-switch-empty', peopleRuntime ? '尚未选择重要人物' : '暂无人物状态'));
    const moreToggle = element('button', `secondary-action qqj-relation-more-toggle${showMoreCsePeople ? ' active' : ''}`, showMoreCsePeople ? '返回关系' : `更多人物（${more.length}）`); moreToggle.type = 'button'; moreToggle.setAttribute('aria-pressed', String(showMoreCsePeople)); moreToggle.addEventListener('click', () => { showMoreCsePeople = !showMoreCsePeople; render(foundationState); });
    switchRow.append(switcher, moreToggle); pageNode.append(switchRow);
    const selectedPerson = important.find(person => person.entityId === selectedCsePersonId), selectedSubject = selectedPerson ? subjectById.get(selectedPerson.entityId) : null;
    if (showMoreCsePeople) {
      const picker = element('section', 'qqj-profile-picker qqj-cse-more'), pickerHeading = element('header', 'qqj-profile-picker-heading');
      const order = element('button', 'secondary-action qqj-people-order-open', '排序'); order.type = 'button'; order.disabled = Boolean(peopleState?.active) || candidates.length < 2; order.addEventListener('click', () => {
        if (!customImpl || !peopleRuntime?.setPersonOrderEntityIds) return;
        void openPeopleOrderDialog({ customImpl, runtime: peopleRuntime, people: candidates, documentRef, chatId: peopleState?.chatId });
      });
      pickerHeading.append(element('strong', '', '更多人物'), element('span', 'v3-memory-status', `${more.length} 位`), order); picker.append(pickerHeading);
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
      const userTowardHistory = userToward.situational.length || userToward.adaptive.length ? null : lastHistoricalRelation(state, userEntity?.entityId, selectedPerson.entityId);
      const personTowardHistory = personToward.situational.length || personToward.adaptive.length ? null : lastHistoricalRelation(state, selectedPerson.entityId, userEntity?.entityId);
      const relationNote = renderSubject(selectedSubject, state, { person: selectedPerson, ownOnly: true, relationNote: true, actionsContainer: pairActions });
      if (pairActions.children.length) { pairMenu.append(pairMenuToggle, pairActions); pairHead.append(operationMenus.register(pairMenu)); }
      dual.append(renderRelationLane(`你 → ${selectedPerson.displayName}`, userToward, state, 'from-user', userTowardHistory), element('span', 'qqj-relation-divider'), renderRelationLane(`${selectedPerson.displayName} → 你`, personToward, state, 'toward-user', personTowardHistory)); pair.append(dual, relationNote); pageNode.append(pair);
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
    if (state.cseReplayDiagnostic?.message) pageNode.append(element('p', 'v3-foundation-feedback error', errorMessage(state.cseReplayDiagnostic))); return pageNode;
  }

  function renderRecallDetails(state = recallState) {
    const drawer = setDetailsState(element('details', 'qqj-management-drawer'), 'recall-details', false), record = state?.lastRecall ?? null, status = state?.recallStatus ?? 'idle';
    const recallStatus = record?.legacyReadOnly ? '旧版只读记录 · 不代表本轮已注入' : record?.restoredReceipt ? '聊天记录中的回执 · 恢复显示' : statusCopy(status);
    const summary = element('summary', 'qqj-section-summary'); summary.append(element('strong', '', record?.restoredReceipt ? '最近一次召回结果' : '最近召回回执'), element('span', 'v3-memory-status', recallStatus)); drawer.append(summary);
    const body = element('div', 'qqj-management-drawer-body'); if (receiptFeedback) body.append(element('p', 'v3-foundation-feedback error', receiptFeedback));
    if (!record) { body.append(element('p', 'settings-hint', state?.activeRecall ? `正在处理 ${state.activeRecall.generationType} · ${state.activeRecall.phase}` : '下一次正文生成后，这里会保留最近一次召回结果。')); drawer.append(body); return drawer; }
    const coverage = record.coverage, stages = record.stages, timings = record.timings, sourceReads = timings?.sourceReadAttempts;
    const uncommitted = ['error', 'stale'].includes(record.status);
    const phaseCopy = value => ({ input: '输入准备', source: '来源读取', selecting: '选材', commit: '提交前核验', receipt: '回执保存' })[value] ?? '未记录阶段';
    const selectionCopy = value => ({ notStarted: '未执行选材', incomplete: '选材未完成', completed: '选材已完成', receiptCandidate: '回执复用候选，未提交', reused: '已复用回执' })[value] ?? (record.reusedReceipt ? '复用回执，未发起新选材' : record.restoredReceipt ? '历史回执未记录阶段' : stages ? '选材已完成' : '未执行选材');
    const sourceExitCopy = { ready: '读取成功', validatedSnapshot: '已使用完成校验的快照', memoryPreparation: '记忆准备未完成', memoryPreparationTimeout: '记忆准备超时', memoryPreparationFailed: '记忆准备失败', stale: '读取时已失效', unavailable: '来源不可用' };
    const sourceReadCopy = sourceReads ? `完整快照 ${sourceReads.reachableReads} 次 · 退出 ${sourceExitCopy[sourceReads.exitPoint] ?? '未知'}` : record.restoredReceipt ? '历史回执不重新读取来源' : '未记录';
    const floors = (record.selectedFloors ?? []).map(value => floorCopy(foundationState, value, '来源楼号未提供')).join('、') || '无', states = (record.selectedStates ?? []).map(value => `${value.subject} / ${value.layer}`).join('、') || '无';
    const changes = (record.selectedCseChanges ?? []).map(value => `${value.subject} / ${value.layer} / ${cseActionCopy(value.action)} / ${floorCopy(foundationState, value, '来源楼号未提供')}`).join('、') || '无';
    const droppedCopy = record.strategyVersion === 'continuity-v15'
      ? `${Number.isSafeInteger(stages?.relevanceFilteredCount) ? ` → 相关性或锚依据不足 ${stages.relevanceFilteredCount}` : ''}${Number.isSafeInteger(stages?.budgetDroppedCount) ? ` → 总容量未选入 ${stages.budgetDroppedCount}` : ''}`
      : Number.isSafeInteger(stages?.budgetDroppedCount) ? ` → 未选入 ${stages.budgetDroppedCount}（含预算、条数或剧情线限制）` : '';
    const stageCopy = stages && [stages.recentSummaryCount, stages.distantHistoryItemCount, stages.stateCount].every(Number.isSafeInteger)
      ? { main:`输入 ${stages.input} → 记忆楼 ${stages.candidates} → 近期摘要 ${stages.recentSummaryCount} → 远期旧事 ${stages.distantHistoryItemCount}${Number.isSafeInteger(stages.linkedHistoryItemCount) ? `（关联补入 ${stages.linkedHistoryItemCount}）` : ''} → 当前态 ${stages.currentStateCount ?? stages.stateCount} → 历史变化 ${stages.cseChangeCount ?? 0}${Number.isSafeInteger(stages.linkedCseChangeCount) ? `（关联补入 ${stages.linkedCseChangeCount}）` : ''}${[stages.timeCorrectionCount, stages.timeReminderCount].every(Number.isSafeInteger) ? ` → 时间参考 ${stages.timeCorrectionCount + stages.timeReminderCount}` : ''}${Number.isSafeInteger(stages.storylineCount) ? ` → 剧情线 ${stages.storylineCount}` : ''}${droppedCopy}${Number.isSafeInteger(stages.finalInjectionItemCount) ? ` → 最终材料 ${stages.finalInjectionItemCount}` : ''}`, token:Number.isSafeInteger(stages.estimatedTokenCount) && Number.isSafeInteger(stages.estimatedTokenBudget) ? `Token 保守估算 ${stages.estimatedTokenCount}/${stages.estimatedTokenBudget}` : '' }
      : { main:stages ? `输入 ${stages.input} → 记忆楼 ${stages.candidates} → 去近期 ${stages.dropRecent} → 去常驻重复 ${stages.dropPersistent ?? 0} → 去越界 ${stages.dropVisibility} → 选中楼 ${stages.selected}` : selectionCopy(record.selectionStatus), token:'' };
    if (uncommitted) stageCopy.main = `${record.diagnosticAttempt ? `第 ${record.diagnosticAttempt} 次尝试的` : ''}候选选材结果（本轮未注入） · ${stageCopy.main.replace('最终材料', '候选材料')}`;
    const selector = record.selectorDiagnostic;
    const selectorCount = value => Number.isSafeInteger(value) ? String(value) : '未知';
    const hasExclusionCounts = ['historyExcludedCount', 'stateExcludedCount', 'historyRetainedCount', 'stateRetainedCount'].some(key => Number.isSafeInteger(selector?.[key]));
    let selectorCountCopy = hasExclusionCounts
      ? `历史候选 ${selectorCount(selector?.historyCandidateCount)} → 模型排除 ${selectorCount(selector?.historyExcludedCount)} → 保留 ${selectorCount(selector?.historyRetainedCount)} → 关联补入 ${selectorCount(stages?.linkedHistoryItemCount)} → 最终远期 ${selectorCount(stages?.distantHistoryItemCount)} · 人物候选 ${selectorCount(selector?.stateCandidateCount)} → 模型排除 ${selectorCount(selector?.stateExcludedCount)} → 保留 ${selectorCount(selector?.stateRetainedCount)} → 关联补入 ${selectorCount(stages?.linkedCseChangeCount)} → 最终注入 ${Number.isSafeInteger(stages?.currentStateCount) && Number.isSafeInteger(stages?.cseChangeCount) ? stages.currentStateCount + stages.cseChangeCount : '未知'}`
      : `历史候选 ${selectorCount(selector?.historyCandidateCount)} → 模型选择 ${selectorCount(selector?.historyModelSelectedCount)} → 最终远期 ${selectorCount(stages?.distantHistoryItemCount)} · 人物候选 ${selectorCount(selector?.stateCandidateCount)} → 模型选择 ${selectorCount(selector?.stateModelSelectedCount)} → 最终注入 ${Number.isSafeInteger(stages?.currentStateCount) && Number.isSafeInteger(stages?.cseChangeCount) ? stages.currentStateCount + stages.cseChangeCount : '未知'}`;
    if (uncommitted) selectorCountCopy = selectorCountCopy.replace('最终注入', '候选材料');
    const persistenceCopy = { sessionOnly: '仅当前页面可复用', saveUnconfirmed: '已请求宿主保存，结果未确认', chatRecord: '从聊天记录读取', none: '未保存' };
    const selectorBreakdown = selector?.mode === 'local' && Number.isFinite(selector?.localSelectionMs)
      ? `未发起选材接口 · 本地选材 ${Number(selector.localSelectionMs).toFixed(1)} ms`
      : Number.isFinite(selector?.utilityRoundTripMs) && Number.isFinite(selector?.localSelectionMs)
      ? `接口往返（含传输） ${Number(selector.utilityRoundTripMs).toFixed(1)} ms · 本地选材 ${Number(selector.localSelectionMs).toFixed(1)} ms`
      : '接口往返与本地选材未记录';
    let timingCopy = record.reusedReceipt
      ? `${Number.isFinite(timings?.totalMs) ? `本轮复用耗时 ${Number(timings.totalMs).toFixed(1)} ms` : '本轮复用耗时未记录'} · 未发起新选材请求 · 原回执${selectorBreakdown}`
      : record.restoredReceipt
        ? `历史原始耗时：${Number.isFinite(timings?.totalMs) ? `总等待 ${Number(timings.totalMs).toFixed(1)} ms · ` : ''}${Number.isFinite(timings?.selectorMs) ? `选材总等待 ${Number(timings.selectorMs).toFixed(1)} ms · ` : ''}${selectorBreakdown}${Number.isFinite(timings?.sourceMs) ? ` · 读取 ${Number(timings.sourceMs).toFixed(1)} ms` : ''}`
        : timings ? `${Number.isFinite(timings.totalMs) ? `本轮召回等待 ${Number(timings.totalMs).toFixed(1)} ms · ` : ''}${Number.isFinite(timings.selectorMs) ? `选材总等待 ${Number(timings.selectorMs).toFixed(1)} ms · ` : ''}${selectorBreakdown}${Number.isFinite(timings.sourceMs) ? ` · 读取 ${Number(timings.sourceMs).toFixed(1)} ms` : ''}` : '未记录';
    if (uncommitted && record.diagnosticAttempt) timingCopy = `选材与读取耗时来自第 ${record.diagnosticAttempt} 次尝试 · ${timingCopy}`;
    const filterReasons = (record.skipReasons ?? []).filter(value => value !== 'historySelectionFallback').map(skipReasonCopy);
    const details = element('dl', 'v3-foundation-grid'); details.append(row('触发用户楼', userFloorCopy(record.userMessageIndex)), row('生成时间', localTimeCopy(record.createdAt)), row('生成类型', generationTypeCopy(record.generationType)), row('收据', record.legacyReadOnly ? '旧版只读记录' : record.restoredReceipt ? '从聊天记录读取 · 仅恢复历史展示，不会再次注入' : `${record.reusedReceipt ? '复用' : '新算'} · ${persistenceCopy[record.receiptPersistence] ?? record.receiptPersistence ?? '未知'}`), row('召回旧楼', floors), row('当前人物状态', states), row('人物状态历史变化', changes), row('覆盖范围', coverage ? `记忆 ${coverage.rememberedAiFloors}/${coverage.stableAiFloors} · ${coverage.cseThroughAssistantSeq ? `CSE 到${floorCopy(foundationState, { assistantSeq: coverage.cseThroughAssistantSeq }, '终点楼号未提供')}` : 'CSE 尚未覆盖'}` : '本轮未读取'), stageRow('筛选阶段', stageCopy), row('选材方式', selectorModeCopy(selector?.mode)), row('智能选材计数', selectorCountCopy), ...(selector?.mode === 'fallback' ? [row('选材失败原因', `${selectorFailureCopy(selector.code)}${selector.httpStatus ? `（HTTP ${selector.httpStatus}）` : ''}`)] : []), row('耗时', timingCopy), row('来源读取', sourceReadCopy), row('普通过滤说明', filterReasons.join('、') || '无'));
    if (record.diagnosticPhase) details.append(row('所示诊断阶段', `${record.diagnosticAttempt ? `第 ${record.diagnosticAttempt} 次尝试 · ` : ''}${phaseCopy(record.diagnosticPhase)} · ${selectionCopy(record.selectionStatus)}${uncommitted ? ' · 本轮未注入' : ''}`));
    for (const attempt of record.attemptDiagnostics ?? []) details.append(row(`第 ${attempt.attempt} 次尝试`, `${phaseCopy(attempt.phase)} · ${selectionCopy(attempt.selectionStatus)}${attempt.error?.code ? ` · 错误 ${attempt.error.code}` : ''}${Number.isFinite(attempt.timings?.totalMs) ? ` · ${Number(attempt.timings.totalMs).toFixed(1)} ms` : ''}`));
    body.append(details); const safeError = errorMessage(state?.lastRecallError) || errorMessage(record.error); if (safeError) body.append(element('p', 'v3-foundation-feedback error', safeError));
    const errorCode = state?.lastRecallError?.code ?? record.error?.code;
    if (errorCode) body.append(element('p', 'settings-hint', `错误代码：${errorCode}`));
    const copyButton = element('button', 'secondary-action qqj-recall-copy', '复制回执'); copyButton.type = 'button'; copyButton.setAttribute('aria-label', '复制召回回执诊断');
    summary.append(copyButton);
    const copyFeedback = element('p', 'settings-result'), copyFallback = element('div'); body.append(copyFeedback, copyFallback);
    copyButton.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation();
      const excluded = new Set(['召回旧楼', '当前人物状态', '人物状态历史变化']);
      const nodeCopy = node => node.children?.length ? Array.from(node.children).map(nodeCopy).filter(Boolean).join(' ') : node.textContent || '';
      const value = [`召回回执：${recallStatus}`, ...Array.from(details.children).filter(node => !excluded.has(node.children[0]?.textContent)).map(node => nodeCopy(node)),
        `实际注入：${record.restoredReceipt || record.legacyReadOnly ? '历史展示，不代表本轮' : record.injectionText && !uncommitted ? '有' : '无'}；旧楼 ${record.selectedFloors?.length ?? 0}，状态 ${record.selectedStates?.length ?? 0}，变化 ${record.selectedCseChanges?.length ?? 0}`,
        ...(errorCode ? [`错误代码：${errorCode}`, `错误：${publicErrorMessage({ code: errorCode }, { fallback: '召回未完成，请按错误代码检查。' })}`] : [])].join('\n');
      copyFeedback.textContent = await copy(value, { local: true }); copyFallback.replaceChildren();
      if (copyFeedback.textContent !== '已复制。') { const input = element('textarea', 'v3-diagnostic-fallback qqj-recall-copy-fallback'); input.value = value; input.readOnly = true; input.setAttribute('aria-label', '召回回执诊断复制文本'); copyFallback.append(input); }
    });
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
  function renderPrequelDetails() {
    if (typeof recallRuntime?.getPrequel !== 'function' || typeof recallRuntime?.savePrequel !== 'function') return null;
    let saved;
    try { saved = recallRuntime.getPrequel(); }
    catch (error) { saved = { hostChatId: null, text: '' }; if (!prequelFeedback) prequelFeedback = errorMessage(error) || '前情读取失败。'; }
    if (!prequelDraft || prequelDraft.hostChatId !== saved.hostChatId) prequelDraft = { hostChatId: saved.hostChatId, text: saved.text, dirty: false, saving: false };
    else if (!prequelDraft.dirty && !prequelDraft.saving && prequelDraft.text !== saved.text) prequelDraft.text = saved.text;
    const drawer = setDetailsState(element('details', 'qqj-management-drawer qqj-prequel-drawer qqj-manual-editor-host'), 'prequel', false);
    const summary = element('summary', 'qqj-section-summary'); summary.append(element('strong', '', '前情'), element('span', 'v3-memory-status', saved.text ? `当前 ${[...saved.text].length} 字符` : '尚未设置')); drawer.append(summary);
    const body = element('div', 'qqj-management-drawer-body qqj-manual-editor');
    body.append(element('p', 'settings-hint', '粘贴旧聊天的大摘要。原文随当前聊天保存，生成时按需选段；清空文本后保存即可移除。'));
    const editor = element('textarea', 'v3-diagnostic-fallback qqj-prequel-editor'); editor.value = prequelDraft.text; editor.textContent = prequelDraft.text; editor.readOnly = false;
    editor.addEventListener('input', () => { prequelDraft.text = editor.value; prequelDraft.dirty = true; });
    const actions = element('div', 'v3-foundation-actions qqj-manual-save-bar');
    const save = element('button', 'primary-action', prequelDraft.saving ? '保存中…' : '保存前情'); save.type = 'button'; save.disabled = prequelDraft.saving;
    save.addEventListener('click', async () => {
      if (prequelDraft.saving) return;
      const submittedText = editor.value;
      const submittedDraft = prequelDraft;
      prequelDraft.text = submittedText; prequelDraft.dirty = true; prequelDraft.saving = true; save.disabled = true; prequelFeedback = '';
      let savedCurrentDraft = false;
      try {
        const result = await recallRuntime.savePrequel(submittedText);
        if (prequelDraft !== submittedDraft) return;
        if (prequelDraft.text === submittedText) { prequelDraft = { hostChatId: result.hostChatId, text: result.text, dirty: false, saving: false }; savedCurrentDraft = true; }
        else { prequelDraft.hostChatId = result.hostChatId; prequelDraft.saving = false; prequelDraft.dirty = true; }
        prequelFeedback = result.text ? '前情已更新，并已交给酒馆保存。' : '前情已移除，并已交给酒馆保存。';
      } catch (error) {
        if (prequelDraft !== submittedDraft) return;
        prequelDraft.saving = false;
        prequelFeedback = errorMessage(error) || '前情保存失败。';
      }
      if (active && container && page === 'management') render(foundationState);
      if (savedCurrentDraft && active && container && page === 'management') scrollEditorToTop('.qqj-prequel-drawer');
    });
    actions.append(save); body.append(editor, actions);
    if (prequelFeedback) body.append(element('p', `v3-foundation-feedback${/失败|不支持|请先/u.test(prequelFeedback) ? ' error' : ''}`, prequelFeedback));
    const selected = recallState?.lastPrequel ?? null;
    if (selected?.status === 'error') body.append(element('p', 'v3-foundation-feedback error', publicErrorMessage(selected.error, { fallback: '本次前情注入失败；正文已继续生成。' })));
    else if (selected?.injectionText) {
      const details = setDetailsState(element('details', 'qqj-management-drawer'), 'prequel-selection', false);
      const detailSummary = element('summary', 'qqj-section-summary'); detailSummary.append(element('strong', '', '本次选用'), element('span', 'v3-memory-status', selected.fragmentIndexes.map(value => `片段 ${value}`).join('、'))); details.append(detailSummary);
      const ordinaryTokens = recallState?.lastRecall?.restoredReceipt ? 0 : Number(recallState?.lastRecall?.stages?.estimatedTokenCount) || 0;
      const selectedBody = element('div', 'qqj-management-drawer-body');
      selectedBody.append(element('p', 'settings-hint', `召回材料估算 ${ordinaryTokens} + 前情估算 ${selected.estimatedTokens} = 合计 ${ordinaryTokens + selected.estimatedTokens} Token`), element('pre', 'v3-recall-injection', selected.injectionText));
      details.append(selectedBody); body.append(details);
    }
    drawer.append(body); return drawer;
  }
  function renderDiagnostics(state) {
    const drawer = setDetailsState(element('details', 'qqj-management-drawer'), 'diagnostics', false), summary = element('summary', 'qqj-section-summary'); summary.append(element('strong', '', '详细诊断'), element('span', 'v3-memory-status', '按需展开')); drawer.append(summary);
    const body = element('div', 'qqj-management-drawer-body'), details = element('dl', 'v3-foundation-grid');
    if (feedback.includes('历史召回回执已独立处理')) details.append(row('最近读取结果', feedback));
    const rebuildCopy = ({ rebuilding: '正在重建', paused: '已暂停', waitingRealtime: '等待新楼', failed: '失败', caughtUp: '已追平', pendingRebuild: '等待开始', notReady: '覆盖待确认' })[state.rebuildStatus] ?? '尚未判断';
    details.append(row('当前聊天编号', state.chatId), row('记忆状态', statusCopy(effectiveStatus(state))), row('待核对原因', reviewReasonCopy(state.reviewReason)), row('自动维护新楼', state.autoMemoryEnabled ? '已开启 · 每楼更新' : '已关闭'), row('历史重建', `${rebuildCopy} · ${state.rebuildCompletedCount ?? 0}/${state.rebuildTotalCount ?? state.stableCount ?? 0}`), row('CSE 待分析 / 失败', `${state.csePendingCount ?? 0} / ${state.cseFailedCount ?? 0}`), row('当前记忆快照', state.headCheckpointId), row('最近记忆错误', errorMessage(state.lastExtractorError) || errorMessage(state.lastError) || '无'), row('最近自动任务错误', errorMessage(state.lastAutomationError) || '无'), row('最近 CSE 错误', errorMessage(state.lastCseError) || '无')); body.append(details);
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
    if (typeof runtime.copySafeDiagnostic === 'function' && typeof runtime.copyFullDiagnostic === 'function' && state.floors?.length) {
      const floorDrawer = setDetailsState(element('details', 'qqj-management-drawer qqj-floor-diagnostics'), 'floor-diagnostics', false);
      const floorSummary = element('summary', 'qqj-section-summary');
      floorSummary.append(element('strong', '', '楼层诊断'), element('span', 'v3-memory-status', `${state.floors.length} 楼`));
      const floorList = element('div', 'qqj-floor-diagnostics-list');
      for (const floor of [...(state.floors ?? [])].reverse()) {
        const diagnostic = element('div', 'qqj-diagnostic-row'); diagnostic.append(element('span', '', floorCopy(state, floor)));
        const safe = element('button', 'secondary-action', '复制安全诊断'); safe.type = 'button'; safe.addEventListener('click', () => { void run('复制安全诊断', async () => { feedback = await copy(runtime.copySafeDiagnostic(floor.floorId)); return runtime.getState(); }); });
        const full = element('button', 'secondary-action', '复制完整诊断'); full.type = 'button'; full.addEventListener('click', () => { void run('复制完整诊断', async () => { if (!await Promise.resolve(confirmImpl({ title: '复制完整诊断', body: '完整诊断包含本楼正文与证据原文。确认复制吗？', confirmText: '复制', cancelText: '取消' }))) { feedback = '已取消完整诊断复制。'; return runtime.getState(); } feedback = await copy(runtime.copyFullDiagnostic(floor.floorId)); return runtime.getState(); }); });
        diagnostic.append(safe, full); floorList.append(diagnostic);
      }
      floorDrawer.append(floorSummary, floorList); body.append(floorDrawer);
    }
    if (fallbackText) { const fallback = element('textarea', 'v3-diagnostic-fallback'); fallback.value = fallbackText; fallback.textContent = fallbackText; fallback.readOnly = true; body.append(element('p', 'settings-hint', '诊断文本（长按全选复制）'), fallback); }
    drawer.append(body); return drawer;
  }
  function updateManagementFeedback(state) {
    if (!managementFeedbackNode) return;
    const copy = (feedback || errorCopy(state) || '状态已显示。').replace('；历史召回回执已独立处理。', '');
    const isError = errorCopy(state) || copy.startsWith('记忆读取失败') || copy.startsWith('刷新状态未完成');
    managementFeedbackNode.className = `v3-foundation-feedback qqj-management-feedback${isError ? ' error' : ''}`;
    managementFeedbackNode.textContent = copy;
  }
  function renderManagement(state) {
    const pageNode = element('section', 'qqj-page qqj-management-page'); pageNode.append(heading('记忆管理', '管理当前聊天的现有记忆任务。', state));
    if (['pendingRebuild', 'paused', 'failed', 'partial'].includes(state.rebuildStatus) || (state.rebuildStatus === 'waitingRealtime' && state.rebuildHasActionableWork)) pageNode.append(element('p', 'qqj-management-notice', '记忆尚未完整。“补齐缺失”会保留已有结果，只处理摘要或人物状态缺口；刷新页面不会自动续跑旧档。'));
    const deleting = managementState?.status === 'deleting', deletePending = managementState?.status === 'failed';
    const actions = element('div', 'v3-foundation-actions qqj-management-actions'), busy = workBusy(state) || managementState?.workBusy || deleting || deletePending;
    const refresh = element('button', 'secondary-action', '刷新状态'); refresh.type = 'button'; refresh.disabled = busy;
    refresh.addEventListener('click', () => { void run('正在刷新状态', () => runtime.refreshStatus({ preferCached: false, recoverTailDeletion: true, reconcileFoundation: true }), { resultCopy: refreshResult }); });
    actions.append(refresh);
    const rebuildActionable = state.rebuildHasActionableWork ?? !['caughtUp', 'waitingRealtime'].includes(state.rebuildStatus);
    if (state.rebuildStatus === 'rebuilding' && typeof runtime.pauseHistoricalRebuild === 'function') { const pause = element('button', 'primary-action', '暂停补齐'); pause.type = 'button'; pause.disabled = !state.activeAutoMemory; pause.addEventListener('click', () => { void run('暂停补齐', () => runtime.pauseHistoricalRebuild(), { resultCopy: automaticResult('补齐缺失') }); }); actions.append(pause); }
    else if (!['paused', 'failed'].includes(state.cseRebuildStatus)) { const begin = runtime.startHistoricalRebuild ?? runtime.retryAutomation; const proceedLabel = ['paused', 'failed', 'partial'].includes(state.rebuildStatus) ? '继续补齐' : '补齐缺失'; const proceed = element('button', 'primary-action', busy ? workPhaseCopy(state) : proceedLabel); proceed.type = 'button'; proceed.disabled = busy || typeof begin !== 'function' || !rebuildActionable; proceed.addEventListener('click', async () => { const mode = await confirmHistoricalMode(); if (!mode) { feedback = `已取消${proceedLabel}。`; render(foundationState); return; } void run(proceedLabel, () => begin === runtime.startHistoricalRebuild ? begin.call(runtime, mode) : begin.call(runtime), { resultCopy: automaticResult(proceedLabel) }); }); actions.append(proceed); }
    const reset = element('button', 'secondary-action', '完全重构'); reset.type = 'button'; reset.disabled = busy || typeof memoryManagement?.fullRebuild !== 'function'; reset.addEventListener('click', async () => { const mode = await confirmHistoricalMode({ fullRebuild: true }); if (!mode) { feedback = '已取消完全重构。'; render(foundationState); return; } const resetDraft = prequelDraft; void run('完全重构', () => memoryManagement.fullRebuild(state.chatId, mode), { after: () => { if (prequelDraft === resetDraft) { prequelDraft = null; prequelFeedback = ''; } }, resultCopy: automaticResult('完全重构') }); }); actions.append(reset);
    const cseRunning = state.cseRebuildStatus === 'running' && state.activeAutoMemory?.mode === 'cseRebuild';
    const cseResume = ['paused', 'failed'].includes(state.cseRebuildStatus);
    const cseAction = element('button', 'secondary-action', cseRunning ? '暂停人物状态重构' : cseResume ? '继续人物状态重构' : '人物状态重构'); cseAction.type = 'button';
    cseAction.disabled = cseRunning ? typeof runtime.pauseCseRebuild !== 'function' || deleting : busy || typeof runtime.rebuildCse !== 'function' || (state.rememberedCount ?? 0) < 1;
    cseAction.addEventListener('click', async () => {
      if (cseRunning) { void run('暂停人物状态重构', () => runtime.pauseCseRebuild(), { resultCopy: cseRebuildResult('人物状态重构') }); return; }
      if (cseResume) { void run('继续人物状态重构', () => runtime.resumeCseRebuild(state.chatId), { resultCopy: cseRebuildResult('人物状态重构') }); return; }
      if (!await Promise.resolve(confirmImpl({ title: '重构当前聊天人物状态', body: '所有摘要及摘要人工修订都会保留；已有摘要对应的人物状态将从头重新生成，CSE 人工纠正也会被覆盖。未摘要楼不会处理。', confirmText: '人物状态重构', cancelText: '取消' }))) { feedback = '已取消人物状态重构。'; render(foundationState); return; }
      void run('人物状态重构', () => runtime.rebuildCse(state.chatId), { resultCopy: cseRebuildResult('人物状态重构') });
    });
    actions.append(cseAction);
    const progress = element('div', 'qqj-management-progress');
    if (state.cseRebuildStatus !== 'idle') progress.append(element('span', 'settings-hint', `人物状态${state.cseRebuildStatus === 'completed' ? '已完成' : state.cseRebuildStatus === 'failed' ? '失败' : state.cseRebuildStatus === 'paused' ? '已暂停' : '重构中'} · ${state.cseRebuildCompletedCount ?? 0}/${state.cseRebuildTotalCount ?? 0}`));
    const pendingCopy = `摘要待补 ${state.unprocessedCount ?? 0} 楼 · CSE 待分析 ${state.csePendingCount ?? 0} 楼`;
    const nextStepCopy = deletePending ? '上次删除尚未完成，请先继续删除当前聊天记忆。'
      : busy ? `${workPhaseCopy(state)}，完成后可继续操作。`
        : ['needsReview', 'error'].includes(effectiveStatus(state)) || sessionErrorCopy() ? `当前${sessionErrorCopy() ? '记忆读取失败' : statusCopy(effectiveStatus(state))}；请先点击“刷新状态”。若仍无法确认真实归属，现有记忆会保留、正文可继续，可复制诊断反馈。`
          : uninitializedCopy(state) || (!state.chatId ? '当前记忆状态尚未载入，请点击“刷新状态”。'
            : !rebuildActionable ? '当前没有需要补齐的稳定楼。'
              : '可用“补齐缺失”保留已有结果；“完全重构”会替换全部摘要与人物状态。');
    progress.append(element('span', 'settings-hint', `${pendingCopy}。${nextStepCopy}`));
    const deleteActions = element('div', 'qqj-management-delete');
    if (memoryManagement) {
      const sessionState = readDiagnosticState(sessionStateProvider);
      const hasCurrentIdentity = Boolean(state.chatId || (sessionState?.status === 'ready' && sessionState.identity?.chatId));
      const remove = element('button', 'primary-action', deleting ? '删除中…' : deletePending ? '继续删除当前聊天记忆' : '删除当前聊天记忆');
      remove.type = 'button'; remove.disabled = deleting || managementState?.blockedByOtherChat === true || (!deletePending && (managementState?.workBusy === true || !hasCurrentIdentity));
      remove.addEventListener('click', async () => {
        if (!await Promise.resolve(confirmImpl({ title: '删除当前聊天记忆', body: '将删除本聊天的摘要、人物状态、人物资料、召回记录及历史派生版本。聊天正文、手动前情和全局 API、提示词设置会保留；手动前情可在“前情”中另行清空。下次建档需要从头开始。', note: '后端数据会移入回收站；这不代表永久擦除。', confirmText: deletePending ? '继续删除' : '删除记忆', cancelText: '取消' }))) { feedback = '已取消删除当前聊天记忆。'; render(foundationState); return; }
        void run(deletePending ? '继续删除当前聊天记忆' : '删除当前聊天记忆', () => memoryManagement.deleteCurrent(), { after: () => { managementState = memoryManagement.getState(); feedback = '当前聊天记忆已删除；聊天正文、手动前情与全局设置均已保留。手动前情可在“前情”中清空。'; return true; }, failed: () => { managementState = memoryManagement.getState(); return true; } });
      });
      deleteActions.append(remove);
    }
    if (deletePending && managementState.error) pageNode.append(element('p', 'v3-foundation-feedback error', `上次删除未完成：${managementState.error} 已保留原聊天身份，可继续删除剩余记录。`));
    else if (managementState?.status === 'completed') pageNode.append(element('p', 'v3-foundation-feedback', '当前聊天记忆已清空；聊天正文、手动前情和全局设置仍保留。手动前情可在“前情”中清空。'));
    const previousCseError = (['paused', 'failed'].includes(state.cseRebuildStatus)
      ? errorMessage(state.cseRebuildError) || errorMessage(state.lastCseError)
      : '').replace(/[。；\s]+$/u, '');
    if (previousCseError) progress.append(element('span', 'settings-hint error', `上次人物状态分析失败：${previousCseError}；可继续人物状态重构。`));
    managementFeedbackNode = element('p');
    updateManagementFeedback(state);
    pageNode.append(actions, progress, managementFeedbackNode);
    const prequel = renderPrequelDetails(); if (prequel) pageNode.append(prequel);
    pageNode.append(renderRecallDetails(), renderDiagnostics(state));
    if (memoryManagement) pageNode.append(deleteActions);
    return pageNode;
  }

  function renderAdopted(state) {
    if (!container) return;
    if (relationSwitcherNode) relationSwitcherScrollLeft = Number(relationSwitcherNode.scrollLeft) || 0;
    const previousSignature = relationSwitcherSignature, previousChatId = relationSwitcherChatId;
    relationSwitcherNode = null;
    recentItemsUi = null;
    operationMenus.reset();
    recallState = recallRuntime?.getState?.() ?? recallState; peopleState = peopleRuntime?.getState?.() ?? peopleState; managementState = memoryManagement?.getState?.() ?? managementState; healthNode = null; managementFeedbackNode = null;
    container.replaceChildren(page === 'memories' ? renderMemories(state) : page === 'people' ? renderPeople(state) : renderManagement(state));
    if (relationSwitcherNode) {
      const userEntityId = (state.memoryEntities ?? []).find(entity => entity.specialRole === 'user')?.entityId ?? null;
      const nextSignature = JSON.stringify((peopleState?.people ?? []).filter(person => person.entityId !== userEntityId && person.selected).map(person => person.entityId).sort());
      const preserveScroll = previousChatId === (state.chatId ?? null) && previousSignature === nextSignature;
      relationSwitcherNode.scrollLeft = preserveScroll ? relationSwitcherScrollLeft : 0;
      relationSwitcherSignature = nextSignature; relationSwitcherChatId = state.chatId ?? null; relationSwitcherScrollLeft = relationSwitcherNode.scrollLeft;
    }
  }
  const syncingDisplayState = state => syncingChatId && syncingChatId === state?.chatId
    ? { ...state, memorySnapshotStatus: 'syncing', memorySyncStatus: 'syncing', memoryWorkBusy: true }
    : state;
  const applySyncingPresentation = () => {
    const safeButtons = new Set(['取消', '分析记录', '返回当前状态', '复制安全诊断', '复制完整诊断', '复制界面诊断', '复制状态诊断', '复制调用示例']);
    const visit = node => {
      for (const child of Array.from(node?.children ?? [])) {
        const tag = String(child?.tagName ?? child?.tag ?? '').toLowerCase();
        const classes = String(child.className ?? '').split(/\s+/);
        const diagnosticFallback = tag === 'textarea' && child.readOnly === true && classes.includes('v3-diagnostic-fallback');
        const prequelControl = tag === 'textarea' && classes.includes('qqj-prequel-editor');
        if ((['input', 'select', 'textarea'].includes(tag) && !diagnosticFallback && !prequelControl) || (tag === 'button' && !safeButtons.has(child.textContent) && child.textContent !== '保存前情')) child.disabled = true;
        visit(child);
      }
    };
    visit(container);
    updateHealth(syncingDisplayState(foundationState));
  };
  function render(state = runtime.getState()) {
    const adopted = adoptFoundationState(state).state;
    renderAdopted(syncingDisplayState(adopted));
    if (syncingChatId && syncingChatId === adopted?.chatId) applySyncingPresentation();
  }
  function receiveFoundation(snapshot) {
    if (snapshot?.memorySnapshotStatus === 'syncing' && snapshot?.chatId && snapshot.chatId === foundationState?.chatId) {
      syncingChatId = snapshot.chatId;
      applySyncingPresentation();
      updateRecentItems(); if (recentItemsOpen && page === 'memories') void timeRuntime?.refreshStatus?.();
      return;
    }
    syncingChatId = null;
    const { state, mustReplace } = adoptFoundationState(snapshot);
    if (page === 'memories' && (drafts.size || recentItemDraft) && !mustReplace) {
      for (const draft of drafts.values()) for (const control of draft.controls ?? []) control.disabled = draft.saving === true || workBusy(state);
      updateHealth(state); updateRecentItems(); if (recentItemsOpen) void timeRuntime?.refreshStatus?.(); return;
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
    if (typeof runtime.subscribe === 'function') { const release = runtime.subscribe(snapshot => { if (snapshot?.status === 'ready' && feedback === statusCopy('stale')) feedback = '记忆状态已刷新。'; if (feedback === '正在读取当前聊天…' && snapshot?.memorySnapshotStatus !== 'syncing' && snapshot?.memorySyncStatus !== 'syncing') feedback = snapshot?.status === 'ready' ? '记忆状态已刷新。' : ''; if (active && container) receiveFoundation(snapshot); }); if (typeof release === 'function') releases.push(release); }
    if (typeof recallRuntime?.subscribe === 'function') { const release = recallRuntime.subscribe(snapshot => { recallState = snapshot; if (active && container && page === 'management') render(foundationState); }); if (typeof release === 'function') releases.push(release); }
    if (typeof peopleRuntime?.subscribe === 'function') { const release = peopleRuntime.subscribe(snapshot => { peopleState = snapshot; if (active && container && page === 'people') render(foundationState); }); if (typeof release === 'function') releases.push(release); }
    if (typeof timeRuntime?.subscribe === 'function') { const release = timeRuntime.subscribe(() => { if (active && container) { updateHealth(foundationState); updateRecentItems(); } }); if (typeof release === 'function') releases.push(release); }
    if (typeof memoryManagement?.subscribe === 'function') { const release = memoryManagement.subscribe(snapshot => { managementState = snapshot; if (active && container && page === 'management') render(foundationState); }); if (typeof release === 'function') releases.push(release); }
    unsubscribe = () => { for (const release of releases) { try { release(); } catch { /* listener cleanup isolation */ } } };
  }
  function stopSubscription() { const release = unsubscribe; unsubscribe = null; try { release?.(); } catch { /* runtime listener cleanup is isolated from view lifecycle */ } }
  function mount(target) { stopSubscription(); operationMenus.deactivate(); container = target; active = true; recallState = recallRuntime?.getState?.() ?? null; render(runtime.getState()); operationMenus.activate(); subscribe(); }
  async function activate() {
    if (!container) throw new Error('V3 foundation view 尚未挂载');
    active = true; operationMenus.activate(); subscribe(); const mine = ++epoch; feedback = '正在读取最新状态…'; receiptFeedback = ''; updateHealth(runtime.getState());
    if (readDiagnosticState(sessionStateProvider)?.status === 'preparing') {
      feedback = '正在读取当前聊天…';
      render(runtime.getState());
      const [receiptOutcome] = await Promise.allSettled([recallRuntime?.restorePersistedReceipt?.()]);
      if (!active || mine !== epoch) return { status: 'stale' };
      if (receiptOutcome.status === 'rejected') receiptFeedback = `历史召回回执恢复失败：${publicErrorMessage(receiptOutcome.reason, { fallback: '回执读取失败。' })}；不影响记忆读取。`;
      render(runtime.getState());
      return { status: 'preparing' };
    }
    const prepare = page === 'management' || typeof runtime.prepareCurrent !== 'function'
      ? runtime.refreshStatus({ preferCached: page !== 'management' })
      : runtime.prepareCurrent({ preferCached: true }).then(() => runtime.getState());
    const [foundationOutcome, receiptOutcome] = await Promise.allSettled([prepare, recallRuntime?.restorePersistedReceipt?.()]);
    if (!active || mine !== epoch) return { status: 'stale' };
    const peopleOutcome = page === 'people' && peopleRuntime?.refresh
      ? await Promise.resolve(peopleRuntime.refresh({ refreshMemory: false })).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))
      : { status: 'fulfilled', value: null };
    if (!active || mine !== epoch) return { status: 'stale' };
    if (receiptOutcome.status === 'rejected') receiptFeedback = `历史召回回执恢复失败：${publicErrorMessage(receiptOutcome.reason, { fallback: '回执读取失败。' })}；不影响记忆读取。`;
    const peopleFeedback = peopleOutcome.status === 'rejected' ? `重要人物选择读取失败：${publicErrorMessage(peopleOutcome.reason, { fallback: '人物选择暂时无法读取。' })}；人物状态仍可查看。` : '';
    if (foundationOutcome.status === 'rejected') { feedback = `记忆读取失败：${publicErrorMessage(foundationOutcome.reason, { fallback: '后端数据暂时无法读取。' })}；历史召回回执已独立处理。`; const result = runtime.getState(); render(result); return { status: 'error', error: foundationOutcome.reason }; }
    const result = foundationOutcome.value; feedback = peopleFeedback || (result?.status === 'ready' ? '记忆状态已刷新。' : statusCopy(result?.status)); render(result); return result;
  }
  function deactivate() { active = false; epoch += 1; operationMenus.deactivate(); stopSubscription(); }
  function setPage(next) { if (!['memories', 'people', 'management'].includes(next)) throw new TypeError('V3 view page 无效'); page = next; if (container) render(foundationState); }
  return Object.freeze({ mount, activate, deactivate, render, setPage, getPage: () => page });
}
