const PROTECTED_BODY_KEYS = new Set(['chat_completion_source', 'reverse_proxy', 'proxy_password', 'model', 'messages', 'json_schema']);
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
const normalizeFinishReason = value => {
  const reason = String(value ?? '').trim().toLowerCase();
  if (!reason) return '';
  return ['stop', 'length', 'max_tokens', 'content_filter', 'tool_calls', 'function_call'].includes(reason) ? reason : 'other';
};
const truncatedFinishReason = value => ['length', 'max_tokens'].includes(normalizeFinishReason(value));
const safeError = (code, status = 0, details = {}) => {
  const messages = {
    config: 'API 配置不完整，请检查 URL 和 Key',
    timeout: 'API 请求超时，请检查网络或调高超时时间',
    auth: 'API 认证失败，请检查 Key 和模型权限',
    'not-found': 'API 地址不存在，请检查 Base URL',
    'rate-limit': 'API 请求过于频繁，请稍后再试',
    server: 'API 服务暂时异常，请稍后再试',
    network: '无法连接 API，请检查地址和网络',
    empty: '模型没有返回内容，请检查模型配置',
    format: '模型返回的 JSON 格式无效',
    models: '接口没有返回可用模型',
    unsupported: '当前响应格式不受支持',
    'request-format': 'API 请求参数或响应格式与当前网关不兼容',
    'http-response-json': 'API 响应不是合法 JSON',
    'stream-event-json': '流式响应事件不是合法 JSON',
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

async function readLimitedErrorText(response, maximum = HTTP_ERROR_BODY_LIMIT) {
  const reader = response?.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder(); let text = '';
    try {
      while (text.length < maximum) {
        const { done, value } = await reader.read();
        if (done) { text += decoder.decode(); break; }
        if (!value) continue;
        const remaining = maximum - text.length;
        const chunk = typeof value.subarray === 'function' ? value.subarray(0, remaining) : value;
        text += decoder.decode(chunk, { stream: true });
        if (text.length >= maximum || chunk.length < value.length) { try { await reader.cancel?.(); } catch { /* best effort */ } break; }
      }
      return text.slice(0, maximum);
    } catch { return text.slice(0, maximum); }
  }
  if (typeof response?.text === 'function') {
    try { return String(await response.text()).slice(0, maximum); } catch { /* fall through */ }
  }
  if (typeof response?.json === 'function') {
    try { return JSON.stringify(await response.json()).slice(0, maximum); } catch { /* no safe body */ }
  }
  return '';
}

async function readProviderError(response, secrets = []) {
  const text = (await readLimitedErrorText(response)).trim();
  if (!text) return null;
  let candidate = null;
  let malformedJson = false;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) candidate = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error) ? parsed.error : parsed;
  } catch { malformedJson = /^[{[]/u.test(text); }
  if (malformedJson) return Object.freeze({ message: '上游返回了无法安全解析的错误 JSON' });
  const providerError = candidate ? {
    code: safeProviderIdentifier(candidate.code, secrets),
    status: safeProviderIdentifier(candidate.status, secrets),
    message: providerMessageTemplate(candidate.message),
  } : { code: null, status: null, message: providerMessageTemplate(text) };
  const compact = Object.fromEntries(Object.entries(providerError).filter(([, value]) => value !== null));
  return Object.keys(compact).length ? Object.freeze(compact) : null;
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

export function extractCompletion(data) { return completionDetails(data).text; }

function balancedObjects(text) {
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

export function parseJsonOutput(value, { finishReason } = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const normalizedFinishReason = normalizeFinishReason(finishReason);
  if (truncatedFinishReason(normalizedFinishReason)) throw safeError('output-truncated', 0, { finishReason: normalizedFinishReason });
  const text = String(value ?? '').trim();
  const failCompletion = () => { throw safeError('completion-json', 0, { finishReason: normalizedFinishReason }); };
  const parseObject = candidate => {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { return null; }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return failCompletion();
    return parsed;
  } catch (error) { if (error?.code === 'QQJ_COMPLETION_JSON') throw error; }
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
    const parsed = parseObject(fences[0][1].trim());
    if (!parsed) return failCompletion();
    return parsed;
  }
  const balanced = balancedObjects(text);
  if (balanced.unclosed) {
    // Some compatible endpoints report `stop` after omitting one object-closing
    // brace in the final structural suffix. Accept only a unique, mechanically
    // provable one-brace insertion near the end; broader truncation still fails.
    if (normalizedFinishReason === 'stop') {
      const repairs = [];
      for (let index = Math.max(0, text.length - 64); index <= text.length; index += 1) {
        if (index < text.length && !/[}\]]/u.test(text[index])) continue;
        const repaired = parseObject(`${text.slice(0, index)}}${text.slice(index)}`);
        if (repaired) repairs.push(repaired);
      }
      if (repairs.length === 1) return repairs[0];
    }
    throw safeError('output-truncated', 0, { finishReason: normalizedFinishReason });
  }
  if (balanced.candidates.length !== 1) return failCompletion();
  const parsed = parseObject(balanced.candidates[0]);
  if (!parsed) return failCompletion();
  return parsed;
}

