// actionNormalization.js - safe, deterministic clean-up of an utterance BEFORE the action parsers read it (Issue #77).
//
// What it does:
//   - whitespace / quote / zero-width clean-up, harmless fillers ("um", "uh") removed
//   - a CURATED alias table fixes common typos and speech-recognition slips in action KEYWORDS (payed -> paid, lon -> loan)
//   - a small keyword-only Damerau-Levenshtein backstop catches other typos of the closed routing vocabulary
//   - every change is logged ({ from, to, ... }) and can be mapped back to the original text
//
// What it never does:
//   - touch digits, amounts, punctuation inside numbers, or number words (those are read by numberParser.js in context)
//   - alter an entity name: names the caller passes in `protect` (the user's goals, loans, budget labels) are skipped, and
//     the fuzzy backstop never reaches outside the routing vocabulary
//   - manufacture a direction or a classification: the fuzzy vocabulary holds no income / expense / refund / transfer /
//     confirmation words and no amounts. (The curated table may fix a clear typo of a cue the user did type, e.g. payed.)
//   - correct a token of 3 characters or fewer by edit distance, or a word on the protected list (send, sent, spent, set,
//     lend, earn, learn, ...)
//   - lowercase the text: titles keep the user's capitalization, so only the corrected tokens change
//
// Pure functions, no I/O.
import { editDistance } from './entityMatcher.js';

// Curated: exact, lower-case typo -> intended word. Checked first.
export const ALIASES = Object.freeze({
  payed: 'paid', pyed: 'paid', paied: 'paid', payd: 'paid', paidd: 'paid',
  lon: 'loan', lone: 'loan', lonn: 'loan', loen: 'loan', lons: 'loans',
  budgt: 'budget', bujet: 'budget', budjet: 'budget', bugdet: 'budget', budet: 'budget', budgts: 'budgets', bujets: 'budgets',
  mnth: 'month', mnths: 'months', monht: 'month', mont: 'month',
  thosand: 'thousand', thousnd: 'thousand', thousend: 'thousand', thosend: 'thousand', thouand: 'thousand', tousand: 'thousand', thousnad: 'thousand', thousan: 'thousand',
  hundrd: 'hundred', hundered: 'hundred', hundrad: 'hundred', hundread: 'hundred',
  fourty: 'forty',
  emy: 'emi', emie: 'emi', emmi: 'emi', emii: 'emi',
  gaol: 'goal', gol: 'goal', goall: 'goal', gaols: 'goals',
  repaymnt: 'repayment', repayent: 'repayment', repaymant: 'repayment', repayement: 'repayment',
  salry: 'salary', salery: 'salary', sallary: 'salary', slary: 'salary',
  recieved: 'received', receved: 'received', recived: 'received',
  rupes: 'rupees', rupess: 'rupees',
  persnal: 'personal', personel: 'personal', personl: 'personal', vehical: 'vehicle', vehicel: 'vehicle', vechile: 'vehicle',
  educaton: 'education', eduction: 'education', educatin: 'education', mortage: 'mortgage', borowed: 'borrowed', borrowd: 'borrowed',
  intrest: 'interest', intrst: 'interest', percnt: 'percent', precent: 'percent',
});

// "gol" is a typo of "goal" at the end of a request ("...to my goa gol") but also half of "gol gappa": only the former.
function aliasApplies(lower, after) {
  if (PROTECTED_WORDS.has(lower)) return false;
  if (lower === 'gol') return /^\s*(?:[.,!?]|$|(?:please|now|today|yesterday|tonight|thanks)\b)/i.test(after);
  return true;
}

// Closed routing vocabulary for the edit-distance backstop (no direction / classification / amount / confirmation words).
export const FUZZY_VOCAB = Object.freeze([
  'loan', 'loans', 'goal', 'goals', 'budget', 'budgets', 'month', 'months', 'repayment', 'liability', 'liabilities',
  'contribute', 'deposit', 'record', 'mortgage', 'yesterday',
]);

// Real words that sit close to the vocabulary (or are the vocabulary's own inflections): never rewritten.
export const PROTECTED_WORDS = new Set([
  'send', 'sent', 'spent', 'spend', 'set', 'lend', 'lent', 'land', 'lead', 'learn', 'earn', 'load', 'loaded', 'lean', 'leans',
  'road', 'lane', 'loin', 'loon', 'moan', 'mouth', 'moth', 'mount', 'coal', 'goat', 'goad', 'gold', 'foal', 'bud', 'buds', 'budge',
  'monthly', 'records', 'recorded', 'recording', 'recorder', 'deposits', 'deposited', 'depositing', 'contributes', 'contributed',
  'contributing', 'budgeted', 'budgeting', 'budged', 'repays', 'repaid', 'repaying', 'repair', 'repairs', 'repayments', 'mortgages',
  'mortgaged', 'yesterdays', 'loam', 'reorder',
]);
// "goats", "loads", "repairs": the plural of a protected word is protected too.
const isProtectedWord = (w) => PROTECTED_WORDS.has(w) || (w.endsWith('s') && PROTECTED_WORDS.has(w.slice(0, -1)));

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'hmm', 'hm']);

const maxDistance = (len) => (len <= 3 ? 0 : len <= 6 ? 1 : 2);

