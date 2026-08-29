const PROTECTED_BODY_KEYS = new Set(['chat_completion_source', 'reverse_proxy', 'proxy_password', 'model', 'messages']);
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT = 180;

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
const safeError = (code, status = 0) => {
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
  };
  const error = new Error(messages[code] || 'API 请求失败');
  error.code = `QQJ_${String(code).toUpperCase().replace(/-/g, '_')}`;
  if (status) error.status = status;
  if (code === 'format') error.retryableRecognitionFormat = true;
  return error;
};

function mapHttpError(status) {
  if (status === 401 || status === 403) return safeError('auth', status);
  if (status === 404) return safeError('not-found', status);
  if (status === 429) return safeError('rate-limit', status);
  if (status >= 500) return safeError('server', status);
  return safeError('unsupported', status);
}

export function extractCompletion(data) {
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.content ?? '';
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text || ['none', '<none>'].includes(text.toLowerCase())) throw safeError('empty');
  return text;
}

export function parseJsonOutput(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  let text = String(value ?? '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed;
  } catch { throw safeError('format'); }
}

export async function readSseContent(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return extractCompletion(await response.json());
  const decoder = new TextDecoder(); let buffer = '', output = '', event = [];
  const flush = () => {
    if (!event.length) return;
    const payload = event.join('\n').trim(); event = [];
    if (!payload || payload === '[DONE]') return;
    let value; try { value = JSON.parse(payload); } catch { throw safeError('format'); }
    if (value?.error) throw safeError('unsupported');
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
  if (!output.trim()) throw safeError('empty');
  return output.trim();
}

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

export function createCompactApiClient({ fetchImpl = globalThis.fetch, headers = () => ({}), retryWait = wait, timeoutMs = seconds => seconds * 1000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch 不可用');
  const request = async ({ path, body, config, signal, stream = false, retries = 2 }) => {
    if (!config?.url || !config?.key) throw safeError('config');
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw abortError();
      const linked = linkedController(signal, config.timeoutSec, timeoutMs);
      try {
        const response = await fetchImpl(path, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: linked.controller.signal });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < retries) {
            attempt += 1; linked.cleanup(); await retryWait(Math.min(400 * 2 ** attempt, 2000), signal); continue;
          }
          throw mapHttpError(response.status);
        }
        return stream ? await readSseContent(response) : await response.json();
      } catch (error) {
        if (linked.timedOut()) throw safeError('timeout');
        if (signal?.aborted || error?.name === 'AbortError') throw abortError();
        if (error instanceof TypeError && attempt < retries) {
          attempt += 1; linked.cleanup(); await retryWait(Math.min(400 * 2 ** attempt, 2000), signal); continue;
        }
        if (error instanceof TypeError) throw safeError('network');
        if (error instanceof SyntaxError) throw safeError('format');
        throw error;
      } finally { linked.cleanup(); }
    }
  };
  const generateTask = async ({ config, taskMessages, jsonSchema, signal, maxTokens = 12000, temperature = 0.2 } = {}) => {
    const compactMessages = [
      { role: 'system', content: 'You extract people only from the supplied frozen sources. Return only JSON matching the requested schema.' },
      ...(Array.isArray(taskMessages) ? taskMessages : []).filter(message => ['system', 'user'].includes(message?.role) && typeof message.content === 'string').map(message => ({ role: message.role, content: message.content })),
    ];
    const body = {
      chat_completion_source: 'openai', reverse_proxy: normalizeApiUrl(config?.url), proxy_password: config?.key,
      model: config?.model || DEFAULT_MODEL, messages: compactMessages, stream: config?.stream === true,
      temperature, max_tokens: maxTokens,
    };
    if (jsonSchema) body.response_format = { type: 'json_schema', json_schema: { name: jsonSchema.name || 'qianqianjie_people', schema: jsonSchema.value || jsonSchema.schema, strict: jsonSchema.strict !== false } };
    for (const item of config?.excludeParams || []) {
      const key = String(item).trim(); if (key && !PROTECTED_BODY_KEYS.has(key)) delete body[key];
    }
    const response = await request({ path: '/api/backends/chat-completions/generate', body, config, signal, stream: body.stream === true });
    const text = body.stream === true ? response : extractCompletion(response);
    return { jsonData: parseJsonOutput(text) };
  };
  const testConnection = async ({ config, signal } = {}) => {
    const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean', const: true } } };
    const result = await generateTask({ config: { ...config, stream: false }, taskMessages: [{ role: 'user', content: 'Connection check. Reply with {"ok":true}.' }], jsonSchema: { name: 'qianqianjie_connection_check', value: schema, strict: true }, signal, maxTokens: 48, temperature: 0 });
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
