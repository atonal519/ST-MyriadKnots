export const CSE_EMOTIONS = Object.freeze(['亲近', '满足', '兴奋', '松弛', '期待', '担忧', '恐惧', '失望', '悲伤', '不满', '反感', '羞怯', '愧疚', '嫉妒']);
export const CSE_QUANTIFICATION_GUIDANCE = '量化为0—100独立强度，结合该条文字与对象理解，不是整个人格或合计比例。按文字中的触发原因、对象、适用条件与既有人格理解情绪并存和牵制，不只取最高分或据分数指定动作。外露程度描述该条感受在言行中的显露，内心强烈仍可克制；visibility及知情范围决定谁能知道，外露数字不改变它们。仅在已有可比前后状态时理解变化，缺值是未知；正文自然呈现，无需报分数。';
const validStrength = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const round1 = value => Math.round(value * 10) / 10;

export function normalizeCseQuantification(value, category) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (category === 'adaptive') return validStrength(value.strength) ? { strength: round1(value.strength) } : null;
  if (category !== 'situational') return null;
  const emotions = value.emotions && typeof value.emotions === 'object' && !Array.isArray(value.emotions)
    ? Object.fromEntries(CSE_EMOTIONS.filter(key => validStrength(value.emotions[key])).map(key => [key, round1(value.emotions[key])])) : {};
  const quantification = { ...(Object.keys(emotions).length ? { emotions } : {}), ...(validStrength(value.expression) ? { expression: round1(value.expression) } : {}) };
  return Object.keys(quantification).length ? quantification : null;
}

export function advanceAdaptiveStrength(previous, target) {
  if (!validStrength(target)) return null;
  return round1(validStrength(previous) ? previous + Math.max(-5, Math.min(5, 0.2 * (target - previous))) : target);
}

export function cseQuantificationFields(item, category) {
  const quantification = normalizeCseQuantification(item?.quantification, category);
  return quantification ? { quantification } : {};
}

export function isCseQuantificationOnlyChange(change) {
  if (!change?.before || !change.after) return false;
  const meaning = item => [item.text, item.visibility, item.reason, item.origin, item.towardEntityId ?? null];
  return JSON.stringify(meaning(change.before)) === JSON.stringify(meaning(change.after))
    && JSON.stringify(normalizeCseQuantification(change.before.quantification, change.category)) !== JSON.stringify(normalizeCseQuantification(change.after.quantification, change.category));
}

export function formatCseQuantification(item, category) {
  const value = normalizeCseQuantification(item?.quantification, category);
  if (!value) return '';
  if (category === 'adaptive') return `（倾向强度：${value.strength}）`;
  const parts = [];
  if (value.emotions) parts.push(`情绪强度：${Object.entries(value.emotions).map(([key, strength]) => `${key}${strength}`).join('、')}`);
  if (value.expression !== undefined) parts.push(`外露程度：${value.expression}`);
  return `（${parts.join('；')}）`;
}
