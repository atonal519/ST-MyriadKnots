import { rankRecallDocuments } from './recall-ranking.js';
import { estimateRecallTokens, recallBudget } from './recall-selector.js';

export const PREQUEL_PROMPT_SLOT = 'qqj_v3_prequel_context';
export const PREQUEL_METADATA_KEY = 'qianqianjiePrequel';

const DEFAULT_FRAGMENT_CHARACTERS = 560;
const PREQUEL_BUDGET_SHARE = 0.3;
const MAX_PREQUEL_TOKENS = 1200;
const PREQUEL_INSTRUCTION = '以下是用户导入的过去经历资料，仅用于理解前情。旧状态不代表现在仍持续；若新聊天已明确发生变化，以新聊天为准。';

const boundaryWeight = value => /[\n\r]/u.test(value) ? 3
  : /[。！？!?；;]/u.test(value) ? 2
    : /\s/u.test(value) ? 1 : 0;

export function splitPrequelText(value, { maxCharacters = DEFAULT_FRAGMENT_CHARACTERS } = {}) {
  const source = String(value ?? '');
  if (!source) return Object.freeze([]);
  const characters = [...source];
  const maximum = Math.max(32, Math.floor(Number(maxCharacters) || DEFAULT_FRAGMENT_CHARACTERS));
  const fragments = [];
  for (let start = 0; start < characters.length;) {
    const endLimit = Math.min(characters.length, start + maximum);
    let end = endLimit;
    if (endLimit < characters.length) {
      const minimum = Math.min(endLimit, start + Math.max(16, Math.floor(maximum * 0.55)));
      let bestWeight = 0;
      for (let index = endLimit - 1; index >= minimum; index -= 1) {
        const weight = boundaryWeight(characters[index]);
        if (weight > bestWeight) { end = index + 1; bestWeight = weight; }
        if (weight === 3) break;
      }
    }
    fragments.push(Object.freeze({ index: fragments.length + 1, text: characters.slice(start, end).join('') }));
    start = end;
  }
  return Object.freeze(fragments);
}

export function formatPrequelInjection(fragments = []) {
  const selected = (Array.isArray(fragments) ? fragments : []).filter(value => value && typeof value.text === 'string');
  if (!selected.length) return '';
  return `【用户导入的过去经历资料】\n${PREQUEL_INSTRUCTION}\n\n${selected.map(value => `【前情片段 ${value.index}】\n${value.text}`).join('\n\n')}`;
}

const within = (text, characterBudget, tokenBudget) => text.length <= characterBudget && estimateRecallTokens(text) <= tokenBudget;

export function selectPrequel({ text = '', queryContext = {}, contextSize = 8192, maxCharacters = null, maxTokens = null, requireMatch = false, fallbackToTail = true } = {}) {
  const source = String(text ?? '');
  if (!source.trim()) return Object.freeze({ status: 'empty', injectionText: '', fragmentIndexes: Object.freeze([]), fragments: Object.freeze([]), estimatedCharacters: 0, estimatedTokens: 0, characterBudget: 0, tokenBudget: 0 });
  const total = recallBudget(contextSize);
  const characterBudget = maxCharacters !== null && maxCharacters !== undefined && Number.isFinite(Number(maxCharacters))
    ? Math.max(0, Math.floor(Number(maxCharacters)))
    : Math.floor(total.totalCharacters * PREQUEL_BUDGET_SHARE);
  const tokenBudget = maxTokens !== null && maxTokens !== undefined && Number.isFinite(Number(maxTokens))
    ? Math.max(0, Math.floor(Number(maxTokens)))
    : Math.min(MAX_PREQUEL_TOKENS, Math.floor(total.totalTokens * PREQUEL_BUDGET_SHARE));
  const fragmentMaximum = Math.max(32, Math.min(DEFAULT_FRAGMENT_CHARACTERS, characterBudget - 120, tokenBudget - 100));
  const fragments = splitPrequelText(source, { maxCharacters: fragmentMaximum });
  const complete = formatPrequelInjection(fragments);
  let selected = [];
  if (!requireMatch && within(complete, characterBudget, tokenBudget)) selected = [...fragments];
  else {
    const ranked = rankRecallDocuments({
      documents: fragments.map(fragment => ({ id: fragment.index, text: fragment.text })),
      queries: [
        { key: 'latestUser', text: queryContext?.latestUserText, weight: 0.65 },
        { key: 'recentAssistant', text: queryContext?.recentAssistantText, weight: 0.25 },
        { key: 'previousUser', text: queryContext?.previousUserText, weight: 0.1 },
      ],
    });
    const byIndex = new Map(fragments.map(fragment => [fragment.index, fragment]));
    const matches = ranked.filter(value => value.score > 0).sort((left, right) => right.score - left.score || right.id - left.id);
    const candidates = matches.length ? matches.map(value => byIndex.get(value.id)) : fallbackToTail ? [...fragments].reverse().slice(0, 2) : [];
    for (const fragment of candidates) {
      const attempt = [...selected, fragment].sort((left, right) => left.index - right.index);
      if (within(formatPrequelInjection(attempt), characterBudget, tokenBudget)) selected = attempt;
    }
  }
  const injectionText = formatPrequelInjection(selected);
  return Object.freeze({
    status: injectionText ? 'ready' : 'empty',
    injectionText,
    fragmentIndexes: Object.freeze(selected.map(value => value.index)),
    fragments: Object.freeze(selected),
    estimatedCharacters: injectionText.length,
    estimatedTokens: estimateRecallTokens(injectionText),
    characterBudget,
    tokenBudget,
  });
}
