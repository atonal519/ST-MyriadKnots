import { createActivitySignal } from './plugin-activity.js';
import { withBaseProcessingPrompt } from './internal-processing-prompt.js';
import { getSharedProcessingPrompt, prependProcessingPrompt, resolveSharedProcessingPrompt } from './shared-processing-prompt.js';
import { sha256 } from './identity.js';
import { normalizeFinishReason, parseJsonWithSymbolRepair, repairJsonWithUniqueMissingObjectClose } from './json-symbol-repair.js';
import { normalizeRetryCount, parseAdditionalParams } from './settings.js';
import { stripMemoryTagBlocks } from './memory-content-sanitizer.js';

const PROTECTED_BODY_KEYS = new Set(['chat_completion_source', 'reverse_proxy', 'proxy_password', 'model', 'messages', 'json_schema']);
const REASONING_MODEL = /^(?:openai\/)?(?:gpt-[56]|o[134])(?:$|[.-])/iu;
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT = 180;
const HTTP_ERROR_BODY_LIMIT = 4096;
const PROVIDER_SENSITIVE_TEXT = /(?:\b(?:https?|wss?):\/\/|\bauthorization\b|\bbasic\b|\bbearer\b|\b(?:cookie|set-cookie)\b|\b(?:api[-_ ]?key|x-api-key|proxy_password)\b|\bsecret(?:[_-][a-z0-9]+)?\b|\bsk-[a-z0-9_-]{3,}\b)/i;

export function normalizeApiUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (/\/chat\/completions$/i.test(url)) return url.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(url)) return `${url}/v1`;
  return url;
}

function applyOutputTokenLimit(body, additional, maxTokens, excludedParams) {
  let field = 'max_tokens';
  if (Object.hasOwn(additional, 'max_completion_tokens')) field = 'max_completion_tokens';
  else if (!Object.hasOwn(additional, 'max_tokens') && REASONING_MODEL.test(String(body.model).trim())) field = 'max_completion_tokens';
  const otherField = field === 'max_completion_tokens' ? 'max_tokens' : 'max_completion_tokens';
  delete body[otherField];
  delete additional[otherField];
  if (!Object.hasOwn(additional, field) && !excludedParams.has(field)) body[field] = maxTokens;
}

const timeoutSeconds = value => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 5 && number <= 600 ? number : DEFAULT_TIMEOUT;
};
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
const FORMAT_STAGES = Object.freeze({
  'http-response-json': 'http_response_json',
  'stream-event-json': 'stream_event_json',
  'completion-json': 'completion_json',
  'output-truncated': 'output_truncated',
});
const truncatedFinishReason = value => ['length', 'max_tokens'].includes(normalizeFinishReason(value));
const safeError = (code, status = 0, details = {}) => {
  const messages = {
    config: 'API 配置不完整，请检查 URL 和 Key',
    timeout: 'API 请求超时，请检查网络或调高超时时间',
    auth: 'API 认证失败，请检查 Key 和模型权限',
    'not-found': 'API 404，请检查地址和模型名。',
    'rate-limit': 'API 请求过于频繁，请稍后再试',
    server: 'API 服务暂时异常，请稍后再试',
    network: '无法连接 API，请检查地址和网络',
    empty: '模型没有返回内容，请检查模型配置',
    format: '模型返回的 JSON 格式无效',
    models: '接口没有返回可用模型',
    unsupported: '当前响应格式不受支持',
    upstream: 'API 请求失败，上游返回了错误。',
    'request-format': 'API 请求参数或响应格式与当前网关不兼容',
    'http-response-json': 'API 响应不是合法 JSON',
    'stream-event-json': '流式响应事件不是合法 JSON',
    'stream-protocol': '接口声明为 SSE 流式响应，但正文不符合 SSE 协议',
    'completion-json': '模型输出中没有唯一完整 JSON 对象',
    'output-truncated': '模型输出疑似被截断',
    'transport-budget': '本次任务的网络尝试次数已用完，请稍后重试',
  };
  const error = new Error(messages[code] || 'API 请求失败');
  error.code = `QQJ_${String(code).toUpperCase().replace(/-/g, '_')}`;
  if (status) { error.status = status; error.httpStatus = status; }
  if (details.providerError && typeof details.providerError === 'object') error.providerError = Object.freeze({ ...details.providerError });
  if (code === 'format' || FORMAT_STAGES[code]) error.retryableRecognitionFormat = true;
  if (FORMAT_STAGES[code]) error.formatStage = FORMAT_STAGES[code];
  const finishReason = normalizeFinishReason(details.finishReason);
  if (finishReason) error.finishReason = finishReason;
  return error;
};

