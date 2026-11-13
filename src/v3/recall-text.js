export const RECALL_COMPACT_KNOWLEDGE_GUIDANCE = '作者资料按原描述及实际接收范围限定人物知情。';
export const RECALL_KNOWLEDGE_GUIDANCE = '资料供作者理解剧情。人物知情依已存表达者、接收者、实际观察及原描述范围。私下约定、传闻与推测保留原语义。';

// 先按程序写入的长度跳过原文块，再解析外层来源/时间/剧情线。
export function readManualArtifactBlocks(source, { preserveHeaders = false } = {}) {
  const header = /^(- (?:AI #[^\n]+：|\[旧事\] ))\[人工原文｜(\d+)字符\]\n/gmu;
  const blocks = new Map(), parts = [];
  let cursor = 0, match;
  while ((match = header.exec(source))) {
    const length = Number(match[2]), start = header.lastIndex, end = start + length;
    if (!Number.isSafeInteger(length) || length < 1 || end > source.length || end < source.length && source[end] !== '\n') return { valid: false, text: source, blocks };
    const token = `\u0000qqj-manual-${blocks.size}\u0000`;
    blocks.set(token, source.slice(start, end));
    parts.push(source.slice(cursor, match.index), preserveHeaders ? match[0] : match[1], token);
    cursor = end; header.lastIndex = end;
  }
  if (!blocks.size) return { valid: true, text: source, blocks };
  parts.push(source.slice(cursor));
  return { valid: true, text: parts.join(''), blocks };
}
