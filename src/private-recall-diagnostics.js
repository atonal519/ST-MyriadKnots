import { REQUEST_CONNECTION_FIELDS, REQUEST_SIZE_FIELDS, requestProtocol } from './v3/recall-request-diagnostic.js';

export const PRIVATE_DIAGNOSTIC_POLICY = '/scripts/extensions/third-party/ST-QianQianJie/diagnostics.local.json';
export const PRIVATE_DIAGNOSTIC_COLLECTION = 'private-diagnostics';
const MAX_EVENTS = 32, SLOT_COUNT = 8;
const choose = (value, values) => values.includes(value) ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const requestCount = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(2, value) : null;
const httpStatus = value => Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;
const counts = (value, keys) => Object.fromEntries(keys.map(key => [key, number(value?.[key])]));
const code = value => typeof value === 'string' && /^(?:V3_|VECTOR_|BACKEND_|ROOT_|QQJ_)[A-Z0-9_]{1,100}$/u.test(value) ? value : null;
const networkCode = value => typeof value === 'string' && /^(?:UND_ERR_[A-Z0-9_]{1,56}|ERR_[A-Z0-9_]{2,56}|ECONN[A-Z0-9_]{2,56}|E(?:AI_AGAIN|ADDRNOTAVAIL|AFNOSUPPORT|HOSTUNREACH|NETUNREACH|PIPE|TIMEDOUT)|ENOTFOUND|ETIMEDOUT)$/u.test(value) ? value : null;
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/iu.test(value) ? value : null;
const phase = value => choose(value, ['input', 'source', 'selecting', 'commit', 'receipt']);
const generationType = value => choose(value, ['normal', 'regenerate', 'swipe', 'continue', 'quiet', 'impersonate']);
const stamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ? value : null;
const safeError = value => value ? { code: code(value.code), sourceStage: phase(value.sourceStage), httpStatus: number(value.httpStatus) } : null;
const stageKeys = ['input', 'candidates', 'selected', 'recentSummaryCount', 'distantHistoryItemCount', 'currentStateCount', 'cseChangeCount', 'storylineCount', 'timeReminderCount', 'timeCorrectionCount', 'budgetDroppedCount', 'finalInjectionItemCount', 'estimatedTokenCount', 'estimatedTokenBudget', 'linkedHistoryItemCount', 'linkedCseChangeCount'];
const timingKeys = ['inputMs', 'sourceMs', 'selectorMs', 'commitMs', 'receiptMs', 'totalMs'];
const preparationStages = ['identity', 'root', 'prepare', 'read', 'projection'];
function timingDiagnostic(value) {
  return { ...counts(value, timingKeys), ...(Array.isArray(value?.preparationAttempts) ? {
    preparationAttempts: value.preparationAttempts.slice(0, 2).map(item => ({ phase: choose(item?.phase, ['source', 'commit']),
      mode: choose(item?.mode, ['cached', 'fresh']), stage: choose(item?.stage, preparationStages), status: choose(item?.status, ['ready', 'timeout', 'stale', 'unavailable', 'disabled']),
      ...counts(item, ['totalMs', 'budgetMs', ...preparationStages.map(stage => `${stage}Ms`)]) })),
  } : {}) };
}
const selectorKeys = ['durationMs', 'utilityRoundTripMs', 'localSelectionMs', 'historyCandidateCount', 'stateCandidateCount', 'historyExcludedCount', 'stateExcludedCount', 'historyRetainedCount', 'stateRetainedCount', 'requestCharacters', 'requestEstimatedTokens'];
const selectorSteps = ['semanticQuery', 'candidateBuild', 'utilityTask', 'responseParse', 'localSelection'];
const activeSteps = ['input', 'source', 'identity', 'root', 'prepare', 'read', 'projection', 'timeProjection', 'bodyWitness', 'qianshiProgress', 'queryContext', 'prequelSelection', 'receiptValidation', 'receiptSourceVerification', ...selectorSteps,
  'qianshiSeal', 'commitVerification', 'deletionWitness', 'receiptSeal', 'receiptSaveCall', 'receiptSaveWait', 'receiptSaveReturned', 'receiptSaveFailed', 'complete'];
