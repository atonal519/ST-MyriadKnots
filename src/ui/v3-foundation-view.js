import { preparationContextDiagnostic } from '../v3/preparation-diagnostic.js';
import { projectCseSubjectDiagnostic } from '../v3/cse-failure-diagnostic.js';
import { safePrefixDifference } from '../v3/memory-prefix-diagnostic.js';
import { createInlineSelect } from './inline-select.js';
import { createOperationMenuController } from './operation-menu-controller.js';
import { bindHorizontalStrip, openPeopleOrderDialog } from './people-interactions.js';
import { publicErrorMessage } from '../public-error.js';
import { formatStoryTime, mainlineTimeText } from '../v3/time-engine.js';

function text(value, fallback = '—') { return value === null || value === undefined || value === '' ? fallback : String(value); }

const cseReadingPairs = new Map([['（', '）'], ['(', ')'], ['［', '］'], ['[', ']'], ['【', '】'], ['〔', '〕'], ['｛', '｝'], ['{', '}'], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['《', '》'], ['〈', '〉']]);
const cseReadingClosers = new Set(cseReadingPairs.values());
function cseReadingText(value) {
  const source = String(value ?? '');
  if (!/[。？！]/u.test(source)) return source;
  const stack = [];
  const output = [];
  let pendingBreak = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const previous = source[index - 1] ?? '';
    const next = source[index + 1] ?? '';
    if (pendingBreak) {
      if (character === '\n' || character === '\r') pendingBreak = false;
      else if (/\s/u.test(character) || cseReadingClosers.has(character) || /[。？！,，、]/u.test(character)) {
        // Keep original spacing, closing punctuation, and existing punctuation runs with this sentence.
      } else if (stack.length) pendingBreak = false;
      else {
        output.push('\n');
        pendingBreak = false;
      }
    }
    output.push(character);
    if ((character === '"' || character === "'") && !(character === "'" && /[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next))) {
      if (stack.at(-1) === character) stack.pop();
      else stack.push(character);
    } else if (cseReadingPairs.has(character)) stack.push(cseReadingPairs.get(character));
    else if (cseReadingClosers.has(character) && stack.at(-1) === character) stack.pop();
    if (!stack.length && /[。？！]/u.test(character)) pendingBreak = true;
  }
  return output.join('');
}

function statusCopy(value) {
  return ({
    uninitialized: '尚未开始记录', ready: '可用', running: '正在处理', empty: '完成 · 无需注入',
    skipped: '本轮已跳过', idle: '尚无生成记录', conflict: '并发冲突，未覆盖新数据', error: '处理失败，可重试',
    disabled: '插件已关闭', stale: '正在等待最新结果', needsReview: '需要核对当前聊天记忆', unprocessed: '未处理',
    failed: '失败可重试', partial: '部分完成，可继续补齐', pending: '待分析', noChange: '无实质变化', notApplicable: '尚无摘要',
  })[value] ?? text(value, '尚未初始化');
}

const effectiveStatus = state => state.status === 'idle' ? state.foundationStatus : state.status;
const waitingForConfirmation = state => (state.unregisteredCandidates ?? []).filter(candidate => candidate.reason !== 'waitingNextUser').length;
const timeFailureCopy = state => state?.active || ['waiting', 'disabled'].includes(state?.status) ? ''
  : state?.last?.automaticFailure || state?.last?.status === 'failed' || state?.status === 'failed' ? '更新失败'
    : state?.last?.status === 'partial' || state?.status === 'partial' ? '部分未更新'
      : state?.last?.status === 'interrupted' ? '更新未完成' : '';
// 只复制时间校验器的固定原因；旧汇总 message 仅用于命中这些常量，不输出自由文本。
const TIME_ITEM_FAILURE_REASONS = new Set([
  '当前评估只能更新选入的活跃事项。', '当前评估缺少推测、无法判断原因或退出理由。',
  '时间事项身份或字段无效。', '来源编号未在本次请求中出现。', '时间事项人物归属不明确。',
  '时间事项人物未在正文明确出现。', '时间事项来源无效。', '时间事项重复。', '时间事项缺少原观察。',
  '退出跟进只允许已有活跃身体事项，并需单独提供退出理由。', '归并组字段无效。',
  '归并组存在重复、自归并或交叉事项。', '归并组必须使用输入的同人物同类型事项。',
  '归并成员来源不完整。', '归并组含无效事项更新。', '归并主项缺少当前评估。',
  '已手动解除归并，缺少新观察不能重新归并。', '归并组不能撤销已停止或结束的事项。',
  '本次未返回该事项的有效当前评估。',
]);
const validMessageIndex = value => Number.isSafeInteger(value) && value >= 0;
const messageIndexFor = (state, reference = {}) => {
  if (validMessageIndex(reference.messageIndex)) return reference.messageIndex;
  const floors = state?.floors ?? [];
  const floorId = reference.floorId ?? reference.sourceFloorId;
  if (floorId !== undefined && floorId !== null) {
    const floor = floors.find(value => value.floorId === floorId);
    return validMessageIndex(floor?.messageIndex) ? floor.messageIndex : null;
  }
  if (Number.isSafeInteger(reference.assistantSeq) && reference.assistantSeq > 0) {
    const floor = floors.find(value => value.assistantSeq === reference.assistantSeq);
    return validMessageIndex(floor?.messageIndex) ? floor.messageIndex : null;
  }
  return null;
};
const floorCopy = (state, reference, fallback = '楼号未提供', { knownFloor = false } = {}) => {
  const floorId = reference?.floorId ?? reference?.sourceFloorId;
  const floor = knownFloor ? reference : floorId ? state?.floors?.find(value => value.floorId === floorId) : null;
  const origin = reference?.sourceOrigin ?? floor?.sourceOrigin;
  if ((reference?.frozen === true || floor?.frozen === true) && Number.isSafeInteger(origin?.sourceMessageIndex)) return `来源聊天第 ${origin.sourceMessageIndex} 楼`;
  const range = Array.isArray(reference?.sourceMessageIndexes) ? reference.sourceMessageIndexes.filter(validMessageIndex) : [];
  if (range.length > 1) return `第 ${range[0]}–${range.at(-1)} 楼`;
  const messageIndex = knownFloor && validMessageIndex(reference?.messageIndex) ? reference.messageIndex : messageIndexFor(state, reference);
  return messageIndex === null ? fallback : `第 ${messageIndex} 楼`;
};
const memoryFloorTitle = (state, floor) => {
  if (floor?.frozen !== true) return floorCopy(state, floor, '楼号未提供', { knownFloor: true });
  const origin = floor.sourceOrigin;
  const number = validMessageIndex(origin?.sourceMessageIndex) ? `第 ${origin.sourceMessageIndex} 楼` : floorCopy(state, floor, '归档楼', { knownFloor: true });
  const source = typeof origin?.sourceHostChatId === 'string' ? origin.sourceHostChatId.trim() : '';
  return source ? `${number} · ${source.replace(/\.jsonl$/iu, '')}` : number;
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
  waitingNextUser: '尚未摘要，发送下一条用户消息后检查。',
  waitingEarlierFloor: '尚未摘要，先确认前面的 AI 楼。',
  consecutiveAssistant: '尚未摘要，请到「千结」页顶部，点击「确认连续 AI 并分别记录」。',
  registrationNeedsReview: '尚未摘要，需核对楼层与记忆的对应关系。',
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
  QQJ_COMPLETION_JSON: '模型输出格式无效', QQJ_OUTPUT_TRUNCATED: '模型输出疑似截断', QQJ_STREAM_PROTOCOL: '流式接口响应协议不符', QQJ_STREAM_EVENT_JSON: '流式接口事件格式无效',
  V3_RECALL_LLM_SCHEMA_INVALID: '选材结果结构无效', V3_RECALL_LLM_KEYS_INVALID: '选材返回了本次候选池之外的键', V3_RECALL_LLM_FIELDS_MISSING: '非空候选池没有有效答复', V3_RECALL_LLM_UNAVAILABLE: '智能选材路由不可用',
})[value] ?? text(value, '无');
const skipReasonCopy = value => ({
  coreBodyDuplicate: '已排除当前正文完整覆盖的摘要', partialAggregateBodyOverlap: '部分聚合摘要与当前正文来源重叠；整条材料仍参与相关性和预算筛选，可能重复，未逐成员拆分',
  uninitialized: '尚未开始记录，本轮不注入记忆，正文继续生成',
  noReliableMemoryMatch: '未找到可靠的远期匹配', persistentStateDuplicate: '已去除重复材料',
  dynamicStateCoverageIncomplete: '当前人物状态覆盖不完整，本轮只参考可信历史变化', cseReplayUnavailable: '人物状态重放不可用',
  memoryNotReady: '当前记忆仍有缺口', coverageUnconfirmed: '记忆与正文对应关系尚未确认', memoryRebuildFailed: '上次记忆补齐未完成',
  historicalRebuildRequired: '仍有历史摘要缺口', memoryPreparationTimeout: '记忆准备超时，本轮召回失败并停止正文生成', memoryPreparationFailed: '记忆准备失败，本轮召回失败并停止正文生成',
})[value] ?? text(value);
const workBusy = state => Boolean(state.memoryWorkBusy || state.activeMemoryWork || state.activeAutoMemory || state.activeExtraction || state.activeCse);
const memoryBusy = state => Boolean((state.activeExtraction && state.activeExtraction.phase !== 'analyzingCse') || ['revising', 'extracting', 'reconciling', 'committing'].includes(state.activeMemoryWork?.phase) || state.activeAutoMemory?.phase === 'extracting');
const cseBusy = state => Boolean(state.activeCse || state.activeMemoryWork?.phase === 'analyzingCse' || state.activeAutoMemory?.phase === 'analyzingCse');
const workPhaseCopy = state => ({ reconciling: '正在同步楼层', syncing: '正在同步记忆状态', extracting: '正在提取摘要', analyzingCse: '正在分析人物状态', revisingCse: '正在保存人物状态', committing: '正在保存结果', resetting: '正在重建后端数据', revising: '正在保存修订' })[state.activeMemoryWork?.phase ?? state.activeAutoMemory?.phase ?? state.activeExtraction?.phase ?? state.activeCse?.phase] ?? '正在处理';
const DIAGNOSTIC_STATUS = new Set(['idle', 'preparing', 'ready', 'error', 'disabled', 'suspended', 'running', 'uninitialized', 'stale', 'needsReview', 'conflict', 'empty', 'skipped', 'failed', 'partial', 'pending', 'noChange', 'notApplicable', 'unavailable', 'syncing', 'caughtUp', 'waitingRealtime', 'pendingRebuild', 'rebuilding', 'paused', 'completed', 'deleting', 'historicalDebt', 'realtimeTail', 'notReady', 'unknown']);
const DIAGNOSTIC_PHASE = new Set(['preparing', 'migrating', 'loading', 'inspecting', 'generating', 'generatingAvatar', 'building', 'sealing', 'savingProfile', 'savingSelection', 'savingAvatar', 'deleting', 'cleaning', 'scanning', 'checking', 'updating', 'request', 'capturing', 'completed', 'stale', 'retryableError', 'anchor', 'load', 'foundation', 'extracting', 'validating', 'committing', 'resetting', 'reconciling', 'syncing', 'analyzingCse', 'revisingCse', 'revising', 'baseline', 'analyzing', 'correcting', 'pending', 'input', 'source', 'selecting', 'receipt', 'starting', 'deletingRecords', 'deletingBinding', 'clearingHost', 'unknown']);
const DIAGNOSTIC_KIND = new Set(['manual', 'auto', 'unknown']);
const DIAGNOSTIC_REVIEW_REASON = new Set(['missingRoot', 'indexNeedsReseal', 'stableCountMismatch', 'candidateCountMismatch', 'locatorMismatch', 'markerMismatch', 'fingerprintMismatch']);
const DIAGNOSTIC_MARKER_STATUS = new Set(['none', 'valid', 'foreign', 'invalid']);
const DIAGNOSTIC_BINDING_ISSUE = new Set(['markerConflict', 'duplicateMarker', 'duplicateBinding', 'markerRejected']);
const VECTOR_RUNTIME_STATUS = new Set(['idle', 'building', 'ready', 'error']);
const VECTOR_BUILD_STATUS = new Set(['building', 'ready', 'failed', 'cancelled', 'skipped']);
const VECTOR_BUILD_PHASE = new Set(['source', 'cache', 'embedding', 'verification', 'save', 'complete']);
const VECTOR_REQUEST_PHASE = new Set(['request', 'response', 'validation', 'complete']);
const VECTOR_REQUEST_STAGE = new Set(['request_prepared', 'fetch_call_start', 'fetch_called', 'response_headers', 'response_body', 'complete', 'aborted']);
const STANDARD_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'AggregateError', 'AbortError', 'DOMException', 'TimeoutError']);
const DIAGNOSTIC_PREPARE_STEP = new Set(['synchronizing', 'snapshotClone', 'sourceSelection', 'sourceSanitization', 'timeSources', 'identityDirectory', 'qianshiCandidates', 'extractorEnvelope', 'dependencySnapshot', 'rootCheck', 'extractorHandoff']);
const AUTOMATION_DETAILS = new Set(['Graphology 检测到重复图边。', '结构化复制失败。', '类型检查失败。', '插件内部错误码已记录。', '未分类错误。']);
const enumDiagnostic = (value, allowed) => allowed.has(value) ? value : 'unknown';
const booleanDiagnostic = value => typeof value === 'boolean' ? value : 'unknown';
const countDiagnostic = value => Number.isSafeInteger(value) && value >= 0 ? value : 'unknown';
const diagnosticCode = value => Number.isSafeInteger(value)
  ? value
  : typeof value === 'string' && /^(?:(?:QQJ|V3|CHAT_SESSION|QIANSHI)_[A-Z0-9_]{1,80}|BACKEND_TIMEOUT)$/u.test(value) ? value : null;
const presenceDiagnostic = (source, key) => source && Object.hasOwn(source, key) ? Boolean(source[key]) : 'unknown';
const operationDiagnostic = (value, { kind = false } = {}) => value
  ? { present: true, ...(kind ? { kind: enumDiagnostic(value.kind, DIAGNOSTIC_KIND) } : {}), phase: enumDiagnostic(value.phase, DIAGNOSTIC_PHASE) }
  : { present: false, ...(kind ? { kind: null } : {}), phase: null };
const REQUEST_PHASES = new Set(['preparing', 'fetch', 'responseBody', 'sseBody', 'normalize', 'compile', 'validating', 'saving']);
const TIME_FAILURE_PHASES = new Set(['preparing', 'request', 'compile', 'compilePartial', 'sourceValidation', 'saving']);
const requestDiagnostic = value => value ? {
  phase: enumDiagnostic(value.phase, REQUEST_PHASES), outcome: enumDiagnostic(value.outcome, new Set(['running', 'completed', 'failed', 'cancelled'])),
  ...Object.fromEntries(['startedAt', 'endedAt', 'elapsedMs', 'phaseElapsedMs', 'attemptElapsedMs', 'attempts', 'timeoutMs', 'fromAssistantSeq', 'toAssistantSeq'].map(key => [key, value[key] === null ? null : countDiagnostic(value[key])])),
  error: errorDiagnostic(value.error), lastAttemptError: value.lastAttemptError ? { ...errorDiagnostic(value.lastAttemptError),
    attempt: countDiagnostic(value.lastAttemptError.attempt), at: countDiagnostic(value.lastAttemptError.at), phase: enumDiagnostic(value.lastAttemptError.phase, REQUEST_PHASES) } : null,
} : null;
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
    if (value.code === 'V3_MEMORY_PREFIX_CHANGED') {
      const difference = safePrefixDifference(value.prefixDifference);
      if (difference) result.prefixDifference = difference;
    }
    const httpStatus = value.httpStatus ?? value.status;
    if (Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) result.httpStatus = httpStatus;
  }
  return result;
}
function preparationErrorFields(value) {
  if (!value || typeof value !== 'object') return {};
  const fields = preparationContextDiagnostic(value);
  if (typeof value.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(value.name)) fields.name = value.name;
  if (Number.isSafeInteger(value.code) || typeof value.code === 'string' && /^(?:(?:QQJ|V3|CHAT_SESSION|QIANQIANJIE|QIANSHI)_[A-Z0-9_]{1,80}|BACKEND_TIMEOUT)$/u.test(value.code)) fields.code = value.code;
  return fields;
}
function automationErrorDiagnostic(value, sourceKnown = true) {
  const result = errorDiagnostic(value, sourceKnown);
  if (result.present !== true) return result;
  const safeName = typeof value?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(value.name) ? value.name : null;
  const safeCode = diagnosticCode(value?.code);
  const safeLocation = typeof value?.location === 'string' && /^(?:src\/[A-Za-z0-9_./-]+\.js|index\.js|dist\/qqj-app\.js):[1-9]\d{0,6}:[1-9]\d{0,6}$/u.test(value.location) ? value.location : null;
  const failedAt = typeof value?.lastFailedAt === 'string' && Number.isFinite(Date.parse(value.lastFailedAt)) ? value.lastFailedAt.slice(0, 80) : null;
  return {
    ...result,
    name: safeName,
    code: safeCode,
    prepareStep: value?.prepareStep == null ? null : enumDiagnostic(value.prepareStep, DIAGNOSTIC_PREPARE_STEP),
    detail: AUTOMATION_DETAILS.has(value?.detail) ? value.detail : null,
    location: safeLocation,
    lastFailedAt: failedAt,
  };
}
const diagnosticVersion = value => typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/.test(value) ? value : 'unknown';
const splitPeople = value => [...new Set(String(value ?? '').split(/[、,，\n]/u).map(item => item.trim()).filter(Boolean))];
const timeDisplay = chronology => [...new Set((chronology ?? []).map(item => item?.time?.sourceText || item?.time?.normalized || item?.description).map(item => String(item ?? '').trim()).filter(Boolean))].join('；');
const floorTimeDisplay = (memory, floor) => {
  const chronology = memory?.chronology ?? [], saved = floor?.manualTime ? timeDisplay(chronology)
    : mainlineTimeText(memory);
  const extracted = String(floor?.timeFallback ?? '').trim();
  if (floor?.manualTime) return saved;
  return extracted || saved;
};
const comparableLocations = locations => (locations ?? []).map(item => ({ itemId: item?.itemId ?? null, name: String(item?.name ?? '').trim() })).filter(item => item.name);
const sameList = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const unchangedDraft = (draft, payload) => String(payload.summary ?? '').trim() === String(draft.originalSummary ?? '').trim()
  && String(payload.timeText ?? '').trim() === String(draft.originalTimeText ?? '').trim()
  && sameList(comparableLocations(payload.locations), comparableLocations(draft.originalLocations))
  && (!Object.hasOwn(payload, 'participantNames') || sameList(payload.participantNames, draft.originalParticipantNames))
  && sameList(payload.exactAnchors, draft.originalExactAnchors)
  && !String(payload.revisionNote ?? '').trim();
const CSE_VISIBILITY_OPTIONS = Object.freeze([['private', '私密'], ['expressed', '已表达'], ['observable', '可观察'], ['shared', '共享'], ['authorial', '作者设定']]);
const visibilityBadgeCopy = value => CSE_VISIBILITY_OPTIONS.find(([key]) => key === value)?.[1] ?? '未标注';
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