async function readSseResponse(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    let data; try { data = await response.json(); } catch { throw safeError('http-response-json'); }
    return completionDetails(data);
  }
  const decoder = new TextDecoder(); let buffer = '', output = '', event = [], finishReason = '';
  const flush = () => {
    if (!event.length) return;
    const payload = event.join('\n').trim(); event = [];
    if (!payload || payload === '[DONE]') return;
    let value; try { value = JSON.parse(payload); } catch { throw safeError('stream-event-json'); }
    if (value?.error) throw safeError('unsupported');
    const currentFinishReason = normalizeFinishReason(value?.choices?.[0]?.finish_reason);
    if (currentFinishReason) finishReason = currentFinishReason;
    const delta = value?.choices?.[0]?.delta?.content ?? value?.choices?.[0]?.message?.content ?? value?.choices?.[0]?.text;
    if (typeof delta === 'string') output += delta;
  };
  const line = value => {
    const text = String(value).replace(/\r$/, '');
    if (!text) return flush();
    if (text.startsWith('data:')) event.push(text.slice(5).replace(/^\s/, ''));
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { buffer += decoder.decode(); if (buffer) line(buffer); flush(); break; }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop() || '';
    lines.forEach(line);
  }
  if (truncatedFinishReason(finishReason)) throw safeError('output-truncated', 0, { finishReason });
  if (!output.trim()) { const error = safeError('empty'); if (finishReason) error.finishReason = finishReason; throw error; }
  return { text: output.trim(), finishReason };
}

export async function readSseContent(response) { return (await readSseResponse(response)).text; }

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  });
}

function linkedController(signal, timeoutSec, timeoutMs) {
  const controller = new AbortController(); let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs(timeoutSeconds(timeoutSec)));
  return { controller, timedOut: () => timedOut, cleanup: () => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); } };
}

export function createCompactApiClient({ fetchImpl, headers = () => ({}), retryWait = wait, timeoutMs = seconds => seconds * 1000 } = {}) {
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') throw new Error('fetch 不可用');
  const resolveFetch = () => {
    const current = fetchImpl === undefined ? globalThis.fetch : fetchImpl;
    if (typeof current !== 'function') throw new Error('fetch 不可用');
    return current;
  };
  const request = async ({ path, body, config, signal, stream = false, retries = 2, transportBudget = null }) => {
    if (!config?.url || !config?.key) throw safeError('config');
    let attempt = 0;
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
      try {
        const response = await resolveFetch()(path, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: linked.controller.signal });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < retries) {
            attempt += 1; linked.cleanup(); await retryWait(Math.min(400 * 2 ** attempt, 2000), signal); continue;
          }
          throw mapHttpError(response.status, await readProviderError(response, [config.key, config.url, normalizeApiUrl(config.url)]));
        }
        if (stream) return readSseResponse(response);
        try { return await response.json(); } catch { throw safeError('http-response-json'); }
      } catch (error) {
        if (linked.timedOut()) throw safeError('timeout');
        if (signal?.aborted || error?.name === 'AbortError') throw abortError();
        if (error instanceof TypeError && attempt < retries) {
          attempt += 1; linked.cleanup(); await retryWait(Math.min(400 * 2 ** attempt, 2000), signal); continue;
        }
        if (error instanceof TypeError) throw safeError('network');
        if (error instanceof SyntaxError) throw safeError('http-response-json');
        throw error;
      } finally { linked.cleanup(); }
    }
  };
  const generateTask = async ({ config, taskMessages, jsonSchema, signal, maxTokens = 12000, temperature = 0.2, systemPrompt, transportBudget = null, parseMode = 'strict' } = {}) => {
    const compactMessages = [
      { role: 'system', content: typeof systemPrompt === 'string' && systemPrompt.trim()
        ? systemPrompt.trim()
        : 'You extract people only from the supplied frozen sources. Return only JSON matching the requested schema.' },
      ...(Array.isArray(taskMessages) ? taskMessages : []).filter(message => ['system', 'user'].includes(message?.role) && typeof message.content === 'string').map(message => ({ role: message.role, content: message.content })),
    ];
    const body = {
      chat_completion_source: 'openai', reverse_proxy: normalizeApiUrl(config?.url), proxy_password: config?.key,
      model: config?.model || DEFAULT_MODEL, messages: compactMessages, stream: config?.stream === true,
      temperature, max_tokens: maxTokens,
    };
    if (jsonSchema) body.json_schema = { name: jsonSchema.name || 'qianqianjie_people', value: jsonSchema.value || jsonSchema.schema, strict: jsonSchema.strict !== false };
    for (const item of config?.excludeParams || []) {
      const key = String(item).trim(); if (key && !PROTECTED_BODY_KEYS.has(key)) delete body[key];
    }
    let response;
    try {
      response = await request({ path: '/api/backends/chat-completions/generate', body, config, signal, stream: body.stream === true, transportBudget });
    } catch (error) {
      if (error && (typeof error === 'object' || typeof error === 'function') && transportBudget) error.transportAttempts = transportBudget.used;
      throw error;
    }
    const completion = body.stream === true ? response : completionDetails(response);
    const payload = parseMode === 'semantic'
      ? { textData: completion.text }
      : { jsonData: parseJsonOutput(completion.text, { finishReason: completion.finishReason }) };
    return { ...payload, taskMetadata: { ...(completion.finishReason ? { finishReason: completion.finishReason } : {}), ...(transportBudget ? { transportAttempts: transportBudget.used } : {}) } };
  };
  const testConnection = async ({ config, signal } = {}) => {
    const result = await generateTask({ config: { ...config, stream: false }, systemPrompt: 'This is a JSON text connection check. Return exactly one JSON object and no Markdown or extra text.', taskMessages: [{ role: 'user', content: 'Reply with exactly {"ok":true}.' }], signal, maxTokens: 48, temperature: 0 });
    if (result?.jsonData?.ok !== true) throw safeError('format');
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
  return { generateTask, testConnection, fetchModels };
}

export { PROTECTED_BODY_KEYS };