function mapHttpError(status, providerError = null) {
  const details = providerError ? { providerError } : {};
  if (status === 401 || status === 403) return safeError('auth', status, details);
  if (status === 404) return safeError('not-found', status, details);
  if (status === 429) return safeError('rate-limit', status, details);
  if (status >= 500) return safeError('server', status, details);
  if (status === 400 || status === 422) return safeError('request-format', status, details);
  return safeError('unsupported', status, details);
}

const safeProviderField = (value, maximum, secrets = []) => {
  if (!['string', 'number', 'boolean'].includes(typeof value) || !Number.isFinite(maximum) || maximum < 1) return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text) return null;
  if (PROVIDER_SENSITIVE_TEXT.test(text) || secrets.some(secret => secret && text.includes(String(secret)))) return '[REDACTED]';
  return text.slice(0, maximum);
};

const safeProviderIdentifier = (value, secrets = []) => {
  const text = safeProviderField(value, 120, secrets);
  if (!text || text === '[REDACTED]') return text;
  return /^[a-z0-9_.:-]+$/iu.test(text) ? text : '[REDACTED]';
};

const providerMessageTemplate = value => {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').toLowerCase();
  if (!text.trim()) return null;
  if (/json[_ -]?schema|response[_ -]?format|structured output|schema validation/u.test(text)) return '上游不接受当前 JSON 响应格式';
  if (/invalid (?:argument|request|parameter|field)|invalid_argument|unprocessable/u.test(text)) return '上游拒绝了请求参数';
  if (/context.{0,20}(?:length|limit|window)|token.{0,20}(?:limit|maximum)|request.{0,20}too long/u.test(text)) return '上游认为请求内容超过限制';
  if (/rate.?limit|too many requests/u.test(text)) return '上游请求频率受限';
  if (/unauthori[sz]ed|authorization|authentication|permission|forbidden|bearer|credential|api.?key/u.test(text)) return '上游认证或权限检查失败';
  if (/not found/u.test(text)) return '上游未找到请求的资源';
  if (/time.?out/u.test(text)) return '上游处理请求超时';
  return '上游错误详情已隐藏';
};

function providerErrorDetails(candidate, secrets = []) {
  const object = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : null;
  const fields = {
    code: safeProviderIdentifier(object?.code, secrets),
    status: safeProviderIdentifier(object?.status, secrets),
    message: providerMessageTemplate(object ? object.message : candidate),
  };
  const compact = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
  return Object.keys(compact).length ? Object.freeze(compact) : null;
}

function throwResponseError(data, secrets = []) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.hasOwn(data, 'error') || !data.error) return;
  const candidate = typeof data.error === 'object' && !Array.isArray(data.error) ? data.error : {};
  const providerError = providerErrorDetails(data.error, secrets);
  const status = [candidate.status, candidate.code, data.status].find(value => (typeof value === 'number' || typeof value === 'string') && /^[45]\d\d$/u.test(String(value)));
  if (status !== undefined) throw mapHttpError(Number(status), providerError);
  // 原生宿主可能只保留 statusText；分类不将其推断成真实 HTTP 状态。
  const identifiers = [candidate.code, candidate.status, candidate.type].filter(value => typeof value === 'string').map(value => value.trim().toLowerCase().replace(/[ -]/gu, '_'));
  const message = String(typeof data.error === 'string' ? data.error : candidate.message ?? '').trim();
  const matches = (identifier, text) => identifiers.some(value => identifier.test(value)) || text.test(message);
  const code = matches(/^(?:unauthorized|unauthenticated|forbidden|authentication_error|invalid_api_key|incorrect_api_key|permission_denied)$/u, /^(?:unauthori[sz]ed|forbidden)\b|(?:invalid|incorrect)\s+(?:api[ _-]*)?key\b|authentication (?:failed|error)\b/iu) ? 'auth'
    : matches(/^(?:rate_limit_exceeded|rate_limit_error|too_many_requests|resource_exhausted|insufficient_quota)$/u, /^too many requests\b|\brate[ _-]?limit(?:ed| exceeded)?\b/iu) ? 'rate-limit'
      : matches(/^(?:bad_request|invalid_argument|invalid_request_error|unprocessable_entity)$/u, /^bad request\b|\binvalid (?:argument|request|parameter|field)\b|\bjson[_ -]?schema\b|\bresponse[_ -]?format\b/iu) ? 'request-format'
        : matches(/^(?:not_found|model_not_found|resource_not_found)$/u, /^not found\b|\bmodel\b.{0,80}\bnot found\b/iu) ? 'not-found'
          : matches(/^(?:internal|internal_server_error|server_error|service_unavailable|overloaded_error)$/u, /^(?:internal server error|bad gateway|service unavailable|gateway timeout)\b/iu) ? 'server' : 'upstream';
  throw safeError(code, 0, providerError ? { providerError } : {});
}

