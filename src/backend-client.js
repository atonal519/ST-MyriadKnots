import { API_BASE, NAMESPACE } from './constants.js';

function safeError(status) { return new Error(`后端请求失败（HTTP ${status}）`); }
function timeoutError() { const error = new Error('后端请求超时'); error.name = 'TimeoutError'; error.code = 'BACKEND_TIMEOUT'; return error; }
export function createBackendClient({ fetchImpl = globalThis.fetch, headers = () => ({}), baseUrl = API_BASE, timeoutMs = 15000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch 不可用');
  const request = async (path, options = {}) => {
    const controller = new AbortController(), outerSignal = options.signal; let timedOut = false;
    const abortFromOuter = () => controller.abort(outerSignal?.reason);
    if (outerSignal?.aborted) abortFromOuter(); else outerSignal?.addEventListener?.('abort', abortFromOuter, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, Number(timeoutMs) || 15000));
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, { ...options, signal: controller.signal, headers: { Accept: 'application/json', ...headers(), ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
      let body = null; try { body = await response.json(); } catch { /* empty */ }
      if (!response.ok) { const error = safeError(response.status); error.status = response.status; throw error; }
      return body;
    } catch (error) { if (timedOut) throw timeoutError(); throw error; }
    finally { clearTimeout(timer); outerSignal?.removeEventListener?.('abort', abortFromOuter); }
  };
  const key = (collection, recordId) => `/v1/records/${encodeURIComponent(NAMESPACE)}/${encodeURIComponent(collection)}/${encodeURIComponent(recordId)}`;
  return {
    async health() {
      const result = await request('/v1/health');
      if (!result?.ok || result.api?.current !== 1 || !result.api?.supported?.includes(1) || result.capabilities?.records !== true || result.capabilities?.optimisticRevision !== true) throw new Error('后端能力不兼容');
      return result;
    },
    async get(collection, recordId) { return request(key(collection, recordId)); },
    async put(collection, recordId, data, expectedRevision, { signal } = {}) { return request(key(collection, recordId), { method: 'PUT', body: JSON.stringify({ data, expectedRevision }), signal }); },
  };
}

export async function getOrCreateIdentity(client, collection, recordId, data, guard = () => {}) {
  try { const record = await client.get(collection, recordId); guard(); return { record, created: false }; }
  catch (error) {
    if (error.status !== 404) throw error;
    guard();
    try { guard(); const record = await client.put(collection, recordId, data, 0); guard(); return { record, created: true }; }
    catch (race) { if (race.status !== 409) throw race; const record = await client.get(collection, recordId); guard(); return { record, created: false }; }
  }
}
