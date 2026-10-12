// numberParser.js - exact money amounts from text, written or spoken (Issue #77).
//
// Digit forms ("₹500", "5k", "4.5k", "1,25,000", "1.5 lakh") and number words ("five thousand", "one lakh twenty
// thousand", "two and a half thousand", "six five zero zero") both end up as the same thing: a Number of rupees computed
// with BigInt arithmetic. There is no floating-point multiplication anywhere.
//
// Rules this module enforces on purpose:
//   - Number words only count in a likely MONEY SLOT: a currency marker, a scale word (hundred, thousand, lakh, crore, k),
//     or a payment verb right before them. "Five Guys", "Seven Eleven" and "Two Wheeler" are never read as amounts, and
//     a lone "one".."nine" is never an amount unless it is marked ("five rupees").
//   - A number followed by a dangling fraction ("2 and a half") is never accepted as the bare leading number: the whole
//     phrase is parsed ("2 and a half thousand" = 2500) or reported as unclear. It can never become ₹2.
//   - Exactly two spoken digits ("six five") and mixed forms ("6 five 00") are unclear, not guesses.
//   - "million" / "billion" are not part of the Indian money scale: reported as unclear, never silently interpreted.
//   - Unclear amounts are reported separately; callers turn them into a clarification question.
//
// Pure functions, no I/O.