async function readLimitedErrorText(response, maximum = HTTP_ERROR_BODY_LIMIT, signal) {
  // 错误正文只补充诊断，读取沿原请求取消；清理不等待宿主关闭连接。
  const reader = response?.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder(); let text = '', eof = false;
    try {
      while (text.length < maximum) {
        const { done, value } = await abortable(() => reader.read(), signal);
        if (done) { eof = true; text += decoder.decode(); break; }
        if (!value) continue;
        const remaining = maximum - text.length;
        const chunk = typeof value.subarray === 'function' ? value.subarray(0, remaining) : value;
        text += decoder.decode(chunk, { stream: true });
        if (text.length >= maximum || chunk.length < value.length) break;
      }
      return text.slice(0, maximum);
    } catch { return text.slice(0, maximum); }
    finally {
      if (!eof) try { Promise.resolve(reader.cancel?.()).catch(() => {}); } catch {}
      try { reader.releaseLock?.(); } catch { /* 宿主可能仍持有原生读取。 */ }
    }
  }
  if (typeof response?.text === 'function') {
    try { return String(await abortable(() => response.text(), signal)).slice(0, maximum); } catch {}
  }
  if (typeof response?.json === 'function') {
    try { return JSON.stringify(await abortable(() => response.json(), signal)).slice(0, maximum); } catch {}
  }
  return '';
}

async function readProviderError(response, secrets = [], signal) {
  const text = (await readLimitedErrorText(response, HTTP_ERROR_BODY_LIMIT, signal)).trim();
  if (!text) return null;
  let candidate = null;
  let malformedJson = false;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) candidate = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error) ? parsed.error : parsed;
  } catch { malformedJson = /^[{[]/u.test(text); }
  if (malformedJson) return Object.freeze({ message: '上游返回了无法安全解析的错误 JSON' });
  return providerErrorDetails(candidate ?? text, secrets);
}

function completionDetails(data) {
  const finishReason = normalizeFinishReason(data?.choices?.[0]?.finish_reason);
  if (truncatedFinishReason(finishReason)) throw safeError('output-truncated', 0, { finishReason });
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.content ?? '';
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text || ['none', '<none>'].includes(text.toLowerCase())) {
    const error = safeError('empty'); if (finishReason) error.finishReason = finishReason; throw error;
  }
  return { text, finishReason };
}

export function balancedObjects(text) {
  const candidates = []; let objectDepth = 0, arrayDepth = 0, start = -1, quoted = false, escaped = false, unclosed = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '[') { if (objectDepth === 0) arrayDepth += 1; continue; }
    if (char === ']') { if (objectDepth === 0 && arrayDepth > 0) arrayDepth -= 1; continue; }
    if (char === '{') {
      if (objectDepth === 0 && arrayDepth === 0) start = index;
      objectDepth += 1;
      continue;
    }
    if (char === '}' && objectDepth > 0) {
      objectDepth -= 1;
      if (objectDepth === 0 && start >= 0) { candidates.push(text.slice(start, index + 1)); start = -1; }
    }
  }
  if (objectDepth > 0 || quoted && start >= 0) unclosed = true;
  return { candidates, unclosed };
}

export { repairJsonWithUniqueMissingObjectClose } from './json-symbol-repair.js';

