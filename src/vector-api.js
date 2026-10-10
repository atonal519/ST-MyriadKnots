import { newIdentityUuid, sha256 } from './identity.js';

export const VECTOR_DEFAULT_URL = 'https://api.siliconflow.cn/v1';
export const VECTOR_DEFAULT_MODEL = 'Qwen/Qwen3-Embedding-8B';
const XFYUN_MAAS_HOST = 'maas-api.cn-huabei-1.xf-yun.com';
const MAX_PROVIDER_ERROR_BYTES = 8192;
const PROVIDER_ERROR_READ_MS = 250;
const fail = (code, message) => Object.assign(new Error(message), { code });
const cancelQuietly = value => { try { Promise.resolve(value?.cancel?.()).catch(() => {}); } catch { /* optional diagnostic stream */ } };
const safeNetworkCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(value) ? value : null;
const safeAbortReason = value => ['stopped', 'superseded', 'chatChanged', 'userChanged', 'narrativeChanged', 'disabled', 'invalidated', 'indexReset'].includes(value) ? value : 'external';
function providerRequestId(headers) {
  try {
    const value = headers?.get?.('x-siliconcloud-trace-id') ?? headers?.get?.('x-request-id') ?? headers?.get?.('x-inference-request-id');
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value) ? value : null;
  } catch { return null; }
}

function safeProviderField(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 && text.length <= 80 && /^[A-Za-z0-9_.:\-\[\]]+$/u.test(text) ? text : null;
}

function providerErrorFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const error = value.error && typeof value.error === 'object' && !Array.isArray(value.error) ? value.error : value;
  const fields = { code: safeProviderField(error.code ?? value.code), type: safeProviderField(error.type ?? value.type), param: safeProviderField(error.param ?? value.param) };
  return Object.values(fields).some(Boolean) ? fields : null;
}

async function readSmallErrorBody(response, signal) {
  let timer = null;
  let reader = null;
  let timedOut = false;
  const deadline = Date.now() + PROVIDER_ERROR_READ_MS;
  try {
    const rawLength = response.headers?.get?.('content-length');
    const length = rawLength === null || rawLength === undefined || rawLength === '' ? NaN : Number(rawLength);
    if (Number.isFinite(length) && length > MAX_PROVIDER_ERROR_BYTES) {
      cancelQuietly(response.body);
      return null;
    }
    reader = response.body?.getReader?.();
    if (reader) {
      const chunks = [];
      let total = 0;
      const cancel = () => cancelQuietly(reader);
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          const remainingMs = Math.max(0, deadline - Date.now());
          if (remainingMs === 0) { timedOut = true; cancel(); return null; }
          const result = await Promise.race([
            reader.read().then(value => value, () => ({ done: true })),
            new Promise(resolve => { timer = setTimeout(() => { timedOut = true; cancel(); resolve({ done: true }); }, remainingMs); }),
          ]);
          clearTimeout(timer); timer = null;
          if (timedOut) return null;
          const { done, value } = result;
          if (done) break;
          total += value?.byteLength ?? 0;
          if (total > MAX_PROVIDER_ERROR_BYTES) {
            cancel();
            return null;
          }
          chunks.push(value);
        }
      } finally {
        clearTimeout(timer); timer = null;
        signal?.removeEventListener('abort', cancel);
        try { reader.releaseLock(); } catch { /* optional stream reader */ }
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder().decode(bytes);
    }
    if (typeof response.text === 'function') {
      // Fetch streams can be consumed incrementally above. A text-only adapter
      // has no size bound before allocation, so inspect it only with a trusted
      // small Content-Length; otherwise preserve the HTTP error without reading.
      if (!Number.isFinite(length) || length < 0 || length > MAX_PROVIDER_ERROR_BYTES) {
        cancelQuietly(response.body);
        return null;
      }
      const text = await Promise.race([
        response.text().then(value => value, () => null),
        new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(null); }, PROVIDER_ERROR_READ_MS); }),
      ]);
      clearTimeout(timer); timer = null;
      return typeof text === 'string' && text.length <= MAX_PROVIDER_ERROR_BYTES ? text : null;
    }
  } catch { /* provider detail never changes the HTTP error */ }
  finally {
    clearTimeout(timer);
    if (timedOut) cancelQuietly(reader ?? response.body);
  }
  return null;
}

