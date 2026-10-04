import { REQUEST_CONNECTION_FIELDS, REQUEST_SIZE_FIELDS, requestProtocol } from './v3/recall-request-diagnostic.js';

export const PRIVATE_DIAGNOSTIC_POLICY = '/scripts/extensions/third-party/ST-QianQianJie/diagnostics.local.json';
export const PRIVATE_DIAGNOSTIC_COLLECTION = 'private-diagnostics';
const MAX_EVENTS = 32, SLOT_COUNT = 8;
const choose = (value, values) => values.includes(value) ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const counts = (value, keys) => Object.fromEntries(keys.map(key => [key, number(value?.[key])]));
const code = value => typeof value === 'string' && /^(?:V3_|BACKEND_|ROOT_|QQJ_)[A-Z0-9_]{1,100}$/u.test(value) ? value : null;
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
const reasons = ['chatChanged', 'userChanged', 'narrativeChanged', 'selectedRefsChanged', 'sourceStale', 'sourceUnavailable', 'stopped', 'superseded', 'disabled', 'error', 'memoryNotReady', 'memoryPreparationTimeout', 'memoryPreparationFailed', 'emptyUserInput', 'unsupportedGenerationType', 'quiet', 'impersonate'];
function selector(value) {
  return value ? { mode: choose(value.mode, ['llm', 'fallback', 'local']), code: code(value.code), ...counts(value, selectorKeys) } : null;
}

// 临时失败不能依赖聊天回执落盘；独立诊断只投影白名单，绝不复制材料、异常消息或配置对象。
export function projectPrivateRecallDiagnostic(state, { visibilityState } = {}) {
  const active = state?.activeRecall, last = state?.lastRecall, request = state?.requestDiagnostic;
  return { status: choose(state?.recallStatus, ['running', 'ready', 'empty', 'skipped', 'stale', 'error', 'idle']), pageVisibility: choose(visibilityState, ['visible', 'hidden', 'prerender']),
    chatId: uuid(active?.chatId ?? state?.lastRecallBinding?.chatId),
    active: active ? { token: number(active.token), phase: phase(active.phase), generationType: generationType(active.generationType), userMessageIndex: number(active.userMessageIndex) } : null,
    last: last ? { status: choose(last.status, ['ready', 'empty', 'skipped', 'stale', 'error']), createdAt: stamp(last.createdAt),
      userMessageIndex: number(last.userMessageIndex), generationType: generationType(last.generationType), diagnosticPhase: phase(last.diagnosticPhase), diagnosticAttempt: number(last.diagnosticAttempt),
      receiptPersistence: choose(last.receiptPersistence, ['none', 'saving', 'saveUnconfirmed', 'sessionOnly', 'chatRecord', 'legacyReadOnly']),
      injected: typeof last.injectionText === 'string' && last.injectionText.length > 0,
      selected: { floors: Array.isArray(last.selectedFloors) ? last.selectedFloors.length : 0, states: Array.isArray(last.selectedStates) ? last.selectedStates.length : 0, changes: Array.isArray(last.selectedCseChanges) ? last.selectedCseChanges.length : 0 },
      coverage: counts(last.coverage, ['stableAiFloors', 'stableThroughAssistantSeq', 'rememberedAiFloors', 'cseThroughAssistantSeq']),
      sourceRead: { reachableReads: number(last.timings?.sourceReadAttempts?.reachableReads), exitPoint: choose(last.timings?.sourceReadAttempts?.exitPoint, ['ready', 'validatedSnapshot', 'memoryPreparationFailed', 'memoryPreparationTimeout', 'memoryPreparation', 'stale', 'unavailable']) },
      stages: counts(last.stages, stageKeys), timings: timingDiagnostic(last.timings), selector: selector(last.selectorDiagnostic),
      skipReasons: (Array.isArray(last.skipReasons) ? last.skipReasons : []).filter(value => reasons.includes(value)).slice(0, 16), error: safeError(last.error),
      attempts: (Array.isArray(last.attemptDiagnostics) ? last.attemptDiagnostics : []).slice(-2).map(value => ({ attempt: number(value.attempt), phase: phase(value.phase),
        timings: timingDiagnostic(value.timings), stages: counts(value.stages, stageKeys), selector: selector(value.selectorDiagnostic), error: safeError(value.error) })) } : null,
    requests: { status: choose(request?.status, ['recording', 'complete', 'unsupported', 'unavailable']), id: number(request?.id), ...counts(request, ['startedAt', 'finishedAt', 'droppedCount']),
      entries: (Array.isArray(request?.requests) ? request.requests : []).slice(-64).filter(value => ['追加聊天', '更新聊天', '保存聊天', '保存聊天设定', '分词', '批量分词', '生成请求'].includes(value.label))
        .map(value => ({ label: value.label, protocol: requestProtocol(value.protocol),
          ...counts(value, ['startedAt', 'requestStartedAt', 'responseStartedAt', 'finishedAt', ...Object.values(REQUEST_CONNECTION_FIELDS), ...REQUEST_SIZE_FIELDS]) })) } };
}

export function createPrivateRecallDiagnostics({ client, recallRuntime, fetchImpl = globalThis.fetch, documentRef = globalThis.document, isEnabled = () => true, policyUrl = PRIVATE_DIAGNOSTIC_POLICY,
  bundleUrl = import.meta.url, random = Math.random, now = Date.now, pollMs = 5000, flushMs = 1000 } = {}) {
  let enabled = false, disposed = false, starting = null, revision = null, sequence = 0, sent = 0, previous = null, pending = null, timer = null, poll = null;
  const events = [], cleanups = [];
  const recordId = `recall-live-${Math.min(SLOT_COUNT - 1, Math.max(0, Math.floor(random() * SLOT_COUNT)))}`;
  let bundleVersion = null;
  try { const value = new URL(bundleUrl).searchParams.get('v'); if (/^[a-z0-9._-]{1,100}$/iu.test(value ?? '')) bundleVersion = value; } catch { /* 本地测试没有浏览器包地址。 */ }
  const schedule = () => { if (!disposed && !timer && !pending && sent < sequence) timer = setTimeout(() => { timer = null; void flush(); }, flushMs); };
  const capture = () => {
    if (!enabled || disposed || !isEnabled()) return;
    const data = projectPrivateRecallDiagnostic(recallRuntime.getState(), { visibilityState: documentRef?.visibilityState });
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
