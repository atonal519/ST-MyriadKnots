import { API_BASE, NAMESPACE } from './constants.js';

const RECORD_TYPE_PREFIXES = Object.freeze([
  ['v3-floor-', 'floor'], ['v3-run-', 'run'], ['v3-checkpoint-', 'checkpoint'],
  ['v3-entity-', 'entity'], ['v3-baseline-', 'baseline'], ['v3-state-delta-', 'stateDelta'],
  ['v3-current-state-', 'currentState'], ['v3-index-', 'index'],
]);
function safeError(status) { return new Error(`后端请求失败（HTTP ${status}）`); }
function timeoutError() { const error = new Error('后端请求超时'); error.name = 'TimeoutError'; error.code = 'BACKEND_TIMEOUT'; return error; }
function recordTypeFromId(recordId) {
  const value = String(recordId);
  if (value === 'v3-root') return 'root';
  if (value === 'v3-people-workspace') return 'peopleWorkspace';
  if (value.startsWith('binding-')) return 'binding';
  if (value.startsWith('v3-floor-memory-')) return 'floorMemory';
  return RECORD_TYPE_PREFIXES.find(([prefix]) => value.startsWith(prefix))?.[1] ?? 'unknown';
}
export function createBackendClient({ fetchImpl = globalThis.fetch, headers = () => ({}), baseUrl = API_BASE, timeoutMs = 15000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch 不可用');
  const diagnostic = { sinceClientCreatedRequestCounts: { get: 0, put: 0, delete: 0 }, latestRead: null, latestWrite: null, lastFailure: null };
  let diagnosticSequence = 0;
  const finishDiagnostic = (requestDiagnostic, startedAt, outcome, { httpStatus, code } = {}) => {
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
    };
    diagnostic[requestDiagnostic.method === 'GET' ? 'latestRead' : 'latestWrite'] = record;
    if (outcome !== 'success') diagnostic.lastFailure = record;
  };
  const request = async (path, options = {}, requestDiagnostic = null) => {
    const startedAt = Date.now();
    if (requestDiagnostic) diagnostic.sinceClientCreatedRequestCounts[requestDiagnostic.method.toLowerCase()] += 1;
    const controller = new AbortController(), outerSignal = options.signal; let timedOut = false;
    const abortFromOuter = () => controller.abort(outerSignal?.reason);
    if (outerSignal?.aborted) abortFromOuter(); else outerSignal?.addEventListener?.('abort', abortFromOuter, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, Number(timeoutMs) || 15000));
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, { ...options, signal: controller.signal, headers: { Accept: 'application/json', ...headers(), ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
      if (!response.ok) { const error = safeError(response.status); error.status = response.status; throw error; }
      const body = await response.json();
      finishDiagnostic(requestDiagnostic, startedAt, 'success');
      return body;
    } catch (error) {
      if (timedOut) {
        const timeout = timeoutError();
        finishDiagnostic(requestDiagnostic, startedAt, 'timeout', { code: timeout.code });
        throw timeout;
      }
      if (Number.isSafeInteger(error?.status)) finishDiagnostic(requestDiagnostic, startedAt, 'httpError', { httpStatus: error.status });
      else finishDiagnostic(requestDiagnostic, startedAt, outerSignal?.aborted ? 'aborted' : 'failure');
      throw error;
    }
    finally { clearTimeout(timer); outerSignal?.removeEventListener?.('abort', abortFromOuter); }
  };
  const collectionKey = collection => `/v1/records/${encodeURIComponent(NAMESPACE)}/${encodeURIComponent(collection)}`;
  const key = (collection, recordId) => `${collectionKey(collection)}/${encodeURIComponent(recordId)}`;
  return {
    async health() {
      const result = await request('/v1/health');
      if (!result?.ok || result.api?.current !== 1 || !result.api?.supported?.includes(1) || result.capabilities?.records !== true || result.capabilities?.optimisticRevision !== true) throw new Error('后端能力不兼容');
      return result;
    },
    async list(collection, { signal } = {}) { return request(collectionKey(collection), { signal }, { method: 'GET', recordType: 'collection' }); },
    async get(collection, recordId) { return request(key(collection, recordId), {}, { method: 'GET', recordType: recordTypeFromId(recordId) }); },
    async put(collection, recordId, data, expectedRevision, { signal } = {}) { return request(key(collection, recordId), { method: 'PUT', body: JSON.stringify({ data, expectedRevision }), signal }, { method: 'PUT', recordType: recordTypeFromId(recordId) }); },
    async remove(collection, recordId, expectedRevision, { signal } = {}) { return request(key(collection, recordId), { method: 'DELETE', body: JSON.stringify({ expectedRevision }), signal }, { method: 'DELETE', recordType: recordTypeFromId(recordId) }); },
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
}
