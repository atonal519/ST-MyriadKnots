const HAN_RUN = /[\p{Script=Han}]+/gu;
const LATIN_NUMBER_WORD = /[\p{Script=Latin}\p{N}_]+/gu;

export const BM25_DEFAULTS = Object.freeze({ k1: 1.2, b: 0.75 });

/**
 * Small deterministic tokenizer for recall ranking. Han text becomes overlapping
 * character bigrams; Latin words and numbers remain whole tokens.
 *
 * The standard BM25 formula and Han-bigram approach are informed by TriviumDB's
 * text index (Apache-2.0), src/index/text.rs at 406a948b44d535efae1ef755367b2ee074b9cc12.
 */
export function tokenizeRecallText(value) {
  const normalized = String(value ?? '').normalize('NFKC').toLocaleLowerCase('zh-CN');
  const tokens = [];
  for (const match of normalized.matchAll(HAN_RUN)) {
    const characters = [...match[0]];
    if (characters.length === 1) tokens.push(characters[0]);
    else for (let index = 0; index + 1 < characters.length; index += 1) tokens.push(`${characters[index]}${characters[index + 1]}`);
  }
  for (const match of normalized.matchAll(LATIN_NUMBER_WORD)) tokens.push(match[0]);
  return tokens;
}

const termFrequency = tokens => {
  const frequencies = new Map();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  return frequencies;
};

const finiteWeight = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;

/**
 * Rank a fixed document corpus against independent query branches. Each branch
 * is normalized by its own best BM25 score before the available branch weights
 * are re-normalized, so a long background query cannot drown the latest user.
 */
export function rankRecallDocuments({ documents = [], queries = [], k1 = BM25_DEFAULTS.k1, b = BM25_DEFAULTS.b } = {}) {
  const corpus = (Array.isArray(documents) ? documents : []).map((document, index) => {
    const tokens = tokenizeRecallText(document?.text);
    return { id: document?.id ?? index, index, length: tokens.length, frequencies: termFrequency(tokens) };
  });
  if (!corpus.length) return [];
  const documentFrequency = new Map();
  for (const document of corpus) for (const token of document.frequencies.keys()) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  const averageLength = corpus.reduce((sum, document) => sum + document.length, 0) / corpus.length || 1;
  const safeK1 = Number.isFinite(Number(k1)) && Number(k1) >= 0 ? Number(k1) : BM25_DEFAULTS.k1;
  const safeB = Number.isFinite(Number(b)) ? Math.max(0, Math.min(1, Number(b))) : BM25_DEFAULTS.b;
  const activeQueries = (Array.isArray(queries) ? queries : []).map((query, index) => ({
    key: String(query?.key ?? index),
    weight: finiteWeight(query?.weight),
    terms: [...new Set(tokenizeRecallText(query?.text))],
  })).filter(query => query.weight > 0 && query.terms.length);
  const weightTotal = activeQueries.reduce((sum, query) => sum + query.weight, 0);
  if (!activeQueries.length || weightTotal <= 0) return corpus.map(document => ({ id: document.id, score: 0, branchScores: Object.freeze({}), branchRawScores: Object.freeze({}), branchMatchCounts: Object.freeze({}), documentLength: document.length }));

  const rawByBranch = new Map(), normalizedByBranch = new Map();
  const matchesByBranch = new Map();
  for (const query of activeQueries) {
    const matches = [];
    const raw = corpus.map(document => {
      let score = 0;
      let matched = 0;
      for (const token of query.terms) {
        const frequency = document.frequencies.get(token) ?? 0;
        if (!frequency) continue;
        matched += 1;
        const df = documentFrequency.get(token) ?? 0;
        const idf = Math.log(1 + ((corpus.length - df + 0.5) / (df + 0.5)));
        const denominator = frequency + safeK1 * (1 - safeB + safeB * (document.length / averageLength));
        score += idf * ((frequency * (safeK1 + 1)) / denominator);
      }
      matches.push(matched);
      return score;
    });
    const maximum = Math.max(0, ...raw);
    rawByBranch.set(query.key, raw);
    // Do not promote a corpus-wide, low-IDF overlap to a perfect branch hit.
    // Strong branches are normalized to their best document; weak branches keep
    // their absolute BM25 magnitude so generic words cannot be amplified to 1.
    const divisor = Math.max(1, maximum);
    normalizedByBranch.set(query.key, raw.map(score => score / divisor));
    matchesByBranch.set(query.key, matches);
  }

  return corpus.map((document, index) => {
    const branchScores = {}, branchRawScores = {}, branchMatchCounts = {};
    let score = 0;
    for (const query of activeQueries) {
      const normalized = normalizedByBranch.get(query.key)[index];
      branchScores[query.key] = normalized;
      branchRawScores[query.key] = rawByBranch.get(query.key)[index];
      branchMatchCounts[query.key] = matchesByBranch.get(query.key)[index];
      score += normalized * (query.weight / weightTotal);
    }
    return { id: document.id, score, branchScores: Object.freeze(branchScores), branchRawScores: Object.freeze(branchRawScores), branchMatchCounts: Object.freeze(branchMatchCounts), documentLength: document.length };
  });
}