function parseProviderError(text) {
  if (text === null) return null;
  try { return providerErrorFields(JSON.parse(text)); } catch { return null; }
}

// 向量角色独立配置凭证；空 URL/模型才使用默认值，不跟随聊天 API。
export function resolveVectorConfig(settings) {
  const value = settings.get();
  if (value.vectorEnabled !== true) return null;
  const preset = value.vectorPresetId ? settings.sharedPresets().find(item => item.id === value.vectorPresetId) : null;
  if (value.vectorPresetId && !preset) throw fail('VECTOR_PRESET_MISSING', '向量预设已失效，请重新选择。');
  return normalizeVectorConfig(preset ?? { url: value.vectorUrl, key: value.vectorKey, model: value.vectorModel });
}

export function normalizeVectorConfig(value = {}) {
  let endpoint;
  try { endpoint = new URL((String(value.url ?? '').trim() || VECTOR_DEFAULT_URL).replace(/\/+$/u, '').replace(/\/embeddings$/u, '')); }
  catch { throw fail('VECTOR_CONFIG_INVALID', '向量 API 地址无效。'); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw fail('VECTOR_CONFIG_INVALID', '向量 API 地址无效。');
  const key = String(value.key ?? '').trim(), model = String(value.model ?? '').trim() || VECTOR_DEFAULT_MODEL;
  if (!key) throw fail('VECTOR_KEY_MISSING', '请填写向量 API Key。');
  return Object.freeze({ url: endpoint.href.replace(/\/+$/u, ''), key, model, dimensions: /^Qwen\/Qwen3-Embedding-/u.test(model) ? 1024 : null });
}

export function usesNativeXfyunProxy(url) {
  try {
    const endpoint = new URL(String(url ?? '').trim().replace(/\/+$/u, '').replace(/\/embeddings$/u, ''));
    return endpoint.protocol === 'https:' && endpoint.hostname === XFYUN_MAAS_HOST && !endpoint.port
      && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
      && (endpoint.pathname === '/v1' || endpoint.pathname === '/v2');
  } catch { return false; }
}

function vectorRequestUrl(config) {
  if (!usesNativeXfyunProxy(config.url)) return `${config.url}/embeddings`;
  // 避免 MaaS 浏览器跨域限制，只把这一服务送到宿主既有代理。
  return `/proxy/${encodeURIComponent(`${config.url}/embeddings`)}`;
}

export function normalizeVector(values) {
  if (!Array.isArray(values) || !values.length || values.length > 8192 || !values.every(value => typeof value === 'number' && Number.isFinite(value))) throw fail('VECTOR_RESPONSE_INVALID', '向量接口返回无效。');
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || norm === 0) throw fail('VECTOR_RESPONSE_INVALID', '向量接口返回无效。');
  return Float32Array.from(values, value => value / norm);
}