export function createV3FoundationView({ runtime, recallRuntime = null, vectorRuntime = null, onOpenVectorSettings = null, peopleRuntime = null, timeRuntime = null, memoryManagement = null, sessionStateProvider = null, prepareSession = null, backendDiagnosticProvider = null, pluginDiagnosticProvider = null, pluginVersion = 'unknown', uiDiagnosticProvider = null, documentRef = globalThis.document, navigatorRef = globalThis.navigator, confirmImpl = options => globalThis.confirm?.(typeof options === 'string' ? options : `${options?.title ?? '请确认'}\n\n${options?.body ?? ''}`) === true, chooseImpl = null, infoImpl = () => Promise.resolve(true), customImpl = null } = {}) {
  if (!runtime || ['getState', 'refreshStatus', 'confirmLatest'].some(name => typeof runtime[name] !== 'function')) throw new TypeError('V3 foundation view runtime 无效');
  if (recallRuntime && typeof recallRuntime.getState !== 'function') throw new TypeError('V3 recall view runtime 无效');
  if (peopleRuntime && typeof peopleRuntime.getState !== 'function') throw new TypeError('V3 people workspace runtime 无效');
  if (memoryManagement && (typeof memoryManagement.getState !== 'function' || typeof memoryManagement.deleteCurrent !== 'function')) throw new TypeError('当前聊天记忆管理器无效');
  if (sessionStateProvider !== null && typeof sessionStateProvider !== 'function') throw new TypeError('聊天身份状态 provider 无效');
  if (prepareSession !== null && typeof prepareSession !== 'function') throw new TypeError('聊天身份准备 provider 无效');
  if (uiDiagnosticProvider !== null && typeof uiDiagnosticProvider !== 'function') throw new TypeError('界面诊断 provider 无效');
  if (!documentRef?.createElement) throw new TypeError('V3 foundation view documentRef 无效');

  let pluginActivity = { busy: false, copy: '' };
  let refreshManagementProgress = null;
  let container = null, active = false, epoch = 0, feedback = '', refreshFeedback = null, receiptFeedback = '', prequelFeedback = '', fallbackText = '', unsubscribe = null;
  let page = 'management';
  let peopleMode = 'current', selectedCsePersonId = null, showMoreCsePeople = false;
  let foundationState = runtime.getState(), recallState = recallRuntime?.getState?.() ?? null, peopleState = peopleRuntime?.getState?.() ?? null, managementState = memoryManagement?.getState?.() ?? null, chatId = foundationState?.chatId ?? null, healthNode = null, pageFeedbackNode = null, managementFeedbackNode = null;
  let vectorIndexLink = null, vectorIndexReadErrorNode = null;
  let vectorReadArmed = false, vectorReadStarted = false, vectorReadPromise = Promise.resolve(), vectorIndexResult = null;
  let syncingChatId = null;
  let recentItemsOpen = false, recentItemsUi = null, showStoppedItems = false, recentItemDraft = null, recentBatchMode = false;
  let memorySearchQuery = '', memoryListPage = 0, cseSearchQuery = '';
  let renderedMemoryInputs = null, activeMemoryFloorId = null;
  let memoryWorkControls = [], memoryRowWorkControls = [], memoryRowMenus = [];
  const memoryCardStatusViews = new Map();
  let cseHistoryUi = null;
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
  const currentSituationLine = value => { const line = element('span', 'qqj-current-situation-line'); line.append(element('small', 'qqj-current-situation-visibility', visibilityBadgeCopy(value.visibility)), element('span', 'v3-cse-item-text', cseReadingText(value.text))); return line; };
  const confirmHistoricalMode = async ({ fullRebuild = false } = {}) => {
    const title = fullRebuild ? '完全重构当前聊天记忆' : '补齐当前聊天记忆';
    const hasArchivedPrefix = typeof foundationState?.migrationDescriptorId === 'string' && foundationState.migrationDescriptorId.length > 0;
    const body = fullRebuild
      ? hasArchivedPrefix
        ? '保留归档历史、千人人物资料（含头像与重要人物选择）和前情；重新整理当前部分的摘要与人物状态，并补查时间事项。聊天正文、其他插件数据和全局设置保留。时间事项按正文分批补查，完成后最多追加一次评估，失败不自动重试。'
        : '删除本聊天全部千千结记录后，调用 API 从头重建。摘要、双丝网、千人人物资料、头像、重要人物选择、时间事项、前情及所有人工修改都会清除；聊天正文、其他插件和全局设置保留。时间事项按正文分批补查，完成后最多追加一次评估，失败不自动重试。'
      : '已有摘要和人物状态会保留，只处理缺失部分；刷新页面后不会自动续跑。';
    if (typeof chooseImpl !== 'function') {
      if (!fullRebuild) return Object.freeze({ aggregate: false });
      const confirmed = await Promise.resolve(confirmImpl({ title, body, confirmText: '完全重构', cancelText: '取消' }));
      return confirmed ? Object.freeze({ aggregate: false }) : null;
    }
    const selected = await Promise.resolve(chooseImpl({
      title,
      body,
      note: '压缩模式：每 10 个 AI 楼合成一份记忆，批末分析一次人物状态；请求更少，细节也更少。普通模式逐楼处理。关闭窗口不开始任务。',
      choices: [
        { value: false, label: '否（普通逐楼模式）' },
        { value: true, label: '是（高楼压缩模式）', primary: true },
      ],
    }));
    return typeof selected === 'boolean' ? Object.freeze({ aggregate: selected }) : null;
  };
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
    chatId = nextChatId;
    for (const [key, draft] of drafts) if (!draft.saving) drafts.delete(key);
    cseDrafts.clear(); cseHistoryUi = null; openState.clear(); recentItemsOpen = false; recentItemsUi = null; memorySearchQuery = ''; memoryListPage = 0; cseSearchQuery = ''; peopleMode = 'current'; selectedCsePersonId = null; showMoreCsePeople = false; peopleScroll.set('current', 0); peopleScroll.set('history', 0); relationSwitcherNode = null; relationSwitcherSignature = null; relationSwitcherChatId = nextChatId; relationSwitcherScrollLeft = 0; fallbackText = ''; feedback = ''; refreshFeedback = null;
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
  const healthCopy = (state, timeSnapshot = null) => {
    if (state.pluginEnabled === false) return '千千结已关闭';
    if (pluginActivity.busy && ['memories', 'management'].includes(page) && !errorCopy(state)) return pluginActivity.copy;
    const time = timeSnapshot ?? timeRuntime?.getState?.();
    const sessionError = sessionErrorCopy(); if (sessionError) return `记忆读取失败 · ${sessionError}`;
    if (state.memorySnapshotStatus === 'syncing' && !(state.floors ?? []).length) return '正在读取当前聊天记忆';
    if (state.activeExtraction && state.activeExtraction.phase !== 'analyzingCse' && state.activeCse) return `摘要与人物状态并行 · 摘要 ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼 · 人物状态待分析 ${state.csePendingCount ?? 0} 楼`;
    if (state.activeExtraction?.phase === 'analyzingCse') return '摘要已保存，正在分析人物状态';
    if (!memoryBusy(state) && !cseBusy(state) && !workBusy(state) && !errorCopy(state)) {
      if (time?.active) return time.phase === 'saving' ? '正在保存时间事项' : time.phase === 'projecting' ? '正在推算时间状态' : '正在整理时间事项';
      if (page === 'management' && timeFailureCopy(time)) return `时间事项${timeFailureCopy(time)}`;
    }
    if (page === 'memories') {
      if (state.activeMemoryWork?.kind === 'auto' && state.activeMemoryWork.phase === 'reconciling' && !state.activeExtraction) return `正在同步楼层 · 已记忆 ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼`;
      if (memoryBusy(state)) return `正在处理摘要 · ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼${state.activeAutoMemory?.cseBlocked ? ' · 人物状态待重试' : ''}`;
      const error = errorCopy(state); if (error) return state.lastExtractorError?.phase === 'anchor'
        ? `消息标识保存待重试 · ${error}`
        : !state.lastExtractorError || state.lastExtractorError.floorId === null ? `记忆读取失败 · ${error}` : `摘要提取失败 · ${error}`;
      if (cseBusy(state)) return `摘要已保存 · ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼 · 正在分析人物状态`;
      if (state.activeMemoryWork?.phase === 'syncing') return `摘要已保存 · ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼 · 正在同步记忆状态`;
      const uninitialized = uninitializedCopy(state); if (uninitialized) return uninitialized;
      const waiting = waitingForConfirmation(state);
      return `已记忆 ${state.rememberedCount ?? 0}/${state.stableCount ?? 0} 楼${state.unprocessedCount > 0 ? ` · 待摘要 ${state.unprocessedCount} 楼` : ''}${waiting ? ` · ${waiting} 楼待确认` : ''}${state.memorySyncStatus === 'syncing' ? ' · 后台同步中' : ''}`;
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
      || (page === 'memories' && waitingForConfirmation(state) > 0)
      || !['ready', 'uninitialized'].includes(effectiveStatus(state));
    return `qqj-page-health ${checking ? 'checking' : 'healthy'}`;
  };
  const updateHealth = (state, timeSnapshot = null) => {
    if (!healthNode) return;
    healthNode.textContent = healthCopy(state, timeSnapshot);
    healthNode.className = healthClass(state);
  };
  const updatePageFeedback = state => {
    if (!pageFeedbackNode) return;
    const copy = pageFeedbackCopy(state);
    pageFeedbackNode.textContent = copy;
    pageFeedbackNode.hidden = !copy;
    pageFeedbackNode.className = `v3-foundation-feedback${copy.includes('失败') || (!feedback && errorCopy(state)) ? ' error' : ''}`;
  };
  const captureMemoryInputs = state => ({ chatId: state?.chatId ?? null, rootRevision: state?.rootRevision ?? null,
    headCheckpointId: state?.headCheckpointId ?? null, pluginEnabled: state?.pluginEnabled ?? null,
    foundationStatus: state?.foundationStatus ?? null, memorySnapshotStatus: state?.memorySnapshotStatus ?? null,
    memorySyncStatus: state?.memorySyncStatus ?? null,
    memorySyncError: state?.memorySyncError ? `${state.memorySyncError.code ?? ''}|${state.memorySyncError.message ?? ''}` : '',
    reviewReason: state?.reviewReason ? `${state.reviewReason.code ?? ''}|${state.reviewReason.assistantSeq ?? ''}|${state.reviewReason.messageIndex ?? ''}|${state.reviewReason.bindingIssue ?? ''}` : '',
    stableCount: state?.stableCount ?? null, rememberedCount: state?.rememberedCount ?? null,
    unprocessedCount: state?.unprocessedCount ?? null, failedCount: state?.failedCount ?? null,
    pendingAssistantSeq: state?.pending?.assistantSeq ?? null, pendingMessageIndex: state?.pending?.messageIndex ?? null,
    unregisteredCandidates: state?.unregisteredCandidates, consecutiveAssistantConfirmation: state?.consecutiveAssistantConfirmation,
    lastExtractorError: state?.lastExtractorError,
    lastCseError: state?.lastCseError ? `${state.lastCseError.floorId ?? ''}|${state.lastCseError.code ?? ''}|${state.lastCseError.message ?? ''}|${state.lastCseError.lastFailedAt ?? ''}` : '',
    lastError: state?.lastError, lastAutoMemory: state?.lastAutoMemory });
  const sameMemoryInputs = (left, right) => {
    if (!left || !right) return false;
    const current = captureMemoryInputs(right);
    return Object.keys(current).every(key => left[key] === current[key]);
  };
  const trackMemoryRowWorkControl = control => { memoryWorkControls.push(control); memoryRowWorkControls.push(control); };
  const forgetMemoryRows = () => {
    const rowWork = new Set(memoryRowWorkControls);
    memoryWorkControls = memoryWorkControls.filter(control => !rowWork.has(control));
    for (const menu of memoryRowMenus) operationMenus.unregister(menu);
    memoryRowWorkControls = []; memoryRowMenus = [];
    memoryCardStatusViews.clear(); activeMemoryFloorId = null;
  };
  const updateMemoryFloorStatus = (floorId, state) => {
    const view = memoryCardStatusViews.get(floorId);
    if (!view || view.frozen) return;
    const running = floorId === state?.activeExtraction?.floorId && state.activeExtraction.phase !== 'analyzingCse';
    const floor = (state?.floors ?? []).find(item => item.floorId === floorId);
    if (!floor) return;
    const userEdited = floor.summarySource === 'user' && floor.status === 'ready';
    view.card.className = `qqj-memory-card status-${floor.status}`;
    view.statusNode.textContent = running ? workPhaseCopy(state) : userEdited ? '人工修订' : statusCopy(floor.status);
    view.statusNode.className = `v3-memory-status${userEdited ? ' is-user' : ''}`;
  };
  const updateMemoryFloorStatuses = state => {
    const nextId = state?.activeExtraction?.phase !== 'analyzingCse' ? state?.activeExtraction?.floorId ?? null : null;
    if (activeMemoryFloorId && activeMemoryFloorId !== nextId) updateMemoryFloorStatus(activeMemoryFloorId, state);
    if (nextId) updateMemoryFloorStatus(nextId, state);
    activeMemoryFloorId = nextId;
  };
  const updateMemoryControls = state => {
    for (const control of memoryWorkControls) control.node.disabled = control.disabled(state);
  };
  const reviewCopy = state => {
    const reason = state?.reviewReason;
    const copy = ({ stableCountMismatch: '当前消息楼与已存记忆尚未同步。', markerMismatch: '有消息的记忆标记无法对应。', candidateCountMismatch: '有已存记忆楼尚未对应当前消息。', locatorMismatch: '有已存记忆楼的位置尚未对应。', fingerprintMismatch: '有消息与已存记录的正文版本依据不一致。', memoryExclusionChanged: '无需记录的楼标记尚未同步。', indexNeedsReseal: '记忆索引尚待同步。', missingRoot: '当前记忆记录尚未就绪。' })[reason?.code] || '当前记忆的对应关系尚未确认。';
    return copy + '请点击“刷新状态”；若仍未完成，到“详细诊断”复制状态诊断反馈。';
  };
  const currentFeedback = state => {
    const routine = !feedback || ['正在处理', '需要核对当前聊天记忆', '记忆状态已刷新。', '记忆状态已显示。', '当前聊天已读取完成。', '当前聊天尚未建立记忆，状态已读取完成。', '状态已显示。'].includes(feedback)
      || refreshFeedback !== null && feedback === refreshFeedback;
    if (!routine) return feedback;
    const error = errorCopy(state); if (error) return error;
    if (pluginActivity.busy && ['memories', 'management'].includes(page)) return '';
    if (['memories', 'management'].includes(page) && !refreshSyncing(state) && (effectiveStatus(state) === 'needsReview' || state.memorySyncStatus === 'needsReview')) return reviewCopy(state);
    return feedback === statusCopy('running') ? '' : feedback;
  };
  const pageFeedbackCopy = state => {
    const copy = currentFeedback(state) || errorCopy(state) || '记忆状态已显示。';
    return (page === 'memories' || pluginActivity.busy && page === 'management') && ['记忆状态已刷新。', '记忆状态已显示。'].includes(copy) ? errorCopy(state) : copy;
  };
  const pageStatus = state => {
    const block = element('div', 'qqj-page-status');
    healthNode = element('p', healthClass(state), healthCopy(state));
    const copy = pageFeedbackCopy(state);
    pageFeedbackNode = element('p', `v3-foundation-feedback${copy.includes('失败') || (!feedback && errorCopy(state)) ? ' error' : ''}`, copy);
    pageFeedbackNode.hidden = !copy;
    block.append(healthNode, pageFeedbackNode);
    return block;
  };
  const updateManagementVectorIndex = state => {
    if (!vectorIndexLink && !vectorIndexReadErrorNode) return;
    const matches = vectorIndexResult?.chatId === state?.chatId && vectorIndexResult?.narrativeGeneration === state?.narrativeGeneration;
    const result = matches ? vectorIndexResult : null;
    const zero = result?.status === 'ready' && result.chunkCount === 0;
    const readError = result?.status === 'error';
    if (vectorIndexLink) vectorIndexLink.hidden = page !== 'management' || !zero;
    if (vectorIndexReadErrorNode) {
      vectorIndexReadErrorNode.hidden = page !== 'management' || !readError;
      vectorIndexReadErrorNode.textContent = readError
        ? `读取当前聊天的向量索引失败：${result.message}。${result.code === 'VECTOR_CACHE_INVALID' ? '请到设置的“向量召回”中点击“建立索引”。' : '请重新打开记忆管理重试。'}`
        : '';
    }
  };
  const readVectorIndexForReadyState = (state, { refresh = false } = {}) => {
    if (!vectorReadArmed || !active || page !== 'management' || !vectorRuntime?.readIndexStatus
      || state?.memorySnapshotStatus !== 'ready' || typeof state.chatId !== 'string' || !state.chatId
      || typeof state.narrativeGeneration !== 'string' || !state.narrativeGeneration) return Promise.resolve();
    if (refresh) {
      const mine = epoch;
      vectorReadPromise = Promise.resolve(vectorReadPromise).then(() => {
        if (!active || mine !== epoch || !vectorReadArmed || page !== 'management') return;
        vectorReadStarted = false;
        return readVectorIndexForReadyState(state);
      });
      return vectorReadPromise;
    }
    if (vectorReadStarted) return vectorReadPromise;
    vectorReadStarted = true;
    const target = { chatId: state.chatId, narrativeGeneration: state.narrativeGeneration };
    const mine = epoch;
    vectorReadPromise = Promise.resolve().then(() => vectorRuntime.readIndexStatus(target)).then(result => {
      if (!active || mine !== epoch) return;
      vectorIndexResult = { ...result, ...target };
      updateManagementVectorIndex(foundationState);
    }, error => {
      if (!active || mine !== epoch) return;
      vectorIndexResult = { status: 'error', code: typeof error?.code === 'string' ? error.code : null,
        ...target, message: publicErrorMessage(error, { fallback: '索引状态暂时无法读取。' }) };
      updateManagementVectorIndex(foundationState);
    });
    return vectorReadPromise;
  };
  const renderManagementVectorIndex = state => {
    const link = element('button', 'qqj-vector-index-link', '还没有向量索引，去建立吧 →');
    link.type = 'button'; link.hidden = true;
    link.addEventListener('click', () => { onOpenVectorSettings?.(); });
    vectorIndexLink = link;
    vectorIndexReadErrorNode = element('p', 'settings-hint qqj-vector-index-read-error');
    vectorIndexReadErrorNode.hidden = true;
    updateManagementVectorIndex(state);
    return [link, vectorIndexReadErrorNode];
  };
  const heading = (title, description, state) => {
    const block = element('header', 'qqj-view-heading');
    block.append(element('h2', '', title), element('p', '', description));
    healthNode = element('p', healthClass(state), healthCopy(state));
    block.append(healthNode); return block;
  };

  async function copy(value, { local = false } = {}) {
    if (navigatorRef?.clipboard?.writeText) {
      try {
        await navigatorRef.clipboard.writeText(value); if (!local) fallbackText = '';
        // 剪贴板写入成功才提示；通知失败不应误报复制失败或切到手动复制。
        try { globalThis.toastr?.success?.('已复制。'); } catch {}
        return '已复制。';
      }
      catch { /* 浏览器或壳层拒绝剪贴板权限时改用只读文本框。 */ }
    }
    if (!local) fallbackText = value; return '浏览器不允许直接复制，请在下方文本框长按全选复制。';
  }
  const readDiagnosticState = provider => { try { return provider?.() ?? null; } catch { return null; } };
  const stateDiagnostic = () => {
    const memory = readDiagnosticState(() => runtime.getState());
    const qianshiState = readDiagnosticState(() => runtime.getQianshiStatus?.());
    const identity = readDiagnosticState(sessionStateProvider);
    const hasPluginDiagnosticProvider = typeof pluginDiagnosticProvider === 'function';
    let pluginDiagnostic = null, pluginDiagnosticReadFailed = false;
    if (hasPluginDiagnosticProvider) {
      try { pluginDiagnostic = pluginDiagnosticProvider(); }
      catch { pluginDiagnosticReadFailed = true; }
    }
    const recall = readDiagnosticState(() => recallRuntime?.getState?.());
    const vector = readDiagnosticState(() => vectorRuntime?.getState?.());
    const management = readDiagnosticState(() => memoryManagement?.getState?.());
    const managementActivity = readDiagnosticState(() => memoryManagement?.getActivityState?.());
    const historical = management?.rebuildState;
    const time = readDiagnosticState(() => typeof timeRuntime?.getActivityState === 'function' ? timeRuntime.getActivityState() : timeRuntime?.getState?.());
    const memoryKnown = memory !== null, identityKnown = identity !== null, recallKnown = recall !== null, managementKnown = management !== null;
    const deleting = management?.status === 'deleting', deletePending = management?.status === 'failed';
    const indexMatchesMemory = Boolean(memory && vectorIndexResult
      && vectorIndexResult.chatId === memory.chatId
      && vectorIndexResult.narrativeGeneration === memory.narrativeGeneration);
    const indexCheckStatus = indexMatchesMemory && ['ready', 'error'].includes(vectorIndexResult.status)
      ? vectorIndexResult.status : 'notChecked';
    const indexStatusDiagnostic = {
      indexCheckStatus,
      indexChunkCount: indexCheckStatus === 'ready' && Number.isSafeInteger(vectorIndexResult.chunkCount) && vectorIndexResult.chunkCount >= 0 ? vectorIndexResult.chunkCount : null,
      indexChatMatchesMemory: indexMatchesMemory,
    };
    const qianshiDiagnostic = (() => {
      if (!qianshiState) return { status: 'unknown', coverage: null, history: null };
      const coverage = qianshiState.coverage ?? {}, processable = coverage.processable ?? coverage;
      const outcomes = Array.isArray(qianshiState.history?.outcomes) ? qianshiState.history.outcomes : [];
      const history = qianshiState.history;
      return {
        status: enumDiagnostic(qianshiState.status, new Set(['ready', 'not-ready', 'unavailable', 'error'])),
        coverage: {
          eligibleFloors: countDiagnostic(processable.eligibleFloors),
          readyFloors: countDiagnostic(processable.readyFloors),
          completeFloors: countDiagnostic(processable.completeFloors),
          pendingFloors: countDiagnostic(processable.pendingFloors),
          partialFloors: countDiagnostic(processable.partialFloors),
          degradedFloors: countDiagnostic(processable.degradedFloors),
          unavailableFloors: countDiagnostic(processable.unavailableFloors),
          emptyFloors: countDiagnostic(processable.emptyFloors),
          frozenFloors: countDiagnostic(processable.frozenFloors),
        },
        history: history ? {
          status: enumDiagnostic(history.status, new Set(['idle', 'running', 'completed', 'partial', 'stopped', 'failed'])),
          mode: enumDiagnostic(history.mode, new Set(['history', 'rejudge'])),
          committing: booleanDiagnostic(history.committing),
          commitStatus: enumDiagnostic(history.commitStatus, new Set(['notAttempted', 'attempted', 'saved', 'unknown', 'conflict'])),
          processedFloors: countDiagnostic(history.processedFloors), totalFloors: countDiagnostic(history.totalFloors),
          calls: countDiagnostic(history.calls), attemptedFloors: countDiagnostic(history.attemptedFloors),
          savedCompleteFloors: countDiagnostic(history.savedCompleteFloors), savedPartialFloors: countDiagnostic(history.savedPartialFloors),
          savedFloors: countDiagnostic(history.savedFloors), failedFloors: countDiagnostic(history.failedFloors),
          skippedFloors: countDiagnostic(history.skippedFloors),
          outcomes: outcomes.filter(item => item?.status !== 'saved-complete').map(item => {
            return {
              messageIndex: countDiagnostic(item?.messageIndex), assistantSeq: countDiagnostic(item?.assistantSeq),
              status: enumDiagnostic(item?.status, new Set(['failed', 'skipped', 'conflict-review', 'commit-unknown', 'saved-partial'])),
              reasonCode: diagnosticCode(item?.reasonCode),
            };
          }),
        } : null,
      };
    })();
    return {
        formatVersion: 2,
      pluginVersion: diagnosticVersion(pluginVersion),
      capturedAt: new Date().toISOString(),
      backend: readDiagnosticState(backendDiagnosticProvider),
      time: (() => {
        const statuses = new Set(['idle', 'running', 'waiting', 'disabled', 'completed', 'empty', 'partial', 'failed', 'interrupted']);
        const rawErrors = Array.isArray(time?.last?.itemErrors) ? time.last.itemErrors : [];
        const fixedReason = value => {
          const plain = typeof value === 'string' && value.startsWith('归并组：') ? value.slice(4) : value;
          return TIME_ITEM_FAILURE_REASONS.has(plain) ? plain : null;
        };
        const itemErrors = rawErrors.slice(0, 12).flatMap(item => {
          const reason = fixedReason(item?.reason);
          return reason ? [{ index: Number.isSafeInteger(item.index) && item.index > 0 ? item.index : null, reason }] : [];
        });
        const message = typeof time?.last?.message === 'string' ? time.last.message.slice(0, 12000) : '';
        const knownReasons = [...new Set([...itemErrors.map(item => item.reason), ...[...TIME_ITEM_FAILURE_REASONS].filter(reason => message.includes(reason))])];
        const failures = Array.isArray(time?.last?.failureDiagnostics) ? time.last.failureDiagnostics
          : Array.isArray(time?.last?.failedBodyAttempts) ? time.last.failedBodyAttempts : time?.last?.failure ? [{ failure: time.last.failure, cutoffAssistantSeq: time.last.cutoffAssistantSeq }] : [];
        return { status: enumDiagnostic(time?.status, statuses),
          phase: time?.phase == null ? null : enumDiagnostic(time.phase, new Set(['preparing', 'collecting', 'projecting', 'saving'])),
          active: time ? booleanDiagnostic(time.active) : 'unknown',
          progress: time?.progress ? { completed: countDiagnostic(time.progress.completed), total: countDiagnostic(time.progress.total) } : null,
          last: time?.last ? { status: enumDiagnostic(time.last.status, statuses),
            cutoffAssistantSeq: countDiagnostic(time.last.cutoffAssistantSeq), failedBatchCount: countDiagnostic(time.last.failedBatchCount),
            itemErrorIndexScope: 'batch', itemErrors, itemErrorsTruncated: rawErrors.length > 12,
            knownReasons, reasonStatus: knownReasons.length ? 'known' : 'unknown',
            batchFailures: failures.slice(0, 12).map(item => ({ ...errorDiagnostic(item.failure, Boolean(item.failure)),
              phase: enumDiagnostic(item.failure?.phase, TIME_FAILURE_PHASES), at: countDiagnostic(item.failure?.at), currentReview: booleanDiagnostic(item.currentReview), fromAssistantSeq: countDiagnostic(item.fromAssistantSeq),
              toAssistantSeq: countDiagnostic(item.toAssistantSeq), cutoffAssistantSeq: countDiagnostic(item.cutoffAssistantSeq) })),
            batchFailuresTruncated: failures.length > 12 || time.last.failureDiagnosticsTruncated === true, failureDetails: time.last.failure || failures.some(item => item.failure) ? 'recorded' : 'unknown',
            error: ['failed', 'partial'].includes(time.last.status) ? { ...errorDiagnostic(time.last.failure ?? time.last.error ?? time.last, true),
              ...(time.last.failure ? { phase: enumDiagnostic(time.last.failure.phase, TIME_FAILURE_PHASES), at: countDiagnostic(time.last.failure.at) } : {}) } : null } : null };
      })(),
      identity: {
        status: identityKnown ? enumDiagnostic(identity.status, DIAGNOSTIC_STATUS) : 'unknown',
        identityPresent: identityKnown ? Boolean(identity.identity) : 'unknown',
        error: errorDiagnostic(identity?.error, identityKnown),
        preparationFailure: (() => {
          const failure = identity?.preparationFailure;
          if (!failure) return { present: identityKnown ? false : 'unknown' };
          return { present: true, ...errorDiagnostic(failure, true), ...preparationErrorFields(failure), prepareStep: enumDiagnostic(failure.prepareStep, DIAGNOSTIC_PREPARE_STEP), detail: AUTOMATION_DETAILS.has(failure.detail) ? failure.detail : null, location: typeof failure.location === 'string' && /^(?:src\/[A-Za-z0-9_./-]+\.js|index\.js|dist\/qqj-app\.js):[1-9]\d{0,6}:[1-9]\d{0,6}$/u.test(failure.location) ? failure.location : null };
        })(),
      },
      pluginLifecycle: (() => {
        if (!hasPluginDiagnosticProvider || pluginDiagnosticReadFailed) return { phase: 'unknown', failure: { present: 'unknown' } };
        if (!pluginDiagnostic) return { phase: 'unknown', failure: { present: false } };
        const failure = pluginDiagnostic.failure;
        if (!failure) return { phase: enumDiagnostic(pluginDiagnostic.phase, new Set(['settingsSave', 'pluginEnable', 'startup', 'identityPrepare'])), failure: { present: false } };
        return { phase: enumDiagnostic(pluginDiagnostic.phase, new Set(['settingsSave', 'pluginEnable', 'startup', 'identityPrepare'])), failure: { present: true, ...errorDiagnostic(failure, true), ...preparationErrorFields(failure), prepareStep: enumDiagnostic(failure.prepareStep, DIAGNOSTIC_PREPARE_STEP), detail: AUTOMATION_DETAILS.has(failure.detail) ? failure.detail : null, location: typeof failure.location === 'string' && /^(?:src\/[A-Za-z0-9_./-]+\.js|index\.js|dist\/qqj-app\.js):[1-9]\d{0,6}:[1-9]\d{0,6}$/u.test(failure.location) ? failure.location : null } };
      })(),
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
        request: requestDiagnostic(memory?.extractorRequest),
        lastAutomationError: automationErrorDiagnostic(memory?.lastAutomationError, memoryKnown),
      },
      cse: {
        request: requestDiagnostic(memory?.cseRequest),
        active: memoryKnown ? operationDiagnostic(memory.activeCse) : { present: 'unknown', phase: 'unknown' },
        rebuildStatus: enumDiagnostic(memory?.cseRebuildStatus, DIAGNOSTIC_STATUS),
        lastError: { ...errorDiagnostic(memory?.lastCseError, memoryKnown),
          ...(memory?.lastCseError ? { subjectResolution: projectCseSubjectDiagnostic(memory.lastCseError.diagnostics?.subjectResolution) } : {}) },
      },
      qianshi: qianshiDiagnostic,
      recall: {
        status: recallKnown ? enumDiagnostic(recall.recallStatus, DIAGNOSTIC_STATUS) : 'unknown',
        active: recallKnown ? operationDiagnostic(recall.activeRecall) : { present: 'unknown', phase: 'unknown' },
        lastError: errorDiagnostic(recall?.lastRecallError, recallKnown),
      },
      vector: (() => {
        const build = vector?.buildDiagnostic;
        if (!build) return { status: enumDiagnostic(vector?.status, VECTOR_RUNTIME_STATUS), ...indexStatusDiagnostic, build: null };
        const request = build.request;
        const safeField = value => typeof value === 'string' && value.length <= 80 && /^[A-Za-z0-9_.:\-\[\]]+$/u.test(value) ? value : null;
        return { status: enumDiagnostic(vector?.status, VECTOR_RUNTIME_STATUS), ...indexStatusDiagnostic,
          build: {
          status: enumDiagnostic(build.status, VECTOR_BUILD_STATUS),
          phase: enumDiagnostic(build.phase, VECTOR_BUILD_PHASE),
          batchNumber: countDiagnostic(build.batchNumber), completedChunks: countDiagnostic(build.completedChunks), totalChunks: countDiagnostic(build.totalChunks),
          inputCount: countDiagnostic(build.inputCount), inputCharacters: countDiagnostic(build.inputCharacters), longestInputCharacters: countDiagnostic(build.longestInputCharacters),
          errorCode: typeof build.errorCode === 'string' && /^VECTOR_[A-Z0-9_]{1,80}$/u.test(build.errorCode) ? build.errorCode : null,
          httpStatus: Number.isSafeInteger(build.httpStatus) && build.httpStatus >= 100 && build.httpStatus <= 599 ? build.httpStatus : null,
          request: request ? { requestId: typeof request.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\-]{7,127}$/u.test(request.requestId) ? request.requestId : null,
            phase: enumDiagnostic(request.phase, VECTOR_REQUEST_PHASE),
            pendingStage: enumDiagnostic(request.pendingStage, VECTOR_REQUEST_STAGE),
            elapsedMs: countDiagnostic(request.elapsedMs), deadlineMs: countDiagnostic(request.deadlineMs),
            httpStatus: Number.isSafeInteger(request.httpStatus) && request.httpStatus >= 100 && request.httpStatus <= 599 ? request.httpStatus : null,
            errorCode: typeof request.errorCode === 'string' && /^VECTOR_[A-Z0-9_]{1,80}$/u.test(request.errorCode) ? request.errorCode : null,
            providerRequestId: typeof request.providerRequestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\-]{7,127}$/u.test(request.providerRequestId) ? request.providerRequestId : null,
            providerError: request.providerError ? { code: safeField(request.providerError.code), type: safeField(request.providerError.type), param: safeField(request.providerError.param) } : null,
            fetchCallMs: countDiagnostic(request.fetchCallMs), responseHeadersMs: countDiagnostic(request.responseHeadersMs), responseBodyMs: countDiagnostic(request.responseBodyMs) } : null,
        } };
      })(),
      management: {
        status: managementKnown ? enumDiagnostic(management.status, DIAGNOSTIC_STATUS) : 'unknown',
        phase: managementKnown && management.phase !== null ? enumDiagnostic(management.phase, DIAGNOSTIC_PHASE) : managementKnown ? null : 'unknown',
        workBusy: managementKnown ? booleanDiagnostic(management.workBusy) : 'unknown',
        error: errorDiagnostic(management?.error, managementKnown),
        activity: {
          busy: booleanDiagnostic(managementActivity?.busy),
          phase: managementActivity?.busy === false ? null : enumDiagnostic(managementActivity?.phase, DIAGNOSTIC_PHASE),
        },
        rebuildState: historical ? {
          status: enumDiagnostic(historical.status, DIAGNOSTIC_STATUS),
          snapshotStatus: enumDiagnostic(historical.memorySnapshotStatus, DIAGNOSTIC_STATUS),
          syncStatus: enumDiagnostic(historical.memorySyncStatus, DIAGNOSTIC_STATUS),
          rebuildStatus: enumDiagnostic(historical.rebuildStatus, DIAGNOSTIC_STATUS),
          phase: historical.phase === null ? null : enumDiagnostic(historical.phase, DIAGNOSTIC_PHASE),
          rememberedCount: countDiagnostic(historical.rememberedCount), stableCount: countDiagnostic(historical.stableCount),
          rebuildCompletedCount: countDiagnostic(historical.rebuildCompletedCount), rebuildTotalCount: countDiagnostic(historical.rebuildTotalCount),
          memoryWorkBusy: booleanDiagnostic(historical.memoryWorkBusy),
          activeMemoryWork: operationDiagnostic(historical.activeMemoryWork, { kind: true }),
          activeExtraction: operationDiagnostic(historical.activeExtraction),
          activeAutoMemory: operationDiagnostic(historical.activeAutoMemory),
          activeCse: operationDiagnostic(historical.activeCse),
          syncError: errorDiagnostic(historical.memorySyncError),
          lastExtractorError: errorDiagnostic(historical.lastExtractorError),
          extractorRequest: requestDiagnostic(historical.extractorRequest), cseRequest: requestDiagnostic(historical.cseRequest),
          lastAutomationError: automationErrorDiagnostic(historical.lastAutomationError),
          lastCseError: errorDiagnostic(historical.lastCseError),
        } : null,
      },
      ui: {
        syncingOverlayActive: Boolean(syncingChatId && syncingChatId === foundationState?.chatId),
        workBusy: memoryKnown ? workBusy(memory) : 'unknown',
        pluginActivity: { busy: pluginActivity.busy === true, phase: pluginActivity.busy ? enumDiagnostic(pluginActivity.phase, DIAGNOSTIC_PHASE) : null },
        deleting,
        deletePending,
      },
    };
  };
  const copyStateDiagnostic = async () => {
    const value = JSON.stringify(stateDiagnostic(), null, 2);
    refreshFeedback = null;
    feedback = await copy(value);
    if (active && container) {
      if (fallbackText) render(runtime.getState());
      else if (page === 'management') updateManagementFeedback(foundationState);
      else updatePageFeedback(foundationState);
    }
  };
  const refreshSyncing = state => state?.memorySnapshotStatus === 'syncing' || state?.memorySyncStatus === 'syncing';
  async function run(label, task, { after, failed, resultCopy, followState = false } = {}) {
    const mine = ++epoch, progressFeedback = `${label}…`; feedback = progressFeedback; refreshFeedback = followState ? progressFeedback : null; updateManagementFeedback(foundationState); updateHealth(foundationState);
    const beforeState = runtime.getState?.() ?? foundationState;
    try {
      const next = await task();
      const nextState = runtime.getState?.() ?? next;
      const settledRender = after?.(nextState) === true;
      if (!active) return next;
      if (mine !== epoch) { if (settledRender) { feedback = `${label}完成。`; render(nextState); } return next; }
      if (followState && (feedback === progressFeedback || refreshFeedback !== null && feedback === refreshFeedback) && (refreshSyncing(nextState) || pluginActivity.busy)) {
        feedback = resultCopy?.(nextState, beforeState, next) ?? `${label}结束：${statusCopy(nextState?.status)}`;
        refreshFeedback = feedback;
      } else {
        if (followState) refreshFeedback = null;
        if (!feedback || feedback.endsWith('…')) feedback = resultCopy?.(nextState, beforeState, next) || (nextState?.status === 'ready' ? `${label}完成。` : `${label}结束：${statusCopy(nextState?.status)}`);
      }
      render(nextState); return next;
    } catch (error) {
      const settledRender = failed?.(error) === true;
      if (!active) return { status: 'stale' };
      if (mine !== epoch && !settledRender) return { status: 'stale' };
      if (followState) refreshFeedback = null;
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
      : `${label}部分完成：新增摘要 ${result.processed ?? 0} 楼，补齐人物状态 ${result.cseProcessed ?? 0} 楼；${result.failedItems?.length || result.available || 0} 楼摘要需重试，详见楼层列表。`;
    if (result?.status === 'failed') {
      // 单楼错误保留具体楼号；多楼只报数量，避免提示随历史长度膨胀。
      const failedFloors = result.failedItems?.length === 1 ? result.failedItems[0].floorLabel || floorCopy(state, result.failedItems[0], '目标楼')
        : result.failedItems?.length ? `${result.failedItems.length} 楼失败` : '';
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
    if (pluginActivity.busy) return '';
    if (refreshSyncing(state)) return state?.memorySnapshotStatus === 'ready'
      ? '记忆资料已读入，正在同步与核验。'
      : '正在读取当前聊天记忆。';
    if (effectiveStatus(state) === 'needsReview' || state?.foundationStatus === 'needsReview' || state?.memorySyncStatus === 'needsReview') return statusCopy('needsReview');
    if (effectiveStatus(state) === 'uninitialized') return '当前聊天尚未建立记忆，状态已读取完成。';
    if (state?.memorySnapshotStatus === 'ready') return '当前聊天已读取完成。';
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

  function openMemoryEditor(floor, state, key, draft) {
    if (typeof customImpl !== 'function') { feedback = '当前环境无法打开记忆编辑窗口。'; render(state); return; }
    drafts.set(key, draft);
    const editor = element('div', 'qqj-editor-dialog qqj-memory-edit');
    const draw = (keepLocationsOpen = false, keepAnchorGroupOpen = false) => {
      const controls = [];
      const priorLocationGroup = Array.from(editor.children).find(node => (node.tag === 'details' || node.tagName?.toLowerCase() === 'details') && node.children[0]?.textContent === '地点');
      const priorAnchorGroup = Array.from(editor.children).find(node => (node.tag === 'details' || node.tagName?.toLowerCase() === 'details') && String(node.children[0]?.textContent ?? '').startsWith('关键原文'));
      keepLocationsOpen ||= priorLocationGroup?.open === true;
      keepAnchorGroupOpen ||= priorAnchorGroup?.open === true;
      editor.replaceChildren(element('p', 'qqj-editor-intro', '只修改本楼摘要与已有元信息；保存会保留原来的楼层对应关系。'));
      const label = (copy, control) => { const node = element('label', 'qqj-memory-edit-field'); node.append(element('span', '', copy), control); controls.push(control); return node; };
      const summary = element('textarea', 'settings-input'); summary.value = draft.summary; summary.placeholder = '输入用户修订摘要'; summary.rows = 8; summary.addEventListener('input', () => { draft.summary = summary.value; });
      const summaryGroup = element('section', 'qqj-editor-group'); summaryGroup.append(element('h3', '', '摘要'), label('摘要正文', summary)); editor.append(summaryGroup);
      const time = element('input', 'settings-input'); time.value = draft.timeText; time.placeholder = '日期、时间范围或相对时间'; time.addEventListener('input', () => { draft.timeText = time.value; });
      const timeGroup = element('details', 'qqj-editor-group'); timeGroup.append(element('summary', 'qqj-editor-group-summary', '时间'), label('时间', time)); editor.append(timeGroup);
      const locations = element('details', 'qqj-editor-group'); locations.open = keepLocationsOpen; locations.append(element('summary', 'qqj-editor-group-summary', '地点'));
      draft.locations.forEach((item, index) => {
        const row = element('div', 'qqj-memory-edit-row'), input = element('input', 'settings-input'); input.value = item.name ?? ''; input.placeholder = '地点名称'; input.addEventListener('input', () => { item.name = input.value; }); controls.push(input);
        const remove = element('button', 'secondary-action', '删除地点'); remove.type = 'button'; remove.addEventListener('click', () => { draft.locations.splice(index, 1); draw(true); }); controls.push(remove); row.append(input, remove); locations.append(row);
      });
      const add = element('button', 'secondary-action', '添加地点'); add.type = 'button'; add.addEventListener('click', () => { draft.locations.push({ itemId: null, name: '' }); draw(true); }); controls.push(add); locations.append(add); editor.append(locations);
      const people = element('textarea', 'settings-input'); people.value = draft.peopleText; people.placeholder = '张三、李四、路人甲'; people.addEventListener('input', () => { draft.peopleText = people.value; });
      const peopleGroup = element('details', 'qqj-editor-group'); peopleGroup.append(element('summary', 'qqj-editor-group-summary', '人物'), label('人物名称', people)); editor.append(peopleGroup);
      const anchors = element('details', 'qqj-editor-group'); anchors.open = keepAnchorGroupOpen; anchors.append(element('summary', 'qqj-editor-group-summary', `关键原文（${draft.exactAnchors.length}）`));
      const peopleOptions = (state.memoryEntities ?? []).filter(entity => entity?.entityId && entity.displayName).slice().sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), 'zh-Hans-CN') || a.entityId.localeCompare(b.entityId));
      draft.exactAnchors.forEach((item, index) => {
        const row = element('div', 'qqj-memory-edit-anchor');
        const carrier = element('input', 'settings-input'); carrier.value = item.carrier ?? ''; carrier.placeholder = '载体名称'; carrier.addEventListener('input', () => { item.carrier = carrier.value; }); controls.push(carrier);
        const content = element('textarea', 'settings-input'); content.value = item.exactText ?? ''; content.placeholder = '关键原文，最多 2000 字；保留换行与标点'; content.rows = 4; content.addEventListener('input', () => { item.exactText = content.value; }); controls.push(content);
        item.knownEntityIds = [...(item.knownEntityIds ?? [])];
        const knowledge = element('details', 'qqj-editor-group qqj-exact-anchor-knowledge'); knowledge.append(element('summary', 'qqj-editor-group-summary', `知情人物（${item.knownEntityIds.length}）`));
        knowledge.addEventListener('toggle', () => {
          if (!knowledge.open || knowledge.datasetBuilt) return;
          knowledge.datasetBuilt = true;
          const hint = element('p', 'qqj-exact-anchor-knowledge-hint', '仅勾选者知道这条原文；未选者均未知，user也不会默认知情。');
          const search = element('input', 'settings-input'); search.type = 'search'; search.placeholder = '搜索人物名称或别名'; search.setAttribute('aria-label', '搜索人物名称或别名');
          const clear = element('button', 'secondary-action', '清空选择'); clear.type = 'button';
          const list = element('div', 'qqj-exact-anchor-knowledge-list');
          const empty = element('p', 'qqj-exact-anchor-knowledge-empty', '没有匹配的人物。'); empty.hidden = true;
          const options = peopleOptions.map(person => {
            const choice = element('label', 'qqj-exact-anchor-knowledge-choice');
            const checkbox = element('input', ''); checkbox.type = 'checkbox'; checkbox.checked = item.knownEntityIds.includes(person.entityId); checkbox.setAttribute('data-entity-id', person.entityId);
            checkbox.addEventListener('change', () => {
              item.knownEntityIds = checkbox.checked ? [...new Set([...item.knownEntityIds, person.entityId])] : item.knownEntityIds.filter(id => id !== person.entityId);
              knowledge.children[0].textContent = `知情人物（${item.knownEntityIds.length}）`;
            });
            choice.append(checkbox, element('span', '', `${person.displayName}${person.aliases?.length ? `（${person.aliases.join('、')}）` : ''}`)); list.append(choice); controls.push(checkbox);
            return { choice, person, checkbox };
          });
          search.addEventListener('input', () => {
            const query = String(search.value ?? '').trim().toLocaleLowerCase();
            for (const { choice, person } of options) choice.hidden = !!query && ![person.displayName, ...(person.aliases ?? [])].some(value => String(value).toLocaleLowerCase().includes(query));
            empty.hidden = options.some(({ choice }) => !choice.hidden);
          });
          search.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
          clear.addEventListener('click', () => {
            item.knownEntityIds = [];
            for (const { checkbox } of options) checkbox.checked = false;
            knowledge.children[0].textContent = '知情人物（0）';
          });
          knowledge.append(hint, search, clear, list, empty); controls.push(search, clear);
        });
        const remove = element('button', 'secondary-action', '删除原文'); remove.type = 'button'; remove.addEventListener('click', () => { draft.exactAnchors.splice(index, 1); draw(false, true); }); controls.push(remove);
        row.append(label('载体', carrier), label('内容', content), knowledge, remove); anchors.append(row);
      });
      const addAnchor = element('button', 'secondary-action', '添加原文'); addAnchor.type = 'button'; addAnchor.addEventListener('click', () => { draft.exactAnchors.push({ anchorId: null, carrier: '', exactText: '', knownEntityIds: [] }); draw(false, true); }); controls.push(addAnchor); anchors.append(addAnchor); editor.append(anchors);
      const note = element('input', 'settings-input'); note.value = draft.note; note.placeholder = '修订说明（可选）'; note.addEventListener('input', () => { draft.note = note.value; });
      const noteGroup = element('details', 'qqj-editor-group'); noteGroup.append(element('summary', 'qqj-editor-group-summary', '修订说明'), note); editor.append(noteGroup);
      controls.push(note); draft.controls = controls;
    };
    draw();
    let saved = false;
    void Promise.resolve(customImpl({ title: `编辑摘要 · ${floorCopy(state, floor)}`, content: editor, confirmText: '保存', cancelText: '取消', submit: async () => {
      const payload = { summary: draft.summary, timeText: draft.timeText, originalTimeText: draft.originalTimeText, timeChanged: String(draft.timeText ?? '').trim() !== String(draft.originalTimeText ?? '').trim(), locations: draft.locations,
        ...(draft.peopleText !== draft.originalParticipantNames.join('、') ? { participantNames: splitPeople(draft.peopleText) } : {}),
        exactAnchors: draft.exactAnchors, revisionNote: draft.note };
      if (unchangedDraft(draft, payload)) { saved = true; drafts.delete(key); return true; }
      const task = typeof runtime.editMemory === 'function' ? () => runtime.editMemory(floor.floorId, payload) : () => runtime.editSummary(floor.floorId, payload.summary, payload.revisionNote);
      let failure = null;
      await run('保存本楼记忆', task, { after: () => { drafts.delete(key); saved = true; return true; }, failed: error => { draft.saveError = `保存失败：${publicErrorMessage(error, { fallback: '本楼记忆没有保存，请重试。' })}`; failure = error; return true; } });
      if (failure) { draw(); throw failure; }
      return true;
    }, onClose: () => { if (!saved && drafts.get(key) === draft) { drafts.delete(key); if (active) render(foundationState); } } })).catch(() => {});
  }

  function memoryLocationLabelsByFloor(state, floors) {
    // Keep containment history on the loaded floor order and evidence floor IDs; display numbers may repeat across archived sources.
    const sourceOrder = new Map(), floorTargets = new Map();
    let nextOrder = 0;
    for (let index = 0; index < floors.length; index += 1) {
      const floor = floors[index];
      const sourceIds = Array.isArray(floor.sourceFloorIds) && floor.sourceFloorIds.length
        ? floor.sourceFloorIds : [floor.floorId];
      for (const sourceFloorId of sourceIds) {
        if (typeof sourceFloorId !== 'string' || !sourceFloorId) continue;
        if (!sourceOrder.has(sourceFloorId)) sourceOrder.set(sourceFloorId, nextOrder++);
      }
      const targetId = sourceIds.at(-1);
      floorTargets.set(floor.floorId, { order: sourceOrder.get(targetId) ?? index, index });
    }

    const relationChanges = new Map();
    for (const floor of floors) {
      const memory = floor.memory;
      if (memory?.recordStatus !== 'active') continue;
      const containments = memory.spatialFacts?.containments ?? [];
      for (const relation of containments) {
        const childId = relation?.placeEntityId, parentId = relation?.parentEntityId;
        if (typeof childId !== 'string' || !childId || typeof parentId !== 'string' || !parentId) continue;
        const sourceIds = new Set((relation.evidenceRefs ?? []).map(ref => ref?.floorId).filter(sourceFloorId => sourceOrder.has(sourceFloorId)));
        for (const sourceFloorId of sourceIds) {
          const order = sourceOrder.get(sourceFloorId);
          let byChild = relationChanges.get(order);
          if (!byChild) relationChanges.set(order, byChild = new Map());
          let parents = byChild.get(childId);
          if (!parents) byChild.set(childId, parents = new Set());
          parents.add(parentId);
        }
      }
    }

    const placeNames = new Map((state.memoryPlaceEntities ?? [])
      .filter(entity => typeof entity?.entityId === 'string' && entity.entityId && typeof entity.displayName === 'string' && entity.displayName.trim())
      .map(entity => [entity.entityId, entity.displayName.trim()]));
    const orderedTargets = [...floors].sort((left, right) => {
      const leftTarget = floorTargets.get(left.floorId), rightTarget = floorTargets.get(right.floorId);
      return leftTarget.order - rightTarget.order || leftTarget.index - rightTarget.index;
    });
    const orderedChanges = [...relationChanges].sort(([left], [right]) => left - right);
    const currentParents = new Map(), labelsByFloor = new Map();
    let changeIndex = 0;
    for (const floor of orderedTargets) {
      const targetOrder = floorTargets.get(floor.floorId).order;
      while (changeIndex < orderedChanges.length && orderedChanges[changeIndex][0] <= targetOrder) {
        const [, changes] = orderedChanges[changeIndex++];
        for (const [childId, parents] of changes) {
          if (parents.size === 1) currentParents.set(childId, parents.values().next().value);
          else currentParents.delete(childId);
        }
      }
      const labels = (floor.memory?.locations ?? []).map(location => {
        const originalName = location?.name;
        let entityId = location?.entityId;
        if (typeof entityId !== 'string' || !entityId || !originalName) return originalName;
        const path = [originalName], visited = new Set([entityId]);
        while (currentParents.has(entityId)) {
          const parentId = currentParents.get(entityId);
          if (visited.has(parentId)) break;
          const parentName = placeNames.get(parentId);
          if (!parentName) break;
          visited.add(parentId);
          path.unshift(parentName);
          entityId = parentId;
        }
        return path.join(' › ');
      });
      labelsByFloor.set(floor.floorId, labels);
    }
    return labelsByFloor;
  }

  function renderMemoryFloor(floor, state, locationLabelsByFloor) {
    const key = `${state.chatId ?? 'no-chat'}:${floor.floorId}`;
    const title = memoryFloorTitle(state, floor);
    const card = setDetailsState(element('details', `qqj-memory-card status-${floor.status}`), `memory:${key}`, false);
    card.setAttribute('data-qqj-floor-id', floor.floorId);
    const head = element('summary', `qqj-memory-card-head${floor.frozen ? ' is-archived' : ''}`);
    const memory = floor.memory;
    const times = floorTimeDisplay(memory, floor) || '时间未明确';
    const timeNode = element('span', 'qqj-floor-time', times); timeNode.setAttribute('title', times);
    const floorStatus = floor.frozen ? '来源归档 · 只读' : floor.summarySource === 'user' && floor.status === 'ready' ? '人工修订' : statusCopy(floor.status);
    const statusNode = element('span', `v3-memory-status${floor.summarySource === 'user' && floor.status === 'ready' ? ' is-user' : ''}`, floorStatus);
    const chevron = element('span', 'qqj-memory-chevron', '›'); chevron.setAttribute('aria-hidden', 'true');
    const numberNode = element('strong', 'qqj-floor-number', title);
    if (floor.frozen && floor.sourceOrigin?.sourceHostChatId) numberNode.setAttribute('title', floor.sourceOrigin.sourceHostChatId);
    head.append(numberNode, timeNode, statusNode, chevron);
    card.append(head);
    memoryCardStatusViews.set(floor.floorId, { card, statusNode, frozen: floor.frozen === true });
    let body = null;
    const buildBody = () => {
      if (body) return;
      const currentState = syncingDisplayState(foundationState ?? state);
      body = element('div', 'qqj-memory-card-body');
      if (floor.frozen) {
        const sourceName = typeof floor.sourceOrigin?.sourceHostChatId === 'string' ? floor.sourceOrigin.sourceHostChatId : '';
        body.append(element('p', 'settings-hint qqj-memory-source', `来源：${sourceName || '未记录'}；来源聊天的已保存资料在此只读展示。`));
      }
      if (memory) {
        const locations = (memory.locations ?? []).map((item, index) => locationLabelsByFloor.get(floor.floorId)?.[index] ?? item.name).filter(Boolean).join('、') || '未提取';
        const names = new Map((currentState.memoryEntities ?? []).flatMap(entity => [entity.entityId, ...(entity.memberEntityIds ?? [])].map(id => [id, entity.displayName])));
        const canonicalEntityByMemberId = new Map((currentState.memoryEntities ?? []).flatMap(entity => (entity.memberEntityIds ?? [entity.entityId]).map(id => [id, entity])));
        for (const [entityId, displayName] of Object.entries(floor.memoryEntityNames ?? {})) names.set(entityId, displayName);
        const people = [...new Set((memory.participants ?? []).map(item => canonicalEntityByMemberId.get(item.entityId)?.entityId ?? item.entityId))].map(id => names.get(id) ?? '未知人物').join('、') || '未提取';
        body.append(element('p', 'qqj-memory-main', floor.summary || '暂无摘要。'));
        const meta = element('div', 'qqj-memory-meta');
        const metaItem = (label, value) => { const item = element('span', 'qqj-memory-meta-item'); item.append(element('strong', '', label), element('span', '', value)); return item; };
        meta.append(metaItem('人物', people), metaItem('地点', locations)); body.append(meta);
        const exactAnchors = (memory.exactAnchors ?? []).filter(anchor => typeof anchor?.exactText === 'string' && anchor.exactText.trim());
        if (exactAnchors.length) {
          const quoteLine = anchor => {
            const line = element('p', 'qqj-memory-key-quote');
            if (anchor.carrier) line.append(element('span', 'qqj-memory-key-quote-carrier', `载体：${anchor.carrier}　`));
            const speaker = names.get(anchor.speakerEntityId);
            if (speaker) line.append(element('span', 'qqj-memory-key-quote-speaker', `${speaker}：`));
            if (anchor.manual === true) {
              const knowers = [...new Set((anchor.knownEntityIds ?? []).map(id => canonicalEntityByMemberId.get(id)?.displayName ?? names.get(id)).filter(Boolean))];
              line.append(element('span', 'qqj-memory-key-quote-speaker', knowers.length ? `知情：${knowers.join('、')}（其余未知）　` : '人物均未知　'));
            }
            line.append(element('span', 'qqj-memory-key-quote-text', anchor.exactText));
            return line;
          };
          if (exactAnchors.length === 1) {
            const quote = element('div', 'qqj-memory-key-quotes');
            quote.append(element('strong', 'qqj-memory-key-quotes-label', '关键原文'), quoteLine(exactAnchors[0]));
            body.append(quote);
          } else {
            const quote = setDetailsState(element('details', 'qqj-memory-key-quotes is-collapsible'), `memory-key-quotes:${key}`, false);
            quote.append(element('summary', 'qqj-memory-key-quotes-summary', `关键原文（${exactAnchors.length}）`));
            exactAnchors.forEach(anchor => quote.append(quoteLine(anchor)));
            body.append(quote);
          }
        }
      } else body.append(element('p', 'qqj-memory-main is-empty', floor.summary || (floor.status === 'unprocessed' ? '这一楼尚未生成摘要。' : '暂无摘要。')));
      const actions = operationMenus.register(element('details', 'qqj-memory-menu')); memoryRowMenus.push(actions);
      const menuToggle = element('summary', 'qqj-memory-menu-toggle', '⋮');
      menuToggle.setAttribute('aria-label', `${title}操作`); menuToggle.setAttribute('title', '本楼操作');
      const menuBody = element('div', 'qqj-memory-menu-pop');
      if (floor.frozen) {
        menuBody.append(element('p', 'settings-hint', '来源聊天资料只读。'));
      } else if (floor.memoryId) {
        const edit = element('button', 'qqj-memory-menu-action', '编辑'); edit.type = 'button'; edit.disabled = workBusy(currentState);
        trackMemoryRowWorkControl({ node: edit, disabled: current => workBusy(current) });
        edit.addEventListener('click', () => { const latest = foundationState ?? currentState; const names = new Map((latest.memoryEntities ?? []).flatMap(entity => [entity.entityId, ...(entity.memberEntityIds ?? [])].map(id => [id, entity.displayName]))); const canonicalByMember = new Map((latest.memoryEntities ?? []).flatMap(entity => (entity.memberEntityIds ?? [entity.entityId]).map(id => [id, entity.entityId]))); const normalizeKnownIds = values => [...new Set((values ?? []).map(id => canonicalByMember.get(id) ?? id))].sort(); const originalTimeText = floorTimeDisplay(memory, floor); const locations = (memory?.locations ?? []).map(item => ({ itemId: item.itemId, name: item.name ?? '' })); const participantNames = [...new Set((memory?.participants ?? []).map(item => canonicalByMember.get(item.entityId) ?? item.entityId))].map(id => names.get(id)).filter(Boolean); const exactAnchors = (memory?.exactAnchors ?? []).map(item => ({ anchorId: item.anchorId, carrier: item.carrier ?? '', exactText: item.exactText, knownEntityIds: normalizeKnownIds(item.knownEntityIds) })); const draft = { floorId: floor.floorId, canonicalFingerprint: floor.canonicalFingerprint, rawFingerprint: floor.rawFingerprint, summary: floor.summary, originalSummary: floor.summary, timeText: originalTimeText, originalTimeText, locations, originalLocations: locations.map(item => ({ ...item })), peopleText: participantNames.join('、'), originalParticipantNames: participantNames, exactAnchors, originalExactAnchors: structuredClone(exactAnchors), note: '', saving: false, saveError: '' }; void openMemoryEditor(floor, latest, key, draft); });
        const extract = element('button', 'qqj-memory-menu-action', '重新提取'); extract.type = 'button'; extract.disabled = workBusy(currentState) || typeof runtime.extractFloor !== 'function';
        trackMemoryRowWorkControl({ node: extract, disabled: current => workBusy(current) || typeof runtime.extractFloor !== 'function' });
        extract.addEventListener('click', async () => { const latest = foundationState ?? currentState; const ranged = (floor.sourceFloorIds?.length ?? 0) > 1; if (!await Promise.resolve(confirmImpl({ title: ranged ? '重新提取整段压缩记忆' : '重新提取本楼摘要', body: `${ranged ? `${floorCopy(latest, floor)}将整体重新压缩。` : '将重新提取本楼摘要。'}已有的人物状态和其他楼不变；千事按字段保留人工修订，无法匹配时保留旧千事并提示。`, confirmText: '重新提取', cancelText: '取消' }))) { feedback = '已取消重新提取。'; render(foundationState); return; } void run('重新提取', () => runtime.extractFloor(floor.floorId), { resultCopy: floorActionResult('重新提取', floor.floorId) }); });
        menuBody.append(edit, extract);
      } else {
        const extract = element('button', 'qqj-memory-menu-action', '提取摘要'); extract.type = 'button'; extract.disabled = workBusy(currentState) || typeof runtime.extractFloor !== 'function';
        trackMemoryRowWorkControl({ node: extract, disabled: current => workBusy(current) || typeof runtime.extractFloor !== 'function' });
        extract.addEventListener('click', () => { void run('提取摘要', () => runtime.extractFloor(floor.floorId), { resultCopy: floorActionResult('提取摘要', floor.floorId) }); });
        menuBody.append(extract);
      }
      actions.append(menuToggle, menuBody); body.append(actions);
      if (floor.error) body.append(element('p', 'v3-foundation-feedback error', floor.error));
      card.append(body);
    };
    card.addEventListener('toggle', () => { if (card.open) buildBody(); });
    if (card.open) buildBody();
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
  function updateRecentItems(timeSnapshot = null) {
    if (!active || page !== 'memories' || !recentItemsUi) return;
    const { toggle, body, status, organize, retryRead, reason, list, stoppedToggle, stop, batchEntry, batchControls, batchAll, batchProblems, batchActions, batchDelete, automaticFailure, clockReminder } = recentItemsUi;
    const state = timeSnapshot ?? timeRuntime?.getState?.(), result = state?.last, tracked = state?.trackedItems, stopped = state?.stoppedItems, annual = state?.annualItems;
    const selectable = new Map(((showStoppedItems ? stopped : tracked) ?? []).map(item => [item.id, item]));
    if (state?.pendingDeletionCount > 0) selectedRecentItems.clear();
    for (const [id, key] of selectedRecentItems) if (selectable.get(id)?.observationKey !== key) selectedRecentItems.delete(id);
    toggle.textContent = `近期事项${Array.isArray(tracked) ? `（${tracked.length + (annual?.length ?? 0)}）` : ''}`;
    toggle.className = `secondary-action qqj-profile-more${recentItemsOpen ? ' active' : ''}`;
    toggle.disabled = false;
    toggle.setAttribute('aria-expanded', String(recentItemsOpen)); body.hidden = !recentItemsOpen;
    const failureNotice = timeFailureCopy(state);
    automaticFailure.textContent = failureNotice;
    automaticFailure.hidden = !failureNotice || recentItemsOpen;
    clockReminder.hidden = state?.clockContentChanged !== true;
    if (!recentItemsOpen) return;
    const label = state?.status === 'disabled' ? '已关闭' : state?.active ? state.phase === 'saving' ? '保存中' : '处理中' : state?.status === 'waiting' ? '等待记忆同步' : failureNotice || (result?.status === 'completed' ? '已处理' : result?.status === 'empty' ? '已检查无适合事项' : '待初始化');
    status.textContent = [label, Array.isArray(tracked) ? `追踪中 ${tracked.length} 项` : '', state?.progress ? `本次进度 ${state.progress.completed}/${state.progress.total}` : ''].filter(Boolean).join(' · ');
    status.className = ['failed', 'partial'].includes(result?.status) ? 'settings-result error' : 'settings-result';
    organize.textContent = result?.currentReview && ['failed', 'interrupted', 'partial'].includes(result?.status) ? '重新更新当前事项' : ['failed', 'interrupted', 'partial'].includes(result?.status) ? '继续补查历史' : '补查历史';
    organize.disabled = state?.canOrganize !== true || result?.reason === 'read' || Boolean(recentItemsUi.pendingAction);
    if (stop) { stop.hidden = !state?.active || state.phase === 'saving'; stop.disabled = !state?.active; }
    retryRead.hidden = result?.reason !== 'read'; retryRead.disabled = state?.active === true || state?.status === 'disabled' || state?.status === 'waiting';
    stoppedToggle.textContent = showStoppedItems ? '返回追踪中事项' : `查看停止项${Array.isArray(stopped) ? `（${stopped.length}）` : ''}`;
    stoppedToggle.setAttribute('aria-pressed', String(showStoppedItems));
    stoppedToggle.disabled = recentItemDraft !== null || Boolean(recentItemsUi.pendingAction);
    batchEntry.textContent = recentBatchMode ? '取消批量' : '批量管理';
    batchEntry.disabled = recentItemDraft !== null || Boolean(recentItemsUi.pendingAction) || !Array.isArray(showStoppedItems ? stopped : tracked);
    batchControls.hidden = !recentBatchMode;
    const batchBusy = state?.canOrganize !== true || Boolean(recentItemsUi.pendingAction);
    batchAll.disabled = batchBusy || state?.pendingDeletionCount > 0 || !selectable.size;
    batchProblems.hidden = showStoppedItems;
    batchProblems.disabled = batchBusy || !(tracked ?? []).some(item => item.failureReason || item.assessmentReason || item.reviewStatus === 'unanswered');
    for (const control of batchActions) { control.hidden = showStoppedItems; control.disabled = batchBusy || selectedRecentItems.size === 0; }
    batchDelete.hidden = !showStoppedItems;
    batchDelete.textContent = state?.pendingDeletionCount ? '继续永久删除' : '批量永久删除';
    batchDelete.disabled = batchBusy || selectedRecentItems.size === 0 && !state?.pendingDeletionCount;
    const coverage = state?.coverage;
    const coverageCopy = coverage ? [
      `正文已检查 ${coverage.checkedFloors}/${coverage.totalFloors} 楼`,
      coverage.earlierUnchecked > 0 ? `此前 ${coverage.earlierUnchecked} 楼未检查` : '',
      coverage.pendingFloors > 0 ? `${coverage.pendingFloors} 楼等待稳定` : '',
    ].filter(Boolean).join('；') : '';
    reason.textContent = state?.disabledReason || recentItemsUi.planFeedback
      || (result?.reason === 'read' ? '近期事项读取失败，请点击“重试读取”。' : '')
      || (failureNotice ? '可到“设置→记忆管理→详细诊断”复制状态诊断。' : '')
      || (state?.status === 'waiting' ? '记忆同步后读取近期事项。' : coverageCopy);
    if (recentItemDraft) {
      for (const control of recentItemDraft.controls) control.disabled = recentItemDraft.saving || state?.canOrganize !== true;
      organize.disabled = true;
      return;
    }
    const visibleItems = showStoppedItems ? stopped : tracked;
    const message = !Array.isArray(visibleItems) ? state?.status === 'disabled' ? '时间推演已关闭；已有记录保留。' : result?.reason === 'read' ? '时间清单读取失败，请点击“重试读取”。' : '等待当前聊天记忆同步与时间记录读取。' : showStoppedItems ? '当前没有停止的时间事项。' : '当前没有追踪中的时间事项。';
    const displayItems = (Array.isArray(visibleItems) ? visibleItems : []).map(item => {
      const stoppedLabel = { completed: '已完成', paused: '已暂停', cancelled: '已移除' }[item.status];
      const statusLabel = item.mergedInto ? '已归并' : stoppedLabel;
      const times = [];
      if (item.occurrenceTime?.date) times.push(`发生：${formatStoryTime(item.occurrenceTime)}`);
      if (item.dueTime?.date) times.push(`${item.type === 'cycle' ? '预计周期日' : item.type === 'deadline' ? '约定时间' : '预计节点'}：${formatStoryTime(item.dueTime)}`);
      const results = [];
      if (item.status === 'active' && item.type !== 'deadline' && item.projection) results.push({ text: `当前推测：${item.projection}`, error: false });
      else if (item.status === 'active' && item.type !== 'deadline' && item.assessmentReason) results.push({ text: `依据不足：${item.assessmentReason}`, error: true });
      if (item.status === 'active' && item.type !== 'deadline' && item.projection && item.projectionTime?.date) times.push(`推算至：${formatStoryTime(item.projectionTime)}`);
      if (item.failureReason) results.push({ text: '更新失败', error: true });
      const keywords = Array.isArray(item.keywords) ? item.keywords.filter(keyword => typeof keyword === 'string' && keyword.trim()).slice(0, 4) : [];
      return {
        item,
        title: `${item.person} · ${item.label}${statusLabel ? ` · ${statusLabel}` : ''}`,
        description: item.mergeDescription || item.observation || '',
        keywords,
        results,
        times,
        readOnly: '',
        issue: item.status === 'active' && Boolean(item.failureReason || item.type !== 'deadline' && item.assessmentReason),
      };
    });
    if (!showStoppedItems) for (const item of annual ?? []) displayItems.push({
      item: null,
      title: `${item.person} · ${item.label} · ${item.status}`,
      description: item.note ?? '',
      results: [],
      times: [item.originalDate ? `原日期：${item.originalDate}` : '', item.nextDate ? `本年日期：${item.nextDate}` : ''].filter(Boolean),
      readOnly: '只读事项，请在千人资料或用户人设中修改。',
      issue: false,
    });
    const titleIssues = displayItems.map(item => item.issue);
    const visibleProjection = displayItems.map(({ title, description, keywords, results, times, readOnly, issue }) => ({ title, description, keywords, results, times, readOnly, issue }));
    const signature = JSON.stringify([displayItems.length ? visibleProjection : message, titleIssues, recentBatchMode, [...selectedRecentItems], state?.pendingDeletionCount ?? 0, (visibleItems ?? []).map(item => [item.id, item.observationKey]), (annual ?? []).map(item => [item.id, item.status, item.nextDate])]);
    if (recentItemsUi.listSignature === signature) { for (const control of recentItemsUi.itemControls) control.disabled = state?.canOrganize !== true || Boolean(recentItemsUi.pendingAction) || showStoppedItems && state?.pendingDeletionCount > 0; return; }
    recentItemsUi.listSignature = signature;
    list.replaceChildren();
    recentItemsUi.itemControls = [];
    if (!displayItems.length) list.append(element('p', 'settings-hint', message));
    else for (const [index, display] of displayItems.entries()) {
      const entry = element('div', 'settings-field');
      const head = element('div', 'qqj-recent-item-head');
      const item = display.item;
      if (recentBatchMode && item) {
        const select = element('input', 'qqj-recent-item-select'); select.type = 'checkbox'; select.checked = selectedRecentItems.get(item.id) === item.observationKey;
        select.setAttribute('aria-label', `选择${item.label}`); select.disabled = batchBusy;
        select.addEventListener('change', () => { if (select.checked) selectedRecentItems.set(item.id, item.observationKey); else selectedRecentItems.delete(item.id); recentItemsUi.listSignature = null; updateRecentItems(); });
        select.disabled = batchBusy || showStoppedItems && state?.pendingDeletionCount > 0;
        head.append(select); recentItemsUi.itemControls.push(select);
      }
      head.append(element('span', `qqj-recent-item-title${titleIssues[index] ? ' error' : ''}`, display.title));
      entry.append(head);
      if (display.description) entry.append(element('p', 'settings-hint qqj-recent-item-description', display.description));
      if (display.keywords?.length) {
        const tags = element('div', 'qqj-recent-item-keywords');
        for (const keyword of display.keywords) tags.append(element('span', 'qqj-recent-item-keyword', keyword));
        entry.append(tags);
      }
      for (const result of display.results) entry.append(element('p', `settings-hint qqj-recent-item-result${result.error ? ' error' : ''}`, result.text));
      if (display.times.length) entry.append(element('p', 'settings-hint qqj-recent-item-times', display.times.join(' · ')));
      if (display.readOnly) entry.append(element('p', 'settings-hint qqj-recent-item-readonly', display.readOnly));
      list.append(entry);
      if (!item) continue;
      const actions = operationMenus.register(element('details', 'qqj-profile-menu'));
      const menuToggle = element('summary', 'qqj-profile-menu-toggle', '⋮'); menuToggle.setAttribute('aria-label', `${item.label}事项操作`); menuToggle.setAttribute('title', '事项操作'); menuToggle.setAttribute('aria-haspopup', 'menu');
      const menuBody = element('div', 'qqj-profile-menu-pop'); menuBody.setAttribute('role', 'menu');
      const actionFeedback = element('p', 'settings-result error');
      const addAction = (label, callback) => { const button = element('button', `qqj-profile-menu-action${label === '移除' ? ' danger' : ''}`, label); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.disabled = state?.canOrganize !== true || Boolean(recentItemsUi.pendingAction); button.addEventListener('click', () => { if (button.disabled) return; actions.open = false; return callback(); }); menuBody.append(button); recentItemsUi.itemControls.push(button); };
      if (typeof timeRuntime?.editItem === 'function' && !recentBatchMode) {
        addAction('编辑事项', () => startRecentEdit(item));
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
  async function deleteRecentItems(actionFeedback) {
    const ui = recentItemsUi, originalChatId = chatId, mine = epoch;
    const selected = [...selectedRecentItems].map(([itemId, observationKey]) => ({ itemId, observationKey }));
    const currentUi = () => active && page === 'memories' && recentItemsUi === ui && chatId === originalChatId && epoch === mine && runtime.getState()?.chatId === originalChatId;
    const canDelete = () => {
      const state = timeRuntime.getState(), current = new Map((state.stoppedItems ?? []).map(item => [item.id, item]));
      return currentUi() && showStoppedItems && recentBatchMode && !recentItemDraft && state.canOrganize === true
        && (state.pendingDeletionCount > 0 || selected.length > 0 && selected.every(item => current.get(item.itemId)?.observationKey === item.observationKey));
    };
    if (ui.pendingAction || typeof timeRuntime?.deleteItems !== 'function' || !canDelete()) return;
    const pending = {}; ui.pendingAction = pending; actionFeedback.textContent = ''; updateRecentItems();
    try {
      if (!timeRuntime.getState().pendingDeletionCount) {
        const confirmed = await Promise.resolve(confirmImpl({ title: '批量永久删除时间事项',
          body: `永久删除 ${selected.length} 项及其全部时间历史，不可恢复。不调用模型，其他事项、摘要与千事保留。`, confirmText: '永久删除', cancelText: '取消' }));
        if (!confirmed || !canDelete()) return;
      }
      await timeRuntime.deleteItems(timeRuntime.getState().pendingDeletionCount ? [] : selected);
      if (!currentUi()) return;
      selectedRecentItems.clear(); recentBatchMode = false;
    } catch (error) { if (currentUi()) actionFeedback.textContent = `永久删除未完成：${publicErrorMessage(error, { fallback: '旧历史记录尚未清理完，可在同一入口继续。' })}`; }
    finally { if (ui.pendingAction === pending) ui.pendingAction = null; updateRecentItems(); }
  }
  function startRecentEdit(item) {
    if (typeof customImpl !== 'function') return;
    const timeValue = value => value?.raw || (value?.date ? `${value.date}${value.clock ? ` ${value.clock}` : ''}` : '');
    const canEditProjection = item.status === 'active' && item.type !== 'deadline' && Boolean(item.projection && item.projectionTime?.date);
    const draft = { item, chatId, foundationState, ui: recentItemsUi, fields: { label: item.label, observation: item.observation, observationTime: timeValue(item.observationTime), occurrenceTime: timeValue(item.occurrenceTime), dueTime: timeValue(item.dueTime), periodDays: item.periodDays ?? '', subjectEntityId: item.subjectEntityId ?? '', ...(canEditProjection ? { projectionText: item.projection } : {}) }, controls: [], saving: false, error: '' };
    const initialFields = { ...draft.fields };
    recentItemDraft = draft;
    const editor = element('div', 'qqj-editor-dialog qqj-profile-form');
    const groups = new Map();
    const group = (name, title, collapsed = false) => { let node = groups.get(name); if (!node) { node = element(collapsed ? 'details' : 'section', 'qqj-editor-group'); node.append(collapsed ? element('summary', 'qqj-editor-group-summary', title) : element('h3', '', title)); groups.set(name, node); editor.append(node); } return node; };
    const field = (name, labelText, multiline = false, section = '事项内容', groupKey = section, collapsed = false) => { const row = element('label', 'settings-field'), input = element(multiline ? 'textarea' : 'input', 'settings-input'); input.value = draft.fields[name]; input.addEventListener('input', () => { draft.fields[name] = input.value; }); input.setAttribute('aria-label', labelText); row.append(element('span', '', labelText), input); group(groupKey, section, collapsed).append(row); draft.controls.push(input); };
    const people = new Map();
    for (const person of foundationState?.memoryEntities ?? []) if (person.entityId && person.displayName) people.set(person.entityId, person.displayName);
    const timeState = timeRuntime?.getState?.();
    for (const known of [...(timeState?.trackedItems ?? []), ...(timeState?.stoppedItems ?? [])]) if (String(known.subjectEntityId ?? '').startsWith('time-person-') && known.person) people.set(known.subjectEntityId, known.person);
    if (item.subjectEntityId && !people.has(item.subjectEntityId) && item.person) people.set(item.subjectEntityId, item.person);
    const personRow = element('label', 'settings-field'), personSelect = element('select', 'settings-input'); personSelect.setAttribute('aria-label', '人物归属');
    for (const [entityId, displayName] of people) { const option = element('option', '', displayName); option.value = entityId; personSelect.append(option); }
    personSelect.value = draft.fields.subjectEntityId; personSelect.addEventListener('input', () => { draft.fields.subjectEntityId = personSelect.value; }); personSelect.addEventListener('change', () => { draft.fields.subjectEntityId = personSelect.value; });
    personRow.append(element('span', '', '人物归属'), personSelect); draft.controls.push(personSelect);
    if (item.hasMergedMembers === true) editor.append(element('p', 'settings-hint', '此项仍有归并成员；请先在“停止项”中恢复追踪所有成员，再修改人物归属。'));
    else if (item.mergedInto && item.status !== 'active') editor.append(element('p', 'settings-hint', '此项仍归属于其他主项；请先恢复追踪并解除归并，再修改人物归属。'));
    field('label', '事项名称'); field('observation', '观察描述', true);
    field('observationTime', '观察时间', false, '时间信息', 'time', true); field('occurrenceTime', '发生时间（可空，优先用于计算经过时间）', false, '时间信息', 'time', true);
    if (['cycle', 'deadline'].includes(item.type)) field('dueTime', item.type === 'cycle' ? '预计周期日' : '约定期限', false, '时间信息', 'time', true);
    if (item.type === 'cycle') { field('periodDays', '周期天数（可空）', false, '时间信息', 'time', true); group('time', '时间信息', true).append(element('p', 'settings-hint', '已知发生时间与周期天数时，预计周期日由程序计算。模糊时间保留原词，不补现实年份。')); }
    group('identity', '人物归属', true).append(personRow);
    if (canEditProjection) { field('projectionText', '当前推测', true, '当前推测', 'projection', true); const projectionInput = draft.controls.at(-1); projectionInput.maxLength = 2000; }
    editor.append(element('p', 'qqj-editor-intro', '保存不调用模型。只改人物或推测会保留原推算时间；修改其他内容会清除旧推测。'));
    const finish = () => { recentItemDraft = null; draft.ui.listSignature = null; if (active && container && page === 'memories' && draft.foundationState !== foundationState) render(foundationState); else updateRecentItems(); };
    let saved = false;
    void Promise.resolve(customImpl({ title: `编辑近期事项 · ${item.label}`, content: editor, confirmText: '保存事项', cancelText: '取消', submit: async () => {
      if (draft.saving) return false;
      const fields = Object.fromEntries(Object.entries(draft.fields).filter(([name, value]) => value !== initialFields[name]));
      if (!Object.keys(fields).length) { saved = true; finish(); return true; }
      draft.saving = true; draft.error = '';
      try {
        await timeRuntime.editItem(item.id, fields, item.observationKey);
        if (recentItemDraft !== draft || chatId !== draft.chatId) return false;
        saved = true; finish(); return true;
      } catch (error) { if (recentItemDraft === draft && chatId === draft.chatId) { draft.saving = false; draft.error = `保存失败：${publicErrorMessage(error, { fallback: '事项未保存，请重试。' })}`; } throw error; }
    }, onClose: () => { if (!saved && recentItemDraft === draft) finish(); } }));
    for (const control of recentItemsUi.itemControls) control.disabled = true;
    updateRecentItems();
  }
  function renderRecentItems(memorySearch) {
    if (recentItemDraft) { recentItemsUi = recentItemDraft.ui; updateRecentItems(); return recentItemsUi.section; }
    const section = element('section', 'qqj-profile-toolbar');
    const actions = element('div', 'qqj-profile-toolbar-actions qqj-memory-toolbar');
    const toggle = element('button', 'secondary-action qqj-profile-more', '近期事项'); toggle.type = 'button';
    const automaticFailure = element('small', 'settings-hint qqj-time-automatic-failure', '时间自动推演这次未能完成，请打开近期事项查看或重试。'); automaticFailure.hidden = true;
    const clockReminder = element('small', 'settings-hint qqj-time-clock-reminder', '时间信息可能变化，请用户核实'); clockReminder.hidden = true;
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
    const batchDelete = element('button', 'secondary-action danger', '批量永久删除'); batchDelete.type = 'button'; batchDelete.addEventListener('click', () => deleteRecentItems(batchFeedback));
    const batchFeedback = element('p', 'settings-result error');
    batchControls.append(batchAll, batchProblems, ...batchActions, batchDelete); listActions.append(batchControls);
    stoppedToggle.addEventListener('click', () => { if (stoppedToggle.disabled) return; showStoppedItems = !showStoppedItems; recentBatchMode = false; selectedRecentItems.clear(); updateRecentItems(); });
    batchEntry.addEventListener('click', () => { if (batchEntry.disabled) return; recentBatchMode = !recentBatchMode; if (!recentBatchMode) selectedRecentItems.clear(); recentItemsUi.listSignature = null; updateRecentItems(); });
    batchAll.addEventListener('click', () => { if (batchAll.disabled) return; selectedRecentItems.clear(); for (const item of showStoppedItems ? timeRuntime.getState().stoppedItems ?? [] : timeRuntime.getState().trackedItems ?? []) selectedRecentItems.set(item.id, item.observationKey); recentItemsUi.listSignature = null; updateRecentItems(); });
    batchProblems.addEventListener('click', () => { if (batchProblems.disabled) return; selectedRecentItems.clear(); for (const item of timeRuntime.getState().trackedItems ?? []) if (item.failureReason || item.assessmentReason || item.reviewStatus === 'unanswered') selectedRecentItems.set(item.id, item.observationKey); recentItemsUi.listSignature = null; updateRecentItems(); });
    copy.append(status, reason); row.append(copy, buttons); body.append(row, listActions, batchFeedback, list); actions.append(memorySearch, toggle, automaticFailure, clockReminder); section.append(actions, body);
    recentItemsUi = { section, toggle, body, status, organize, retryRead, reason, list, stoppedToggle, stop, batchEntry, batchControls, batchAll, batchProblems, batchActions, batchDelete, automaticFailure, clockReminder, itemControls: [], listSignature: null };
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
          body: `${plan.floorCount} 个 AI 楼，正文 ${plan.bodyBatchCount ?? plan.batchCount} 批；最多调用摘要 API ${plan.apiCalls} 次。${plan.currentReview ? '含一次当前事项评估。' : ''}${plan.annualSetting?.shouldRequest ? '含一次年度设定读取。' : ''}${plan.supplement ? '正文已查，本次只更新活跃事项一次。' : '每批最多20楼，长楼分片；失败、部分完成或停止后暂停，已保存结果保留。'}不自动重试，未评估或依据不足的事项会列出。`, confirmText: '开始补查', cancelText: '取消' }));
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
    const locationLabelsByFloor = memoryLocationLabelsByFloor(state, floors);
    const registeredMessageIndexes = new Set(floors.filter(floor => floor.frozen !== true).map(floor => floor.messageIndex).filter(validMessageIndex));
    const waiting = (state.unregisteredCandidates ?? []).filter(candidate => validMessageIndex(candidate?.messageIndex) && !registeredMessageIndexes.has(candidate.messageIndex));
    const consecutive = waiting.filter(candidate => candidate.reason === 'consecutiveAssistant');
    const hasWaitingTail = waiting.some(candidate => candidate.reason === 'waitingNextUser');
    const confirmationScope = state.consecutiveAssistantConfirmation;
    const confirmationCandidates = Array.isArray(confirmationScope?.candidates) ? confirmationScope.candidates : [];
    if (consecutive.length && confirmationCandidates.length && typeof runtime.confirmConsecutiveAssistants === 'function') {
      const action = element('div', 'qqj-inline-panel');
      action.append(element('p', 'settings-hint', `本次确认 ${confirmationCandidates.length} 个连续 AI 回复，按顺序分别摘要。${hasWaitingTail ? '最新 AI 楼仍等待下一条用户消息，不在本次范围内。' : ''}`));
      const confirm = element('button', 'secondary-action', '确认连续 AI 并分别记录'); confirm.type = 'button'; confirm.disabled = workBusy(state);
      memoryWorkControls.push({ node: confirm, disabled: current => workBusy(current) });
      confirm.addEventListener('click', async () => {
        const first = confirmationCandidates[0].messageIndex, last = confirmationCandidates.at(-1).messageIndex;
        const range = first === last ? `第 ${first} 楼` : `第 ${first}–${last} 楼`;
        const accepted = await Promise.resolve(confirmImpl({ title: '确认连续 AI 回复',
          body: `${range}，共 ${confirmationCandidates.length} 个 AI 回复，将按顺序分别摘要；正文不删除或合并。${hasWaitingTail ? '最新 AI 楼等待下一条用户消息，不在本次范围内。' : ''}`, confirmText: '确认并分别记录', cancelText: '取消' }));
        if (!accepted) { feedback = '已取消连续 AI 确认。'; render(foundationState); return; }
        void run('确认连续 AI', () => runtime.confirmConsecutiveAssistants(confirmationScope));
      });
      action.append(confirm); pageNode.append(action);
    }
    const rows = [
      ...floors.map(value => ({ kind: 'registered', value })),
      ...waiting.map(value => ({ kind: 'waiting', value })),
    ].sort((left, right) => {
      if (left.kind === 'registered' && right.kind === 'registered') return (right.value.assistantSeq ?? right.value.messageIndex ?? 0) - (left.value.assistantSeq ?? left.value.messageIndex ?? 0);
      if (left.kind === 'waiting' && right.kind === 'waiting') return (right.value.messageIndex ?? 0) - (left.value.messageIndex ?? 0);
      const waitingRow = left.kind === 'waiting' ? left : right;
      const floorRow = left.kind === 'registered' ? left : right;
      const order = floorRow.value.frozen === true ? -1 : (floorRow.value.messageIndex ?? 0) - (waitingRow.value.messageIndex ?? 0);
      return left.kind === 'waiting' ? order : -order;
    });
    const pageSize = 50;
    const appendPagination = (total, ariaLabel) => {
      const pageCount = Math.ceil(total / pageSize);
      memoryListPage = Math.min(memoryListPage, Math.max(0, pageCount - 1));
      if (pageCount <= 1) return;
      const nav = element('nav', 'qqj-memory-pagination'); nav.setAttribute('aria-label', ariaLabel);
      const previous = element('button', 'secondary-action qqj-memory-page-button', '上一页'); previous.type = 'button'; previous.disabled = memoryListPage === 0;
      previous.addEventListener('click', () => { if (memoryListPage > 0) { memoryListPage -= 1; fillList(); } });
      const status = element('span', 'qqj-memory-page-status', `第 ${memoryListPage + 1} / ${pageCount} 页 · 共 ${total} 条`);
      const input = element('input', 'settings-input qqj-memory-page-input'); input.type = 'number'; input.min = '1'; input.max = String(pageCount); input.step = '1'; input.value = String(memoryListPage + 1); input.setAttribute('aria-label', '跳转到摘要页');
      const go = element('button', 'secondary-action qqj-memory-page-button', '跳转'); go.type = 'button';
      const jump = () => { const requested = Number(input.value); if (!Number.isInteger(requested) || requested < 1 || requested > pageCount) { input.value = String(memoryListPage + 1); return; } memoryListPage = requested - 1; fillList(); };
      go.addEventListener('click', jump); input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); jump(); } });
      const next = element('button', 'secondary-action qqj-memory-page-button', '下一页'); next.type = 'button'; next.disabled = memoryListPage + 1 >= pageCount;
      next.addEventListener('click', () => { if (memoryListPage + 1 < pageCount) { memoryListPage += 1; fillList(); } });
      nav.append(previous, status, input, go, next); list.append(nav);
    };
    const fillList = () => {
      forgetMemoryRows();
      list.replaceChildren();
      const query = memorySearchQuery.trim();
      if (query) {
        const matches = floors.filter(floor => floor.memoryId && plainSearchIncludes(floor.summary, query))
          .sort((left, right) => (right.assistantSeq ?? right.messageIndex ?? 0) - (left.assistantSeq ?? left.messageIndex ?? 0));
        list.append(element('p', 'qqj-search-count', `在全部摘要中找到 ${matches.length} 条结果`));
        appendPagination(matches.length, '摘要搜索结果页码');
        for (const floor of matches.slice(memoryListPage * pageSize, (memoryListPage + 1) * pageSize)) {
          const result = element('article', 'qqj-history-search-result');
          const title = memoryFloorTitle(state, floor), titleNode = element('div', 'qqj-history-search-title qqj-memory-search-title');
          titleNode.append(element('strong', '', title));
          result.append(titleNode, element('p', 'qqj-history-search-snippet', searchSnippet(floor.summary, query)));
          if (floor.frozen && floor.sourceOrigin?.sourceHostChatId) result.setAttribute('title', floor.sourceOrigin.sourceHostChatId);
          result.setAttribute('role', 'button'); result.setAttribute('tabindex', '0'); result.setAttribute('aria-label', `打开${title}完整摘要`);
          const openResult = () => { memorySearchQuery = ''; memoryListPage = Math.max(0, Math.floor(rows.findIndex(row => row.kind === 'registered' && row.value.floorId === floor.floorId) / pageSize)); memorySearch.children[0].value = ''; memorySearch.children[1].hidden = true; openState.set(`memory:${state.chatId ?? 'no-chat'}:${floor.floorId}`, true); fillList(); list.querySelector?.(`[data-qqj-floor-id="${floor.floorId}"]`)?.scrollIntoView?.({ block: 'nearest' }); };
          result.addEventListener('click', openResult); result.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openResult(); } });
          list.append(result);
        }
        if (!matches.length) list.append(element('div', 'qqj-inline-empty', '没有包含该文字的摘要。'));
        return;
      }
      appendPagination(rows.length, '摘要页码');
      for (const item of rows.slice(memoryListPage * pageSize, (memoryListPage + 1) * pageSize)) list.append(item.kind === 'registered' ? renderMemoryFloor(item.value, state, locationLabelsByFloor) : renderWaitingMemoryFloor(item.value, state));
      if (!rows.length) list.append(element('div', 'qqj-inline-empty', '这里还没有已保存摘要。最新 AI 楼将在下一条用户消息发出后开始摘要。'));
    };
    const memorySearch = searchControl({ value: memorySearchQuery, placeholder: '搜索全部摘要', ariaLabel: '搜索当前聊天的全部摘要', onInput: value => { if (value !== memorySearchQuery) memoryListPage = 0; memorySearchQuery = value; fillList(); }, onClear: () => { memorySearchQuery = ''; memoryListPage = 0; fillList(); } });
    if (timeRuntime) pageNode.append(renderRecentItems(memorySearch));
    else { const toolbar = element('section', 'qqj-profile-toolbar'), actions = element('div', 'qqj-profile-toolbar-actions qqj-memory-toolbar'); actions.append(memorySearch); toolbar.append(actions); pageNode.append(toolbar); }
    fillList();
    pageNode.append(list); return pageNode;
  }

  const appendSubjectGroups = (card, subject, state, { core = subject.core ?? [], adaptive = subject.adaptive ?? [], situational = subject.situational ?? [], empty = true, showMeta = true, groupAdaptiveByTarget = true, showSituationalVisibility = false } = {}) => {
    const item = (value, showVisibility = false) => { const node = element('li', 'v3-cse-item'); node.append(showVisibility ? currentSituationLine(value) : element('span', 'v3-cse-item-text', cseReadingText(value.text))); if (showMeta) { const source = value.sourceFloorId || value.sourceAssistantSeq ? sourceFloorCopy(state, value) : value.origin === 'baseline' ? '来源：聊天基线' : '来源：本地重放'; node.append(element('small', 'v3-cse-item-meta', [...new Set([value.reason, originCopy(value.origin), source, visibilityCopy(value.visibility)])].join(' · '))); } return node; };
    const addGroup = (label, values, groupByTarget = false, showVisibility = false) => {
      const block = element('div', 'v3-cse-group'); block.append(element('h5', '', label));
      if (!values.length) { if (empty) { block.append(element('p', 'settings-hint', '暂无')); card.append(block); } return; }
      if (groupByTarget) {
        const grouped = new Map(); for (const value of values) { const key = value.towardEntityId || null; grouped.set(key, [...(grouped.get(key) ?? []), value]); }
        for (const [target, targetItems] of grouped) { block.append(element('h6', '', target ? `对 ${targetItems[0].towardDisplayName || '未知人物'}` : '自身状态')); const ul = element('ul', 'v3-cse-items'); targetItems.forEach(value => ul.append(item(value, showVisibility))); block.append(ul); }
      } else { const ul = element('ul', 'v3-cse-items'); values.forEach(value => ul.append(item(value, showVisibility))); block.append(ul); }
      card.append(block);
    };
    addGroup('核心特质', core); addGroup('长期倾向', adaptive, groupAdaptiveByTarget); addGroup('当前情境', situational, false, showSituationalVisibility);
  };
  function renderCseEditor(body, draft, state, redraw, expandedField = null) {
    const editor = element('div', 'qqj-editor-dialog qqj-cse-edit');
    const controls = [], disabled = draft.saving === true || workBusy(state);
    editor.append(element('p', 'qqj-editor-intro', '修改保存到对应楼层。其他楼层的重算不会改写本楼记录。'));
    const scopeHeading = element('div', 'qqj-cse-scope-heading');
    const scopeHelp = element('button', 'secondary-action qqj-cse-help', '信息范围说明'); scopeHelp.type = 'button'; scopeHelp.disabled = disabled;
    const scopeCopy = element('div', 'qqj-editor-intro qqj-cse-scope-copy'); scopeCopy.hidden = true;
    scopeCopy.append(element('p', '', '说明剧情中谁能知道这项状态，与上传权限无关。'), element('p', '', '私密：本人内心；已表达：说出或表现，未必人人收到；可观察：外表或动作，不能读心；共享：相关人已知，不代表全员；作者设定：塑造人物的参考，角色未必知道。'));
    scopeHelp.addEventListener('click', () => { scopeCopy.hidden = !scopeCopy.hidden; });
    scopeHeading.append(scopeHelp, scopeCopy); editor.append(scopeHeading); controls.push(scopeHelp);
    const category = (field, label, { toward = false } = {}) => {
      const group = element(toward ? 'details' : 'section', 'qqj-editor-group qqj-cse-edit-group');
      if (toward) { group.qqjCategory = field; group.open = field === expandedField; group.append(element('summary', 'qqj-editor-group-summary', label)); }
      else group.append(element('h3', '', label));
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
        const remove = element('button', 'secondary-action', '删除'); remove.type = 'button'; remove.disabled = disabled; remove.addEventListener('click', () => { draft[field].splice(index, 1); redraw(field); }); controls.push(remove); meta.append(remove); group.append(rowNode);
      });
      const add = element('button', 'secondary-action', `添加${label}`); add.type = 'button'; add.disabled = disabled; add.addEventListener('click', () => { draft[field].push({ itemId: null, text: '', visibility: field === 'core' ? 'authorial' : 'private', towardEntityId: null }); redraw(field); }); controls.push(add); group.append(add); return group;
    };
    for (const [field,label,options] of [['core','核心特质',{}],['adaptive','长期倾向',{toward:true}],['situational','当前情境',{toward:true}]]) editor.append(category(field,label,options));
    body.append(editor);
    return controls;
  }
  function openCseEditor(key, draft, state, title) {
    if (typeof customImpl !== 'function') return;
    cseDrafts.set(key, draft);
    const content = element('div');
    const redraw = (expandedField = null) => { const previous = Array.from(content.children[0]?.children ?? []).find(node => (node.tag === 'details' || node.tagName?.toLowerCase() === 'details') && node.open); content.replaceChildren(); renderCseEditor(content, draft, foundationState ?? state, redraw, expandedField ?? previous?.qqjCategory ?? null); };
    redraw();
    let saved = false;
    void Promise.resolve(customImpl({ title, content, confirmText: '保存', cancelText: '取消', submit: async () => {
      if (draft.saving) return false;
      if (workBusy(foundationState ?? state)) throw new Error('后台记忆仍在整理，请稍后再保存人物状态。');
      const cloneItems = items => items.map(item => ({ ...item }));
      const payload = { expectedCurrentStateId: draft.expectedCurrentStateId, expectedCurrentStateFingerprint: draft.expectedCurrentStateFingerprint, core: cloneItems(draft.core), adaptive: cloneItems(draft.adaptive), situational: cloneItems(draft.situational) };
      const currentDraft = () => cseDrafts.get(key) === draft && (runtime.getState?.() ?? foundationState)?.chatId === draft.chatId;
      draft.saving = true; draft.saveError = ''; redraw();
      let failure = null;
      await run('保存人物状态', () => runtime.correctSubjectState(draft.subjectEntityId, payload), {
        after: () => { if (!currentDraft()) return false; cseDrafts.delete(key); openState.set(`subject:${draft.subjectEntityId}`, true); saved = true; return true; },
        failed: error => { if (!currentDraft()) return false; draft.saving = false; draft.saveError = `保存失败：${publicErrorMessage(error, { fallback: '人物状态没有保存，请重试。' })}`; failure = error; return true; },
      });
      if (failure) { redraw(); throw failure; }
      return saved;
    }, onClose: () => { if (!saved && cseDrafts.get(key) === draft) { cseDrafts.delete(key); render(foundationState); } } }));
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
    if (subject) appendSubjectGroups(body, subject, state, ownOnly ? { adaptive: (subject.adaptive ?? []).filter(item => !item.towardEntityId), situational: (subject.situational ?? []).filter(item => !item.towardEntityId), showMeta: false, groupAdaptiveByTarget: false, showSituationalVisibility: true, empty: !relationNote } : { showSituationalVisibility: true });
    else body.append(element('p', 'settings-hint', '这个重要人物还没有已保存的状态分析；后台摘要与 CSE 会继续正常处理。'));
    if (subject && !draft) {
      const edit = element('button', actionsContainer ? 'qqj-memory-menu-action' : 'secondary-action', '编辑状态'); edit.type = 'button'; edit.disabled = workBusy(state) || typeof runtime.correctSubjectState !== 'function' || !state.currentStateId || !state.currentStateFingerprint;
      edit.addEventListener('click', () => {
        const copyItems = values => (values ?? []).map(item => ({ itemId: item.id, text: item.text, visibility: item.visibility, towardEntityId: item.towardEntityId ?? null }));
        openCseEditor(key, { chatId: state.chatId, subjectEntityId: entityId, expectedCurrentStateId: state.currentStateId, expectedCurrentStateFingerprint: state.currentStateFingerprint, core: copyItems(subject.core), adaptive: copyItems(subject.adaptive), situational: copyItems(subject.situational), saving: false, saveError: '' }, state, `编辑人物状态 · ${displayName}`);
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
    if (floor.frozen || !floor.memoryId || typeof runtime.retryStateAnalysis !== 'function') return null;
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
    const pageStatusNode = pageStatus(state); section.append(pageStatusNode);
    const headingNode = element('header', 'qqj-cse-page-heading');
    const countStatusNode = element('span', 'v3-memory-status', `${state.csePendingCount ?? 0} 待分析 · ${state.cseFailedCount ?? 0} 失败`);
    headingNode.append(element('strong', '', '分析记录'), countStatusNode);
    let fillList = () => {};
    const cseSearch = searchControl({ value: cseSearchQuery, placeholder: '搜索全部分析记录', ariaLabel: '搜索当前聊天的全部人物状态历史', onInput: value => { cseSearchQuery = value; fillList(); }, onClear: () => { cseSearchQuery = ''; fillList(); } });
    const back = element('button', 'secondary-action qqj-cse-view-toggle', '返回当前状态'); back.type = 'button'; back.addEventListener('click', () => switchPeopleMode('current')); headingNode.append(cseSearch, back); section.append(headingNode);
    const list = element('div', 'qqj-cse-history-list');
    let currentState = state;
    let floors = [...(currentState.floors ?? [])].filter(floor => floor.memoryId).sort((left, right) => (right.messageIndex ?? 0) - (left.messageIndex ?? 0));
    const rowInfoByFloorId = new Map();
    const buildBody = info => {
      const { body } = info, floor = info.floor, record = floor.cse?.record;
      body.replaceChildren();
      if (record) {
        if (record.fixedChangesAvailable === false) {
          const resultNode = element('section', 'qqj-cse-floor-result'); resultNode.append(element('strong', 'qqj-cse-floor-result-title', '本楼已保存状态'));
          const resultBody = element('div', 'qqj-cse-floor-state-body'), subjects = record.endStateSubjects ?? [];
          for (const subject of subjects) {
            const subjectNode = element('section', 'qqj-cse-record-subject'); subjectNode.append(element('strong', '', subject.displayName));
            appendSubjectGroups(subjectNode, subject, currentState); resultBody.append(subjectNode);
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
              item.append(element('span', 'v3-cse-item-text', cseReadingText(`${categoryCopy[change.category] ?? '人物状态'}：${after?.text ?? '状态内容未提供'}`)));
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
              for (const value of subject.changes) { const copy = changeCopy(value), item = element('li', `v3-cse-item qqj-cse-change is-${value.action ?? 'add'}`); item.append(element('span', 'v3-cse-item-text', cseReadingText(copy.main))); if (copy.details.length) item.append(element('small', 'v3-cse-item-meta', copy.details.join(' · '))); listNode.append(item); }
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
              appendSubjectGroups(subjectNode, subject, currentState); stateBody.append(subjectNode);
            }
            if (!record.endStateSubjects.length) stateBody.append(element('p', 'settings-hint', '本楼结束时没有已保存状态。'));
            stateNode.append(stateBody); body.append(stateNode);
          }
        }
      }
      if (!record && !floor.cse?.error) body.append(element('p', 'settings-hint', '本楼还没有已保存的状态分析记录。'));
      if (floor.cse?.error) body.append(element('p', 'v3-foundation-feedback error', errorMessage(floor.cse.error))); const action = cseActionFor(floor, currentState); if (action) body.append(action);
    };
    const ensureBody = info => {
      if (!info.body) { info.body = element('div', 'qqj-cse-floor-body'); info.rowNode.append(info.body); }
      if (!info.hasRenderedBody || info.renderedRecord !== info.floor.cse?.record) {
        buildBody(info); info.renderedRecord = info.floor.cse?.record; info.hasRenderedBody = true;
      }
      return info.body;
    };
    for (const floor of floors) {
      const rowNode = setDetailsState(element('details', 'qqj-cse-history-row'), `cse-floor:${floor.floorId}`, false);
      const rowSummary = element('summary', 'qqj-cse-floor-summary'), floorLabel = element('span', '', floorCopy(currentState, floor)), floorStatus = element('span', 'v3-memory-status', statusCopy(floor.cse?.status));
      rowSummary.append(floorLabel, floorStatus); rowNode.append(rowSummary);
      const info = { floor, rowNode, floorLabel, floorStatus, body: null, renderedRecord: null, hasRenderedBody: false };
      rowInfoByFloorId.set(floor.floorId, info);
      rowNode.addEventListener('toggle', () => { if (rowNode.open) ensureBody(info); });
      if (rowNode.open) ensureBody(info);
      list.append(rowNode);
    }
    if (!floors.length) list.append(element('p', 'settings-hint', '生成摘要后，这里会显示逐楼人物状态分析记录。'));
    const defaultRows = [...list.children];
    fillList = () => {
      const query = cseSearchQuery.trim();
      if (!query) { list.replaceChildren(...defaultRows); return; }
      const results = [];
      for (const floor of floors) {
        const seen = new Set(), record = floor.cse?.record;
        const add = (subject, category, value) => {
          if (!value?.text) return;
          const displayName = subject.displayName;
          const copy = [value.text, value.towardDisplayName ? `对象：${value.towardDisplayName}` : '', value.visibility ? `信息范围：${visibilityCopy(value.visibility)}` : '', value.reason ? `依据：${value.reason}` : '', value.origin ? `来源：${originCopy(value.origin)}` : ''].filter(Boolean).join(' · ');
          const searchable = `${displayName} ${category} ${copy}`;
          if (!plainSearchIncludes(searchable, query)) return;
          const key = JSON.stringify([subject.subjectEntityId ?? null, value.towardEntityId ?? null, displayName, category, copy]); if (seen.has(key)) return; seen.add(key);
          results.push({ floor, displayName, category, copy });
        };
        for (const subject of record?.subjects ?? []) {
          for (const change of subject.changes ?? []) {
            const category = categoryCopy[change.category] ?? '人物状态';
            add(subject, category, change.before?.text ? change.before : change.beforeText ? { ...change.before, text: change.beforeText } : null);
            add(subject, category, change.after?.text ? change.after : change.afterText ? { ...change.after, text: change.afterText } : null);
          }
        }
        for (const subject of record?.endStateSubjects ?? []) {
          for (const [key, category] of Object.entries(categoryCopy)) for (const value of subject[key] ?? []) add(subject, category, value);
        }
      }
      list.replaceChildren(element('p', 'qqj-search-count', `在全部人物状态历史中找到 ${results.length} 条结果`));
      for (const result of results) {
        const node = element('article', 'qqj-history-search-result'), title = element('div', 'qqj-history-search-title');
        title.append(element('strong', '', result.displayName), element('span', '', floorCopy(currentState, result.floor)), element('span', 'v3-memory-status', result.category));
        node.append(title, element('p', 'qqj-history-search-snippet', searchSnippet(result.copy, query)));
        node.setAttribute('role', 'button'); node.setAttribute('tabindex', '0'); node.setAttribute('aria-label', `打开${floorCopy(currentState, result.floor)}完整分析记录`);
        const openResult = () => {
          cseSearchQuery = ''; cseSearch.children[0].value = ''; cseSearch.children[1].hidden = true;
          for (const key of [`cse-floor:${result.floor.floorId}`, `cse-floor-changes:${result.floor.floorId}`, `cse-floor-state:${result.floor.floorId}`]) openState.set(key, true);
          const info = rowInfoByFloorId.get(result.floor.floorId), rowNode = info?.rowNode;
          if (info) ensureBody(info);
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
    section.append(list); let diagnosticNode = null;
    if (currentState.cseReplayDiagnostic?.message) { diagnosticNode = element('p', 'v3-foundation-feedback error', errorMessage(currentState.cseReplayDiagnostic)); section.append(diagnosticNode); }
    const historyStatusKey = value => {
      const healthText = healthCopy(value), healthTone = healthClass(value);
      const feedbackText = currentFeedback(value) || errorCopy(value) || '记忆状态已显示。';
      const feedbackTone = `v3-foundation-feedback${feedbackText.includes('失败') || (!feedback && errorCopy(value)) ? ' error' : ''}`;
      return [healthText, healthTone, feedbackText, feedbackTone].join('\u0000');
    };
    let lastStatusKey = historyStatusKey(currentState), lastWorkBusy = workBusy(currentState);
    const update = nextState => {
      const nextFloors = [...(nextState.floors ?? [])].filter(floor => floor.memoryId).sort((left, right) => (right.messageIndex ?? 0) - (left.messageIndex ?? 0));
      if (nextFloors.length !== floors.length || nextFloors.some((floor, index) => floor.floorId !== floors[index]?.floorId || floor.memoryId !== floors[index]?.memoryId)) return false;
      const statusKey = historyStatusKey(nextState), globalStatusChanged = statusKey !== lastStatusKey;
      const busyChanged = workBusy(nextState) !== lastWorkBusy;
      currentState = nextState;
      let searchableContentChanged = false;
      for (const floor of nextFloors) {
        const info = rowInfoByFloorId.get(floor.floorId), previous = info.floor;
        const recordChanged = previous.cse?.record !== floor.cse?.record;
        const label = floorCopy(nextState, floor), status = statusCopy(floor.cse?.status);
        const rowStatusChanged = label !== info.floorLabel.textContent || status !== info.floorStatus.textContent
          || previous.cse?.error !== floor.cse?.error || previous.frozen !== floor.frozen;
        if (recordChanged || label !== info.floorLabel.textContent) searchableContentChanged = true;
        if (label !== info.floorLabel.textContent) info.floorLabel.textContent = label;
        if (status !== info.floorStatus.textContent) info.floorStatus.textContent = status;
        info.floor = floor;
        if (info.body && (recordChanged || rowStatusChanged || busyChanged)) {
          buildBody(info); info.renderedRecord = floor.cse?.record; info.hasRenderedBody = true;
        }
      }
      floors = nextFloors;
      if (globalStatusChanged) {
        const updated = pageStatus(nextState);
        pageStatusNode.className = updated.className;
        pageStatusNode.replaceChildren(...updated.children);
        lastStatusKey = statusKey;
      }
      const countCopy = `${nextState.csePendingCount ?? 0} 待分析 · ${nextState.cseFailedCount ?? 0} 失败`;
      if (countStatusNode.textContent !== countCopy) countStatusNode.textContent = countCopy;
      const diagnostic = nextState.cseReplayDiagnostic?.message ? errorMessage(nextState.cseReplayDiagnostic) : '';
      if (!diagnosticNode && diagnostic) { diagnosticNode = element('p', 'v3-foundation-feedback error', diagnostic); section.append(diagnosticNode); }
      else if (diagnosticNode) { diagnosticNode.textContent = diagnostic; diagnosticNode.hidden = !diagnostic; }
      lastWorkBusy = workBusy(nextState);
      if (cseSearchQuery.trim() && searchableContentChanged) fillList();
      return true;
    };
    cseHistoryUi = { section, update };
    return section;
  }
  function peopleScrollHost() { return container?.parentElement ?? container; }
  function switchPeopleMode(next) {
    if (!['current', 'history'].includes(next) || next === peopleMode) return;
    const scrollHost = peopleScrollHost(); peopleScroll.set(peopleMode, scrollHost?.scrollTop || 0); peopleMode = next; render(foundationState); if (scrollHost) scrollHost.scrollTop = peopleScroll.get(next) || 0;
  }
  const relationItem = (value, state, { showMeta = false, showVisibility = false } = {}) => {
    const item = element('li', 'qqj-relation-item');
    item.append(showVisibility ? currentSituationLine(value) : element('span', 'v3-cse-item-text', cseReadingText(value.text)));
    if (showMeta) { const source = value.sourceFloorId || value.sourceAssistantSeq ? sourceFloorCopy(state, value) : value.origin === 'baseline' ? '来源：聊天基线' : '来源：本地重放'; item.append(element('small', 'v3-cse-item-meta', [...new Set([value.reason, originCopy(value.origin), source, visibilityCopy(value.visibility)])].join(' · '))); } return item;
  };
  function appendRelationLayers(container, { situational = [], adaptive = [] }, state, { situationalLabel = '当前态度', showSituationalVisibility = true } = {}) {
    let count = 0;
    for (const [label, values] of [[situationalLabel, situational], ['长期相处方式', adaptive]]) {
      if (!values.length) continue;
      const group = element('div', 'qqj-relation-layer'); group.append(element('strong', 'qqj-relation-layer-title', label));
      const list = element('ul', 'qqj-relation-items'); for (const value of values) list.append(relationItem(value, state, { showVisibility: label === situationalLabel && showSituationalVisibility })); group.append(list); container.append(group); count += values.length;
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
        appendRelationLayers(lane, historical.values, state, { situationalLabel: '当时态度', showSituationalVisibility: false });
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
    {
      appendSubjectGroups(anchor, userSubject, state, { situational: (userSubject.situational ?? []).filter(item => !item.towardEntityId), showMeta: false, groupAdaptiveByTarget: true, showSituationalVisibility: true });
      const edit = element('button', 'secondary-action qqj-cse-edit-action', '编辑我的状态'); edit.type = 'button'; edit.disabled = workBusy(state) || typeof runtime.correctSubjectState !== 'function' || !state.currentStateId || !state.currentStateFingerprint;
      edit.addEventListener('click', () => { const copyItems = values => (values ?? []).map(item => ({ itemId: item.id, text: item.text, visibility: item.visibility, towardEntityId: item.towardEntityId ?? null })); openCseEditor(key, { chatId: state.chatId, subjectEntityId: userSubject.subjectEntityId, expectedCurrentStateId: state.currentStateId, expectedCurrentStateFingerprint: state.currentStateFingerprint, core: copyItems(userSubject.core), adaptive: copyItems(userSubject.adaptive), situational: copyItems(userSubject.situational), saving: false, saveError: '' }, state, '编辑我的状态'); });
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
    const terminationStatus = record?.terminationEvent === 'GENERATION_STOPPED' ? '召回已停止'
      : record?.terminationEvent === 'GENERATION_ENDED' ? '生成已结束，召回未完成'
        : record?.status === 'stale' && record?.skipReasons?.includes('stopped') ? '召回已停止' : null;
    const recallStatus = record?.legacyReadOnly ? '旧版只读记录 · 不代表本轮已注入' : record?.restoredReceipt ? '聊天记录中的回执 · 恢复显示' : terminationStatus ?? statusCopy(status);
    const summary = element('summary', 'qqj-section-summary'); summary.append(element('strong', '', record?.restoredReceipt ? '最近一次召回结果' : '最近召回回执'), element('span', 'v3-memory-status', recallStatus)); drawer.append(summary);
    const body = element('div', 'qqj-management-drawer-body'); if (receiptFeedback) body.append(element('p', 'v3-foundation-feedback error', receiptFeedback));
    if (!record) { body.append(element('p', 'settings-hint', state?.activeRecall ? `正在处理 ${state.activeRecall.generationType} · ${state.activeRecall.phase}` : '下一次正文生成后，这里会保留最近一次召回结果。')); drawer.append(body); return drawer; }
    const coverage = record.coverage, stages = record.stages, timings = record.timings, sourceReads = timings?.sourceReadAttempts;
    const uncommitted = ['error', 'stale'].includes(record.status);
    const phaseCopy = value => ({ input: '输入准备', source: '来源读取', selecting: '选材', commit: '提交前核验', receipt: '回执保存' })[value] ?? '未记录阶段';
    const stepCopy = value => ({ input: '输入准备', source: '来源读取', identity: '身份读取', root: '根版本读取', prepare: '准备缓存', read: '独立来源读取', projection: '来源投影', timeProjection: '时间投影', bodyWitness: '正文关联核验', qianshiProgress: '千事进度准备', queryContext: '查询上下文', prequelSelection: '前情选择', receiptValidation: '已有回执校验', receiptSourceVerification: '回执来源核验', semanticQuery: '语义查询', candidateBuild: '候选构建', utilityTask: '模型选材', responseParse: '结果解析', localSelection: '本地选材', qianshiSeal: '千事结果校验', commitVerification: '提交前核验', deletionWitness: '删除状态核验', receiptSeal: '回执封签', receiptSaveCall: '回执保存请求', receiptSaveWait: '等待回执保存', receiptSaveReturned: '回执保存返回', receiptSaveFailed: '回执保存失败', complete: '完成' })[value] ?? '未记录步骤';
    const preparationCopy = values => (Array.isArray(values) ? values : []).slice(0, 2).map(value => {
      const stages = { identity: '身份读取', root: '根版本读取', prepare: '准备缓存', read: '独立来源读取', projection: '来源投影' };
      const status = { ready: '完成', inProgress: '等待中（终止时）', timeout: '超时', stale: '已失效', unavailable: '不可用', disabled: '已关闭' };
      return `${phaseCopy(value.phase)} · ${value.mode === 'fresh' ? '只读核验' : '常规准备'} · ${status[value.status] ?? '未记录'}于${stages[value.stage] ?? '未知阶段'}${Number.isFinite(value.totalMs) ? ` · ${value.totalMs} ms` : ''}${Number.isFinite(value.budgetMs) ? ` / 期限 ${value.budgetMs} ms` : ''} · ${Object.entries(stages).filter(([stage]) => Number.isFinite(value[`${stage}Ms`])).map(([stage, label]) => `${label} ${value[`${stage}Ms`]} ms`).join(' · ')}`;
    }).join('；');
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
    const semanticStatusCopy = { ready: '可用', cached: '缓存命中', disabled: '已关闭', busy: '忙碌', unindexed: '本轮无可用向量片段', changed: '来源已变化', dimensionMismatch: '维度不匹配', unavailable: '不可用',
      VECTOR_TIMEOUT: '查询超时', VECTOR_INDEX_LOAD_TIMEOUT: '索引读取超时', VECTOR_ABORTED: '查询已取消', VECTOR_QUERY_BUDGET_EXHAUSTED: '本轮次数已用尽' };
    const semanticStatus = status => semanticStatusCopy[status] ?? (String(status ?? '').startsWith('VECTOR_') ? '不可用' : '状态未记录');
    const hasExclusionCounts = ['historyExcludedCount', 'stateExcludedCount', 'historyRetainedCount', 'stateRetainedCount'].some(key => Number.isSafeInteger(selector?.[key]));
    let selectorCountCopy = hasExclusionCounts
      ? `历史候选 ${selectorCount(selector?.historyCandidateCount)} → 模型排除 ${selectorCount(selector?.historyExcludedCount)} → 保留 ${selectorCount(selector?.historyRetainedCount)} → 关联补入 ${selectorCount(stages?.linkedHistoryItemCount)} → 最终远期 ${selectorCount(stages?.distantHistoryItemCount)} · 人物候选 ${selectorCount(selector?.stateCandidateCount)} → 模型排除 ${selectorCount(selector?.stateExcludedCount)} → 保留 ${selectorCount(selector?.stateRetainedCount)} → 关联补入 ${selectorCount(stages?.linkedCseChangeCount)} → 最终注入 ${Number.isSafeInteger(stages?.currentStateCount) && Number.isSafeInteger(stages?.cseChangeCount) ? stages.currentStateCount + stages.cseChangeCount : '未知'}`
      : `历史候选 ${selectorCount(selector?.historyCandidateCount)} → 模型选择 ${selectorCount(selector?.historyModelSelectedCount)} → 最终远期 ${selectorCount(stages?.distantHistoryItemCount)} · 人物候选 ${selectorCount(selector?.stateCandidateCount)} → 模型选择 ${selectorCount(selector?.stateModelSelectedCount)} → 最终注入 ${Number.isSafeInteger(stages?.currentStateCount) && Number.isSafeInteger(stages?.cseChangeCount) ? stages.currentStateCount + stages.cseChangeCount : '未知'}`;
    if (selector?.priority && selector.priority.status !== 'missing') {
      const priority = selector.priority;
      selectorCountCopy += ` · 优先证据 保留 ${priority.selectedKeys.length}/${priority.keys.length}${priority.status === 'timeGuard' ? ' · 时间材料参与，本轮原序' : priority.status === 'invalid' ? ' · 提示无效' : ''}`;
    }
    if (uncommitted) selectorCountCopy = selectorCountCopy.replace('最终注入', '候选材料');
    const persistenceCopy = { saving: '后台保存中；刷新可能丢失本轮回执', sessionOnly: '未保存；仅当前页面可复用', saveUnconfirmed: '已请求宿主保存，结果未确认', chatRecord: '从聊天记录读取', none: '未保存' };
    const selectorBreakdown = selector?.mode === 'local' && Number.isFinite(selector?.localSelectionMs)
      ? `未发起选材接口 · 本地选材 ${Number(selector.localSelectionMs).toFixed(1)} ms`
      : Number.isFinite(selector?.utilityRoundTripMs) && Number.isFinite(selector?.localSelectionMs)
      ? `接口往返（含传输） ${Number(selector.utilityRoundTripMs).toFixed(1)} ms · 本地选材 ${Number(selector.localSelectionMs).toFixed(1)} ms`
      : '接口往返与本地选材未记录';
    let timingCopy = record.terminationEvent === 'GENERATION_STOPPED' || record.terminationEvent === 'GENERATION_ENDED'
      ? `${terminationStatus} · ${Number.isFinite(timings?.totalMs) ? `本轮召回等待 ${Number(timings.totalMs).toFixed(1)} ms` : '本轮召回等待未记录'}${Number.isFinite(timings?.sourceMs) ? ` · 读取 ${Number(timings.sourceMs).toFixed(1)} ms` : ''}${Number.isFinite(timings?.selectorMs) ? ` · 选材 ${Number(timings.selectorMs).toFixed(1)} ms` : ''} · ${selectorBreakdown}`
      : record.reusedReceipt
      ? `${Number.isFinite(timings?.totalMs) ? `本轮复用耗时 ${Number(timings.totalMs).toFixed(1)} ms` : '本轮复用耗时未记录'} · 未发起新选材请求 · 原回执${selectorBreakdown}`
      : record.restoredReceipt
        ? `历史原始耗时：${Number.isFinite(timings?.totalMs) ? `总等待 ${Number(timings.totalMs).toFixed(1)} ms · ` : ''}${Number.isFinite(timings?.selectorMs) ? `选材总等待 ${Number(timings.selectorMs).toFixed(1)} ms · ` : ''}${selectorBreakdown}${Number.isFinite(timings?.sourceMs) ? ` · 读取 ${Number(timings.sourceMs).toFixed(1)} ms` : ''}`
        : timings ? `${Number.isFinite(timings.totalMs) ? `本轮召回等待 ${Number(timings.totalMs).toFixed(1)} ms · ` : ''}${Number.isFinite(timings.selectorMs) ? `选材总等待 ${Number(timings.selectorMs).toFixed(1)} ms · ` : ''}${selectorBreakdown}${Number.isFinite(timings.sourceMs) ? ` · 读取 ${Number(timings.sourceMs).toFixed(1)} ms` : ''}` : '未记录';
    if (!record.restoredReceipt) {
      if (Number.isFinite(timings?.commitMs)) timingCopy += ` · 核验 ${Number(timings.commitMs).toFixed(1)} ms`;
      // 保存耗时单列，不计入放行正文前的召回等待，也不表示落盘已确认。
      if (Number.isFinite(timings?.receiptMs)) timingCopy += ` · 后台保存 ${Number(timings.receiptMs).toFixed(1)} ms`;
      else if (record.receiptPersistence === 'saving') timingCopy += ' · 后台保存中';
    }
    if (uncommitted && record.diagnosticAttempt) timingCopy = `选材与读取耗时来自第 ${record.diagnosticAttempt} 次尝试 · ${timingCopy}`;
    if (selector?.semantic) timingCopy += ` · 向量 ${semanticStatus(selector.semantic.status)} · 候选 ${selector.semantic.candidateCount} · ${Number(selector.semantic.durationMs).toFixed(1)} ms`;
    const filterReasons = (record.skipReasons ?? []).filter(value => value !== 'historySelectionFallback').map(skipReasonCopy);
    const selectorMetadataCopy = selector?.code ? `${selectorFailureCopy(selector.code)}${selector.httpStatus ? ` · HTTP ${selector.httpStatus}` : ''}${selector.formatStage ? ` · 格式阶段 ${selector.formatStage}` : ''}${selector.sourceStage ? ` · 阶段 ${selector.sourceStage}` : ''}${selector.finishReason ? ` · 结束原因 ${selector.finishReason}` : ''}${selector.sourceLabel && selector.sourceLabel !== '未命名 API' ? ` · 来源 ${selector.sourceLabel}` : ''}${selector.model && selector.model !== 'unknown' ? ` · 模型 ${selector.model}` : ''}${Number.isSafeInteger(selector.transportAttempts) ? ` · 网络尝试 ${selector.transportAttempts}` : ''}${Number.isSafeInteger(selector.requestCharacters) ? ` · 请求约 ${selector.requestCharacters} 字符 / ${selector.requestEstimatedTokens} token` : ''}` : '';
    const errorMetadataCopy = record.error ? `${record.error.code}${record.error.httpStatus ? ` · HTTP ${record.error.httpStatus}` : ''}${record.error.formatStage ? ` · 格式阶段 ${record.error.formatStage}` : ''}${record.error.sourceStage ? ` · 阶段 ${record.error.sourceStage}` : ''}${record.error.finishReason ? ` · 结束原因 ${record.error.finishReason}` : ''}${record.error.sourceLabel && record.error.sourceLabel !== '未命名 API' ? ` · 来源 ${record.error.sourceLabel}` : ''}${record.error.model && record.error.model !== 'unknown' ? ` · 模型 ${record.error.model}` : ''}${Number.isSafeInteger(record.error.transportAttempts) ? ` · 网络尝试 ${record.error.transportAttempts}` : ''}` : '';
    const details = element('dl', 'v3-foundation-grid'); details.append(row('触发用户楼', userFloorCopy(record.userMessageIndex)), row('生成时间', localTimeCopy(record.createdAt)), row('生成类型', generationTypeCopy(record.generationType)), row('收据', record.legacyReadOnly ? '旧版只读记录' : record.restoredReceipt ? '从聊天记录读取 · 仅恢复历史展示，不会再次注入' : `${record.reusedReceipt ? '复用' : '新算'} · ${persistenceCopy[record.receiptPersistence] ?? record.receiptPersistence ?? '未知'}`), row('召回旧楼', floors), row('当前人物状态', states), row('人物状态历史变化', changes), row('覆盖范围', coverage ? `记忆 ${coverage.rememberedAiFloors}/${coverage.stableAiFloors} · ${coverage.cseThroughAssistantSeq ? `CSE 到${floorCopy(foundationState, { assistantSeq: coverage.cseThroughAssistantSeq }, '终点楼号未提供')}` : 'CSE 尚未覆盖'}` : '本轮未读取'), stageRow('筛选阶段', stageCopy), row('选材方式', selector?.code ? '智能选材失败' : selectorModeCopy(selector?.mode)), row('智能选材计数', selectorCountCopy), ...(selectorMetadataCopy ? [row('选材失败诊断', selectorMetadataCopy)] : []), ...(errorMetadataCopy ? [row('失败诊断', errorMetadataCopy)] : []), row('耗时', timingCopy), row('来源读取', sourceReadCopy), row('普通过滤说明', filterReasons.join('、') || '无'));
    if (record.diagnosticPhase) details.append(row('所示诊断阶段', `${record.diagnosticAttempt ? `第 ${record.diagnosticAttempt} 次尝试 · ` : ''}${phaseCopy(record.diagnosticPhase)} · ${selectionCopy(record.selectionStatus)}${record.pendingStep ? ` · ${terminationStatus ? '终止时步骤' : '正在'} ${stepCopy(record.pendingStep)}` : ''}${record.lastCompletedStep ? ` · 上一步 ${stepCopy(record.lastCompletedStep)}` : ''}${uncommitted ? ' · 本轮未注入' : ''}`));
    // 准备子阶段只展示枚举与计时；历史回执没有尝试列表时沿已封签的可选计时恢复。
    if (!record.attemptDiagnostics?.length && timings?.preparationAttempts?.length) details.append(row('准备等待', preparationCopy(timings.preparationAttempts)));
    for (const attempt of record.attemptDiagnostics ?? []) {
      const attemptError = attempt.error;
      const attemptSelector = attempt.selectorDiagnostic;
      const attemptMetadata = attemptError ? `${attemptError.code}${attemptError.httpStatus ? ` · HTTP ${attemptError.httpStatus}` : ''}${attemptError.formatStage ? ` · 格式阶段 ${attemptError.formatStage}` : ''}${attemptError.sourceStage ? ` · 阶段 ${attemptError.sourceStage}` : ''}${attemptError.finishReason ? ` · 结束原因 ${attemptError.finishReason}` : ''}${attemptError.sourceLabel && attemptError.sourceLabel !== '未命名 API' ? ` · 来源 ${attemptError.sourceLabel}` : ''}${attemptError.model && attemptError.model !== 'unknown' ? ` · 模型 ${attemptError.model}` : ''}${Number.isSafeInteger(attemptError.transportAttempts) ? ` · 网络尝试 ${attemptError.transportAttempts}` : ''}${Number.isSafeInteger(attemptSelector?.requestCharacters) ? ` · 请求约 ${attemptSelector.requestCharacters} 字符 / ${attemptSelector.requestEstimatedTokens} token` : ''}` : '';
      details.append(row(`第 ${attempt.attempt} 次尝试`, `${phaseCopy(attempt.phase)} · ${selectionCopy(attempt.selectionStatus)}${attemptMetadata ? ` · ${attemptMetadata}` : ''}${Number.isFinite(attempt.timings?.totalMs) ? ` · ${Number(attempt.timings.totalMs).toFixed(1)} ms` : ''}`));
      if (attempt.timings?.preparationAttempts?.length) details.append(row(`第 ${attempt.attempt} 次准备`, preparationCopy(attempt.timings.preparationAttempts)));
    }
    const vectorRequest = selector?.semantic?.request;
    if (vectorRequest) {
      const vectorPhase = { request: '等待响应', response: '读取结果', validation: '校验结果', complete: '完成' };
      details.append(row('向量请求', `${vectorPhase[vectorRequest.phase] ?? '未记录'} · ${vectorRequest.inputCharacters ?? '未知'} 字符 · 上限 ${vectorRequest.timeoutMs ?? '未知'} ms${Number.isSafeInteger(vectorRequest.httpStatus) ? ` · HTTP ${vectorRequest.httpStatus}` : ''}${Number.isFinite(vectorRequest.responseHeadersMs) ? ` · 响应可读 ${vectorRequest.responseHeadersMs} ms` : ' · 响应尚未可读'}${Number.isFinite(vectorRequest.responseBodyMs) ? ` · 结果读取 ${vectorRequest.responseBodyMs} ms` : ''}`));
    }
    const countCopy = values => values.length ? String(values.length) : '0';
    const materialLabel = record.restoredReceipt || record.legacyReadOnly ? '历史展示' : uncommitted ? '候选材料（本轮未注入）' : '本轮选入';
    const selectedCountCopy = `${materialLabel}：旧楼 ${countCopy(record.selectedFloors ?? [])} · 当前状态 ${countCopy(record.selectedStates ?? [])} · 历史变化 ${countCopy(record.selectedCseChanges ?? [])}${Number.isSafeInteger(stages?.locationReferenceCount) ? ` · 地点参照 ${stages.locationReferenceCount}` : ''}${[stages?.timeCorrectionCount, stages?.timeReminderCount].every(Number.isSafeInteger) ? ` · 时间参考 ${stages.timeCorrectionCount + stages.timeReminderCount}` : ''}`;
    const tokenSummary = Number.isSafeInteger(stages?.estimatedTokenCount) && Number.isSafeInteger(stages?.estimatedTokenBudget)
      ? `${stages.estimatedTokenCount}/${stages.estimatedTokenBudget}（保守估算）` : '未记录';
    const totalWaitCopy = Number.isFinite(timings?.totalMs)
      ? `${record.restoredReceipt ? '历史耗时' : record.reusedReceipt ? '复用耗时' : '本轮召回等待'} ${ (Number(timings.totalMs) / 1000).toFixed(1) } 秒`
      : record.restoredReceipt ? '历史耗时未记录' : record.reusedReceipt ? '复用耗时未记录' : '召回等待未记录';
    const semantic = selector?.semantic;
    let vectorSummary = '向量未记录';
    if (semantic) {
      const schemaHasWitnesses = Number(record.schemaVersion) >= 17 || (record.selectedFloors ?? []).some(value => Array.isArray(value?.rawWitnesses));
      const rawWitnessCount = schemaHasWitnesses
        ? (record.selectedFloors ?? []).reduce((sum, value) => sum + (Array.isArray(value?.rawWitnesses) ? value.rawWitnesses.length : 0), 0)
        : null;
      const summaryWitnessCount = (record.selectedFloors ?? []).reduce((sum, value) => sum + (Array.isArray(value?.summaryWitnesses) ? value.summaryWitnesses.length : 0), 0);
      const statusCopy = semanticStatus(semantic.status);
      const witnessLabel = uncommitted ? '候选原文段' : record.restoredReceipt || record.legacyReadOnly ? '历史选入原文段' : '选入原文段';
      vectorSummary = `向量 ${statusCopy} · 候选 ${Number.isSafeInteger(semantic.candidateCount) ? semantic.candidateCount : '未记录'} · ${rawWitnessCount === null ? '原文段未记录' : `${witnessLabel} ${rawWitnessCount}`}${summaryWitnessCount ? ` · 历史人工摘要 ${summaryWitnessCount}条` : ''}`;
    }
    // 候选与历史材料不得伪装成本轮注入；将诊断折叠也不应影响复制完整回执。
    const overview = element('div', 'v3-foundation-grid qqj-recall-overview');
    overview.append(row('本轮材料', selectedCountCopy), row('来源楼号', floors), row('召回等待', totalWaitCopy), row('向量', vectorSummary), row('Token', tokenSummary));
    body.append(overview);
    const diagnosticDrawer = setDetailsState(element('details', 'qqj-management-drawer qqj-recall-diagnostics'), 'recall-diagnostics', false);
    const diagnosticSummary = element('summary', 'qqj-section-summary'); diagnosticSummary.append(element('strong', '', '诊断'), element('span', 'v3-memory-status', '按需展开')); diagnosticDrawer.append(diagnosticSummary);
    const diagnosticBody = element('div', 'qqj-management-drawer-body'); diagnosticBody.append(details); diagnosticDrawer.append(diagnosticBody); body.append(diagnosticDrawer);
    const safeError = errorMessage(state?.lastRecallError) || errorMessage(record.error); if (safeError) body.append(element('p', 'v3-foundation-feedback error', safeError));
    const errorCode = state?.lastRecallError?.code ?? record.error?.code;
    if (errorCode) diagnosticBody.append(element('p', 'settings-hint', `错误代码：${errorCode}`));
    const copyButton = element('button', 'secondary-action qqj-recall-copy', '复制回执'); copyButton.type = 'button'; copyButton.setAttribute('aria-label', '复制召回回执诊断');
    summary.append(copyButton);
    const copyFeedback = element('p', 'settings-result'), copyFallback = element('div'); body.append(copyFeedback, copyFallback);
    copyButton.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation();
      const excluded = new Set(['召回旧楼', '当前人物状态', '人物状态历史变化']);
      const nodeCopy = node => node.children?.length ? Array.from(node.children).map(nodeCopy).filter(Boolean).join(' ') : node.textContent || '';
      // 复制时读最新时间记录，才能包含回执显示之后发出的主楼请求；不附别轮或刷新前的记录。
      const latest = recallRuntime?.getState?.();
      const requests = Number.isSafeInteger(record.requestDiagnosticId) && latest?.lastRecall?.requestDiagnosticId === record.requestDiagnosticId
        ? latest.requestDiagnostic : null;
      const stamp = value => Number.isFinite(value) ? new Date(value).toISOString() : '未记录';
      const requestCopy = !requests || requests.status === 'unavailable' ? ['请求计时：未记录（刷新后不可恢复）。']
        : requests.status === 'unsupported' ? ['请求计时：浏览器不支持。']
        : ['请求计时（UTC，仅 HTTP，可能含后台请求；首响应不代表模型首字）：',
          ...(requests.requests ?? []).map((item, index) => `${index + 1}. ${item.label}：发起 ${stamp(item.startedAt)} · 发送 ${stamp(item.requestStartedAt)} · 首响应 ${stamp(item.responseStartedAt)} · 完成 ${stamp(item.finishedAt)}`),
          ...(requests.droppedCount ? [`仅保留最近 64 条；较早 ${requests.droppedCount} 条已略去。`] : [])];
      const value = [`召回回执：${recallStatus}`, ...Array.from(details.children).filter(node => !excluded.has(node.children[0]?.textContent)).map(node => nodeCopy(node)),
        `实际注入：${record.restoredReceipt || record.legacyReadOnly ? '历史展示，不代表本轮' : record.injectionText && !uncommitted ? '有' : '无'}；旧楼 ${record.selectedFloors?.length ?? 0}，状态 ${record.selectedStates?.length ?? 0}，变化 ${record.selectedCseChanges?.length ?? 0}`,
        ...requestCopy,
        ...(errorCode ? [`错误代码：${errorCode}`, `错误：${publicErrorMessage({ code: errorCode }, { fallback: '召回未完成，请按错误代码检查。' })}`] : []), ...(errorMetadataCopy ? [`安全错误诊断：${errorMetadataCopy}`] : [])].join('\n');
      copyFeedback.textContent = await copy(value, { local: true }); copyFallback.replaceChildren();
      if (copyFeedback.textContent !== '已复制。') { const input = element('textarea', 'v3-diagnostic-fallback qqj-recall-copy-fallback'); input.value = value; input.readOnly = true; input.setAttribute('aria-label', '召回回执诊断复制文本'); copyFallback.append(input); }
    });
    if (record.legacyReadOnly) body.append(element('p', 'settings-hint', '这是旧版只读记录，不会复用、注入或升级为当前回执。'));
    if (record.injectionText) {
      body.append(element('pre', 'v3-recall-injection', record.injectionText));
      if ((record.skipReasons ?? []).includes('memoryNotReady')) body.append(element('p', 'settings-hint', '当前仍有摘要或人物状态缺口；本轮已注入能确认归属的已保存部分，正文继续生成。'));
    }
    else if (record.status === 'empty' || record.status === 'completed-empty') body.append(element('p', 'settings-hint', '本轮没有需要注入的记忆。'));
    else if ((record.skipReasons ?? []).includes('uninitialized')) body.append(element('p', 'settings-hint', '尚未开始记录，本轮不注入记忆，正文继续生成。'));
    else if ((record.skipReasons ?? []).includes('sourceStale')) body.append(element('p', 'settings-hint', '记忆来源正在更新，本轮已安全跳过召回注入。'));
    else if ((record.skipReasons ?? []).includes('sourceUnavailable')) body.append(element('p', 'settings-hint', '记忆来源暂不可用；本轮召回失败，正文生成已停止。'));
    else if ((record.skipReasons ?? []).includes('memoryPreparationTimeout')) body.append(element('p', 'settings-hint', '记忆在准备期限内未准备完成；本轮召回失败，正文生成已停止。'));
    else if ((record.skipReasons ?? []).includes('memoryPreparationFailed')) body.append(element('p', 'settings-hint', '记忆准备失败；本轮召回失败，正文生成已停止。'));
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
    const preview = saved.text ? element('pre', 'qqj-prequel-preview', saved.text.slice(0, 420) + (saved.text.length > 420 ? '…' : '')) : element('p', 'settings-hint', '尚未设置前情。');
    body.append(preview);
    const edit = element('button', 'secondary-action', saved.text ? '编辑前情' : '添加前情'); edit.type = 'button';
    edit.addEventListener('click', () => {
      if (typeof customImpl !== 'function') return;
      const draft = prequelDraft, editor = element('div', 'qqj-editor-dialog');
      editor.append(element('p', 'qqj-editor-intro', '前情保存在当前聊天；清空并保存即可移除。取消不更改已保存内容。'));
      const group = element('section', 'qqj-editor-group'); group.append(element('h3', '', '前情内容'));
      const input = element('textarea', 'settings-input qqj-editor-textarea qqj-prequel-editor'); input.value = draft.text; input.rows = 16;
      input.addEventListener('input', () => { draft.text = input.value; draft.dirty = true; }); group.append(input); editor.append(group);
      let committed = false;
      void Promise.resolve(customImpl({ title: '编辑前情', content: editor, confirmText: '保存前情', cancelText: '取消', submit: async () => {
        if (draft.saving) return false;
        draft.text = input.value; draft.dirty = true; draft.saving = true; prequelFeedback = '';
        try {
          const result = await recallRuntime.savePrequel(draft.text);
          if (prequelDraft !== draft) return false;
          prequelDraft = { hostChatId: result.hostChatId, text: result.text, dirty: false, saving: false };
          prequelFeedback = result.text ? '前情已更新，并已交给酒馆保存。' : '前情已移除，并已交给酒馆保存。';
          committed = true;
          if (active && container && page === 'management') render(foundationState);
          return true;
        } catch (error) { if (prequelDraft === draft) { draft.saving = false; prequelFeedback = errorMessage(error) || '前情保存失败。'; } throw error; }
      }, onClose: () => { if (!committed && prequelDraft === draft) prequelDraft = { hostChatId: saved.hostChatId, text: saved.text, dirty: false, saving: false }; } }));
    });
    body.append(edit);
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
    stateDiagnosticAction.append(copyState, element('span', 'settings-hint', '包含运行状态、错误代码、变化类别与相关 AI 楼序；CSE 失败时附当次分析人物姓名、别名与拒收原因。不含聊天正文、请求头或 API 配置。'));
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
      let floorListBuilt = false;
      const buildFloorList = () => {
        if (!drawer.open || !floorDrawer.open) return;
        if (floorListBuilt) return;
        floorListBuilt = true;
        for (const floor of [...(state.floors ?? [])].reverse()) {
          const diagnostic = element('div', 'qqj-diagnostic-row'); diagnostic.append(element('span', '', floorCopy(state, floor, '楼号未提供', { knownFloor: true })));
          const safe = element('button', 'secondary-action', '复制安全诊断'); safe.type = 'button'; safe.addEventListener('click', () => { void run('复制安全诊断', async () => { feedback = await copy(runtime.copySafeDiagnostic(floor.floorId)); return runtime.getState(); }); });
          const full = element('button', 'secondary-action', '复制完整诊断'); full.type = 'button'; full.addEventListener('click', () => { void run('复制完整诊断', async () => { if (!await Promise.resolve(confirmImpl({ title: '复制完整诊断', body: '完整诊断包含本楼正文与证据原文。确认复制吗？', confirmText: '复制', cancelText: '取消' }))) { feedback = '已取消完整诊断复制。'; return runtime.getState(); } feedback = await copy(runtime.copyFullDiagnostic(floor.floorId)); return runtime.getState(); }); });
          diagnostic.append(safe, full); floorList.append(diagnostic);
        }
      };
      drawer.addEventListener('toggle', buildFloorList); floorDrawer.addEventListener('toggle', buildFloorList);
      buildFloorList();
      floorDrawer.append(floorSummary, floorList); body.append(floorDrawer);
    }
    if (fallbackText) { const fallback = element('textarea', 'v3-diagnostic-fallback'); fallback.value = fallbackText; fallback.textContent = fallbackText; fallback.readOnly = true; body.append(element('p', 'settings-hint', '诊断文本（长按全选复制）'), fallback); }
    drawer.append(body); return drawer;
  }
  function updateManagementFeedback(state) {
    if (!managementFeedbackNode) return;
    const copy = (currentFeedback(state) || errorCopy(state) || (pluginActivity.busy ? '' : '状态已显示。')).replace('；历史召回回执已独立处理。', '');
    const isError = errorCopy(state) || copy.startsWith('记忆读取失败') || copy.startsWith('刷新状态未完成');
    managementFeedbackNode.className = `v3-foundation-feedback qqj-management-feedback${isError ? ' error' : ''}`;
    managementFeedbackNode.textContent = copy; managementFeedbackNode.hidden = !copy;
  }
  function renderManagement(state) {
    const taskState = managementState?.rebuildState;
    if (taskState) state = { ...state, ...taskState };
    const pageNode = element('section', 'qqj-page qqj-management-page'); pageNode.append(heading('记忆管理', '管理当前聊天的现有记忆任务。', state));
    const cseResume = ['paused', 'failed'].includes(state.cseRebuildStatus);
    if (cseResume) pageNode.append(element('p', 'qqj-management-notice', `人物状态重构${state.cseRebuildStatus === 'paused' ? '已暂停' : '未完成'}，请点击“继续人物状态重构”。`));
    else if (['pendingRebuild', 'paused', 'failed', 'partial'].includes(state.rebuildStatus) || (state.rebuildStatus === 'waitingRealtime' && state.rebuildHasActionableWork)) pageNode.append(element('p', 'qqj-management-notice', '记忆尚未完整。“补齐缺失”会保留已有结果，只处理摘要或人物状态缺口；刷新页面不会自动续跑旧档。'));
    const deleting = managementState?.status === 'deleting', deletePending = managementState?.status === 'failed';
    const actions = element('div', 'v3-foundation-actions qqj-management-actions'), busy = workBusy(state) || managementState?.workBusy || deleting || deletePending;
    const refresh = element('button', 'secondary-action', '刷新状态'); refresh.type = 'button'; refresh.disabled = busy;
    refresh.addEventListener('click', () => { void run('正在刷新状态', () => runtime.refreshStatus({ preferCached: false, recoverTailDeletion: true, reconcileFoundation: true }), { resultCopy: refreshResult, followState: true }); });
    actions.append(refresh);
    const rebuildActionable = state.rebuildHasActionableWork ?? !['caughtUp', 'waitingRealtime'].includes(state.rebuildStatus);
    const hasRebuildTask = Boolean(managementState?.rebuildState), pausedRebuildTask = hasRebuildTask && ['paused', 'failed', 'partial'].includes(state.rebuildStatus);
    const pauseHistoricalRebuild = managementState?.pauseHistoricalRebuild ?? runtime.pauseHistoricalRebuild;
    if (state.rebuildStatus === 'rebuilding' && typeof pauseHistoricalRebuild === 'function') { const isTaskRebuild = typeof managementState?.pauseHistoricalRebuild === 'function'; const label = isTaskRebuild ? '暂停重构' : '暂停补齐'; const pause = element('button', 'primary-action', label); pause.type = 'button'; pause.disabled = !state.activeAutoMemory; pause.addEventListener('click', () => { void run(label, () => pauseHistoricalRebuild(), { resultCopy: automaticResult(isTaskRebuild ? '完全重构' : '补齐缺失') }); }); actions.append(pause); }
    else if (!hasRebuildTask && !['paused', 'failed'].includes(state.cseRebuildStatus)) { const begin = runtime.startHistoricalRebuild ?? runtime.retryAutomation; const proceedLabel = ['paused', 'failed', 'partial'].includes(state.rebuildStatus) ? '继续补齐' : '补齐缺失'; const proceed = element('button', 'primary-action', busy ? workPhaseCopy(state) : proceedLabel); proceed.type = 'button'; proceed.disabled = busy || typeof begin !== 'function' || !rebuildActionable; proceed.addEventListener('click', async () => { const mode = await confirmHistoricalMode(); if (!mode) { feedback = `已取消${proceedLabel}。`; render(foundationState); return; } void run(proceedLabel, () => begin === runtime.startHistoricalRebuild ? begin.call(runtime, mode) : begin.call(runtime), { resultCopy: automaticResult(proceedLabel) }); }); actions.append(proceed); }
    const reset = element('button', 'secondary-action', pausedRebuildTask ? '继续完全重构' : '完全重构'); reset.type = 'button'; reset.disabled = (busy && !pausedRebuildTask) || typeof memoryManagement?.fullRebuild !== 'function'; reset.addEventListener('click', async () => { const mode = pausedRebuildTask ? {} : await confirmHistoricalMode({ fullRebuild: true }); if (!mode) { feedback = '已取消完全重构。'; render(foundationState); return; } const resetDraft = prequelDraft; void run(pausedRebuildTask ? '继续完全重构' : '完全重构', () => memoryManagement.fullRebuild(state.chatId, mode), { after: () => { if (prequelDraft === resetDraft) { prequelDraft = null; prequelFeedback = ''; } }, resultCopy: automaticResult('完全重构') }); }); actions.append(reset);
    const cseRunning = state.cseRebuildStatus === 'running' && state.activeAutoMemory?.mode === 'cseRebuild';
    const cseAction = element('button', 'secondary-action', cseRunning ? '暂停人物状态重构' : cseResume ? '继续人物状态重构' : '人物状态重构'); cseAction.type = 'button';
    cseAction.disabled = cseRunning ? typeof runtime.pauseCseRebuild !== 'function' || deleting : busy || typeof runtime.rebuildCse !== 'function' || (state.rememberedCount ?? 0) < 1;
    cseAction.addEventListener('click', async () => {
      if (cseRunning) { void run('暂停人物状态重构', () => runtime.pauseCseRebuild(), { resultCopy: cseRebuildResult('人物状态重构') }); return; }
      if (cseResume) { void run('继续人物状态重构', () => runtime.resumeCseRebuild(state.chatId), { resultCopy: cseRebuildResult('人物状态重构') }); return; }
      if (!await Promise.resolve(confirmImpl({ title: '重构当前聊天人物状态', body: '保留摘要，调用 API 重建其对应的双丝网状态；双丝网人工纠正会被覆盖。未摘要楼不处理。', confirmText: '人物状态重构', cancelText: '取消' }))) { feedback = '已取消人物状态重构。'; render(foundationState); return; }
      void run('人物状态重构', () => runtime.rebuildCse(state.chatId), { resultCopy: cseRebuildResult('人物状态重构') });
    });
    actions.append(cseAction);
    const progress = element('div', 'qqj-management-progress');
    if (state.cseRebuildStatus !== 'idle') progress.append(element('span', 'settings-hint', `人物状态${state.cseRebuildStatus === 'completed' ? '已完成' : state.cseRebuildStatus === 'failed' ? '失败' : state.cseRebuildStatus === 'paused' ? '已暂停' : '重构中'} · ${state.cseRebuildCompletedCount ?? 0}/${state.cseRebuildTotalCount ?? 0}`));
    const pendingCopy = [state.unprocessedCount > 0 ? `摘要待补 ${state.unprocessedCount} 楼` : '', state.csePendingCount > 0 ? `CSE 待分析 ${state.csePendingCount} 楼` : ''].filter(Boolean).join(' · ');
    const nextStepCopy = () => deletePending ? '上次删除尚未完成，请先继续删除当前聊天记忆。'
      : pluginActivity.busy ? ''
      : busy ? state.mainGenerationActive ? '正文正在生成，完成后可继续操作。' : ''
        : ['needsReview', 'error'].includes(effectiveStatus(state)) || sessionErrorCopy() ? ''
          : uninitializedCopy(state) || (!state.chatId ? '当前记忆状态尚未载入，请点击“刷新状态”。'
            : cseResume ? '完成后如仍有缺失，可继续补齐。'
            : !rebuildActionable ? '当前没有需要补齐的稳定楼。'
              : '可用“补齐缺失”保留已有结果；“完全重构”会替换全部摘要与人物状态。');
    const progressCopy = element('span', 'settings-hint');
    refreshManagementProgress = () => { progressCopy.textContent = [pendingCopy, nextStepCopy()].filter(Boolean).join('。'); progressCopy.hidden = !progressCopy.textContent; };
    refreshManagementProgress(); progress.append(progressCopy);
    const deleteActions = element('div', 'qqj-management-delete');
    if (memoryManagement) {
      const sessionState = readDiagnosticState(sessionStateProvider);
      const hasCurrentIdentity = Boolean(state.chatId || (sessionState?.status === 'ready' && sessionState.identity?.chatId));
      const remove = element('button', 'primary-action', deleting ? '删除中…' : deletePending ? '继续删除当前聊天记忆' : '删除当前聊天记忆');
      remove.type = 'button'; remove.disabled = deleting || (!deletePending && (managementState?.workBusy === true || !hasCurrentIdentity));
      remove.addEventListener('click', async () => {
        if (!await Promise.resolve(confirmImpl({ title: '删除当前聊天记忆', body: '删除本聊天的摘要、双丝网、人物资料、时间事项、召回及历史版本，下次需重新建档。正文、手动前情和全局设置保留；前情可另行清空。', note: '后台记录移入回收站，并非永久擦除。', confirmText: deletePending ? '继续删除' : '删除记忆', cancelText: '取消' }))) { feedback = '已取消删除当前聊天记忆。'; render(foundationState); return; }
        void run(deletePending ? '继续删除当前聊天记忆' : '删除当前聊天记忆', () => memoryManagement.deleteCurrent(), { after: () => { managementState = memoryManagement.getState(); feedback = '当前聊天记忆已删除；聊天正文、手动前情与全局设置均已保留。手动前情可在“前情”中清空。'; return true; }, failed: () => { managementState = memoryManagement.getState(); return true; } });
      });
      deleteActions.append(remove);
      if (typeof memoryManagement.migrateCurrent === 'function') {
        const migration = element('button', 'secondary-action', managementState?.migrationState?.status === 'migrating' ? '搬家中…' : '搬家');
        migration.type = 'button'; migration.disabled = busy || managementState?.migrationState?.status === 'migrating';
        migration.addEventListener('click', () => { void run('正在搬家', () => memoryManagement.migrateCurrent(), {
          resultCopy: (_state, _beforeState, result) => result?.status === 'completed'
            ? result.opened ? '搬家完成，新聊天已打开；原聊天保持不变。' : '搬家完成，新聊天已保存；可从当前角色的聊天列表打开。'
            : '搬家没有完成。',
        }); });
        deleteActions.append(migration);
      }
    }
    if (deletePending && managementState.error) pageNode.append(element('p', 'v3-foundation-feedback error', `上次删除未完成：${managementState.error} 已保留原聊天身份，可继续删除剩余记录。`));
    else if (managementState?.status === 'completed') pageNode.append(element('p', 'v3-foundation-feedback', '当前聊天记忆已清空；聊天正文、手动前情和全局设置仍保留。手动前情可在“前情”中清空。'));
    const previousCseError = (['paused', 'failed'].includes(state.cseRebuildStatus)
      ? errorMessage(state.cseRebuildError) || errorMessage(state.lastCseError)
      : '').replace(/[。；\s]+$/u, '');
    if (previousCseError) progress.append(element('span', 'settings-hint error', `上次人物状态分析失败：${previousCseError}；可继续人物状态重构。`));
    managementFeedbackNode = element('p');
    updateManagementFeedback(state);
    const statusRow = element('div', 'qqj-management-status-row');
    statusRow.append(managementFeedbackNode, ...renderManagementVectorIndex(state));
    pageNode.append(actions, progress, statusRow);
    const prequel = renderPrequelDetails(); if (prequel) pageNode.append(prequel);
    pageNode.append(renderRecallDetails(), renderDiagnostics(state));
    if (memoryManagement) pageNode.append(deleteActions);
    return pageNode;
  }

  function renderAdopted(state) {
    if (!container) return;
    if (page === 'people' && peopleMode === 'history' && cseHistoryUi?.update(state)) return;
    if (page !== 'people' || peopleMode !== 'history') cseHistoryUi = null;
    if (relationSwitcherNode) relationSwitcherScrollLeft = Number(relationSwitcherNode.scrollLeft) || 0;
    const previousSignature = relationSwitcherSignature, previousChatId = relationSwitcherChatId;
    relationSwitcherNode = null; vectorIndexLink = null; vectorIndexReadErrorNode = null;
    recentItemsUi = null;
    forgetMemoryRows(); renderedMemoryInputs = null; memoryWorkControls = [];
    operationMenus.reset();
    recallState = recallRuntime?.getState?.() ?? recallState; peopleState = peopleRuntime?.getState?.() ?? peopleState; managementState = memoryManagement?.getState?.() ?? managementState; healthNode = null; pageFeedbackNode = null; managementFeedbackNode = null;
    container.replaceChildren(page === 'memories' ? renderMemories(state) : page === 'people' ? renderPeople(state) : renderManagement(state));
    if (page === 'memories') { renderedMemoryInputs = captureMemoryInputs(state); updateMemoryFloorStatuses(state); }
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
    if (page === 'memories') {
      const state = syncingDisplayState(foundationState);
      updateHealth(state); updatePageFeedback(state); updateMemoryControls(state); updateMemoryFloorStatuses(state);
      for (const draft of drafts.values()) for (const control of draft.controls ?? []) control.disabled = draft.saving === true || workBusy(state);
      return;
    }
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
    const finishedSyncing = Boolean(syncingChatId && syncingChatId === (snapshot?.chatId ?? null));
    syncingChatId = null;
    const { state, mustReplace } = adoptFoundationState(snapshot);
    for (const draft of drafts.values()) for (const control of draft.controls ?? []) control.disabled = draft.saving === true || workBusy(state);
    if (page === 'memories' && recentItemDraft && !mustReplace) {
      const sameInputs = !finishedSyncing && sameMemoryInputs(renderedMemoryInputs, state);
      if (!sameInputs) renderedMemoryInputs = captureMemoryInputs(state);
      updateHealth(state); updatePageFeedback(state); updateMemoryControls(state); updateMemoryFloorStatuses(state);
      if (!sameInputs) { updateRecentItems(); if (recentItemsOpen) void timeRuntime?.refreshStatus?.(); }
      return;
    }
    if (page === 'people' && peopleMode === 'current' && cseDrafts.size && !mustReplace) {
      for (const draft of cseDrafts.values()) for (const control of draft.controls ?? []) control.disabled = draft.saving === true || workBusy(state);
      updateHealth(state); updatePageFeedback(state); return;
    }
    if (page === 'memories' && !mustReplace && !finishedSyncing && sameMemoryInputs(renderedMemoryInputs, state)) {
      updateHealth(state); updatePageFeedback(state); updateMemoryControls(syncingDisplayState(state)); updateMemoryFloorStatuses(state); return;
    }
    renderAdopted(state);
    readVectorIndexForReadyState(state);
  }
  function subscribe() {
    if (!active || !container || unsubscribe) return;
    const releases = [];
    if (typeof runtime.subscribe === 'function') { const release = runtime.subscribe(snapshot => { if (refreshFeedback !== null) { if (feedback !== refreshFeedback) refreshFeedback = null; else { feedback = refreshResult(snapshot); refreshFeedback = refreshSyncing(snapshot) || pluginActivity.busy ? feedback : null; } } if (snapshot?.status === 'ready' && feedback === statusCopy('stale')) feedback = '记忆状态已刷新。'; if (feedback === '正在读取当前聊天…' && snapshot?.memorySnapshotStatus !== 'syncing' && snapshot?.memorySyncStatus !== 'syncing') feedback = snapshot?.status === 'ready' ? '记忆状态已刷新。' : ''; if (active && container) receiveFoundation(snapshot); }); if (typeof release === 'function') releases.push(release); }
    if (typeof recallRuntime?.subscribe === 'function') { const release = recallRuntime.subscribe(snapshot => { recallState = snapshot; if (active && container && page === 'management') render(foundationState); }); if (typeof release === 'function') releases.push(release); }
    if (typeof peopleRuntime?.subscribe === 'function') { const release = peopleRuntime.subscribe(snapshot => { peopleState = snapshot; if (active && container && page === 'people') render(foundationState); }); if (typeof release === 'function') releases.push(release); }
    if (typeof timeRuntime?.subscribe === 'function') { const release = timeRuntime.subscribe(snapshot => { if (active && container) { updateHealth(foundationState, snapshot); updateRecentItems(snapshot); } }); if (typeof release === 'function') releases.push(release); }
    if (typeof memoryManagement?.subscribe === 'function') { const release = memoryManagement.subscribe(snapshot => { managementState = snapshot; if (active && container && page === 'management') render(foundationState); }); if (typeof release === 'function') releases.push(release); }
    if (typeof vectorRuntime?.subscribe === 'function') {
      let manualBuild = false;
      const release = vectorRuntime.subscribe(snapshot => {
        if (snapshot?.status === 'building' && snapshot.background !== true) { manualBuild = true; return; }
        if (!manualBuild) return;
        manualBuild = false;
        if (snapshot?.status === 'ready' && vectorReadArmed && page === 'management') void readVectorIndexForReadyState(foundationState, { refresh: true });
      });
      if (typeof release === 'function') releases.push(release);
    }
    unsubscribe = () => { for (const release of releases) { try { release(); } catch { /* listener cleanup isolation */ } } };
  }
  function stopSubscription() { const release = unsubscribe; unsubscribe = null; try { release?.(); } catch { /* runtime listener cleanup is isolated from view lifecycle */ } }
  function mount(target, { page: initialPage = page } = {}) {
    if (!['memories', 'people', 'management'].includes(initialPage)) throw new TypeError('V3 view page 无效');
    page = initialPage; stopSubscription(); operationMenus.deactivate(); cseHistoryUi = null; container = target; active = true;
    recallState = recallRuntime?.getState?.() ?? null; render(runtime.getState()); operationMenus.activate(); subscribe();
  }
  async function activate() {
    if (!container) throw new Error('V3 foundation view 尚未挂载');
    active = true; operationMenus.activate(); subscribe(); const mine = ++epoch; vectorReadArmed = page === 'management';
    if (vectorReadArmed) { vectorReadStarted = false; vectorReadPromise = Promise.resolve(); vectorIndexResult = null; updateManagementVectorIndex(foundationState); }
    feedback = '正在读取最新状态…'; receiptFeedback = ''; updateHealth(runtime.getState());
    const sessionState = readDiagnosticState(sessionStateProvider);
    if (sessionState?.status === 'idle' && typeof prepareSession === 'function') {
      let prepared;
      try { prepared = await prepareSession(); }
      catch (error) {
        if (!active || mine !== epoch) return { status: 'stale' };
        feedback = `聊天身份准备失败：${publicErrorMessage(error, { fallback: '请到“记忆管理”页点击“复制状态诊断”反馈。' })}`;
        const result = runtime.getState(); render(result); return { status: 'error', error };
      }
      if (!active || mine !== epoch) return { status: 'stale' };
      if (prepared?.status === 'idle') {
        feedback = '当前聊天尚未开始记录，继续对话后可开始记录';
        const result = runtime.getState(); render(result); return { status: 'uninitialized' };
      }
      if (prepared?.status && prepared.status !== 'ready') return prepared;
    }
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
    const result = runtime.getState(); feedback = peopleFeedback || (result?.status === 'ready' ? '记忆状态已刷新。' : statusCopy(result?.status)); receiveFoundation(result); await readVectorIndexForReadyState(foundationState); return result;
  }
  function deactivate() { refreshManagementProgress = null; active = false; vectorReadArmed = false; epoch += 1; operationMenus.deactivate(); stopSubscription(); forgetMemoryRows(); renderedMemoryInputs = null; healthNode = null; pageFeedbackNode = null; managementFeedbackNode = null; recentItemsUi = null; }
  function setPage(next) { if (!['memories', 'people', 'management'].includes(next)) throw new TypeError('V3 view page 无效'); if (page === next) return; page = next; if (page !== 'people' || peopleMode !== 'history') cseHistoryUi = null; if (active && container) render(foundationState); }
  return Object.freeze({ setActivity(value) { pluginActivity = value; if (refreshFeedback !== null && feedback === refreshFeedback) { feedback = refreshResult(foundationState); refreshFeedback = pluginActivity.busy || refreshSyncing(foundationState) ? feedback : null; } if (active && container) { updateHealth(foundationState); updatePageFeedback(foundationState); updateManagementFeedback(foundationState); if (page === 'management') refreshManagementProgress?.(); } }, mount, activate, deactivate, render, setPage, getPage: () => page });
}
