import { newIdentityUuid, sha256 } from './identity.js';

export const VECTOR_DEFAULT_URL = 'https://api.siliconflow.cn/v1';
export const VECTOR_DEFAULT_MODEL = 'Qwen/Qwen3-Embedding-8B';
const fail = (code, message) => Object.assign(new Error(message), { code });
const safeNetworkCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(value) ? value : null;
const safeAbortReason = value => ['stopped', 'superseded', 'chatChanged', 'userChanged', 'narrativeChanged', 'disabled', 'invalidated', 'indexReset'].includes(value) ? value : 'external';
function providerRequestId(headers) {
  try {
    const value = headers?.get?.('x-request-id') ?? headers?.get?.('x-inference-request-id');
    return typeof value === 'string' && (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value)
      || /^[a-f0-9]{16,64}$/iu.test(value)) ? value : null;
  } catch { return null; }
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

export function normalizeVector(values) {
  if (!Array.isArray(values) || !values.length || values.length > 8192 || !values.every(value => typeof value === 'number' && Number.isFinite(value))) throw fail('VECTOR_RESPONSE_INVALID', '向量接口返回无效。');
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || norm === 0) throw fail('VECTOR_RESPONSE_INVALID', '向量接口返回无效。');
  return Float32Array.from(values, value => value / norm);
}

export function createVectorApiClient({ fetchImpl = globalThis.fetch } = {}) {
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
        fetchCallMs: null, responseHeadersMs: null, responseBodyMs: null, httpStatus: null, durationMs: 0 };
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
          const pending = fetchImpl(`${config.url}/embeddings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
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
          if (!response.ok) throw fail('VECTOR_HTTP_ERROR', `向量请求失败（HTTP ${response.status}）。`);
          const body = await response.json();
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
