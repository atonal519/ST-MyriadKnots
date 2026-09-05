const SENSITIVE_KEY = /^(?:authorization|cookie|set-cookie|api[-_ ]?key|x-api-key|proxy_password|headers?|config|key|url)$/i;
const SENSITIVE_TEXT = /(?:\b(?:https?|wss?):\/\/|\bauthorization\b|\bbasic\b|\bbearer\b|\b(?:cookie|set-cookie)\b|\b(?:api[-_ ]?key|x-api-key|proxy_password)\b|\bsecret(?:[_-][a-z0-9]+)?\b|\bsk-[a-z0-9_-]{3,}\b|\bheaders?\b|\bconfig\b)/i;

export const REDACTED = '[REDACTED]';

export function sanitizeSensitiveText(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  return SENSITIVE_TEXT.test(text) ? REDACTED : text;
}

export function sanitizeDiagnosticValue(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return undefined;
  if (typeof value === 'string') return sanitizeSensitiveText(value);
  if (Array.isArray(value)) return value.map(item => sanitizeDiagnosticValue(item)).filter(item => item !== undefined);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([childKey, child]) => {
    const sanitized = sanitizeDiagnosticValue(child, childKey);
    return sanitized === undefined ? [] : [[childKey, sanitized]];
  }));
  return value;
}

function metadataText(value, fallback, maximum) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return sanitizeSensitiveText(value).trim().slice(0, maximum) || fallback;
}

export function sanitizeTaskMetadata(value) {
  return Object.freeze({
    source: metadataText(value?.source, 'unknown', 80),
    sourceLabel: metadataText(value?.sourceLabel, '未命名 API', 160),
    model: metadataText(value?.model, 'unknown', 160),
    finishReason: metadataText(value?.finishReason, '', 32),
    transportAttempts: Number.isSafeInteger(value?.transportAttempts) && value.transportAttempts >= 0 ? value.transportAttempts : null,
  });
}