function matchCase(original, replacement) {
  if (original.length > 1 && original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

// The closed-vocabulary word within the allowed distance, or null when there is none or the best is a tie.
export function fuzzyKeyword(lower) {
  if (lower.length <= 3 || isProtectedWord(lower) || FUZZY_VOCAB.includes(lower)) return null;
  let best = null;
  let bestD = Infinity;
  let tie = false;
  for (const word of FUZZY_VOCAB) {
    if (word[0] !== lower[0]) continue;                     // a typo almost never changes the first letter; avoids look-alikes
    const limit = maxDistance(Math.min(lower.length, word.length));    // the SHORTER of the two decides how much freedom there is
    if (Math.abs(word.length - lower.length) > limit) continue;
    const d = editDistance(lower, word);
    if (d > limit) continue;
    if (d < bestD) { best = word; bestD = d; tie = false; } else if (d === bestD && word !== best) tie = true;
  }
  return tie ? null : best;
}

// Whole-phrase occurrences of the protected names in the (lower-cased) text -> [[start, end), ...]
function protectedRanges(lowerText, names) {
  const ranges = [];
  for (const raw of names) {
    const name = String(raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (name.length < 2) continue;
    let from = 0;
    for (;;) {
      const at = lowerText.indexOf(name, from);
      if (at < 0) break;
      const end = at + name.length;
      const before = at === 0 ? '' : lowerText[at - 1];
      const after = end >= lowerText.length ? '' : lowerText[end];
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) ranges.push([at, end]);
      from = at + 1;
    }
  }
  return ranges;
}

// -> { original, text, corrections, changed, toOriginal(start, end) }
//   corrections: [{ kind: 'alias' | 'fuzzy' | 'filler', from, to, index, length }]   (index/length are in the ORIGINAL text)
export function normalizeActionText(input, { protect = [] } = {}) {
  const original = String(input ?? '');

  // 1. character clean-up (whitespace runs, odd quotes, zero-width characters), remembering where each character came from
  const cleanChars = [];
  const cleanSrc = [];
  let spaceAt = -1;
  for (let i = 0; i < original.length; i++) {
    let ch = original[i];
    if (/[\u200B-\u200D\uFEFF]/.test(ch)) continue;
    if (/\s/.test(ch)) { if (cleanChars.length && spaceAt < 0) spaceAt = i; continue; }
    if (ch === '‘' || ch === '’') ch = "'";
    else if (ch === '“' || ch === '”') ch = '"';
    if (spaceAt >= 0) { cleanChars.push(' '); cleanSrc.push(spaceAt); spaceAt = -1; }
    cleanChars.push(ch);
    cleanSrc.push(i);
  }
  const clean = cleanChars.join('');
  const ranges = protectedRanges(clean.toLowerCase(), protect);
  const isProtected = (s, e) => ranges.some(([a, b]) => s >= a && e <= b);

  // 2. token-level corrections; every output character remembers the span of `clean` it came from
  const out = [];
  const from = [];
  const to = [];
  const pass = (start, end) => { for (let k = start; k < end; k++) { out.push(clean[k]); from.push(k); to.push(k + 1); } };
  const swap = (str, start, end) => { for (const c of str) { out.push(c); from.push(start); to.push(end); } };
  const corrections = [];
  let pos = 0;
  for (const m of clean.matchAll(/[A-Za-z]+/g)) {
    const s = m.index;
    const e = s + m[0].length;
    pass(pos, s);
    pos = e;
    const word = m[0];
    const lower = word.toLowerCase();
    // digits glued to the word ("5k", "2nd") make it part of an amount or a date, never a keyword
    const glued = (s > 0 && /[0-9]/.test(clean[s - 1])) || (e < clean.length && /[0-9]/.test(clean[e]));
    let replacement = null;
    let kind = null;
    if (!glued && !isProtected(s, e)) {
      if (FILLERS.has(lower)) { kind = 'filler'; replacement = ''; }
      else if (ALIASES[lower] && aliasApplies(lower, clean.slice(e))) { kind = 'alias'; replacement = ALIASES[lower]; }
      else { const fz = fuzzyKeyword(lower); if (fz) { kind = 'fuzzy'; replacement = fz; } }
    }
    if (replacement === null) { pass(s, e); continue; }
    corrections.push({ kind, from: word, to: replacement, index: cleanSrc[s], length: cleanSrc[e - 1] + 1 - cleanSrc[s] });
    if (kind === 'filler') pos = e + /^[,\s]*/.exec(clean.slice(e))[0].length;      // drop the filler and the comma / spaces after it
    else swap(matchCase(word, replacement), s, e);
  }
  pass(pos, clean.length);

  const joined = out.join('');
  const text = joined.trim();
  const lead = joined.length - joined.trimStart().length;

  // 3. map a span [start, end) of the normalized text back to the original text
  const toOriginal = (start, end) => {
    if (!out.length) return { start: 0, end: 0 };
    const a = Math.min(out.length - 1, start + lead);
    const b = Math.max(a, Math.min(out.length, end + lead) - 1);
    let last = 0;
    for (let k = a; k <= b; k++) last = Math.max(last, to[k]);
    return { start: cleanSrc[from[a]], end: cleanSrc[Math.max(last, 1) - 1] + 1 };
  };

  return { original, text, corrections, changed: text !== original.trim(), toOriginal };
}

// "“lon” → “loan”, “payed” → “paid”" for the proposal preview; fillers are not worth mentioning.
export function describeCorrections(corrections, limit = 3) {
  return corrections.filter((c) => c.kind !== 'filler' && c.to).slice(0, limit).map((c) => `“${c.from}” → “${c.to}”`).join(', ');
}
