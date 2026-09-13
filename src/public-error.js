const CHINESE_TEXT = /[\u3400-\u9fff]/u;

const CODE_COPY = Object.freeze({
  QQJ_DISABLED: '千千结当前已关闭。',
  QQJ_CONFIG: 'API 配置不完整，请检查 URL、Key 和模型。',
  QQJ_PRESET_INVALID: '所选 API 预设已失效。',
  QQJ_TIMEOUT: 'API 请求超时，请检查网络或调高超时时间。',
  QQJ_AUTH: 'API 认证失败，请检查 Key 和模型权限。',
  QQJ_NOT_FOUND: 'API 地址不存在，请检查 Base URL。',
  QQJ_RATE_LIMIT: 'API 请求过于频繁，请稍后再试。',
  QQJ_SERVER: 'API 服务暂时异常，请稍后再试。',
  QQJ_NETWORK: '无法连接 API，请检查地址和网络。',
  QQJ_REQUEST_FORMAT: 'API 请求参数或响应格式与当前网关不兼容。',
  QQJ_HTTP_RESPONSE_JSON: 'API 响应不是合法 JSON。',
  QQJ_STREAM_EVENT_JSON: '流式响应事件不是合法 JSON。',
  QQJ_COMPLETION_JSON: '模型输出中没有完整的 JSON 结果。',
  QQJ_OUTPUT_TRUNCATED: '模型输出疑似被截断。',
  QQJ_TRANSPORT_BUDGET: '本次任务的网络尝试次数已用完，请稍后重试。',
  BACKEND_TIMEOUT: '后端请求超时，请稍后重试。',
  V3_RECALL_MEMORY_PREPARATION_TIMEOUT: '当前聊天记忆准备超时。',
  V3_RECALL_SOURCE_UNAVAILABLE: '当前聊天记忆暂时无法读取。',
  V3_MEMORY_FOUNDATION_NOT_READY: '后端数据尚未就绪，请稍后重试。',
  V3_MEMORY_LOAD_FAILED: '记忆数据读取失败，请稍后重试。',
  V3_MEMORY_PERSIST_FAILED: '记忆保存失败，请稍后重试。',
  V3_MEMORY_COMMIT_FAILED: '记忆保存失败，请稍后重试。',
  V3_RECALL_FAILED: '记忆召回失败，请稍后重试。',
  V3_CSE_FAILED: '人物状态分析失败，请稍后重试。',
});

const clean = value => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 500);

export function publicErrorMessage(error, { fallback = '' } = {}) {
  if (error === null || error === undefined || error === '') return clean(fallback);
  const message = clean(typeof error === 'string' ? error : error?.message);
  if (message && CHINESE_TEXT.test(message)) return message;

  const code = clean(typeof error === 'object' ? error?.code : '');
  if (CODE_COPY[code]) return CODE_COPY[code];

  const name = clean(typeof error === 'object' ? error?.name : '');
  if (name === 'AbortError' || /(?:operation was aborted|request (?:was )?aborted|aborterror)/iu.test(message)) return '操作已取消。';
  if (name === 'TimeoutError' || /(?:timed?\s*out|timeout)/iu.test(message)) return '请求超时，请稍后重试。';

  const status = Number(typeof error === 'object' ? (error?.httpStatus ?? error?.status) : 0);
  if (status === 401) return '认证失败，请检查账号凭据或 API Key。';
  if (status === 403) return '当前账号没有执行此操作的权限。';
  if (status === 404) return '请求的资源不存在，请检查配置。';
  if (status === 408 || status === 504) return '请求超时，请稍后重试。';
  if (status === 409) return '数据发生冲突，请刷新后重试。';
  if (status === 429) return '请求过于频繁，请稍后再试。';
  if (status >= 500) return '服务暂时异常，请稍后再试。';

  if (/^(?:load failed|failed to fetch)$/iu.test(message) || /(?:networkerror|network request failed|fetch failed|internet disconnected|connection (?:refused|reset))/iu.test(message)) {
    return '网络连接失败，请检查网络或 API 地址。';
  }
  if (/(?:unauthori[sz]ed|authentication failed|invalid api key|incorrect api key|forbidden|permission denied|access denied)/iu.test(message)) {
    return '认证或权限检查失败，请检查账号凭据和 API Key。';
  }
  if (/(?:rate.?limit|too many requests)/iu.test(message)) return '请求过于频繁，请稍后再试。';
  if ((name === 'SyntaxError' && /json/iu.test(message)) || /(?:unexpected end of json input|unexpected token.+(?:in json at position|is not valid json)|json(?:\.|\s+)parse(?:\s+error)?)/iu.test(message)) {
    return '返回数据不是合法 JSON，请稍后重试。';
  }

  return clean(fallback);
}
