import { API_BASE, NAMESPACE } from './constants.js';
import { createTauriBackendFetch, isTauriTavern } from './tauri-backend.js';

const BATCH_WRITE_LIMIT = 64, BATCH_WRITE_BYTES = 1048576;
// Only the current package is serialized while walking the caller's existing records.
export function* recordWriteBatches(records) {
  const encoder = new TextEncoder(), overhead = encoder.encode('{"records":[]}').length;
  let group = [], size = overhead;
  for (const item of records) {
    const bytes = encoder.encode(JSON.stringify(item)).length;
    if (group.length && (group.length === BATCH_WRITE_LIMIT || size + 1 + bytes > BATCH_WRITE_BYTES)) {
      yield { records: group, single: false }; group = []; size = overhead;
    }
    if (overhead + bytes > BATCH_WRITE_BYTES) { yield { records: [item], single: true }; continue; }
    size += bytes + (group.length ? 1 : 0); group.push(item);
  }
  if (group.length) yield { records: group, single: false };
}

const RECORD_TYPE_PREFIXES = Object.freeze([
  ['v3-floor-', 'floor'], ['v3-run-', 'run'], ['v3-checkpoint-', 'checkpoint'],
  ['v3-entity-', 'entity'], ['v3-baseline-', 'baseline'], ['v3-state-delta-', 'stateDelta'],
  ['v3-current-state-', 'currentState'], ['v3-index-', 'index'],
]);
const ACTION_FOR_METHOD = Object.freeze({ GET: '读取记忆', POST: '读取记忆', PUT: '保存记忆', DELETE: '删除记忆' });
const DIAGNOSTIC_NEXT_STEP = '请到“记忆管理”页点击“复制状态诊断”反馈。';
function safeError(status, action) {
  return new Error(`${action}失败（HTTP ${status}）。${DIAGNOSTIC_NEXT_STEP}`);
}
function shortDiagnosticText(value, limit) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  return text || undefined;
}
function timeoutError(action = null) {
  const message = action
    ? `${action}超时，记忆存储服务未及时响应。请稍后重试；仍失败时，${DIAGNOSTIC_NEXT_STEP}`
    : '后端请求超时';
  const error = new Error(message); error.name = 'TimeoutError'; error.code = 'BACKEND_TIMEOUT'; return error;
}
// Fetch receives one complete body (without streaming-duplex); the shared abort also cancels preparation.
async function gzipRequestBody(bytes, signal) {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const reader = stream.getReader(), chunks = [];
  const cancel = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    let size = 0;
    while (true) {
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength;
    }
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const compressed = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { compressed.set(chunk, offset); offset += chunk.byteLength; }
    return compressed;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
function recordTypeFromId(recordId) {
  const value = String(recordId);
  if (value === 'v3-root') return 'root';
  if (value === 'v3-people-workspace') return 'peopleWorkspace';
  if (value.startsWith('binding-')) return 'binding';
  if (value.startsWith('v3-floor-memory-')) return 'floorMemory';
  return RECORD_TYPE_PREFIXES.find(([prefix]) => value.startsWith(prefix))?.[1] ?? 'unknown';
}
export function createBackendClient({ fetchImpl, headers = () => ({}), baseUrl = API_BASE, timeoutMs = 15000, listTimeoutMs = 120000 } = {}) {
  // TT routing is limited to the default transport so injected and custom HTTP clients retain ownership.
  const defaultTransport = !fetchImpl && baseUrl === API_BASE;
  const useTauri = defaultTransport && isTauriTavern();
  fetchImpl ??= useTauri ? createTauriBackendFetch() : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch 不可用');
  // The native TT bridge, injected fetch clients, and custom endpoints keep their JSON transport contract.
  const allowGzipPut = defaultTransport && !useTauri;
  const diagnostic = { sinceClientCreatedRequestCounts: { get: 0, put: 0, delete: 0 }, latestRead: null, latestWrite: null, lastFailure: null };
  let diagnosticSequence = 0;
  let capabilities = null;
  let capabilityRequest = null;
  const finishDiagnostic = (requestDiagnostic, startedAt, outcome, { httpStatus, code, backendError, backendMessage, transport } = {}) => {
    if (!requestDiagnostic) return;
    const record = {
      sequence: ++diagnosticSequence,
      method: requestDiagnostic.method,
      recordType: requestDiagnostic.recordType,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      completedAt: new Date().toISOString(),
      outcome,
      ...(Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
      ...(code === 'BACKEND_TIMEOUT' ? { code } : {}),
      ...(backendError ? { backendError } : {}),
      ...(backendMessage ? { backendMessage } : {}),
      ...(requestDiagnostic.method === 'PUT' && transport ? {
        bodyBytes: transport.bodyBytes,
        ...(Number.isSafeInteger(transport.encodedBodyBytes) ? { encodedBodyBytes: transport.encodedBodyBytes } : {}),
        ...(transport.contentEncoding ? { contentEncoding: transport.contentEncoding } : {}),
      } : {}),
    };
    diagnostic[requestDiagnostic.method === 'GET' || requestDiagnostic.method === 'POST' ? 'latestRead' : 'latestWrite'] = record;
    if (outcome !== 'success') diagnostic.lastFailure = record;
  };
  const request = async (path, options = {}, requestDiagnostic = null, requestTimeoutMs = timeoutMs) => {
    const startedAt = Date.now();
    const action = requestDiagnostic ? ACTION_FOR_METHOD[requestDiagnostic.method] ?? null : null;
    let http400Diagnostic = null;
    let fetchFailed = false;
    if (requestDiagnostic) {
      const method = requestDiagnostic.method.toLowerCase();
      diagnostic.sinceClientCreatedRequestCounts[method] ??= 0;
      diagnostic.sinceClientCreatedRequestCounts[method] += 1;
    }
    const controller = new AbortController(), outerSignal = options.signal; let timedOut = false;
    const abortFromOuter = () => controller.abort(outerSignal?.reason);
    if (outerSignal?.aborted) abortFromOuter(); else outerSignal?.addEventListener?.('abort', abortFromOuter, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, Number(requestTimeoutMs) || 15000));
    let transport = null;
    try {
      const requestOptions = { ...options };
      const requestHeaders = { Accept: 'application/json', ...(useTauri ? {} : headers()), ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
      if (requestDiagnostic?.method === 'PUT' && typeof options.body === 'string') {
        const bytes = new TextEncoder().encode(options.body);
        transport = { bodyBytes: bytes.byteLength };
        if (allowGzipPut && bytes.byteLength >= 32 * 1024 && typeof CompressionStream === 'function') {
          try {
            const compressed = await gzipRequestBody(bytes, controller.signal);
            if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('Aborted', 'AbortError');
            if (compressed.byteLength < bytes.byteLength) {
              requestOptions.body = compressed;
              requestHeaders['Content-Encoding'] = 'gzip';
              transport = { bodyBytes: bytes.byteLength, encodedBodyBytes: compressed.byteLength, contentEncoding: 'gzip' };
            }
          } catch (error) {
            // Only compression preparation may fall back; cancellation keeps the shared request deadline authoritative.
            if (controller.signal.aborted) throw error;
          }
        }
        if (!transport.contentEncoding) transport = { bodyBytes: bytes.byteLength, encodedBodyBytes: bytes.byteLength, contentEncoding: 'identity' };
      }
      if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('Aborted', 'AbortError');
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, { ...requestOptions, signal: controller.signal, headers: requestHeaders });
      } catch (error) {
        fetchFailed = true;
        throw error;
      }
      if (!response.ok) {
        if (response.status === 400 && requestDiagnostic) {
          try {
            const body = await response.json();
            if (body && typeof body === 'object' && !Array.isArray(body)) {
              http400Diagnostic = {
                backendError: shortDiagnosticText(body.error, 80),
                backendMessage: shortDiagnosticText(body.message, 180),
              };
            }
          } catch { /* 保留原始 HTTP 400；诊断响应可能不是 JSON。 */ }
        }
        const error = safeError(response.status, action ?? '请求'); error.status = response.status; throw error;
      }
      const body = await response.json();
      finishDiagnostic(requestDiagnostic, startedAt, 'success', { transport });
      return body;
    } catch (error) {
      if (timedOut) {
        const timeout = timeoutError(action);
        finishDiagnostic(requestDiagnostic, startedAt, 'timeout', { code: timeout.code, transport });
        throw timeout;
      }
      if (Number.isSafeInteger(error?.status)) finishDiagnostic(requestDiagnostic, startedAt, 'httpError', { httpStatus: error.status, ...(error.status === 400 ? http400Diagnostic : {}), transport });
      else finishDiagnostic(requestDiagnostic, startedAt, outerSignal?.aborted ? 'aborted' : 'failure', { transport });
      if (action && fetchFailed && !useTauri && error?.name === 'TypeError' && !outerSignal?.aborted) {
        const failure = new Error(`${action}失败，无法连接记忆存储服务。请稍后重试；仍失败时，${DIAGNOSTIC_NEXT_STEP}`, { cause: error });
        failure.name = error?.name ?? 'Error';
        if (error?.code !== undefined) failure.code = error.code;
        throw failure;
      }
      throw error;
    }
    finally { clearTimeout(timer); outerSignal?.removeEventListener?.('abort', abortFromOuter); }
  };
  const collectionKey = collection => `/v1/records/${encodeURIComponent(NAMESPACE)}/${encodeURIComponent(collection)}`;
  const key = (collection, recordId) => `${collectionKey(collection)}/${encodeURIComponent(recordId)}`;
  const recordIdsKey = collection => `/v1/record-ids/${encodeURIComponent(NAMESPACE)}/${encodeURIComponent(collection)}`;
  const recordBatchKey = collection => `/v1/record-batch/${encodeURIComponent(NAMESPACE)}/${encodeURIComponent(collection)}`;
  const negotiateCapabilities = async signal => {
    if (capabilities) return capabilities;
    if (useTauri) return null;
    if (!capabilityRequest) {
      capabilityRequest = Promise.resolve().then(async () => { await client.health({ signal }); return capabilities; })
        .finally(() => { capabilityRequest = null; });
    }
    return capabilityRequest;
  };
  const batchResponse = (body, recordIds) => {
    if (!Array.isArray(body) || body.length !== recordIds.length) throw new Error('后端批量读取结果无效');
    return body.map((item, index) => {
      const recordId = recordIds[index];
      if (!item || item.recordId !== recordId || ![200, 404, 500].includes(item.status)) throw new Error('后端批量读取结果无效');
      if (item.status === 200) {
        const envelope = item.envelope;
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !Number.isSafeInteger(envelope.revision) || !Object.hasOwn(envelope, 'data')) throw new Error('后端批量读取结果无效');
        return { recordId, status: 200, envelope };
      }
      if (typeof item.error !== 'string' || typeof item.message !== 'string') throw new Error('后端批量读取结果无效');
      return { recordId, status: item.status, error: item.error, message: item.message };
    });
  };
  const recordEnvelope = item => {
    if (item.status === 200) return { recordId: item.recordId, ...item.envelope };
    const error = safeError(item.status); error.status = item.status; throw error;
  };
  const client = {
    async health({ signal } = {}) {
      const result = await request('/v1/health', { signal });
      if (!result?.ok || result.api?.current !== 1 || !result.api?.supported?.includes(1) || result.capabilities?.records !== true || result.capabilities?.optimisticRevision !== true) throw new Error('后端能力不兼容');
      capabilities = Object.freeze({ recordBatchRead: result.capabilities.recordBatchRead === true, recordBatchWrite: result.capabilities.recordBatchWrite === true, recordIdList: result.capabilities.recordIdList === true });
      return result;
    },
    async list(collection, { signal } = {}) { return request(collectionKey(collection), { signal }, { method: 'GET', recordType: 'collection' }, listTimeoutMs); },
    async get(collection, recordId, { signal } = {}) { return request(key(collection, recordId), { signal }, { method: 'GET', recordType: recordTypeFromId(recordId) }); },
    async getMany(collection, recordIds, { signal, negotiate = true } = {}) {
      if (!Array.isArray(recordIds) || recordIds.length < 1 || recordIds.length > 64 || recordIds.some(id => typeof id !== 'string')) throw new TypeError('recordIds must contain 1..64 strings');
      if (negotiate) await negotiateCapabilities(signal);
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (capabilities?.recordBatchRead) {
        const body = await request(recordBatchKey(collection), { method: 'POST', body: JSON.stringify({ recordIds }), signal }, { method: 'POST', recordType: 'collection' });
        return batchResponse(body, recordIds);
      }
      const results = new Array(recordIds.length); let cursor = 0, firstError = null;
      await Promise.all(Array.from({ length: Math.min(16, recordIds.length) }, async () => {
        while (!firstError && !signal?.aborted) {
          const index = cursor++; if (index >= recordIds.length) return;
          const recordId = recordIds[index];
          try { results[index] = { recordId, status: 200, envelope: await this.get(collection, recordId, { signal }) }; }
          catch (error) {
            if (error?.status === 404 || error?.status === 500) results[index] = { recordId, status: error.status, error: error.status === 404 ? 'not_found' : 'storage_error', message: error.status === 404 ? 'Record not found' : 'Unable to read record' };
            else { firstError ??= error; return; }
          }
        }
      }));
      if (firstError) throw firstError;
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      return results;
    },
    async *iterRecords(collection, { signal } = {}) {
      await negotiateCapabilities(signal);
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (capabilities?.recordBatchRead !== true || capabilities?.recordIdList !== true) {
        const records = await this.list(collection, { signal });
        if (!Array.isArray(records)) throw new Error('后端没有返回有效的记录清单');
        yield* records; return;
      }
      const ids = await request(recordIdsKey(collection), { signal }, { method: 'GET', recordType: 'collection' }, listTimeoutMs);
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('后端没有返回有效的记录 ID 清单');
      for (let offset = 0; offset < ids.length; offset += 64) {
        const batch = await this.getMany(collection, ids.slice(offset, offset + 64), { signal });
        for (const item of batch) yield recordEnvelope(item);
      }
    },
    async put(collection, recordId, data, expectedRevision, { signal } = {}) { return request(key(collection, recordId), { method: 'PUT', body: JSON.stringify({ data, expectedRevision }), signal }, { method: 'PUT', recordType: recordTypeFromId(recordId) }); },
    async putMany(collection, records, { signal } = {}) {
      if (!Array.isArray(records) || records.length < 1 || records.length > BATCH_WRITE_LIMIT
        || records.some(item => !item || typeof item.recordId !== 'string' || !Object.hasOwn(item, 'data') || !Number.isSafeInteger(item.expectedRevision) || item.expectedRevision < 0)
        || new Set(records.map(item => item.recordId)).size !== records.length) throw new TypeError('批量保存参数无效');
      const body = JSON.stringify({ records });
      if (new TextEncoder().encode(body).length > BATCH_WRITE_BYTES) throw new TypeError('批量保存超过1MiB');
      // Reading capability never starts a new probe or changes the native/custom transport.
      if (capabilities?.recordBatchWrite !== true || useTauri) return null;
      const result = await request(recordBatchKey(collection), { method: 'PUT', body, signal }, { method: 'PUT', recordType: 'collection' });
      if (!Array.isArray(result) || result.length !== records.length) throw new Error('后端批量保存结果无效');
      for (let index = 0; index < result.length; index++) {
        const item = result[index];
        if (!item || item.recordId !== records[index].recordId || ![200, 400, 409, 500].includes(item.status)
          || (item.status === 200 ? !item.envelope || !Number.isSafeInteger(item.envelope.revision) || item.envelope.revision < 1 || !Object.hasOwn(item.envelope, 'data') : typeof item.error !== 'string' || typeof item.message !== 'string')) throw new Error('后端批量保存结果无效');
      }
      return result;
    },
    async remove(collection, recordId, expectedRevision, { signal } = {}) { return request(key(collection, recordId), { method: 'DELETE', body: JSON.stringify({ expectedRevision }), signal }, { method: 'DELETE', recordType: recordTypeFromId(recordId) }); },
    async removePermanent(collection, recordId, expectedRevision, { signal } = {}) { return request(`${key(collection, recordId)}/permanent`, { method: 'DELETE', body: JSON.stringify({ expectedRevision }), signal }, { method: 'DELETE', recordType: recordTypeFromId(recordId) }); },
    async collectExpiredTrash(namespace = NAMESPACE, { limit = 32, cursor = null, signal } = {}) {
      const path = `/v1/trash/${encodeURIComponent(namespace)}/collect-expired`;
      return request(path, { method: 'POST', body: JSON.stringify({ limit, cursor }), signal }, null, listTimeoutMs);
    },
    getDiagnosticSnapshot() {
      const copy = value => value ? { ...value } : null;
      return {
        sinceClientCreatedRequestCounts: { ...diagnostic.sinceClientCreatedRequestCounts },
        latestRead: copy(diagnostic.latestRead),
        latestWrite: copy(diagnostic.latestWrite),
        lastFailure: copy(diagnostic.lastFailure),
      };
    },
  };
  return client;
}