export function parseJsonOutput(value, { finishReason } = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const normalizedFinishReason = normalizeFinishReason(finishReason);
  if (truncatedFinishReason(normalizedFinishReason)) throw safeError('output-truncated', 0, { finishReason: normalizedFinishReason });
  let text = String(value ?? '').trim();
  const leadingThought = /^<(think|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/iu;
  for (let prefix; (prefix = text.match(leadingThought));) {
    text = (stripMemoryTagBlocks(prefix[0], [prefix[1]]) + text.slice(prefix[0].length)).trim();
  }
  const failCompletion = () => { throw safeError('completion-json', 0, { finishReason: normalizedFinishReason }); };
  const parseObject = (candidate, { repair = false } = {}) => {
    if (!repair) {
      try {
        const parsed = JSON.parse(candidate);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch { return null; }
    }
    const parsed = parseJsonWithSymbolRepair(candidate, { finishReason: normalizedFinishReason })?.value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return failCompletion();
    return parsed;
  } catch (error) { if (error?.code === 'QQJ_COMPLETION_JSON') throw error; }
  const direct = parseObject(text, { repair: true });
  if (direct) return direct;
  const fencePattern = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  const fences = [...text.matchAll(fencePattern)];
  const fenceMarkers = text.match(/```/g)?.length || 0;
  if (fenceMarkers % 2 === 1) throw safeError('output-truncated', 0, { finishReason: normalizedFinishReason });
  if (fences.length) {
    if (fences.length !== 1) return failCompletion();
    const outside = `${text.slice(0, fences[0].index)}${text.slice((fences[0].index || 0) + fences[0][0].length)}`;
    const outsideObjects = balancedObjects(outside);
    if (outsideObjects.unclosed) throw safeError('output-truncated', 0, { finishReason: normalizedFinishReason });
    if (outsideObjects.candidates.length) return failCompletion();
    const parsed = parseObject(fences[0][1].trim(), { repair: true });
    if (!parsed) return failCompletion();
    return parsed;
  }
  const balanced = balancedObjects(text);
  if (balanced.unclosed) {
    // Some compatible endpoints report `stop` after omitting one object-closing
    // brace in the final structural suffix. Accept only a unique, mechanically
    // provable one-brace insertion near the end; broader truncation still fails.
    const repaired = repairJsonWithUniqueMissingObjectClose(text, { finishReason: normalizedFinishReason });
    if (repaired) return repaired;
    throw safeError('output-truncated', 0, { finishReason: normalizedFinishReason });
  }
  if (balanced.candidates.length !== 1) return failCompletion();
  const parsed = parseObject(balanced.candidates[0]);
  if (!parsed) return failCompletion();
  return parsed;
}

function abortable(task, signal) {
  if (!signal) return Promise.resolve().then(task);
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(abortError()); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw abortError();
      return task();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function readSseResponse(response, { requireSse = false, signal, secrets = [] } = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    if (requireSse) throw safeError('stream-protocol');
    let data; try { data = await abortable(() => response.json(), signal); } catch (error) { if (signal?.aborted || error?.name === 'AbortError') throw abortError(); throw safeError('http-response-json'); }
    throwResponseError(data, secrets);
    return completionDetails(data);
  }
  const decoder = new TextDecoder(); let buffer = '', output = '', event = [], finishReason = '', sawDataLine = false, complete = false, eof = false;
  const flush = () => {
    if (!event.length) return;
    const payload = event.join('\n').trim(); event = [];
    if (!payload) return;
    if (payload === '[DONE]') { complete = true; return; }
    let value; try { value = JSON.parse(payload); } catch { throw safeError('stream-event-json'); }
    throwResponseError(value, secrets);
    const currentFinishReason = normalizeFinishReason(value?.choices?.[0]?.finish_reason);
    if (currentFinishReason) finishReason = currentFinishReason;
    const delta = value?.choices?.[0]?.delta?.content ?? value?.choices?.[0]?.message?.content ?? value?.choices?.[0]?.text;
    if (typeof delta === 'string') output += delta;
  };
  const line = value => {
    if (complete) return;
    const text = String(value).replace(/\r$/, '');
    if (!text) return flush();
    if (text.startsWith('data:')) { sawDataLine = true; event.push(text.slice(5).replace(/^\s/, '')); }
  };
  try {
    while (!complete) {
      const { done, value } = await abortable(() => reader.read(), signal);
      if (done) { eof = true; buffer += decoder.decode(); if (buffer) line(buffer); flush(); break; }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      lines.forEach(line);
    }
  } finally {
    // Host readers may ignore AbortSignal, and some proxies leave the socket open after [DONE].
    if (!eof) try { Promise.resolve(reader.cancel?.()).catch(() => {}); } catch {}
    try { reader.releaseLock?.(); } catch { /* a native read may still be pending */ }
  }
  if (requireSse && !sawDataLine) throw safeError('stream-protocol');
  if (truncatedFinishReason(finishReason)) throw safeError('output-truncated', 0, { finishReason });
  if (!output.trim()) { const error = safeError('empty'); if (finishReason) error.finishReason = finishReason; throw error; }
  return { text: output.trim(), finishReason };
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function linkedController(signal, timeoutSec, timeoutMs) {
  const controller = new AbortController(); let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
  const deadlineMs = timeoutMs(timeoutSeconds(timeoutSec));
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
  return { controller, timeoutMs: deadlineMs, timedOut: () => timedOut, cleanup: () => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); } };
}

function requestProgress(budget, phase, patch = {}) {
  const value = budget?.diagnostic;
  if (!value) return;
  if (value.phase !== phase) { value.phase = phase; value.phaseStartedAt = Date.now(); }
  Object.assign(value, patch);
}
function requestFailure(budget, error, cancelled = false) {
  const value = budget?.diagnostic;
  if (!value) return;
  const code = /^(?:QQJ|V3|CHAT_SESSION|QIANSHI)_[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : null;
  const name = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError'].includes(error?.name) ? error.name : null;
  const status = error?.httpStatus ?? error?.status;
  const failure = { code, name, httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, at: Date.now() };
  Object.assign(value, { outcome: cancelled ? 'cancelled' : 'failed', error: failure, endedAt: Date.now(), attemptEndedAt: Date.now() });
  if (!cancelled) value.lastAttemptError = { ...failure, attempt: budget.used, phase: value.phase };
}

export function createCompactApiClient({ fetchImpl, headers = () => ({}), retryWait = wait, timeoutMs = seconds => seconds * 1000, onBusyChange = () => {}, processingPrompt = () => getSharedProcessingPrompt((globalThis.SillyTavern ?? globalThis.Luker)?.getContext?.()?.extensionSettings) } = {}) {
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') throw new Error('fetch 不可用');
  let activeRequests = 0;
  const activity = createActivitySignal(() => ({ busy: activeRequests > 0, phase: activeRequests > 0 ? 'request' : null }));
  const changeBusy = delta => {
    const wasBusy = activeRequests > 0;
    activeRequests = Math.max(0, activeRequests + delta);
    const busy = activeRequests > 0;
    if (busy === wasBusy) return;
    activity.notifyActivity();
    try { onBusyChange(busy); } catch { /* UI 状态不能影响请求 */ }
  };
  const resolveFetch = () => {
    const current = fetchImpl === undefined ? globalThis.fetch : fetchImpl;
    if (typeof current !== 'function') throw new Error('fetch 不可用');
    return current;
  };
  const request = async ({ path, body, config, signal, stream = false, retries = null, transportBudget = null }) => {
    if (!config?.url || !config?.key) throw safeError('config');
    const retryCount = normalizeRetryCount(config.qqjRetryCount) ?? 2;
    retries = Math.min(retries ?? retryCount, retryCount);
    transportBudget ??= { remaining: retryCount + 1, used: 0 };
    changeBusy(1);
    try {
      let attempt = 0;
      const retryAvailable = () => !transportBudget || transportBudget.remaining > 0;
      for (;;) {
        if (signal?.aborted) throw abortError();
        if (transportBudget) {
          if (!Number.isSafeInteger(transportBudget.remaining) || !Number.isSafeInteger(transportBudget.used) || transportBudget.remaining < 1 || transportBudget.used < 0) {
            const error = safeError('transport-budget'); error.transportAttempts = Math.max(0, Number(transportBudget.used) || 0); throw error;
          }
          transportBudget.remaining -= 1;
          transportBudget.used += 1;
        }
        const linked = linkedController(signal, config.timeoutSec, timeoutMs);
        requestProgress(transportBudget, 'fetch', { attemptStartedAt: Date.now(), attemptEndedAt: null, timeoutMs: linked.timeoutMs, outcome: 'running', error: null, endedAt: null });
        try {
          const response = await abortable(() => resolveFetch()(path, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: linked.controller.signal }), linked.controller.signal);
          if (!response.ok) {
            if ((response.status === 429 || response.status >= 500) && attempt < retries && retryAvailable()) {
              requestFailure(transportBudget, mapHttpError(response.status));
              try { Promise.resolve(response.body?.cancel?.()).catch(() => {}); } catch {}
              attempt += 1; linked.cleanup(); await retryWait(Math.min(400 * 2 ** attempt, 2000), signal); continue;
            }
            requestProgress(transportBudget, 'responseBody');
            let providerError = null;
            try { providerError = await abortable(() => readProviderError(response, [config.key, config.url, normalizeApiUrl(config.url)], linked.controller.signal), linked.controller.signal); }
            catch { if (signal?.aborted) throw abortError(); }
            throw mapHttpError(response.status, providerError);
          }
          const secrets = [config.key, config.url, normalizeApiUrl(config.url)];
          if (stream) {
            const contentType = String(response.headers?.get?.('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
            // Streaming stays on SSE unless the server explicitly labels its response as JSON.
            if (contentType === 'application/json' || contentType.endsWith('+json')) {
              requestProgress(transportBudget, 'responseBody');
              let data; try { data = await abortable(() => response.json(), linked.controller.signal); } catch (error) { if (linked.controller.signal.aborted || error?.name === 'AbortError') throw abortError(); throw safeError('http-response-json'); }
              throwResponseError(data, secrets);
              return completionDetails(data);
            }
            requestProgress(transportBudget, 'sseBody');
            return await abortable(() => readSseResponse(response, { requireSse: contentType === 'text/event-stream', signal: linked.controller.signal, secrets }), linked.controller.signal);
          }
          requestProgress(transportBudget, 'responseBody');
          let data; try { data = await abortable(() => response.json(), linked.controller.signal); } catch (error) { if (linked.controller.signal.aborted || error?.name === 'AbortError') throw abortError(); throw safeError('http-response-json'); }
          throwResponseError(data, secrets);
          return data;
        } catch (error) {
          if (linked.timedOut() && !error?.httpStatus) error = safeError('timeout');
          if (signal?.aborted || error?.name === 'AbortError') { requestFailure(transportBudget, abortError(), true); throw abortError(); }
          requestFailure(transportBudget, error);
          if ((error instanceof TypeError || error?.code === 'QQJ_TIMEOUT' || error?.retryableRecognitionFormat === true) && attempt < retries && retryAvailable()) {
            attempt += 1; linked.cleanup(); await retryWait(Math.min(400 * 2 ** attempt, 2000), signal); continue;
          }
          if (error instanceof TypeError) throw safeError('network');
          if (error instanceof SyntaxError) throw safeError('http-response-json');
          throw error;
        } finally { linked.cleanup(); }
      }
    } finally {
      changeBusy(-1);
    }
  };
  const generateTask = async ({ config, taskMessages, jsonSchema, signal, maxTokens = 12000, temperature = 0.2, systemPrompt, transportBudget = null, parseMode = 'strict' } = {}) => {
    transportBudget ??= { remaining: 1 + (normalizeRetryCount(config?.qqjRetryCount) ?? 2), used: 0 };
    requestProgress(transportBudget, 'preparing', { outcome: 'running', error: null, endedAt: null, attemptStartedAt: null, attemptEndedAt: null, timeoutMs: null });
    const compactMessages = [
      { role: 'system', content: typeof systemPrompt === 'string' && systemPrompt.trim()
        ? systemPrompt.trim()
        : 'Process only the supplied task input. Return only JSON matching the requested schema.' },
      ...(Array.isArray(taskMessages) ? taskMessages : []).filter(message => ['system', 'user'].includes(message?.role) && typeof message.content === 'string').map(message => ({ role: message.role, content: message.content })),
    ];
    const prefix = resolveSharedProcessingPrompt(processingPrompt());
    compactMessages[0].content = prependProcessingPrompt(compactMessages[0].content, prefix);
    const processingPromptFingerprint = `sha256:${await sha256(prefix)}`;
    const systemPromptFingerprint = `sha256:${await sha256(compactMessages[0].content)}`;
    const configuredValue = config?.qqjTemperature;
    const configuredTemperature = configuredValue === null || configuredValue === undefined || typeof configuredValue === 'string' && configuredValue.trim() === ''
      ? null : typeof configuredValue === 'number' || typeof configuredValue === 'string' ? Number(configuredValue) : NaN;
    const hasConfiguredTemperature = Number.isFinite(configuredTemperature) && configuredTemperature >= 0 && configuredTemperature <= 2;
    const requestTemperature = hasConfiguredTemperature ? configuredTemperature : temperature;
    const body = {
      chat_completion_source: 'openai', reverse_proxy: normalizeApiUrl(config?.url), proxy_password: config?.key,
      model: config?.model || DEFAULT_MODEL, messages: compactMessages, stream: config?.stream === true,
      temperature: requestTemperature,
    };
    if (jsonSchema) body.json_schema = { name: jsonSchema.name || 'qianqianjie_task', value: jsonSchema.value || jsonSchema.schema, strict: jsonSchema.strict !== false };
    const additional = parseAdditionalParams(config?.qqjAdditionalParams);
    const excludedParams = new Set();
    for (const item of config?.excludeParams || []) {
      const key = String(item).trim();
      if (key && !PROTECTED_BODY_KEYS.has(key)) { excludedParams.add(key); delete body[key]; delete additional[key]; }
    }
    applyOutputTokenLimit(body, additional, maxTokens, excludedParams);
    if (REASONING_MODEL.test(String(body.model).trim()) && additional.reasoning_effort !== 'none'
      && !hasConfiguredTemperature && !Object.hasOwn(additional, 'temperature')) delete body.temperature;
    if (Object.keys(additional).length) {
      // OpenAI 宿主通道只转发白名单；自定义通道的 JSON/YAML 扩展才会真正传给上游。
      // 凭证明确覆盖宿主自定义 Key，任务材料与 schema 保持原样，空配置仍走原通道。
      body.chat_completion_source = 'custom';
      body.custom_url = normalizeApiUrl(config?.url);
      body.custom_include_headers = JSON.stringify({ Authorization: `Bearer ${config?.key}` });
      body.custom_include_body = JSON.stringify(additional);
      delete body.reverse_proxy; delete body.proxy_password;
    }
    for (;;) {
      try {
        const response = await request({ path: '/api/backends/chat-completions/generate', body, config, signal, stream: body.stream === true, transportBudget });
        const completion = body.stream === true && typeof response?.text === 'string' ? response : completionDetails(response);
        const payload = parseMode === 'semantic'
          ? { textData: completion.text }
          : { jsonData: parseJsonOutput(completion.text, { finishReason: completion.finishReason }) };
        return { ...payload, taskMetadata: { processingPromptFingerprint, systemPromptFingerprint, ...(completion.finishReason ? { finishReason: completion.finishReason } : {}), transportAttempts: transportBudget.used } };
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw abortError();
        if ((error?.code === 'QQJ_EMPTY' || error?.retryableRecognitionFormat === true) && transportBudget.remaining > 0) continue;
        if (error && (typeof error === 'object' || typeof error === 'function')) error.transportAttempts = transportBudget.used;
        throw error;
      }
    }
  };
  const testConnection = async ({ config, signal, processingPrompt = '' } = {}) => {
    await generateTask({ config, systemPrompt: withBaseProcessingPrompt('This is a plain-text connection check. Reply with a short confirmation.', processingPrompt), taskMessages: [{ role: 'user', content: 'Reply with OK.' }], signal, temperature: 0, parseMode: 'semantic' });
    return { ok: true, model: config?.model || DEFAULT_MODEL };
  };
  const fetchModels = async ({ config, signal } = {}) => {
    const body = { chat_completion_source: 'openai', reverse_proxy: normalizeApiUrl(config?.url), proxy_password: config?.key };
    const data = await request({ path: '/api/backends/chat-completions/status', body, config, signal, retries: 1 });
    const models = (Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [])
      .map(item => typeof item === 'string' ? item : item?.id).filter(Boolean).map(String).sort();
    if (!models.length) throw safeError('models');
    return [...new Set(models)];
  };
  return { generateTask, testConnection, fetchModels, getActivityState: activity.getActivityState, subscribeActivity: activity.subscribeActivity };
}

export { PROTECTED_BODY_KEYS };
