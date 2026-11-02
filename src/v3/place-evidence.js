export function locatePlaceQuote(content, quote, { allowWhitespace = false, allowOmission = false } = {}) {
  if (typeof content !== 'string' || typeof quote !== 'string' || !quote.trim()) return null;
  const offset = content.indexOf(quote);
  if (offset >= 0) return [{ quote, start: offset, end: offset + quote.length }];
  if (allowWhitespace) {
    const pattern = quote.trim().split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const matches = [...content.matchAll(new RegExp(pattern, 'gu'))];
    if (matches.length === 1) return [{ quote: matches[0][0], start: matches[0].index, end: matches[0].index + matches[0][0].length }];
  }
  if (!allowOmission) return null;
  const segments = quote.split(/\u2026+|\.{3,}/u).map(segment => segment.trim());
  if (segments.length < 2 || segments.length > 8 || segments.some(segment => !segment || segment.length > 2000)) return null;
  const located = [];
  for (const segment of segments) {
    const start = content.indexOf(segment);
    if (start < 0 || content.indexOf(segment, start + 1) >= 0 || start < (located.at(-1)?.end ?? 0)) return null;
    located.push({ quote: segment, start, end: start + segment.length });
  }
  return located;
}