const UNIT = {
  k: 1000, hundred: 100, thousand: 1000, lakh: 100000, lakhs: 100000, lac: 100000, lacs: 100000,
  crore: 10000000, crores: 10000000, cr: 10000000,
};
const AMOUNT_RE = /(?<![\w.])((?:₹|rs\.?|inr)\s*)?(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?(?:\s*(k|hundred|thousand|lakhs?|lacs?|crores?|cr)\b)?(\s*(?:rupees?|rs\b\.?|inr\b))?(?![A-Za-z0-9])/gi;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

// Exact decimal scaling with BigInt (1.5 lakh -> 150000, 0.1 k -> 100); never floating-point multiplication.
export function scaleDecimal(intDigits, fracDigits, multiplier) {
  const frac = fracDigits ?? '';
  const scaled = (BigInt(intDigits + frac) * BigInt(multiplier)).toString().padStart(frac.length + 1, '0');
  const whole = frac ? scaled.slice(0, scaled.length - frac.length) : scaled;
  const decimals = frac ? scaled.slice(scaled.length - frac.length).replace(/0+$/, '') : '';
  return Number(decimals ? `${whole}.${decimals}` : whole);
}

// ── Number words ───────────────────────────────────────────────────────────────────────────────────────────────────
const DIGIT_WORDS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEEN_WORDS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS_WORDS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE_WORDS = { thousand: [1000n, 1], k: [1000n, 1], lakh: [100000n, 2], lakhs: [100000n, 2], lac: [100000n, 2], lacs: [100000n, 2], crore: [10000000n, 3], crores: [10000000n, 3] };
const UNSUPPORTED_SCALES = new Set(['million', 'millions', 'billion', 'billions', 'trillion', 'trillions']);

// The word just before a number word that makes it a money slot when there is no scale word or currency marker
// ("spent fifty on tea", "gave six five zero zero for my EMI").
const MONEY_CONTEXT = new Set([
  'spent', 'spend', 'spending', 'paid', 'pay', 'paying', 'gave', 'give', 'given', 'giving', 'cost', 'costs', 'costed',
  'add', 'added', 'put', 'repay', 'repaid', 'record', 'log', 'enter', 'send', 'sent', 'deposit', 'contribute', 'save',
  'saved', 'invest', 'move', 'got', 'received', 'earned', 'bought', 'charged', 'budget', 'budgets', 'limit',
]);
const MONEY_FILLER = new Set(['rs', 'rupees', 'rupee', 'inr', 'of', 'about', 'around', 'just', 'only', 'roughly', 'nearly', 'approximately', 'total']);
// "spent two days", "paid fifty people": a count of something, not an amount.
const COUNT_NOUN = new Set([
  'times', 'time', 'days', 'day', 'weeks', 'week', 'months', 'month', 'years', 'year', 'hours', 'hour', 'minutes',
  'minute', 'people', 'persons', 'person', 'guys', 'items', 'item', 'pieces', 'piece', 'tickets', 'ticket', 'kg', 'km',
  'litres', 'liters', 'percent', 'per', 'pm', 'am', 'members', 'friends', 'gram', 'grams', 'gm', 'ml', 'litre', 'liter',
  'kilo', 'kilos', 'kgs', 'meters', 'metres', 'units', 'shares', 'pcs', 'packs', 'rooms', 'seats', 'steps',
]);

function classify(word) {
  const w = word.toLowerCase();
  if (w in DIGIT_WORDS) return { type: 'digit', val: BigInt(DIGIT_WORDS[w]) };
  if (w in TEEN_WORDS) return { type: 'teen', val: BigInt(TEEN_WORDS[w]) };
  if (w in TENS_WORDS) return { type: 'tens', val: BigInt(TENS_WORDS[w]) };
  if (w === 'hundred') return { type: 'hundred' };
  if (w in SCALE_WORDS) return { type: 'scale', val: SCALE_WORDS[w][0], rank: SCALE_WORDS[w][1] };
  if (UNSUPPORTED_SCALES.has(w)) return { type: 'unsupported' };
  if (w === 'and' || w === 'a' || w === 'half') return { type: w };
  return null;
}

function tokenize(text) {
  const tokens = [];
  for (const m of String(text).matchAll(/₹|[A-Za-z]+|\d+|\S/g)) {
    const t = { text: m[0], lower: m[0].toLowerCase(), index: m.index, end: m.index + m[0].length };
    if (/^\d+$/.test(t.text)) { t.type = 'num'; t.val = BigInt(t.text); }
    else if (/^[A-Za-z]+$/.test(t.text)) Object.assign(t, classify(t.text) ?? { type: 'word' });
    else t.type = 'other';
    tokens.push(t);
  }
  return tokens;
}

const isNumberish = (t) => ['digit', 'teen', 'tens', 'hundred', 'scale', 'unsupported', 'half'].includes(t.type);

// Evaluates one run of number tokens. -> { ok: true, value, kind } | { ok: false, reason } | null (not an amount)
//   kind: 'digits' (spoken digit string) | 'scaled' (has hundred/thousand/lakh/crore/k) | 'implicit' ("four fifty") | 'plain'
function evalRun(tokens, marked = false) {
  if (tokens.some((t) => t.type === 'unsupported')) return { ok: false, reason: 'unsupported-scale' };

  const allDigits = tokens.every((t) => t.type === 'digit' || t.type === 'num');
  if (allDigits) {
    if (!tokens.some((t) => t.type === 'digit')) return null;
    if (tokens.some((t) => t.type === 'num')) return { ok: false, reason: 'mixed-digits-and-words' };
    if (tokens.length === 1) {                                         // a lone "five" is only an amount when marked ("five rupees")
      return marked && tokens[0].val > 0n ? { ok: true, value: tokens[0].val, kind: 'plain' } : null;
    }
    if (tokens.length === 2) return { ok: false, reason: 'two-spoken-digits' };
    const s = tokens.map((t) => t.val.toString()).join('');
    if (s.length > 9) return { ok: false, reason: 'too-many-digits' };
    if (s[0] === '0') return { ok: false, reason: 'leading-zero' };
    return { ok: true, value: BigInt(s), kind: 'digits' };
  }

  // "four fifty" -> 450, "six seventy five" -> 675 (Indian speech drops "hundred")
  const T = tokens.map((t) => t.type);
  if (T[0] === 'digit' && tokens[0].val > 0n && T[1] === 'tens' && (T.length === 2 || (T.length === 3 && T[2] === 'digit' && tokens[2].val > 0n))) {
    return { ok: true, value: tokens[0].val * 100n + tokens[1].val + (T.length === 3 ? tokens[2].val : 0n), kind: 'implicit' };
  }

  let total = 0n;
  let cur = 0n;
  let lastRank = 99;
  let pendingA = false;
  let hasScale = false;
  const bad = (reason = 'malformed') => ({ ok: false, reason });
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case 'num':
        if (i !== 0 || t.val === 0n || t.val > 999n) return bad('mixed-digits-and-words');
        cur = t.val;
        break;
      case 'and':
        if (i === 0 || i === tokens.length - 1) return bad();
        break;
      case 'a': {
        const nx = tokens[i + 1];
        if (!nx || !(nx.type === 'hundred' || nx.type === 'scale' || nx.type === 'half')) return bad();
        pendingA = true;
        break;
      }
      case 'digit':
        if (t.val === 0n || cur % 10n !== 0n || cur % 100n === 10n) return bad();
        cur += t.val;
        break;
      case 'teen':
      case 'tens':
        if (cur % 100n !== 0n) return bad();
        cur += t.val;
        break;
      case 'hundred':
        if (pendingA && cur === 0n) cur = 1n;
        pendingA = false;
        if (cur <= 0n || cur >= 100n) return bad();
        cur *= 100n;
        hasScale = true;
        break;
      case 'scale': {
        if (pendingA && cur === 0n) cur = 1n;
        pendingA = false;
        if (cur <= 0n || t.rank >= lastRank) return bad();
        total += cur * t.val;
        cur = 0n;
        lastRank = t.rank;
        hasScale = true;
        break;
      }
      case 'half': {
        // "<N> and a half <scale>" / "half a <scale>": the scale follows (optionally after "a")
        let j = i + 1;
        if (tokens[j]?.type === 'a') j++;
        const sc = tokens[j];
        if (!sc || !(sc.type === 'scale' || sc.type === 'hundred')) return bad('dangling-fraction');
        pendingA = false;
        if (sc.type === 'hundred') {
          if (cur >= 100n) return bad();
          cur = cur * 100n + 50n;
        } else {
          if (sc.rank >= lastRank) return bad();
          total += cur * sc.val + sc.val / 2n;
          cur = 0n;
          lastRank = sc.rank;
        }
        hasScale = true;
        i = j;
        break;
      }
      default:
        return bad();
    }
  }
  if (pendingA) return bad();
  total += cur;
  if (total <= 0n) return bad();
  return { ok: true, value: total, kind: hasScale ? 'scaled' : 'plain' };
}

