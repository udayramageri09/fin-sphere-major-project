// entityMatcher.js - candidate discovery for the user's own goals, liabilities and budget labels (Issue #77).
//
// This module only RANKS candidates. It never chooses one:
//   - tier 'exact'  the normalized phrase equals the normalized name (the callers' exact lookups still decide that)
//   - tier 'strong' similarity >= 0.85   (a likely typo or word-order change: "bike lon" -> "Bike Loan")
//   - tier 'weak'   similarity 0.60-0.85 (shares words: "goa" -> "Goa Trip")
//   - below 0.60    ignored
// A fuzzy candidate (strong or weak) is ALWAYS put to the user as a question, even when it is the only one; only an exact
// match may proceed without asking. Matching order: exact normalized match, whole-word token overlap, then edit-distance
// and trigram similarity. Names are compared as plain strings; they are never executed, interpreted or sent anywhere.
//
// Pure functions, no I/O.

export const STRONG_THRESHOLD = 0.85;
export const WEAK_THRESHOLD = 0.6;
export const MAX_CANDIDATES = 5;

export const normalizeName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Optimal-string-alignment (restricted Damerau-Levenshtein) distance: insert, delete, substitute, swap two neighbours.
export function editDistance(a, b) {
  const x = String(a);
  const y = String(b);
  if (x === y) return 0;
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  const d = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = 0; i <= x.length; i++) d[i][0] = i;
  for (let j = 0; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[x.length][y.length];
}

function trigrams(s) {
  const p = `  ${s} `;
  const out = new Map();
  for (let i = 0; i + 3 <= p.length; i++) { const g = p.slice(i, i + 3); out.set(g, (out.get(g) ?? 0) + 1); }
  return out;
}

// Dice coefficient over character trigrams (0..1).
export function trigramSimilarity(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const gx = trigrams(x);
  const gy = trigrams(y);
  let shared = 0;
  let nx = 0;
  let ny = 0;
  for (const [g, n] of gx) { nx += n; shared += Math.min(n, gy.get(g) ?? 0); }
  for (const n of gy.values()) ny += n;
  return (2 * shared) / (nx + ny);
}

export const editSimilarity = (a, b) => {
  const x = normalizeName(a);
  const y = normalizeName(b);
  const longest = Math.max(x.length, y.length);
  return longest ? 1 - editDistance(x, y) / longest : 0;
};

// Words that describe the KIND of thing, not which one: "bike loan" and "bike" name the same liability.
const NOISE = new Set(['loan', 'loans', 'emi', 'emis', 'goal', 'goals', 'budget', 'budgets', 'the', 'my', 'our', 'a', 'an', 'and', 'of', 'for']);
const contentTokens = (s) => normalizeName(s).split(' ').filter((t) => t && !NOISE.has(t));

// 0..1: how plausibly `phrase` refers to the entity called `name`.
export function scoreName(phrase, name) {
  const p = normalizeName(phrase);
  const n = normalizeName(name);
  if (!p || !n) return 0;
  if (p === n) return 1;
  const pt = contentTokens(p);
  const nt = contentTokens(n);
  let score = 0;
  if (pt.length && nt.length) {
    const nset = new Set(nt);
    const pset = new Set(pt);
    const shared = pt.filter((t) => nset.has(t)).length;
    if (shared === pt.length && shared === nt.length) score = 0.95;                       // same content words ("bike" / "bike loan")
    else if (shared === pt.length || nt.every((t) => pset.has(t))) score = 0.6 + 0.3 * (shared / Math.max(pt.length, nt.length));   // one side's words are all in the other
    else if (shared > 0) score = 0.6 * (shared / Math.max(pt.length, nt.length));
  }
  score = Math.max(score, editSimilarity(p, n));
  if (p.length >= 5 && n.length >= 5) score = Math.max(score, trigramSimilarity(p, n) * 0.95);
  return Math.min(score, 1);
}

// -> [{ item, score, tier }] best first, at most MAX_CANDIDATES, nothing below WEAK_THRESHOLD.
export function rankEntities(items, phrase, nameOf = (x) => x.name ?? x.title ?? x.category) {
  const ranked = [];
  items.forEach((item, order) => {
    const score = scoreName(phrase, nameOf(item));
    if (score >= WEAK_THRESHOLD) ranked.push({ item, score, order, tier: score >= 1 ? 'exact' : score >= STRONG_THRESHOLD ? 'strong' : 'weak' });
  });
  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked.slice(0, MAX_CANDIDATES).map(({ item, score, tier }) => ({ item, score, tier }));
}

// Convenience: just the entities.
export const fuzzyCandidates = (items, phrase, nameOf) => rankEntities(items, phrase, nameOf).map((r) => r.item);
