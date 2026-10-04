const REQUEST_LABELS = new Map([
  ['/api/chats/append', '追加聊天'], ['/api/chats/patch', '更新聊天'],
  ['/api/chats/save', '保存聊天'], ['/api/chats/metadata', '保存聊天设定'],
  ['/api/tokenizers/openai/count', '分词'], ['/api/tokenizers/openai/count-batch', '批量分词'],
  ['/api/backends/chat-completions/generate', '生成请求'],
]);
const MAX_REQUESTS = 64;
export const REQUEST_CONNECTION_FIELDS = Object.freeze({
  fetchStart: 'fetchStartedAt', workerStart: 'workerStartedAt',
  domainLookupStart: 'domainLookupStartedAt', domainLookupEnd: 'domainLookupFinishedAt',
  connectStart: 'connectStartedAt', secureConnectionStart: 'secureConnectionStartedAt', connectEnd: 'connectFinishedAt',
});
export const REQUEST_SIZE_FIELDS = Object.freeze(['transferSize', 'encodedBodySize', 'decodedBodySize']);
export const requestProtocol = value => typeof value === 'string' && /^(?:http\/1\.[01]|h2c?|h3(?:-\d{1,3})?)$/u.test(value) ? value : null;

// 只保存最近一轮的同源请求时间；不读请求体、响应体、查询参数或模型地址。
// Resource Timing 在请求结束时交付，页面自己的资源缓存满后仍可由 observer 接收。
export function createRecallRequestDiagnostic({ performanceRef = globalThis.performance, Observer = globalThis.PerformanceObserver, origin = globalThis.location?.origin } = {}) {
  let serial = 0, current = null, observer = null;
  const receive = (entries, id) => {
    if (current?.id !== id) return;
    for (const entry of entries) {
      if (!['fetch', 'xmlhttprequest'].includes(entry.initiatorType)) continue;
      let url;
      try { url = new URL(entry.name, origin); } catch { continue; }
      const label = url.origin === origin ? REQUEST_LABELS.get(url.pathname) : null;
      const start = performanceRef.timeOrigin + entry.startTime;
      if (!label || !Number.isFinite(start) || start < current.startedAt) continue;
      const stamp = value => Number.isFinite(value) && value > 0 ? performanceRef.timeOrigin + value : null;
      // start→requestStart 的等待可能包含连接或 worker；分段保留，不能全部归为宿主保存队列。
      current.requests.push({ label, startedAt: start, requestStartedAt: stamp(entry.requestStart), responseStartedAt: stamp(entry.responseStart), finishedAt: stamp(entry.responseEnd),
        responseStatus: Number.isSafeInteger(entry.responseStatus) && entry.responseStatus >= 100 && entry.responseStatus <= 599 ? entry.responseStatus : null,
        ...Object.fromEntries(Object.entries(REQUEST_CONNECTION_FIELDS).map(([field, name]) => [name, stamp(entry[field])])),
        ...Object.fromEntries(REQUEST_SIZE_FIELDS.map(field => [field, Number.isFinite(entry[field]) && entry[field] >= 0 ? entry[field] : null])),
        protocol: requestProtocol(entry.nextHopProtocol),
      });
      if (current.requests.length > MAX_REQUESTS) { current.requests.shift(); current.droppedCount += 1; }
    }
  };
  const disconnect = () => {
    if (!observer) return;
    receive(observer.takeRecords(), current.id);
    observer.disconnect(); observer = null;
  };
  function start() {
    disconnect();
    const id = ++serial;
    current = { id, startedAt: Date.now(), finishedAt: null, status: 'unsupported', requests: [], droppedCount: 0 };
    if (typeof Observer !== 'function' || !Number.isFinite(performanceRef?.timeOrigin) || !origin) return id;
    try {
      observer = new Observer(list => receive(list.getEntries(), id));
      observer.observe({ type: 'resource' });
      current.status = 'recording';
    } catch { observer?.disconnect(); observer = null; }
    return id;
  }
  function finish(id) {
    // 停止或结束旧生成不能断开新一轮的 observer。
    if (id == null || current?.id !== id) return;
    disconnect(); current.finishedAt = Date.now();
    if (current.status !== 'unsupported') current.status = 'complete';
  }
  function clear() { disconnect(); current = null; }
  function snapshot(id) {
    if (id == null || current?.id !== id) return { status: 'unavailable', requests: [] };
    return structuredClone(current);
  }
  return Object.freeze({ start, finish, clear, snapshot });
}