export function createVectorApiClient({ fetchImpl = globalThis.fetch, headers: requestHeadersProvider = () => ({}) } = {}) {
  const controllers = new Set();
  return Object.freeze({
    // 单次 embed 只发一次请求；正常召回的限次超时补试由查询方负责，不占宿主生成锁。
    async embed(config, input, { signal, timeoutMs = 30000, onDiagnostic = null, onProgress = null } = {}) {
      if (!Array.isArray(input) || !input.length || input.length > 16 || input.some(text => typeof text !== 'string' || !text.trim() || text.length > 12000)) throw fail('VECTOR_INPUT_INVALID', '向量请求材料无效。');
      if (signal?.aborted) throw fail('VECTOR_ABORTED', '向量请求已取消。');
      const controller = new AbortController(); controllers.add(controller);
      const started = Date.now();
      let requestId = null;
      try { requestId = newIdentityUuid(); } catch { requestId = `vector-${started}`; }
      // 单条输入与离线探针保持原文本 SHA-256；批量输入用 JSON 数组指纹避免拼接歧义。
      let finalized = false;
      const fingerprintMaterial = input.length === 1 ? input[0] : JSON.stringify(input);
      const inputFingerprint = sha256(fingerprintMaterial).then(value => {
        if (!finalized) { diagnostic.inputSha256 = value; emit(onProgress, { ...diagnostic, elapsedMs: Math.max(0, Date.now() - started) }); }
        return value;
      }).catch(() => null);
      // fetch 返回前的等待包含页面包装、跨域握手和网络，不能当作供应商计算耗时。
      // fetch 只能证明本地已调用/收到响应；浏览器不暴露真实网络发送进度。
      const diagnostic = { requestId, startedAt: new Date(started).toISOString(), inputCharacters: input.reduce((sum, text) => sum + text.length, 0), inputSha256: null,
        deadlineMs: timeoutMs, timeoutMs, elapsedMs: 0, phase: 'request', pendingStage: 'request_prepared', lastSuccessfulStage: 'request_prepared', timeoutOrigin: null,
        deadlineOverrunMs: 0, abortOrigin: null, abortReason: null, networkCode: null, providerRequestId: null,
        providerError: null, fetchCallMs: null, responseHeadersMs: null, responseBodyMs: null, httpStatus: null, durationMs: 0 };
      const emit = (callback, value) => {
        if (finalized || typeof callback !== 'function') return;
        try { callback(Object.freeze({ ...value })); } catch { /* 诊断不能改变请求结果。 */ }
      };
      const progress = (phase, patch = {}) => {
        Object.assign(diagnostic, patch, { pendingStage: phase });
        emit(onProgress, { ...diagnostic, elapsedMs: Math.max(0, Date.now() - started) });
      };
      progress('request_prepared');
      const abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      const signalAbort = () => {
        diagnostic.abortOrigin ??= signal?.reason === 'indexReset' ? 'client_abort_all' : 'caller_signal';
        diagnostic.abortReason ??= safeAbortReason(signal?.reason);
        progress('aborted', { lastSuccessfulStage: diagnostic.lastSuccessfulStage });
      };
      controller.signal.addEventListener('abort', signalAbort, { once: true });
      let timer;
      const interrupted = new Promise((_, reject) => {
        const rejectAbort = () => reject(fail('VECTOR_ABORTED', '向量请求已取消。'));
        if (controller.signal.aborted) rejectAbort(); else controller.signal.addEventListener('abort', rejectAbort, { once: true });
        timer = setTimeout(() => {
          diagnostic.timeoutOrigin = 'vector_api_deadline';
          diagnostic.abortOrigin = 'vector_api_deadline';
          diagnostic.abortReason = 'timeout';
          reject(fail('VECTOR_TIMEOUT', '向量请求超时。'));
          controller.abort('timeout');
        }, timeoutMs);
      });
      try {
        return await Promise.race([interrupted, (async () => {
          if (controller.signal.aborted) throw fail('VECTOR_ABORTED', '向量请求已取消。');
          progress('fetch_call_start');
          const requestHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` };
          if (usesNativeXfyunProxy(config.url)) {
            try {
              const hostHeaders = requestHeadersProvider?.() ?? {};
              const csrf = Object.entries(hostHeaders).find(([name]) => name.toLowerCase() === 'x-csrf-token')?.[1];
              if (typeof csrf === 'string' && csrf) requestHeaders['X-CSRF-Token'] = csrf;
            } catch { /* 宿主头只为原生代理服务；读取失败不改供应商凭证或请求体。 */ }
          }
          const pending = fetchImpl(vectorRequestUrl(config), {
            method: 'POST', headers: requestHeaders,
            body: JSON.stringify({ model: config.model, input, encoding_format: 'float', ...(config.dimensions ? { dimensions: config.dimensions } : {}) }), signal: controller.signal,
          });
          diagnostic.fetchCallMs = Math.max(0, Date.now() - started);
          diagnostic.lastSuccessfulStage = 'fetch_called';
          progress('fetch_called');
          const response = await pending;
          if (finalized) throw fail('VECTOR_ABORTED', '向量请求已取消。');
          diagnostic.responseHeadersMs = Math.max(0, Date.now() - started); diagnostic.httpStatus = response.status;
          diagnostic.providerRequestId = providerRequestId(response.headers);
          diagnostic.phase = 'response';
          diagnostic.lastSuccessfulStage = 'response_headers';
          progress('response_headers');
          if (!response.ok) {
            // Once the status is known, optional error detail must not consume the API deadline.
            clearTimeout(timer);
            if (usesNativeXfyunProxy(config.url) && response.status === 401 && /^Basic(?:\s|$)/iu.test(response.headers?.get?.('www-authenticate') ?? '')) {
              throw fail('VECTOR_BASIC_AUTH_CONFLICT', '酒馆密码认证阻止了向量转发。');
            }
            const errorBody = await readSmallErrorBody(response, controller.signal);
            if (usesNativeXfyunProxy(config.url) && response.status === 404) {
              if (errorBody?.trim() === 'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.') {
                throw fail('VECTOR_PROXY_DISABLED', '请开启酒馆 CORS 代理并重启。');
              }
            }
            diagnostic.providerError = parseProviderError(errorBody);
            throw Object.assign(fail('VECTOR_HTTP_ERROR', `向量请求失败（HTTP ${response.status}）。`), {
              status: response.status, providerError: diagnostic.providerError,
            });
          }
          let body;
          try { body = await response.json(); }
          catch (error) {
            if (error?.name === 'SyntaxError') throw fail('VECTOR_RESPONSE_JSON_INVALID', '向量接口返回的不是合法 JSON。');
            throw fail('VECTOR_RESPONSE_READ_FAILED', '读取向量接口响应失败。');
          }
          if (finalized) throw fail('VECTOR_ABORTED', '向量请求已取消。');
          diagnostic.responseBodyMs = Math.max(0, Date.now() - started); diagnostic.phase = 'validation'; diagnostic.lastSuccessfulStage = 'response_body';
          progress('response_body');
          diagnostic.inputSha256 ??= await inputFingerprint;
          if (!Array.isArray(body?.data) || body.data.length !== input.length) throw fail('VECTOR_RESPONSE_INVALID', '向量接口返回无效。');
          const indexed = new Map();
          for (const item of body.data) {
            if (!Number.isSafeInteger(item?.index) || item.index < 0 || item.index >= input.length || indexed.has(item.index)) throw fail('VECTOR_RESPONSE_INVALID', '向量接口返回无效。');
            indexed.set(item.index, normalizeVector(item.embedding));
          }
          const vectors = input.map((_, index) => indexed.get(index));
          if (vectors.some(vector => vector.length !== vectors[0].length || config.dimensions && vector.length !== config.dimensions)) throw fail('VECTOR_RESPONSE_INVALID', '向量维度不一致。');
          diagnostic.lastSuccessfulStage = 'validated';
          diagnostic.phase = 'complete';
          progress('complete');
          return vectors;
        })()]);
      } catch (error) {
        // 不展示供应商响应、输入原文或网络异常中的凭证。
        if (String(error?.code ?? '').startsWith('VECTOR_')) throw error;
        diagnostic.networkCode = safeNetworkCode(error?.code) ?? safeNetworkCode(error?.cause?.code);
        throw fail('VECTOR_CONNECTION_FAILED', '向量接口连接失败，请检查地址与跨域支持。');
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', signalAbort); controllers.delete(controller);
        diagnostic.inputSha256 ??= await inputFingerprint;
        finalized = true;
        diagnostic.elapsedMs = Math.max(0, Date.now() - started);
        diagnostic.durationMs = diagnostic.elapsedMs;
        diagnostic.deadlineOverrunMs = Math.max(0, diagnostic.elapsedMs - timeoutMs);
        if (typeof onDiagnostic === 'function') {
          // 超时后的迟到响应不能改写已交付的诊断，诊断故障也不能影响召回。
          try { onDiagnostic(Object.freeze({ ...diagnostic })); } catch {}
        }
      }
    },
    abortAll() { for (const controller of controllers) controller.abort(); },
  });
}