// Finds the number-word runs in `text`. Returns { found, unclear } with spans into `text`.
function scanWords(text, relaxed) {
  const tokens = tokenize(text);
  const found = [];
  const unclear = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const next = tokens[i + 1];
    const startsRun = t.type === 'digit' || t.type === 'teen' || t.type === 'tens'
      || (t.type === 'a' && (next?.type === 'hundred' || next?.type === 'scale' || next?.type === 'half'))
      || (t.type === 'half' && (next?.type === 'scale' || next?.type === 'hundred' || (next?.type === 'a' && (tokens[i + 2]?.type === 'scale' || tokens[i + 2]?.type === 'hundred'))))
      || (t.type === 'num' && next?.type === 'scale' && ['digit', 'teen', 'tens'].includes(tokens[i + 2]?.type))   // "9 thousand five hundred"
      || (t.type === 'num' && (next?.type === 'digit' || (next?.type === 'and' && (tokens[i + 2]?.type === 'half' || (tokens[i + 2]?.type === 'a' && tokens[i + 3]?.type === 'half')))));
    if (!startsRun) { i++; continue; }

    let j = i;
    for (;;) {
      const nx = tokens[j + 1];
      if (!nx) break;
      const digitMode = tokens.slice(i, j + 1).every((x) => x.type === 'digit' || x.type === 'num');
      if (isNumberish(nx) || nx.type === 'unsupported') { j++; continue; }
      if (nx.type === 'num' && digitMode) { j++; continue; }
      if (nx.type === 'and') {
        const after = tokens[j + 2];
        const afterA = after?.type === 'a' ? tokens[j + 3] : after;
        if (afterA && (afterA.type === 'half' || (!digitMode && (afterA.type === 'digit' || afterA.type === 'teen' || afterA.type === 'tens')))) { j++; continue; }
        break;
      }
      if (nx.type === 'a') {
        const prev = tokens[j];
        const after = tokens[j + 2];
        if ((prev.type === 'and' || prev.type === 'half') && (after?.type === 'half' || after?.type === 'scale' || after?.type === 'hundred')) { j++; continue; }
        break;
      }
      break;
    }
    // trim trailing connectors that ended the run
    let end = j;
    while (end > i && (tokens[end].type === 'and' || tokens[end].type === 'a')) end--;
    const run = tokens.slice(i, end + 1);
    const prevTok = tokens[i - 1];
    const nextTok = tokens[end + 1];
    const marked = Boolean((prevTok && (prevTok.text === '₹' || ['rs', 'inr'].includes(prevTok.lower))) || (nextTok && ['rupees', 'rupee', 'rs', 'inr'].includes(nextTok.lower)));
    const res = evalRun(run, marked || relaxed);
    const raw = text.slice(run[0].index, run[run.length - 1].end);
    const index = run[0].index;

    // the word before the run, skipping fillers like "rs" / "about"
    let k = i - 1;
    while (k >= 0 && MONEY_FILLER.has(tokens[k].lower)) k--;
    const hasContext = k >= 0 && MONEY_CONTEXT.has(tokens[k].lower);
    const countAfter = nextTok && COUNT_NOUN.has(nextTok.lower);

    if (res) {
      if (!res.ok) {
        const signal = relaxed || marked || hasContext || run.some((x) => x.type === 'scale' || x.type === 'hundred' || x.type === 'unsupported' || x.type === 'half');
        if (signal) unclear.push({ raw, index, reason: res.reason });
      } else {
        const strongSlot = marked || res.kind === 'scaled';
        const plainOk = res.kind === 'plain' && (run.length > 1 || res.value >= 10n);
        const accepted = relaxed
          ? true
          : strongSlot ? (marked || !countAfter)
            : (res.kind === 'digits' || res.kind === 'implicit' || plainOk) && hasContext && !countAfter;
        if (accepted && res.value <= BigInt(Number.MAX_SAFE_INTEGER)) found.push({ raw, index, value: Number(res.value), marked, words: true, kind: res.kind });
      }
    }
    i = end + 1;
  }
  return { found, unclear };
}

