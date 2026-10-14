// liabilityLanguage.js - understanding "add my HDFC personal loan" (Issue #79).
//
// Everything liability-specific about natural language lives here, as pure functions (no I/O, no model):
//   - creation vs repayment: when a sentence ADDS a liability and when it pays one down
//   - the liability type from wording ("car loan" -> vehicle_loan), and a lender, from the user's own words
//   - a deterministic name ("HDFC Personal Loan") built only from grounded text
//   - role-labelled numbers in ONE pass: outstanding balance, interest rate, monthly payment and loan term, so that
//     "3 lakh at 11.5% EMI 9,200 for 3 years" is four different things and "11.5%" or "3 years" is never money
//   - deterministic edits of a pending proposal ("EMI is 9500", "call it HDFC Car Loan")
//
// Locked semantics (see the manual route): name, type, outstanding balance, interest rate and monthly payment are ALL
// required and never defaulted or guessed. A stated 0 for the rate or the payment is a real value. A loan term and a
// lender are recognised, but only the lender (inside the name) survives: there is no column for either.
import { scanAmounts, chooseAmount } from './numberParser.js';

export const LIABILITY_TYPES = Object.freeze(['home_loan', 'personal_loan', 'vehicle_loan', 'education_loan', 'credit_card', 'other']);
export const TYPE_LABEL = Object.freeze({
  home_loan: 'Home loan', personal_loan: 'Personal loan', vehicle_loan: 'Vehicle loan',
  education_loan: 'Education loan', credit_card: 'Credit card', other: 'Other',
});
// The name a type gets when the user gave no phrase of their own (e.g. the type was answered separately).
const TYPE_NAME = Object.freeze({
  home_loan: 'Home Loan', personal_loan: 'Personal Loan', vehicle_loan: 'Vehicle Loan',
  education_loan: 'Education Loan', credit_card: 'Credit Card', other: 'Other Loan',
});
export const MAX_NAME_LENGTH = 120;

// ── Type ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Whole-word phrases, most specific first. "EMI" is a payment concept, never a type; "card" alone is ambiguous.
const TYPE_PATTERNS = [
  ['other', /\bloan\s+against\s+(?:property|shares|securities|fd|gold)\b/i],
  ['other', /\b(?:business|gold|lap|bnpl)\s+loans?\b/i],
  ['other', /\b(?:buy\s+now\s+pay\s+later|pay\s+later)\b/i],
  ['credit_card', /\bcredit\s*cards?(?:\s+(?:debt|balance|dues|outstanding|bill))?\b/i],
  ['credit_card', /\bcard\s+(?:debt|balance|dues|outstanding)\b/i],
  ['vehicle_loan', /\b(?:car|bike|vehicle|auto|scooter|motorcycle|motorbike|two[\s-]?wheeler|four[\s-]?wheeler)\s+loans?\b/i],
  ['home_loan', /\b(?:home|house|housing)\s+loans?\b/i],
  ['home_loan', /\bmortgages?\b/i],
  ['education_loan', /\b(?:education|educational|student|study)\s+loans?\b/i],
  ['personal_loan', /\bpersonal\s+loans?\b/i],
];

const titleCase = (s) => s.split(/\s+/).filter(Boolean).map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');

// -> { type, phrase, index, typeWords } | { ambiguous: 'card' | 'multiple' } | null
//   typeWords: the user's own words for the type, title-cased, used in the generated name ("Car Loan")
export function liabilityTypeOf(text) {
  const t = String(text ?? '');
  const hits = [];
  for (const [type, re] of TYPE_PATTERNS) {
    const m = re.exec(t);
    if (m) hits.push({ type, phrase: m[0], index: m.index });
  }
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.index <= h.index && o.index + o.phrase.length >= h.index + h.phrase.length && o.phrase.length > h.phrase.length));
  const types = [...new Set(kept.map((h) => h.type))];
  if (types.length > 1) return { ambiguous: 'multiple' };
  if (kept.length) {
    const h = kept[0];
    const words = /card/i.test(h.phrase) && h.type === 'credit_card' ? 'Credit Card' : /mortgage/i.test(h.phrase) ? 'Mortgage' : titleCase(h.phrase.replace(/\s+/g, ' ').replace(/([a-z])-([a-z])/gi, '$1-$2'));
    return { type: h.type, phrase: h.phrase, index: h.index, typeWords: words };
  }
  if (/\bcards?\b/i.test(t) && /\b(?:loans?|debts?|dues|balance)\b/i.test(t)) return { ambiguous: 'card' };
  return null;
}