const querySteps = ['configIdentity', 'indexLoad', 'eligibility', 'queryCache', 'queryRequest', 'scoring', 'witnessVerification', 'complete'];
const queryStatuses = ['running', 'complete', 'ready', 'cached', 'timeout', 'cancelled', 'changed', 'disabled', 'busy', 'unavailable', 'unindexed', 'dimensionMismatch', 'error', 'VECTOR_TIMEOUT', 'VECTOR_QUERY_BUDGET_EXHAUSTED'];
const requestPhases = ['request', 'response', 'validation', 'complete', 'request_prepared', 'fetch_call_start', 'fetch_called', 'response_headers', 'response_body', 'aborted'];
const hashFingerprint = value => typeof value === 'string' && (/^sha256:[a-f0-9]{64}$/u.test(value) || /^[a-f0-9]{64}$/u.test(value)) ? (value.startsWith('sha256:') ? value : `sha256:${value}`) : null;
function vectorRequest(value) {
  if (!value || typeof value !== 'object') return null;
  const providerId = typeof value.providerRequestId === 'string' && (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value.providerRequestId)
    || /^[a-f0-9]{16,64}$/iu.test(value.providerRequestId)) ? value.providerRequestId : null;
  return { requestId: typeof value.requestId === 'string' && /^[a-z0-9-]{1,80}$/iu.test(value.requestId) ? value.requestId : null,
    phase: choose(value.phase, requestPhases), pendingStage: choose(value.pendingStage, ['request_prepared', 'fetch_call_start', 'fetch_called', 'response_headers', 'response_body', 'complete', 'aborted']),
    startedAt: stamp(value.startedAt), inputCharacters: number(value.inputCharacters), inputSha256: hashFingerprint(value.inputSha256),
    deadlineMs: number(value.deadlineMs ?? value.timeoutMs), timeoutMs: number(value.timeoutMs ?? value.deadlineMs), elapsedMs: number(value.elapsedMs ?? value.durationMs),
    durationMs: number(value.durationMs ?? value.elapsedMs), deadlineOverrunMs: number(value.deadlineOverrunMs),
    lastSuccessfulStage: choose(value.lastSuccessfulStage, ['request_prepared', 'fetch_called', 'response_headers', 'response_body', 'validated']),
    timeoutOrigin: choose(value.timeoutOrigin, ['vector_api_deadline']), abortOrigin: choose(value.abortOrigin, ['caller_signal', 'client_abort_all', 'vector_api_deadline']),
    abortReason: choose(value.abortReason, ['stopped', 'superseded', 'chatChanged', 'userChanged', 'narrativeChanged', 'disabled', 'invalidated', 'timeout', 'indexReset', 'external']),
    result: choose(value.result, ['running', 'succeeded', 'timeout', 'failed', 'cancelled']), errorCode: code(value.errorCode),
    networkCode: networkCode(value.networkCode), httpStatus: httpStatus(value.httpStatus), providerRequestId: providerId,
    fetchCallMs: number(value.fetchCallMs), responseHeadersMs: number(value.responseHeadersMs), responseBodyMs: number(value.responseBodyMs) };
}
function queryDiagnostic(value) {
  if (!value) return null;
  const request = vectorRequest(value.request);
  const requestAttempts = Array.isArray(value.requestAttempts) ? value.requestAttempts.slice(0, 2).map(vectorRequest).filter(Boolean) : null;
  const safeRequestCount = requestCount(value.requestCount);
  return { queryId: typeof value.queryId === 'string' && /^[a-z0-9-]{1,80}$/iu.test(value.queryId) ? value.queryId : null,
    chatId: uuid(value.chatId), status: choose(value.status, queryStatuses), pendingStep: choose(value.pendingStep ?? value.currentStep, querySteps),
    lastCompletedStep: choose(value.lastCompletedStep, querySteps), timings: counts(value.timings, querySteps.map(step => `${step}Ms`)), request,
    ...(requestAttempts?.length ? { requestAttempts, requestCount: safeRequestCount,
      retryOutcome: choose(value.retryOutcome, ['not_retried', 'retrying', 'retry_succeeded', 'retry_failed', 'cancelled', 'budget_exhausted']) } : {}),
    cached: value.cached === true, totalIndexRows: number(value.totalIndexRows), eligibleRows: number(value.eligibleRows), candidateCount: number(value.candidateCount),
    timeoutOrigin: choose(value.timeoutOrigin, ['index_load', 'api']), errorCode: code(value.errorCode), elapsedMs: number(value.elapsedMs),
    abortOrigin: choose(value.abortOrigin, ['client_abort_all']), abortReason: choose(value.abortReason, ['indexReset']),
    load: value.load ? { pending: choose(value.load.pending, ['manifest', 'shard']), shardsRead: number(value.load.shardsRead), shardCount: number(value.load.shardCount),
      exitReason: choose(value.load.exitReason, ['missing', 'invalid', 'ownerMismatch', 'readFailed', 'ready']), backendCode: code(value.load.backendCode),
      httpStatus: httpStatus(value.load.httpStatus) } : null };
}
function receiptSaveDiagnostic(value) {
  if (!value) return null;
  return { status: choose(value.status, ['running', 'returned', 'failed']), step: choose(value.step, ['receiptSaveCall', 'receiptSaveWait', 'receiptSaveReturned', 'receiptSaveFailed']),
    elapsedMs: number(value.elapsedMs), backendCode: code(value.backendCode ?? value.errorCode), networkCode: networkCode(value.networkCode ?? value.errorCode), httpStatus: httpStatus(value.httpStatus) };
}
function safeActive(value) {
  if (!value) return null;
  const progress = value.selectorProgress;
  return { token: number(value.token), phase: phase(value.phase), step: choose(value.pendingStep ?? value.step, activeSteps),
    lastCompletedStep: choose(value.lastCompletedStep, activeSteps), pendingStepMs: number(value.pendingStepMs), generationType: generationType(value.generationType), userMessageIndex: number(value.userMessageIndex),
    timings: timingDiagnostic(value.timings),
    currentPreparation: value.currentPreparation ? { phase: choose(value.currentPreparation.phase, ['source', 'commit']), mode: choose(value.currentPreparation.mode, ['cached', 'fresh']),
      stage: choose(value.currentPreparation.stage, preparationStages), status: choose(value.currentPreparation.status, ['ready', 'timeout', 'stale', 'unavailable', 'disabled']),
      ...counts(value.currentPreparation, ['totalMs', 'budgetMs', ...preparationStages.map(stage => `${stage}Ms`)]) } : null,
    selectorProgress: progress ? { pendingStep: choose(progress.pendingStep, selectorSteps), lastCompletedStep: choose(progress.lastCompletedStep, selectorSteps),
      stageTimings: counts(progress.stageTimings, selectorSteps) } : null };
}
function safeTerminated(value) {
  if (!value) return null;
  return { status: choose(value.status, ['terminated']), chatId: uuid(value.chatId), reason: choose(value.reason, ['stopped', 'superseded', 'chatChanged', 'userChanged', 'narrativeChanged', 'disabled', 'invalidated', 'selectedRefsChanged']),
    sourceEvent: choose(value.sourceEvent, ['GENERATION_STOPPED', 'GENERATION_ENDED', 'interceptorSuperseded', 'CHAT_CHANGED', 'CHAT_RENAMED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'runtimeDisabled', 'runtimeInvalidate', 'finalSafetyGuard']),
    terminatedAt: stamp(value.terminatedAt), phase: phase(value.phase), pendingStep: choose(value.pendingStep, activeSteps), lastCompletedStep: choose(value.lastCompletedStep, activeSteps),
    generationType: generationType(value.generationType), userMessageIndex: number(value.userMessageIndex), timings: timingDiagnostic(value.timings),
    attempts: (Array.isArray(value.attempts) ? value.attempts : []).slice(-2).map(attempt => ({ attempt: number(attempt.attempt), phase: phase(attempt.phase),
      selectionStatus: choose(attempt.selectionStatus, ['notStarted', 'incomplete', 'receiptCandidate', 'reused', 'completed']),
      pendingStep: choose(attempt.pendingStep, activeSteps), lastCompletedStep: choose(attempt.lastCompletedStep, activeSteps),
      timings: timingDiagnostic(attempt.timings), stages: counts(attempt.stages, stageKeys), selector: selector(attempt.selectorDiagnostic), error: safeError(attempt.error) })) };
}
const reasons = ['chatChanged', 'userChanged', 'narrativeChanged', 'selectedRefsChanged', 'sourceStale', 'sourceUnavailable', 'stopped', 'superseded', 'disabled', 'error', 'memoryNotReady', 'memoryPreparationTimeout', 'memoryPreparationFailed', 'emptyUserInput', 'unsupportedGenerationType', 'quiet', 'impersonate'];
function selector(value) {
  if (!value) return null;
  const semantic = value.semantic, request = semantic?.request;
  const requestAttempts = Array.isArray(semantic?.requestAttempts) ? semantic.requestAttempts.slice(0, 2).map(vectorRequest).filter(Boolean) : null;
  const safeSemanticRequestCount = requestCount(semantic?.requestCount);
  return { mode: choose(value.mode, ['llm', 'fallback', 'local']), code: code(value.code), ...counts(value, selectorKeys),
    pendingStep: choose(value.pendingStep, selectorSteps), lastCompletedStep: choose(value.lastCompletedStep, selectorSteps), stageTimings: counts(value.stageTimings, selectorSteps),
    semantic: semantic ? { status: code(semantic.status) ?? choose(semantic.status, ['ready', 'cached', 'disabled', 'busy', 'unindexed', 'changed', 'dimensionMismatch', 'unavailable']),
      ...counts(semantic, ['candidateCount', 'durationMs']),
      request: vectorRequest(request),
      ...(requestAttempts?.length ? { requestAttempts, requestCount: safeSemanticRequestCount,
        retryOutcome: choose(semantic.retryOutcome, ['not_retried', 'retrying', 'retry_succeeded', 'retry_failed', 'cancelled', 'budget_exhausted']) } : {}) } : null };
}

// 临时失败不能依赖聊天回执落盘；独立诊断只投影白名单，绝不复制材料、异常消息或配置对象。
export function projectPrivateRecallDiagnostic(state, vectorState, { visibilityState } = {}) {
  const active = state?.activeRecall, last = state?.lastRecall, request = state?.requestDiagnostic;
  return { status: choose(state?.recallStatus, ['running', 'ready', 'empty', 'skipped', 'stale', 'error', 'idle']), pageVisibility: choose(visibilityState, ['visible', 'hidden', 'prerender']),
    chatId: uuid(active?.chatId ?? state?.lastRecallBinding?.chatId),
    active: active ? { ...safeActive(active), chatId: uuid(active.chatId) } : null,
    lastTerminated: safeTerminated(state?.lastTerminated),
    last: last ? { status: choose(last.status, ['ready', 'empty', 'skipped', 'stale', 'error']), createdAt: stamp(last.createdAt),
      userMessageIndex: number(last.userMessageIndex), generationType: generationType(last.generationType), diagnosticPhase: phase(last.diagnosticPhase), diagnosticAttempt: number(last.diagnosticAttempt),
      receiptPersistence: choose(last.receiptPersistence, ['none', 'saving', 'saveUnconfirmed', 'sessionOnly', 'chatRecord', 'legacyReadOnly']),
      injected: typeof last.injectionText === 'string' && last.injectionText.length > 0,
      selected: { floors: Array.isArray(last.selectedFloors) ? last.selectedFloors.length : 0, states: Array.isArray(last.selectedStates) ? last.selectedStates.length : 0, changes: Array.isArray(last.selectedCseChanges) ? last.selectedCseChanges.length : 0,
        raw: (Array.isArray(last.selectedFloors) ? last.selectedFloors : []).reduce((sum, floor) => sum + (Array.isArray(floor.rawWitnesses) ? floor.rawWitnesses.length : 0), 0) },
      coverage: counts(last.coverage, ['stableAiFloors', 'stableThroughAssistantSeq', 'rememberedAiFloors', 'cseThroughAssistantSeq']),
      sourceRead: { reachableReads: number(last.timings?.sourceReadAttempts?.reachableReads), exitPoint: choose(last.timings?.sourceReadAttempts?.exitPoint, ['ready', 'validatedSnapshot', 'memoryPreparationFailed', 'memoryPreparationTimeout', 'memoryPreparation', 'stale', 'unavailable']) },
      pendingStep: choose(last.pendingStep, activeSteps), lastCompletedStep: choose(last.lastCompletedStep, activeSteps),
      receiptSaveDiagnostic: receiptSaveDiagnostic(last.receiptSaveDiagnostic),
      stages: counts(last.stages, stageKeys), timings: timingDiagnostic(last.timings), selector: selector(last.selectorDiagnostic),
      skipReasons: (Array.isArray(last.skipReasons) ? last.skipReasons : []).filter(value => reasons.includes(value)).slice(0, 16), error: safeError(last.error),
      attempts: (Array.isArray(last.attemptDiagnostics) ? last.attemptDiagnostics : []).slice(-2).map(value => ({ attempt: number(value.attempt), phase: phase(value.phase),
        pendingStep: choose(value.pendingStep, activeSteps), lastCompletedStep: choose(value.lastCompletedStep, activeSteps),
        timings: timingDiagnostic(value.timings), stages: counts(value.stages, stageKeys), selector: selector(value.selectorDiagnostic), error: safeError(value.error) })) } : null,
    receiptSaveDiagnostic: receiptSaveDiagnostic(state?.receiptSaveDiagnostic),
    vector: { status: choose(vectorState?.status, ['idle', 'building', 'ready', 'error']), active: vectorState?.active === true,
      ...counts(vectorState, ['completed', 'total']), query: queryDiagnostic(vectorState?.query) },
    requests: { status: choose(request?.status, ['recording', 'complete', 'unsupported', 'unavailable']), id: number(request?.id), ...counts(request, ['startedAt', 'finishedAt', 'droppedCount']),
      entries: (Array.isArray(request?.requests) ? request.requests : []).slice(-64).filter(value => ['追加聊天', '更新聊天', '保存聊天', '保存聊天设定', '分词', '批量分词', '生成请求'].includes(value.label))
        .map(value => ({ label: value.label, protocol: requestProtocol(value.protocol), httpStatus: httpStatus(value.responseStatus),
          ...counts(value, ['startedAt', 'requestStartedAt', 'responseStartedAt', 'finishedAt', ...Object.values(REQUEST_CONNECTION_FIELDS), ...REQUEST_SIZE_FIELDS]) })) } };
}

export function createPrivateRecallDiagnostics({ client, recallRuntime, vectorRuntime, fetchImpl = globalThis.fetch, documentRef = globalThis.document, isEnabled = () => true, policyUrl = PRIVATE_DIAGNOSTIC_POLICY,
  bundleUrl = import.meta.url, random = Math.random, now = Date.now, pollMs = 5000, flushMs = 1000 } = {}) {
  let enabled = false, disposed = false, starting = null, revision = null, sequence = 0, sent = 0, previous = null, pending = null, timer = null, poll = null;
  const events = [], cleanups = [];
  const recordId = `recall-live-${Math.min(SLOT_COUNT - 1, Math.max(0, Math.floor(random() * SLOT_COUNT)))}`;
  let bundleVersion = null;
  try { const value = new URL(bundleUrl).searchParams.get('v'); if (/^[a-z0-9._-]{1,100}$/iu.test(value ?? '')) bundleVersion = value; } catch { /* 本地测试没有浏览器包地址。 */ }
  const schedule = () => { if (!disposed && !timer && !pending && sent < sequence) timer = setTimeout(() => { timer = null; void flush(); }, flushMs); };
  const capture = () => {
    if (!enabled || disposed || !isEnabled()) return;
    const data = projectPrivateRecallDiagnostic(recallRuntime.getState(), vectorRuntime?.getState?.(), { visibilityState: documentRef?.visibilityState });
    const signature = JSON.stringify(data);
    if (signature === previous) return;
    previous = signature;
    events.push({ sequence: ++sequence, capturedAt: new Date(now()).toISOString(), data });
    if (events.length > MAX_EVENTS) events.shift();
    schedule();
  };
  // 固定八个槽避免刷新无限增档；CAS 只约束诊断自身，失败不重试模型、不阻塞或改变召回。
  function flush() {
    if (!enabled || disposed || !isEnabled() || sent === sequence) return Promise.resolve(false);
    if (pending) return pending;
    const target = sequence;
    const data = { schemaVersion: 1, kind: 'qqj-private-recall-diagnostic', bundleVersion, updatedAt: new Date(now()).toISOString(), events: structuredClone(events) };
    pending = (async () => {
      try {
        if (revision === null) {
          try { revision = (await client.get(PRIVATE_DIAGNOSTIC_COLLECTION, recordId)).revision; }
          catch (error) { if (error?.status !== 404) throw error; revision = 0; }
        }
        if (disposed || !isEnabled()) return false;
        const saved = await client.put(PRIVATE_DIAGNOSTIC_COLLECTION, recordId, data, revision);
        revision = saved.revision; sent = target;
        return true;
      } catch { revision = null; return false; }
      finally { pending = null; if (sequence > target) schedule(); }
    })();
    return pending;
  }
  function start() {
    if (disposed || !isEnabled()) return Promise.resolve(false);
    if (starting) return starting;
    starting = (async () => {
      if (disposed || !isEnabled()) return false;
      const controller = new AbortController(), policyTimer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetchImpl(policyUrl, { cache: 'no-store', signal: controller.signal });
        if (!response.ok || (await response.json())?.enabled !== true || disposed) return false;
        enabled = true;
        cleanups.push(recallRuntime.subscribe(capture));
        if (vectorRuntime?.subscribe) cleanups.push(vectorRuntime.subscribe(capture));
        // 手机切到后台可能暂停计时与网络；只记状态切换，不读取页面内容或设备信息。
        if (documentRef?.addEventListener) {
          documentRef.addEventListener('visibilitychange', capture);
          cleanups.push(() => documentRef.removeEventListener('visibilitychange', capture));
        }
        poll = setInterval(capture, pollMs);
        capture();
        return true;
      } catch { return false; }
      finally { clearTimeout(policyTimer); }
    })();
    return starting;
  }
  function dispose() {
    disposed = true; clearTimeout(timer); clearInterval(poll);
    for (const cleanup of cleanups.splice(0)) cleanup();
  }
  return Object.freeze({ start, capture, flush, dispose });
}