const DANGLING_AFTER = /^\s*(?:and\s+(?:a\s+)?(?:half|quarter)\b|(?:a\s+)?(?:half|quarter)\b)/i;
const HALF_SCALE_AFTER = /^\s+and\s+(?:a\s+)?half\s+(k|hundred|thousand|lakhs?|lacs?|crores?)\b/i;
const UNSUPPORTED_AFTER = /^\s*(?:million|billion|trillion|mn|bn|mil)s?\b/i;

// Everything amount-like in `text`: -> { found: [{ raw, index, value, marked, words? }], unclear: [{ raw, index, reason }] }
//   relaxed: the text is already known to be an amount phrase (a model-supplied span), so no money-slot context is needed.
export function scanAmounts(text, { relaxed = false } = {}) {
  const src = String(text);
  const base = src.replace(ISO_DATE_RE, (m) => ' '.repeat(m.length));   // dates are not amounts
  const words = scanWords(base, relaxed);
  let masked = base;
  for (const w of [...words.found, ...words.unclear]) masked = masked.slice(0, w.index) + ' '.repeat(w.raw.length) + masked.slice(w.index + w.raw.length);

  const found = [...words.found];
  const unclear = [...words.unclear];
  for (const m of masked.matchAll(AMOUNT_RE)) {
    const end = m.index + m[0].length;
    const after = masked.slice(end);
    const unit = m[4] ? UNIT[m[4].toLowerCase()] : 1;
    const digits = m[2].replace(/,/g, '');
    if (!m[4]) {
      const half = HALF_SCALE_AFTER.exec(after);
      if (half) {
        // "2 and a half thousand": N * scale + scale / 2, exact (every scale is even)
        if (m[3]) { unclear.push({ raw: m[0], index: m.index, reason: 'dangling-fraction' }); continue; }
        const scale = BigInt(UNIT[half[1].toLowerCase()]);
        const value = BigInt(digits) * scale + scale / 2n;
        found.push({ raw: src.slice(m.index, end + half[0].length), index: m.index, value: Number(value), marked: Boolean(m[1]), words: true, kind: 'scaled' });
        continue;
      }
      if (DANGLING_AFTER.test(after)) { unclear.push({ raw: m[0], index: m.index, reason: 'dangling-fraction' }); continue; }
    }
    if (UNSUPPORTED_AFTER.test(after)) { unclear.push({ raw: m[0], index: m.index, reason: 'unsupported-scale' }); continue; }
    if (m[4] && /^\s+\d/.test(after)) { unclear.push({ raw: m[0], index: m.index, reason: 'mixed-digits-and-words' }); continue; }   // "9 thousand 500"
    found.push({
      raw: m[0],
      index: m.index,
      value: scaleDecimal(digits, m[3], unit),
      marked: Boolean(m[1] || m[4] || m[5]),    // has a currency sign / unit / "rupees"
    });
  }
  found.sort((a, b) => a.index - b.index);
  unclear.sort((a, b) => a.index - b.index);
  return { found, unclear };
}