// The answer to "What kind of liability is it?": "personal", "a home loan", "credit card", "other"...
export function parseTypeAnswer(text) {
  const direct = liabilityTypeOf(text);
  if (direct?.type) return { type: direct.type };
  if (direct?.ambiguous) return null;
  const t = String(text ?? '').toLowerCase().replace(/[^a-z' -]/g, ' ').replace(/\b(?:it'?s|it is|its|a|an|the|my|loan|liability|type|kind|of|is|that|one|this|please)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(?:home|house|housing|mortgage)$/.test(t)) return { type: 'home_loan' };
  if (t === 'personal') return { type: 'personal_loan' };
  if (/^(?:car|bike|vehicle|auto|scooter|motorcycle|motorbike|two wheeler|four wheeler)$/.test(t)) return { type: 'vehicle_loan' };
  if (/^(?:education|educational|student|study)$/.test(t)) return { type: 'education_loan' };
  if (/^(?:credit card|creditcard|credit)$/.test(t)) return { type: 'credit_card' };
  if (/^(?:other|others|business|gold|something else|none of these|anything else)$/.test(t)) return { type: 'other' };
  return null;
}

// ── Creation vs repayment ──────────────────────────────────────────────────────────────────────────────────────────
const LOAN_NOUN = /\b(?:loans?|debts?|liabilit(?:y|ies)|credit\s*cards?|mortgage|card\s+(?:debt|balance|dues))\b/i;
const CREATE_VERB = /^(?:i\s+)?(?:(?:want|need|would\s+like)\s+to\s+|'d\s+like\s+to\s+)?(?:add|create|register|record|log|enter)\b/i;
const POSSESSION = /^(?:so\s+)?(?:i|we)(?:'ve|\s+have|\s+had|\s+got|\s+own|\s+owe|\s+owed|\s+took|\s+taken|\s+borrowed|\s+borrow|\s+(?:currently|still|just|recently|already)\s+(?:have|owe|took|borrowed))\b/i;
// "I will pay monthly 2000" / "paying 9200 a month" describe the loan's own EMI, not a payment being made now.
const FUTURE_PAYING = /\b(?:will|would|gonna|going\s+to|shall)\s+(?:be\s+)?pay(?:ing)?\b|\bpay(?:ing|s)?\s+(?:monthly|per\s+month|every\s+month|a\s+month)\b/gi;
const PAYING_RAW = /\b(?:paid|pay|paying|repaid|repay|repaying|repayments?|settled|settle|cleared|clear)\b/i;
const PAYING = { test: (t) => PAYING_RAW.test(String(t).replace(FUTURE_PAYING, ' ')) };
// "add 5,000 TO my car loan", "put 6000 TOWARD my HDFC loan": a preposition links the amount to an existing liability.
const REPAYMENT_LINK = /\b(?:to|toward|towards|on|against|into)\s+(?:(?:my|the|our|a|an|this|that)\s+)?(?:[\w&.'-]+\s+){0,3}?(?:loans?|debts?|liabilit\w*|emis?|credit\s*cards?|mortgage|card\s+(?:debt|balance|dues))\b/i;

// A card BILL or a purchase on a card is a spending event, not a new liability.
const NOT_A_BALANCE = /\b(?:bills?|statements?|swiped|spent|spend|bought|purchased?|due\s+date)\b/i;

// 'create' (add/create the loan), 'possession' (I have / I owe), 'borrow' (I took / I borrowed) or null.
// Strict on purpose: a repayment sentence must never be read as a creation.
export function liabilityCreationCue(text) {
  const t = String(text ?? '').trim();
  if (!t || /\?/.test(t)) return null;
  if (PAYING.test(t) || NOT_A_BALANCE.test(t)) return null;
  if (POSSESSION.test(t)) {
    if (!LOAN_NOUN.test(t) && !/\bborrow(?:ed)?\b/i.test(t)) return null;
    return /\b(?:took|taken|borrowed|borrow)\b/i.test(t) ? 'borrow' : 'possession';
  }
  if (CREATE_VERB.test(t) && LOAN_NOUN.test(t) && !REPAYMENT_LINK.test(t)) return 'create';
  return null;
}

// A wider test used only to judge a language model's reading of a sentence the strict grammar did not recognise
// ("took a 5 lakh loan from sbi last year"): a creation / possession / borrowing word, a loan concept, no payment
// verb, and no preposition tying an amount to an existing liability.
export function liabilityCreationCueLoose(text) {
  const t = String(text ?? '');
  if (!t.trim() || /\?/.test(t) || PAYING.test(t) || REPAYMENT_LINK.test(t)) return false;
  return /\b(?:add|create|register|have|has|got|own|owe|owed|took|taken|borrowed|borrow)\b/i.test(t) && (LOAN_NOUN.test(t) || /\bborrow(?:ed)?\b/i.test(t));
}

// ── Numbers, by role ───────────────────────────────────────────────────────────────────────────────────────────────
const maskSpan = (s, index, length) => s.slice(0, index) + ' '.repeat(length) + s.slice(index + length);
const SMALL_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };

const RATE_NUM = /(?<![\d.])(\d+(?:\.\d+)?)\s*(?:%|per\s?cent\b|percent\b)(?:\s*(?:p\.?a\.?|per\s+(?:year|annum)|annually|a\s+year|yearly))?/gi;
const RATE_CUE = /\b(?:interest|rate)(?:\s+rate)?(?:\s+(?:of|at|is|=|:))?\s*(\d+(?:\.\d+)?)(?!\s*(?:lakh|lac|k\b|crore|thousand|%|per\s?cent|percent|\d|years?|yrs?|months?))/gi;
const RATE_PA = /(?<![\d.])(?:at\s+)?(\d+(?:\.\d+)?)\s*(?:p\.?a\.?|per\s+(?:year|annum)|annually)(?![a-z])/gi;
const RATE_WORDS = /\b([a-z]+(?:\s+[a-z]+){0,2})\s+(?:percent|per\s?cent)\b/gi;
const TERM_NUM = /(?<![\d.])(\d+(?:\.\d+)?)\s*(years?|yrs?|months?|mos?)\b/gi;
const TERM_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\s+(years?|months?)\b/gi;
const ZERO_RATE = /\b(?:zero|no|nil)\s+interest\b|\binterest[\s-]free\b|\b(?:zero|nil)\s*(?:%|percent|per\s?cent)/i;
const ZERO_PAYMENT = /\b(?:no|zero|nil)\s+(?:fixed\s+)?(?:emis?|payments?|instal?lments?)\b|\b(?:emis?|payments?)\s+(?:is\s+|of\s+)?(?:zero|nil|none)\b/i;

const PAY_BEFORE = /(?:\bemis?|\binstal?lments?|\bmonthly(?:\s+(?:payment|emi|instal?lment|repayment))?|\bpayments?|\bpay(?:ing)?)\s*(?:(?:of|is|are|=|:|at|about|around|roughly|approximately|rs\.?|₹|inr)\s*)*$/i;
const PAY_AFTER = /^\s*(?:per\s+month|a\s+month|\/\s*(?:month|mo)\b|monthly|every\s+month|emi\b|instal?lments?\b)/i;
// "3 lakh monthly 9200": the word after the 3 lakh belongs to the NEXT number, so it says nothing about the 3 lakh.
const PAY_WORD_THEN_NUMBER = /^\s*(?:monthly|emis?|instal?lments?)\b(?:\s+(?:payment|of|is|are|=|:|at|rs\.?|₹|inr))*\s*\d/i;
const OWE_BEFORE = /(?:\bloan|\bdebt|\boutstanding|\bowe|\bowing|\bowed|\bbalance|\bborrowed|\bborrow|\btook|\btaken|\bof|\bfor|\bworth|\bdue|\bamount|\bis)\s*(?:(?:of|is|=|:|about|around|roughly|approximately|rs\.?|₹|inr)\s*)*$/i;
const OWE_AFTER = /^\s+(?:[A-Za-z&.'-]+\s+){0,3}?(?:loans?|debts?|liabilit\w*|mortgage|credit\s*cards?|outstanding)\b/i;

const decimals = (s) => (s.split('.')[1] ?? '').length;

// The value of a phrase that is NOTHING but one number written in words ("ten", "nine thousand two hundred"); else null.
function wholeNumberWords(phrase) {
  const { found, unclear } = scanAmounts(phrase, { relaxed: true });
  return !unclear.length && found.length === 1 && found[0].raw.trim() === phrase.trim() ? found[0].value : null;
}

// One pass over the sentence. Rates and terms are cut out FIRST (so "11.5%" and "3 years" can never be money), then
// every remaining money amount is given a role from the words right around it. No role is ever chosen by size or by
// "marked beats bare".
//   -> { outstanding?, rate?, payment?, term?, unassigned: [...], issues: {...} }
//      each of outstanding / payment: { value, raw, index }; rate: { value, text, raw, index }; term: { n, unit, raw, index }
export function parseLiabilityNumbers(text) {
  const src = String(text ?? '');
  let work = src;
  const out = { unassigned: [], issues: {} };

  // 1. rate
  const rates = [];
  const grab = (re, valueOf = (m) => m[1]) => {
    for (const m of work.matchAll(re)) rates.push({ text: valueOf(m), raw: m[0], index: m.index });
    for (const r of rates) if (work.slice(r.index, r.index + r.raw.length) === r.raw) work = maskSpan(work, r.index, r.raw.length);
  };
  grab(RATE_NUM);
  grab(RATE_PA);
  grab(RATE_CUE);
  for (const m of work.matchAll(RATE_WORDS)) {
    const words = m[1].trim().split(/\s+/);
    for (let k = 0; k < words.length; k++) {
      const phrase = words.slice(k).join(' ');
      const spoken = wholeNumberWords(phrase);
      if (spoken !== null) {
        const at = m.index + m[0].indexOf(phrase);
        rates.push({ text: String(spoken), raw: m[0].slice(m[0].indexOf(phrase)), index: at });
        work = maskSpan(work, at, m[0].length - m[0].indexOf(phrase));
        break;
      }
    }
  }
  if (rates.length) {
    const distinct = [...new Set(rates.map((r) => r.text))];
    if (distinct.length > 1) out.issues.rateAmbiguous = distinct;
    const r = rates[0];
    const value = Number(r.text);
    if (!(value >= 0 && value <= 100) || decimals(r.text) > 4) out.issues.rateInvalid = r.text;
    else out.rate = { value, text: r.text, raw: r.raw, index: r.index };
  } else if (ZERO_RATE.test(src)) {
    out.rate = { value: 0, text: '0', raw: ZERO_RATE.exec(src)[0], index: ZERO_RATE.exec(src).index };
  }

  // 2. term (recognised, never stored, never money)
  const terms = [];
  for (const m of work.matchAll(TERM_NUM)) terms.push({ n: Number(m[1]), unit: /^y/i.test(m[2]) ? 'years' : 'months', raw: m[0], index: m.index });
  for (const m of work.matchAll(TERM_WORDS)) terms.push({ n: SMALL_WORDS[m[1].toLowerCase()], unit: /^y/i.test(m[2]) ? 'years' : 'months', raw: m[0], index: m.index });
  for (const t of terms) work = maskSpan(work, t.index, t.raw.length);
  if (terms.length) out.term = terms[0];

  // 3. money, by role
  const scan = scanAmounts(work);
  if (scan.unclear.length) out.issues.amountUnclear = true;
  const owe = [];
  const pay = [];
  for (const a of scan.found) {
    const before = work.slice(Math.max(0, a.index - 40), a.index);
    const after = work.slice(a.index + a.raw.length, a.index + a.raw.length + 60);
    if (PAY_BEFORE.test(before) || (PAY_AFTER.test(after) && !PAY_WORD_THEN_NUMBER.test(after))) pay.push(a);
    else if (OWE_BEFORE.test(before) || OWE_AFTER.test(after)) owe.push(a);
    else out.unassigned.push(a);
  }
  const distinctValues = (list) => [...new Set(list.map((a) => a.value))];
  if (pay.length) {
    if (distinctValues(pay).length > 1) out.issues.paymentAmbiguous = distinctValues(pay);
    else out.payment = { value: pay[0].value, raw: pay[0].raw, index: pay[0].index };
  } else if (ZERO_PAYMENT.test(src)) {
    out.payment = { value: 0, raw: ZERO_PAYMENT.exec(src)[0], index: ZERO_PAYMENT.exec(src).index };
  }
  if (owe.length) {
    if (distinctValues(owe).length > 1) out.issues.outstandingAmbiguous = distinctValues(owe);
    else out.outstanding = { value: owe[0].value, raw: owe[0].raw, index: owe[0].index };
    // an amount with no role of its own next to a clear balance is just another candidate for the question
    if (out.unassigned.length) out.issues.outstandingAmbiguous = [...new Set([...(out.issues.outstandingAmbiguous ?? distinctValues(owe)), ...distinctValues(out.unassigned)])];
  } else if (out.unassigned.length) {
    const values = distinctValues(out.unassigned);
    if (values.length === 1) {
      out.outstanding = { value: values[0], raw: out.unassigned[0].raw, index: out.unassigned[0].index };
      out.unassigned = [];                                   // the one remaining amount IS the balance
    }
    else out.issues.outstandingAmbiguous = values;
  }
  if (out.issues.outstandingAmbiguous) delete out.outstanding;
  return out;
}

// Evidence helpers for checking spans a language model pointed at (see provenanceValidator.js).
// A rate span must say it is a rate; a payment span must sit next to an EMI / monthly cue; a term span must be a time.
export function hasRateEvidence(before, spanText) {
  return /%|percent|per\s?cent|p\.?a\.?\b|interest|\brate\b/i.test(spanText) || /\b(?:interest|rate)(?:\s+rate)?(?:\s+(?:of|at|is|=|:))?\s*$/i.test(before);
}
export function hasPaymentEvidence(before, after, spanText) {
  return /\b(?:emis?|monthly|instal?lments?|per\s+month|a\s+month)\b/i.test(spanText) || PAY_BEFORE.test(before) || PAY_AFTER.test(after);
}
// "3 years", "36 months", "five years" -> { n, unit } | null. Never a money amount.
export function parseTermSpan(text) {
  const t = String(text ?? '').trim();
  let m = /^(\d+(?:\.\d+)?)\s*(years?|yrs?|months?|mos?)$/i.exec(t);
  if (m) return { n: Number(m[1]), unit: /^y/i.test(m[2]) ? 'years' : 'months' };
  m = /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\s+(years?|months?)$/i.exec(t);
  return m ? { n: SMALL_WORDS[m[1].toLowerCase()], unit: /^y/i.test(m[2]) ? 'years' : 'months' } : null;
}

// ── Lender and name ────────────────────────────────────────────────────────────────────────────────────────────────
const ACRONYM_BANKS = new Set(['sbi', 'hdfc', 'icici', 'pnb', 'bob', 'lic', 'idfc', 'rbl', 'hsbc', 'sbm', 'uco', 'bofa', 'amex']);
const NOT_LENDER = new Set(['a', 'an', 'the', 'my', 'our', 'some', 'friend', 'friends', 'family', 'relative', 'relatives', 'brother', 'sister', 'dad', 'mom', 'father', 'mother', 'uncle', 'aunt', 'him', 'her', 'them', 'someone', 'somebody', 'people', 'bank', 'others', 'other', 'one', 'cousin', 'neighbour', 'neighbor', 'colleague', 'boss']);
const LENDER_STOP = new Set(['for', 'at', 'with', 'of', 'emi', 'in', 'on', 'and', 'so', 'by', 'that', 'which', 'since', 'last', 'this', 'next', 'to', 'a', 'an', 'the', 'my', 'is', 'was', 'it', 'as', 'under', 'over', 'around', 'about', 'per', 'interest', 'rate']);
const PRE_STOP = new Set(['my', 'the', 'a', 'an', 'new', 'another', 'our', 'one', 'add', 'create', 'have', 'got', 'took', 'take', 'taken', 'i', 'ive', "i've", 'we', 'owe', 'owed', 'of', 'for', 'with', 'big', 'small', 'old', 'huge', 'large', 'little', 'some', 'existing', 'current', 'is', 'was', 'it', 'this', 'that', 'and', 'please', 'want', 'to', 'record', 'register', 'enter', 'log', 'save', 'set', 'up', 'open', 'borrowed', 'borrow', 'at', 'from', 'in', 'on', 'per', 'rs', 'inr', 'lakh', 'lakhs', 'lac', 'lacs', 'thousand', 'crore', 'k', 'cr', 'worth', 'amount', 'total', 'second', 'first', 'third', 'outstanding', 'still', 'currently', 'just', 'recently', 'already', 'also', 'loan', 'loans', 'debt', 'liability', 'about', 'around', 'emi']);

function lenderCase(words) {
  return words.map((w) => (ACRONYM_BANKS.has(w.toLowerCase()) ? w.toUpperCase() : w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

// The lender named in the sentence, from the user's own words only: "from SBI" / "HDFC personal loan". null if none is clear.
export function extractLender(text, typeIndex) {
  const t = String(text ?? '');
  const fm = /\bfrom\s+(?:the\s+)?([A-Za-z][A-Za-z&.'-]*(?:\s+[A-Za-z&.'-]+){0,2})/i.exec(t);
  if (fm) {
    const words = [];
    for (const raw of fm[1].split(/\s+/)) {
      const w = raw.replace(/[.,;:!]+$/, '');
      if (!w || LENDER_STOP.has(w.toLowerCase())) break;
      words.push(w);
      if (w !== raw) break;                                  // the sentence ended here
    }
    if (words.length && !NOT_LENDER.has(words[0].toLowerCase())) return lenderCase(words);
    return null;
  }
  if (typeIndex == null || typeIndex <= 0) return null;
  const pre = t.slice(0, typeIndex).replace(/[₹]/g, ' ').split(/\s+/).filter(Boolean);
  const words = [];
  for (let i = pre.length - 1; i >= 0 && words.length < 3; i--) {
    const w = pre[i].replace(/[^A-Za-z&.'-]/g, '');
    if (!w || w !== pre[i].replace(/[,.;:!]+$/, '') || PRE_STOP.has(w.toLowerCase()) || /^\d/.test(pre[i])) break;
    words.unshift(w);
  }
  if (!words.length || (words.length === 1 && /^bank$/i.test(words[0]))) return null;
  return lenderCase(words);
}

// "add a separate liability", "yes add another", "add another one": the user chose to add a second liability. Whole short
// answers only, and any negation or "instead / update / merge" wording means it is NOT a yes.
const NEGATED = /\b(?:don'?t|do not|dont|not|never|no|nope|cancel|stop|instead|update|merge|replace|change|edit|existing)\b/i;
export function isAddAnotherAnswer(text) {
  const t = String(text ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 8 || NEGATED.test(t)) return false;
  return /^(?:yes |yeah |yep |sure |ok |okay |please )*(?:(?:a|the) )?(?:separate|another|new|second)(?: (?:one|liability|loan))?$/.test(t)
    || /^(?:yes |yeah |yep |sure |ok |okay |please )*(?:add|create|make|record|go with) (?:me )?(?:(?:a|an|the) )?(?:separate|another|new|second)(?: (?:one|liability|loan|entry))?(?: (?:anyway|please))?$/.test(t);
}

// The generated name: [lender] + the type words the user used ("Car Loan") or the type's standard words. Never free text.
export function liabilityName({ lender, typeWords, type }) {
  const words = typeWords || (type ? TYPE_NAME[type] : '');
  return [lender, words].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH) || null;
}

export const cleanName = (raw) => String(raw ?? '').replace(/["“”]/g, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);

// ── Extraction ─────────────────────────────────────────────────────────────────────────────────────────────────────
// A NEW request to add a liability. Strict grammar (see liabilityCreationCue); null for anything else.
//   -> { cue, origination, statesBalance, type?, typeWords?, ambiguousType?, lender?, numbers }
export function extractLiabilityCreation(text) {
  const t = String(text ?? '').trim();
  const cue = liabilityCreationCue(t);
  if (!cue) return null;
  const typed = liabilityTypeOf(t);
  const numbers = parseLiabilityNumbers(t);
  const nounAt = LOAN_NOUN.exec(t)?.index;
  const out = {
    cue,
    origination: cue === 'borrow' && !/\b(?:owe|owing|outstanding|still|remaining|due)\b/i.test(t),
    statesBalance: /\b(?:owe|owing|outstanding|still|remaining|due)\b/i.test(t),
    numbers,
  };
  if (typed?.type) { out.type = typed.type; out.typeWords = typed.typeWords; }
  else if (typed?.ambiguous) out.ambiguousType = typed.ambiguous;
  const lender = extractLender(t, typed?.index ?? nounAt);
  if (lender) out.lender = lender;
  return out;
}

// ── Answers to a single question ───────────────────────────────────────────────────────────────────────────────────
const cleanAnswer = (text) => String(text ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/[!?,;]+/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/^(?:it'?s|it is|its|the|about|around|roughly|approximately|is|there'?s|there is)\s+/, '').replace(/[.]+$/, '').trim();
const ZERO_ANSWER = /^(?:0+(?:\.0+)?\s*(?:%|percent|per cent)?|zero(?:\s+(?:percent|interest|emi|payment))?|none|nil|nothing|n\/a|no\s+(?:interest|emi|payment|fixed payment|fixed emi)|interest[ -]free|0 rupees)$/;

// -> { status: 'ok', value } | { status: 'invalid', value } | null
export function parseRateAnswer(text) {
  const c = cleanAnswer(text);
  if (ZERO_ANSWER.test(c)) return { status: 'ok', value: 0 };
  const roles = parseLiabilityNumbers(text);
  if (roles.issues.rateInvalid) return { status: 'invalid', value: roles.issues.rateInvalid };
  if (roles.rate) return { status: 'ok', value: roles.rate.value };
  const m = /^(\d+(?:\.\d+)?)(?:\s*(?:p\.?a\.?|per year|per annum|a year|yearly|annually))?$/.exec(c);
  if (m) {
    const v = Number(m[1]);
    return v >= 0 && v <= 100 && decimals(m[1]) <= 4 ? { status: 'ok', value: v } : { status: 'invalid', value: m[1] };
  }
  if (!/\d/.test(c)) {
    const w = wholeNumberWords(c);
    if (w !== null) return w <= 100 ? { status: 'ok', value: w } : { status: 'invalid', value: String(w) };
  }
  return null;
}

// -> { status: 'ok', value } | { status: 'many' } | null
export function parsePaymentAnswer(text) {
  const c = cleanAnswer(text);
  if (ZERO_ANSWER.test(c) && !/%|percent|per cent/.test(c)) return { status: 'ok', value: 0 };
  const roles = parseLiabilityNumbers(text);
  if (roles.issues.paymentAmbiguous) return { status: 'many' };
  if (roles.payment) return { status: 'ok', value: roles.payment.value };
  const a = chooseAmount(String(text ?? '').replace(RATE_NUM, ' '));
  if (a.status === 'one') return { status: 'ok', value: a.value };
  if (a.status === 'many') return { status: 'many' };
  return null;
}

// -> { status: 'ok', value } | { status: 'many' } | null
export function parseOutstandingAnswer(text) {
  const roles = parseLiabilityNumbers(text);
  if (roles.outstanding) return { status: 'ok', value: roles.outstanding.value };
  if (roles.issues.outstandingAmbiguous || roles.issues.amountUnclear) return { status: 'many' };
  return null;
}

// ── Edits to a pending proposal ────────────────────────────────────────────────────────────────────────────────────
const ACK = '(?:(?:yes|yeah|yep|yup|sure|ok|okay|no|nope|nah)[,.\\s]+(?:but\\s+)?)?(?:(?:actually|wait|hold on|oh)[,.\\s]+)?(?:please\\s+)?';
const TRAILING = /[,\s]+(?:instead|please|rather|though|then|actually)$/i;
const editBody = (text) => {
  const t = String(text ?? '').trim().replace(/[.!]+$/, '').replace(TRAILING, '');
  const m = new RegExp(`^${ACK}(.+)$`, 'i').exec(t);
  return (m ? m[1] : t).trim();
};
export const REFUSE_MESSAGE = Object.freeze({
  rate: 'The interest rate is required; say 0 if there isn\'t one.',
  payment: 'The monthly payment is required; say 0 if there\'s no fixed payment.',
  name: 'A name is required. Say “call it …” to change it.',
  type: 'The type is required. Say “make it a personal loan” (or home, vehicle, education, credit card, other) to change it.',
  outstanding: 'The outstanding balance is required. Say “make the amount …” to change it.',
});

// -> null | { patch } | { ambiguous: 'amount' | 'rate' | 'payment' } | { refuse: field } | { termNotStored: true }
export function parseLiabilityEdit(text) {
  const b = editBody(text);
  if (!b) return null;
  let m;
  if ((m = /^(?:remove|delete|drop|clear|skip)\s+(?:the\s+)?(interest(?:\s+rate)?|rate|emi|monthly\s+payment|payment|name|type|amount|balance|outstanding(?:\s+(?:amount|balance))?)$/i.exec(b))) {
    const f = m[1].toLowerCase();
    return { refuse: /rate|interest/.test(f) ? 'rate' : /emi|payment/.test(f) ? 'payment' : f === 'name' ? 'name' : f === 'type' ? 'type' : 'outstanding' };
  }
  // name
  if ((m = /^(?:call it|name it|title it|rename it to|rename it|change (?:the )?(?:name|title)(?: it)? to|set (?:the )?(?:name|title) to|make the name)\s+(.+)$/i.exec(b))) {
    const name = cleanName(m[1]);
    return name ? { patch: { nameGiven: name } } : null;
  }
  // type
  if ((m = /^(?:make it|change it to|change (?:the )?type(?: it)? to|set (?:the )?type to|it is|it'?s|should be|it should be)\s+(?:an?\s+)?(.+)$/i.exec(b))) {
    const ty = parseTypeAnswer(m[1]);
    if (ty) return { patch: { type: ty.type, typeWords: undefined, typeChanged: true } };
  }
  // term: recognised, not stored
  if (/^(?:(?:make it|make the (?:term|tenure|duration)|change (?:the )?(?:term|tenure|duration)(?: it)? to|set (?:the )?(?:term|tenure|duration) to|term(?: is)?|tenure(?: is)?|for)\s+)?(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty)\s*(?:years?|yrs?|months?|mos?)(?:\s+instead)?$/i.test(b)) return { termNotStored: true };
  // rate
  if ((m = /^(?:(?:make|change|set|update)\s+(?:the\s+)?)?(?:interest(?:\s+rate)?|rate)\s+(?:to\s+|is\s+|=\s*)?(.+)$/i.exec(b))) {
    const r = parseRateAnswer(m[1]);
    if (r?.status === 'ok') return { patch: { interestRate: r.value } };
    if (r?.status === 'invalid') return { rateInvalid: r.value };
  }
  // payment
  if ((m = /^(?:(?:make|change|set|update)\s+(?:the\s+)?)?(?:emi|monthly\s+payment|monthly\s+emi|payment|instal?lment)\s+(?:to\s+|is\s+|=\s*|of\s+)?(.+)$/i.exec(b))) {
    const p = parsePaymentAnswer(m[1]);
    if (p?.status === 'ok') return { patch: { monthlyPayment: p.value } };
    if (p?.status === 'many') return { ambiguous: 'payment' };
  }
  // balance
  if ((m = /^(?:(?:make|change|set|update)\s+(?:the\s+)?)?(?:amount|balance|outstanding(?:\s+(?:amount|balance))?|principal|loan amount)\s+(?:to\s+|is\s+|=\s*|of\s+)?(.+)$/i.exec(b))) {
    const o = parseOutstandingAnswer(m[1]);
    if (o?.status === 'ok') return { patch: { outstandingAmount: o.value, balanceConfirmed: true } };
    if (o?.status === 'many') return { ambiguous: 'amount' };
  }
  // "make it 4 lakh": a bare amount on a liability proposal is the balance
  if ((m = /^(?:make it|change it to|set it to|it should be|should be)\s+(.+)$/i.exec(b))) {
    const o = parseOutstandingAnswer(m[1]);
    if (o?.status === 'ok') return { patch: { outstandingAmount: o.value, balanceConfirmed: true } };
    if (o?.status === 'many') return { ambiguous: 'amount' };
  }
  return null;
}