export const findAmounts = (text) => scanAmounts(text).found;
export const findUnclearAmounts = (text) => scanAmounts(text).unclear;

// status: 'none' | 'one' | 'many'. Amounts with a currency sign or unit win over bare numbers ("₹450 for 2 people").
// An amount that cannot be read exactly (dangling "and a half", "six five", "5 million") makes the answer 'many' with
// `unclear: true`: the caller asks, it never falls back to some other number in the sentence.
export function chooseAmount(text) {
  const { found: all, unclear } = scanAmounts(text);
  const marked = all.filter((a) => a.marked);
  const group = marked.length ? marked : all;
  const distinct = [...new Set(group.map((a) => a.value))];
  if (unclear.length) return { status: 'many', values: distinct, unclear: true };
  if (distinct.length === 0) return { status: 'none' };
  if (distinct.length > 1) return { status: 'many', values: distinct };
  return { status: 'one', value: distinct[0], spans: all.map((a) => a.raw), spoken: all.filter((a) => a.words).map((a) => ({ raw: a.raw, value: a.value })) };
}

// Parses a short amount PHRASE (a span a model returned, or a field answer) with no sentence around it.
//   -> { status: 'ok', value } | { status: 'none' } | { status: 'many', values } | { status: 'unclear', reason }
export function parseMoneyText(text) {
  const { found, unclear } = scanAmounts(String(text ?? ''), { relaxed: true });
  if (unclear.length) return { status: 'unclear', reason: unclear[0].reason };
  const distinct = [...new Set(found.map((a) => a.value))];
  if (distinct.length === 0) return { status: 'none' };
  if (distinct.length > 1) return { status: 'many', values: distinct };
  const [value] = distinct;
  const dec = String(value).split('.')[1];
  if (dec && dec.length > 2) return { status: 'unclear', reason: 'too-many-decimals' };
  return { status: 'ok', value };
}

// Number words only ("six thousand five hundred", "six five zero zero"): a convenience for tests and callers.
export const parseNumberWords = (text) => parseMoneyText(text);
