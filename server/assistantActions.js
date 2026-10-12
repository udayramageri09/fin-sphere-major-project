// assistantActions.js - confirmed natural-language financial actions (Issue #73, Phase 1).
//
// The assistant can PROPOSE two things from a chat message: add a transaction, or add money to a savings goal. It never
// writes from the message. The flow is: deterministic extraction -> (one clarifying question at a time while a field is
// missing or ambiguous) -> a server-stored proposal with an exact preview -> the user confirms -> the SAME validators
// and database helpers the manual forms use run (see executeProposal in server.js). The model is not involved: Groq
// being down, or injection text inside a goal title, cannot change what is proposed.
//
// This file has two parts:
//   1. pure extraction / parsing functions (exported, unit-tested, no I/O)
//   2. createAssistantActions(deps): the turn handler that talks to the proposal table through injected helpers
import { randomUUID } from 'node:crypto';
import { findAmounts, chooseAmount, scanAmounts } from './numberParser.js';
import { normalizeActionText, describeCorrections } from './actionNormalization.js';
import { fuzzyCandidates } from './entityMatcher.js';
import { validateProvenance } from './provenanceValidator.js';

export const PROPOSAL_TTL_SECONDS = 180;

// ── 1. Pure text helpers ─────────────────────────────────────────────────────────────────────────────────────────

const POLITE_PREFIX = /^(?:(?:hey|hi|ok|okay)\s+finsphere[,\s]+|finsphere[,\s]+)?(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:i(?:'d| would)?\s+(?:want|like)\s+(?:you\s+)?to\s+)?/i;
const POLITE_SUFFIX = /[\s,]+(?:please|thanks|thank you|for me)[.!\s]*$/i;

export const stripPolite = (text) => String(text ?? '').trim().replace(POLITE_PREFIX, '').replace(POLITE_SUFFIX, '').trim();

const QUESTION_START = /^(?:how|what|whats|what's|why|when|where|which|who|whose|is|are|was|were|do|does|did|am|have|has|should|will|shall|can|could|would|tell|show|explain|give|list|summari[sz]e|compare|calculate)\b/i;
export const isQuestion = (text) => /\?/.test(text) || QUESTION_START.test(stripPolite(text));

const clean = (s) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();

// Whole-utterance yes / no (used for an open clarification and for a confirmation that reaches the chat endpoint).
// These two lists are kept IDENTICAL to src/utils/actionConfirmation.js (a test compares them): a phrase that confirms in
// the browser must read the same here.
export const CONFIRM_PHRASES = [
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'confirm', 'confirmed', 'go ahead', 'do it', 'add it', 'save it',
  'record it', 'set it', 'update it', 'create it', 'haan', 'yes please', 'please do', 'yes confirm', 'yes go ahead',
  'yes do it', 'yes add it', 'yes save it', 'yes record it', 'yes set it', 'yes update it', 'yes create it',
  'sure go ahead', 'ok go ahead', 'okay go ahead', 'looks good', 'that is right', 'correct',
  'yeah sure', 'yes sure', 'sure do it', 'ok do it', 'okay do it', 'yeah do it', 'confirm it',
];
export const CANCEL_PHRASES = [
  'no', 'nope', 'nah', 'cancel', 'cancel it', 'stop', "don't", 'dont', "don't add it", 'dont add it', 'never mind',
  'nevermind', 'forget it', 'leave it', 'no thanks', 'no thank you', 'no cancel', 'nahi', 'nahin', 'abort', 'discard it',
];
const YES = new Set(CONFIRM_PHRASES);
const NO = new Set(CANCEL_PHRASES);
export function parseYesNo(text) {
  const c = clean(text);
  if (YES.has(c)) return 'yes';
  if (NO.has(c)) return 'no';
  return null;
}

// ── Amounts: digits ("₹450", "5k", "1.5 lakh", "1,25,000") and number words ("five thousand", "six five zero zero") ──────
// Parsed by numberParser.js (exact BigInt arithmetic); re-exported here because the extractors and tests use them.
export { findAmounts, chooseAmount };
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;

// ── Dates: today / yesterday / day before yesterday / YYYY-MM-DD, resolved from the CLIENT's local date ──────────────
const UNSUPPORTED_DATE = new RegExp([
  String.raw`\b(?:monday|tuesday|wednesday|thursday|friday|mon|tue|tues|wed|thu|thur|thurs|fri)\b`,
  String.raw`\b(?:last|next|this)\s+(?:week|month|year|weekend)\b`,
  String.raw`\btomorrow\b`,
  String.raw`\b\d{1,2}\s*(?:st|nd|rd|th)\b`,
  String.raw`\b\d{1,2}\s*(?:of\s+)?(?:jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\b`,
  String.raw`\b(?:jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+\d{1,2}\b`,
  String.raw`\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b`,
].join('|'), 'i');

function isRealDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

export function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// -> { kind: 'none' } | { kind: 'ok', date } | { kind: 'unsupported' } | { kind: 'needs-local' }
export function findDate(text, localDate) {
  const t = String(text);
  const iso = ISO_DATE_RE.exec(t);
  if (iso) return isRealDate(Number(iso[1]), Number(iso[2]), Number(iso[3])) ? { kind: 'ok', date: iso[0] } : { kind: 'unsupported' };
  let offset = null;
  if (/\bday before yesterday\b/i.test(t)) offset = -2;
  else if (/\byesterday\b/i.test(t)) offset = -1;
  else if (/\b(?:today|tonight|this morning|this evening|this afternoon)\b/i.test(t)) offset = 0;
  if (offset !== null) return localDate ? { kind: 'ok', date: shiftDate(localDate, offset) } : { kind: 'needs-local' };
  if (UNSUPPORTED_DATE.test(t)) return { kind: 'unsupported' };
  return { kind: 'none' };
}

// ── Transactions ───────────────────────────────────────────────────────────────────────────────────────────────────
const INCOME_CUE = /\b(?:received|receive|earned|earn|salary|salaries|income|credited|bonus|stipend|dividends?|interest|freelance|pocket money|allowance|got paid|paid me|paycheck|commission)\b/i;
const EXPENSE_CUE = /\b(?:spent|spend|spending|paid|pay|bought|buy|purchased|purchase|expense|expenses|cost|bill|charged)\b/i;
const UNSUPPORTED_CLASS = /\b(?:refund|refunded|refunds|reimburse\w*|transfer|transferred|transfers|cashback)\b/i;
const TXN_VERB = /^(?:i\s+)?(?:'ve\s+|have\s+|just\s+)*(?:add|record|log|enter|note(?:\s+down)?|register)\b/i;
const TXN_STATEMENT = /^(?:i\s+)?(?:'ve\s+|have\s+|just\s+)*(?:spent|paid|received|earned|got|bought|purchased)\b/i;
const TXN_NOUN = /\b(?:expenses?|income|transactions?|salary|payment|spending)\b/i;
const TITLE_DROP = /\b(?:add|record|log|enter|note|register|spent|spend|spending|paid|pay|received|receive|earned|earn|got|bought|purchased|expense|expenses|income|transaction|transactions|entry|rupees?|rs|inr|a|an|the|my|new|just|i|ive|i've|have|please)\b/gi;
const EDGE_PREPS = /^(?:for|on|of|to|at|in|from|towards?|as|by|with|and|-|:)+\s+|\s+(?:for|on|of|to|at|in|from|towards?|as|by|with|and)$/i;

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function extractTitle(text, amountRaws) {
  let t = String(text);
  for (const raw of amountRaws) t = t.replace(raw, ' ');
  t = t.replace(new RegExp(ISO_DATE_RE.source, 'g'), ' ')
    .replace(/\b(?:day before yesterday|yesterday|today|tonight|this morning|this evening|this afternoon)\b/gi, ' ')
    .replace(new RegExp(UNSUPPORTED_DATE.source, 'gi'), ' ');   // a date phrase we cannot resolve is asked about, not kept in the title
  t = stripPolite(t).replace(TITLE_DROP, ' ').replace(/["“”']/g, ' ').replace(/[.,;:!]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) t = t.replace(EDGE_PREPS, '').trim();
  return t;
}

// What a message says about one transaction: only fields that are actually present (nothing is guessed).
//   fields: { type?, amount?, title?, titleRaw?, date? }   issues: { amountAmbiguous?, dateIssue? }
export function extractTransaction(text, { localDate, allowForCue = true } = {}) {
  const t = stripPolite(text);
  const fields = {};
  const issues = {};

  const noPaidMe = t.replace(/\bpaid me\b/gi, ' got paid ');
  const income = INCOME_CUE.test(noPaidMe);
  const expense = EXPENSE_CUE.test(noPaidMe.replace(/\bgot paid\b/gi, ' '));
  if (income && !expense) fields.type = 'income';
  else if (expense && !income) fields.type = 'expense';
  else if (!income && !expense && allowForCue && TXN_VERB.test(t) && /\bfor\s+\S/i.test(t)) fields.type = 'expense';   // "Add ₹450 for lunch"
  else if (income && expense) issues.directionConflict = true;

  const amount = chooseAmount(t);
  if (amount.status === 'one') fields.amount = amount.value;
  else if (amount.status === 'many') issues.amountAmbiguous = true;

  const date = findDate(t, localDate);
  if (date.kind === 'ok') fields.date = date.date;
  else if (date.kind === 'unsupported' || date.kind === 'needs-local') issues.dateIssue = date.kind;

  const title = extractTitle(t, amount.status === 'one' ? amount.spans : findAmounts(t).map((a) => a.raw));
  if (title) { fields.titleRaw = title; fields.title = capitalize(title); }
  return { fields, issues, unsupportedClassification: UNSUPPORTED_CLASS.test(t) };
}

// Does this (non-question) message start a transaction? Needs an add/record/log verb or a first-person statement,
// plus an amount or a transaction noun, so "add a goal" or "log in" are not hijacked.
export function looksLikeTransaction(text) {
  const t = stripPolite(text);
  if (!t || isQuestion(t)) return false;
  if (/\b(?:goals?|budgets?|liabilit\w*|loans?|emis?)\b/i.test(t)) return false;
  const scan = scanAmounts(t);
  const hasAmount = scan.found.length > 0 || scan.unclear.length > 0;
  if (TXN_VERB.test(t)) return hasAmount || TXN_NOUN.test(t);
  if (TXN_STATEMENT.test(t)) return hasAmount;
  return false;
}

// ── Goal contributions ─────────────────────────────────────────────────────────────────────────────────────────────
const GOAL_VERB = /^(add|put|contribute|deposit|save|move|invest|set aside)\b\s*(.*)$/i;

export function cleanGoalPhrase(phrase) {
  return String(phrase ?? '').trim()
    .replace(/[.!?]+$/g, '').replace(POLITE_SUFFIX, '')
    .replace(/^["“'‘]+|["”'’]+$/g, '').trim()
    .replace(/^(?:my|the|our)\s+/i, '').replace(/\s+goals?$/i, '').trim();
}

// "Add ₹5,000 to my Goa goal" -> { verb, amount, namePhrase, rawPhrase, hasGoalWord, strongVerb }, or null.
export function extractGoalContribution(text) {
  const t = stripPolite(text);
  if (!t || isQuestion(t)) return null;
  // Loans, EMIs, liabilities, credit cards and budgets are not goals: they are handled (or refused) elsewhere, unless the
  // sentence says "goal" outright.
  if ((/\b(?:loans?|emis?|liabilit(?:y|ies)|credit cards?|mortgage|budgets?)\b/i.test(t)) && !/\bgoals?\b/i.test(t)) return null;
  const m = GOAL_VERB.exec(t);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const rest = ` ${m[2]}`;
  let pm = /\s+(?:to|into|towards?|in)\s+(.*)$/i.exec(rest);
  let viaFor = false;
  if (!pm) { pm = /\s+for\s+(.*\bgoals?\b.*)$/i.exec(rest); viaFor = Boolean(pm); }
  if (!pm) return null;
  const left = rest.slice(0, pm.index);
  const rawPhrase = pm[1].trim().replace(/^(?:my|the|our)\s+/i, '');
  const namePhrase = cleanGoalPhrase(pm[1]);
  const hasGoalWord = /\bgoals?\b/i.test(pm[1]) || viaFor || /\bgoals?\b/i.test(left);
  const amount = chooseAmount(left);
  return {
    verb,
    amount,
    namePhrase,
    rawPhrase: rawPhrase.replace(/[.!?]+$/g, ''),
    hasGoalWord,
    strongVerb: verb === 'contribute',
  };
}

const normKey = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

// Substring / word matches first, then similarity matches (typos, word order) that the first pass missed: entityMatcher.js.
// Candidates are only ever put to the user as a question; none is chosen automatically.
function mergeFuzzy(items, direct, phrase, nameOf, limit) {
  const seen = new Set(direct);
  const extra = fuzzyCandidates(items, phrase, nameOf).filter((x) => !seen.has(x));
  return [...direct, ...extra].slice(0, limit);
}

// Goals whose title equals the phrase exactly (case-insensitive, trimmed); never fuzzy.
export function exactGoalMatches(goals, ...phrases) {
  const keys = phrases.filter(Boolean).map(normKey);
  return goals.filter((g) => keys.includes(normKey(g.title)));
}

// Near-miss suggestions (shown as choices, never chosen automatically).
export function nearGoalMatches(goals, phrase, limit = 5) {
  const p = normKey(phrase);
  if (!p) return [];
  const tokens = p.split(/[^a-z0-9]+/).filter((x) => x.length >= 3);
  const direct = goals.filter((g) => {
    const k = normKey(g.title);
    return k.includes(p) || p.includes(k) || tokens.some((tok) => k.split(/[^a-z0-9]+/).includes(tok) || k.includes(tok));
  });
  return mergeFuzzy(goals, direct, p, (g) => g.title, limit);
}

const ORDINALS = { first: 1, '1st': 1, one: 1, second: 2, '2nd': 2, two: 2, third: 3, '3rd': 3, three: 3, fourth: 4, '4th': 4, four: 4, fifth: 5, '5th': 5, five: 5 };
// Which candidate (index) does the reply choose? null when it does not say, or says something ambiguous.
export function pickCandidate(text, candidates) {
  const c = clean(text);
  if (!c) return null;
  if (candidates.length === 1 && (YES.has(c) || c === 'that one' || c === 'the first one')) return 0;
  let m = /^(?:number |option |no |the )?(\d)$/.exec(c);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= candidates.length) return Number(m[1]) - 1;
  m = /^(?:the )?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)(?: one)?$/.exec(c);
  if (m && ORDINALS[m[1]] <= candidates.length) return ORDINALS[m[1]] - 1;
  const hits = candidates.map((g, i) => [g, i]).filter(([g]) => normKey(g.title) === c);
  return hits.length === 1 ? hits[0][1] : null;
}

// ── Months (budgets): this / current / next / last month, YYYY-MM, "October 2026". A month NAME without a year always
// asks for the year; the year is never inferred. ─────────────────────────────────────────────────────────────────────
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_WORD = '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
const monthIndex = (word) => MONTH_NAMES.findIndex((n) => n.startsWith(word.toLowerCase().slice(0, 3))) + 1;
const MONTH_PATTERN_YM = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/;

export const monthLabel = (ym) => {
  const m = MONTH_PATTERN_YM.exec(ym ?? '');
  return m ? `${capitalize(MONTH_NAMES[Number(ym.slice(5, 7)) - 1])} ${ym.slice(0, 4)}` : String(ym);
};

export function shiftMonth(ym, delta) {
  const total = Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(5, 7)) - 1) + delta;
  const year = Math.floor(total / 12);
  return `${String(year).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

const AMBIGUOUS_MONTH = /\b(?:next|last|this|previous)\s+(?:quarter|year|week|weekend)\b|\bquarter\b|\b\d{1,2}\s*(?:st|nd|rd|th)\b|\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/i;

// -> { kind: 'none' } | { kind: 'ok', month, spans } | { kind: 'needs-year', name, spans } | { kind: 'ambiguous' } | { kind: 'needs-local' }
export function findBudgetMonth(text, localDate) {
  const t = String(text);
  if (AMBIGUOUS_MONTH.test(t)) return { kind: 'ambiguous' };
  // "may" is also a verb: it only counts as a month when a year or a month-style preposition goes with it.
  const nameRe = new RegExp(`\\b${MONTH_WORD}\\b\\.?`, 'gi');
  const names = [...t.matchAll(nameRe)].filter((m) => m[0].replace('.', '').toLowerCase() !== 'may' || /\b(?:for|in|of|during|until|by)\s+may\b|\bmay\s+(?:19|20)\d\d\b/i.test(t));
  const distinct = [...new Set(names.map((m) => monthIndex(m[0])))];
  if (distinct.length > 1) return { kind: 'ambiguous' };
  const iso = /(?<![\d-])((?:19|20)\d\d)-(0[1-9]|1[0-2])(?![\d-])/.exec(t);
  if (iso) return { kind: 'ok', month: `${iso[1]}-${iso[2]}`, spans: [iso[0]] };
  const named = new RegExp(`\\b(${MONTH_WORD})\\b\\.?,?\\s+((?:19|20)\\d\\d)\\b`, 'i').exec(t);
  if (named) return { kind: 'ok', month: `${named[2]}-${String(monthIndex(named[1])).padStart(2, '0')}`, spans: [named[0]] };
  const rel = /\b(this month|current month|next month|last month|previous month)\b/i.exec(t);
  if (rel) {
    if (!localDate) return { kind: 'needs-local', spans: [rel[0]] };
    const base = localDate.slice(0, 7);
    const w = rel[1].toLowerCase();
    return { kind: 'ok', month: w === 'next month' ? shiftMonth(base, 1) : (w === 'last month' || w === 'previous month') ? shiftMonth(base, -1) : base, spans: [rel[0]] };
  }
  if (distinct.length === 1) return { kind: 'needs-year', name: MONTH_NAMES[distinct[0] - 1], spans: names.map((m) => m[0]) };
  return { kind: 'none' };
}

// ── Liability repayments ───────────────────────────────────────────────────────────────────────────────────────────
const LIAB_NOUN = /\b(?:loans?|emis?|liabilit(?:y|ies)|credit cards?|mortgage|repayments?)\b/i;
const PAY_VERB = /^(?:i\s+)?(?:'ve\s+|have\s+|just\s+|already\s+)*(?:paid|pay|repay|repaid|record|log|put|add|made|make|deposit|send|sent|(?:gave|give|given)(?!\s+(?:me|us|him|her|them|you)\b)|settle|settled|clear|cleared|contribute)\b/i;
const REPAY_STOP = /\b(?:i|ive|i've|have|just|already|paid|pay|repay|repaid|record|log|put|add|made|make|deposit|send|sent|gave|give|given|settle|settled|clear|cleared|contribute|my|the|our|a|an|of|towards?|to|on|against|for|into|in|emi|emis|repayment|repayments|today|yesterday|please)\b/gi;

// "I paid ₹6,500 toward my bike loan" -> { amount, namePhrase, rawPhrase, hasEmi } or null. Needs a payment verb AND a
// liability word (loan, EMI, credit card...), so "Paid ₹500 for lunch" stays a transaction. A missing amount is reported,
// never filled from the liability's monthly payment.
export function extractRepayment(text) {
  const t = stripPolite(text);
  if (!t || isQuestion(t)) return null;
  if (!PAY_VERB.test(t) || !LIAB_NOUN.test(t)) return null;
  if (/\bbudgets?\b/i.test(t) || /\bgoals?\b/i.test(t)) return null;
  const amount = chooseAmount(t);
  const pm = /\b(?:towards?|toward|to|on|against|for|into|in)\s+(.+)$/i.exec(t);
  let tail = pm ? pm[1] : t.replace(REPAY_STOP, ' ');
  for (const a of findAmounts(tail)) tail = tail.replace(a.raw, ' ');
  tail = tail.replace(/\b(?:today|yesterday|please)\b/gi, ' ').replace(/[.,;:!?"“”]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:my|the|our)\s+/i, '').replace(/\s+(?:of|for)$/i, '').trim();
  const rawPhrase = tail;
  let namePhrase = tail.replace(/\s+(?:loans?|emis?|liabilit(?:y|ies)|repayments?)$/i, '').trim();
  if (/^(?:loans?|emis?|liabilit(?:y|ies)|repayments?|my loan|the loan)$/i.test(namePhrase) || /^(?:loans?|emis?|liabilit(?:y|ies))$/i.test(rawPhrase)) namePhrase = '';
  return { amount, namePhrase, rawPhrase: /^(?:loans?|emis?|liabilit(?:y|ies)|repayments?)$/i.test(rawPhrase) ? '' : rawPhrase, hasEmi: /\bemis?\b/i.test(t) };
}

const normName = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();
export function exactLiabilityMatches(liabilities, ...phrases) {
  const keys = phrases.filter(Boolean).map(normName);
  return liabilities.filter((l) => keys.includes(normName(l.name)));
}

const TYPE_WORDS = {
  vehicle_loan: ['car', 'vehicle', 'bike', 'auto', 'scooter', 'motorcycle'],
  home_loan: ['home', 'house', 'housing', 'mortgage', 'flat'],
  education_loan: ['education', 'study', 'student', 'school', 'college'],
  personal_loan: ['personal'],
  credit_card: ['credit', 'card', 'cards'],
  other: [],
};
// Suggestions only (never chosen automatically): name substring / shared words, or a type word (car -> vehicle loan).
export function nearLiabilityMatches(liabilities, phrase, limit = 5) {
  const p = normName(phrase);
  if (!p) return [];
  const tokens = p.split(/[^a-z0-9]+/).filter((x) => x.length >= 3 && !['loan', 'loans', 'emi', 'the', 'and'].includes(x));
  const direct = liabilities.filter((l) => {
    const k = normName(l.name);
    const words = k.split(/[^a-z0-9]+/);
    // whole words only: "car" must not suggest "Old Card"
    return ` ${k} `.includes(` ${p} `) || ` ${p} `.includes(` ${k} `) || tokens.some((tok) => words.includes(tok) || (TYPE_WORDS[l.type] ?? []).includes(tok));
  });
  return mergeFuzzy(liabilities, direct, p, (l) => l.name, limit);
}

// ── Budgets ────────────────────────────────────────────────────────────────────────────────────────────────────────
const BUDGET_WORD = /\bbudgets?\b/i;
const BUDGET_START = /^(?:i\s+)?(?:(?:want|need|would like)\s+to\s+|'d like to\s+)?(?:set|make|create|update|change|put|raise|increase|lower|reduce|cut|decrease|add|adjust|fix|budget)\b/i;
// "transport 4.5k budget", "food budget 8000": a category, a budget word and an amount, with no leading verb.
const BARE_BUDGET = /^(?:(?:my|the|our)\s+)?[a-z&'/-]+(?:\s+[a-z&'/-]+){0,2}\s+(?:\S*\d\S*\s+)?budgets?\b/i;
const BUDGET_NOT_LIMIT = /\bbudget\s+(?:meeting|review|report|presentation|plan|discussion|proposal)\b/i;
function hasMoney(text) {
  const scan = scanAmounts(text);
  return scan.found.length > 0 || scan.unclear.length > 0;
}
const BUDGET_DROP = /\b(?:set|make|create|update|change|put|raise|increase|lower|reduce|cut|decrease|add|adjust|fix|my|the|a|an|our|new|monthly|budget|budgets|limit|spending|of|to|at|for|as|in|on|please|i|want|need|would|like|d|be|is|should|by|this|current|month)\b/gi;

export function cleanBudgetCategory(text, extraSpans = []) {
  let t = String(text);
  for (const sp of extraSpans) t = t.replace(sp, ' ');
  for (const a of findAmounts(t)) t = t.replace(a.raw, ' ');
  t = stripPolite(t).replace(BUDGET_DROP, ' ').replace(/[^A-Za-z0-9&'/ .-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\-\s]+|[.\-\s]+$/g, '');
  return t;
}

// "Set my food budget to ₹8,000 this month" -> { relative, fields: { categoryPhrase?, amount?, month? }, issues } or null.
// Only an exact budget amount can be set; "add ₹2,000 to my travel budget" is reported as `relative` (not supported).
export function extractBudget(text, { localDate } = {}) {
  const t = stripPolite(text);
  if (!t || isQuestion(t) || !BUDGET_WORD.test(t) || /\bgoals?\b/i.test(t)) return null;
  const addTo = /^(?:i\s+)?(?:(?:want|need|would like)\s+to\s+)?add\b/i.test(t);
  const startsLikeBudget = BUDGET_START.test(t) || /^(?:₹|rs\.?\s*|inr\s*)?\d/i.test(t) || (hasMoney(t) && BARE_BUDGET.test(t) && !BUDGET_NOT_LIMIT.test(t));
  if (!startsLikeBudget) return null;
  if (addTo && !/\bto\s+(?:my\s+|the\s+|our\s+)?[^.?!]*\bbudgets?\b/i.test(t)) return null;   // "Add ₹500 for budget meeting"
  const relative = (addTo && /\bto\s+(?:my\s+|the\s+|our\s+)?[^.?!]*\bbudgets?\b/i.test(t)) || /\bby\s+(?:₹|rs\.?|inr)?\s*\d/i.test(t);
  const month = findBudgetMonth(t, localDate);
  const spans = month.spans ?? [];
  let rest = t;
  for (const sp of spans) rest = rest.replace(sp, ' ');
  if (month.kind === 'needs-year' || month.kind === 'ambiguous') {
    // month words and date fragments are not part of the category
    rest = rest.replace(new RegExp(`\\b${MONTH_WORD}\\b\\.?`, 'gi'), ' ').replace(new RegExp(AMBIGUOUS_MONTH.source, 'gi'), ' ');
    if (month.kind === 'ambiguous') rest = rest.replace(/\bor\b/gi, ' ');
  }
  const fields = {};
  const issues = {};
  const amount = chooseAmount(rest);
  if (amount.status === 'one') fields.amount = amount.value;
  else if (amount.status === 'many') issues.amountAmbiguous = true;
  const category = cleanBudgetCategory(rest);
  if (category) fields.categoryPhrase = category;
  if (month.kind === 'ok') fields.month = month.month;
  else if (month.kind === 'needs-year') { issues.monthIssue = 'needs-year'; issues.monthName = month.name; }
  else if (month.kind === 'ambiguous') issues.monthIssue = 'ambiguous';
  else if (month.kind === 'needs-local') issues.monthIssue = 'needs-local';
  return { relative, fields, issues };
}

// "Set dining to ten thousand next month": a budget change that never says the word "budget". It only counts as one
// when the category is an existing budget (decided by the caller), so "set alarm to 5" is never taken for a budget.
const IMPLICIT_BUDGET = /^(?:i\s+)?(?:(?:want|need|would like)\s+to\s+|'d like to\s+)?(?:set|make|change|update|put|raise|lower)\s+(?!aside\b)(?:my\s+|the\s+|our\s+)?(.+?)\s+(?:to|at|as)\s+(.+)$/i;

export function extractImplicitBudget(text, { localDate } = {}) {
  const t = stripPolite(text);
  if (!t || isQuestion(t)) return null;
  const m = IMPLICIT_BUDGET.exec(t);
  if (!m) return null;
  if (/\b(?:goals?|loans?|emis?|liabilit\w*|budgets?)\b/i.test(t) || /\bby\s+(?:₹|rs\.?|inr)?\s*\d/i.test(t)) return null;
  const amount = chooseAmount(m[2]);
  if (amount.status === 'none') return null;
  const month = findBudgetMonth(m[2], localDate);
  const category = cleanBudgetCategory(m[1]);
  if (!category || category.split(/\s+/).length > 3) return null;
  const fields = { categoryPhrase: category };
  const issues = {};
  if (amount.status === 'one') fields.amount = amount.value; else issues.amountAmbiguous = true;
  if (month.kind === 'ok') fields.month = month.month;
  else if (month.kind === 'needs-year') { issues.monthIssue = 'needs-year'; issues.monthName = month.name; }
  else if (month.kind === 'ambiguous') issues.monthIssue = 'ambiguous';
  else if (month.kind === 'needs-local') issues.monthIssue = 'needs-local';
  return { fields, issues };
}

// Income / expense wording the USER typed. The language model may only agree with this; it never supplies a direction.
export function directionCue(text) {
  const t = String(text).replace(/\bpaid me\b/gi, ' got paid ');
  const income = INCOME_CUE.test(t);
  const expense = EXPENSE_CUE.test(t.replace(/\bgot paid\b/gi, ' '));
  if (income && expense) return 'conflict';
  return income ? 'income' : expense ? 'expense' : null;
}

// Is this message worth a language-model reading at all? Not a question, not advice-seeking, has something money-like and
// an action word. Normal financial questions never reach the extractor.
const ACTION_CUE = /\b(?:pay|paid|repay|repaid|repayment|spend|spent|received|receive|earned|salary|budget|limit|loan|emi|goal|save|saved|put|gave|give|given|set|make|add|record|log|contribute|deposit)\b/i;
const CHATTY = /\b(?:should|advise|advice|suggest|recommend|tips?|why|what|how|which|can i|could i|would|plan|help me|tell me|explain|show|compare)\b/i;
export function looksLikeActionAttempt(text) {
  const t = stripPolite(text);
  if (!t || t.length > 200 || isQuestion(t) || CHATTY.test(t)) return false;
  return hasMoney(t) && ACTION_CUE.test(t);
}
// Stricter: the message OPENS like an instruction or a first-person payment, so a hint is better than silence.
const OPENS_LIKE_ACTION = /^(?:i\s+)?(?:'ve\s+|have\s+|just\s+|already\s+|want\s+to\s+|need\s+to\s+)*(?:paid|pay|repaid|repay|spent|spend|gave|give|put|add|record|log|set|make|save|contribute|deposit|received|earned|got)\b/i;
export function clearlyAnAction(text) {
  const t = stripPolite(text);
  return looksLikeActionAttempt(t) && (OPENS_LIKE_ACTION.test(t) || BARE_BUDGET.test(t));
}
const ACTION_HELP = "I couldn't turn that into an action. You can say things like “Paid ₹5,000 on my bike loan”, “Set food budget to ₹8,000”, “Add ₹2,000 to my Goa goal” or “Spent ₹450 on lunch”.";

// ── Edits to a pending proposal ("make it ₹600", "change it to yesterday", "use the Goa Trip goal", "for next month") ──
// Each kind has its OWN grammar: there is no fall-through to another kind's meaning.
const EDIT_LEAD = /^(?:(?:yes|yeah|yep|yup|sure|ok|okay|no|nope|nah)[,.\s]+(?:but\s+)?)?(?:(?:actually|wait|hold on|oh)[,.\s]+)?(?:please\s+)?(make it|make that|change it to|change (?:the )?(?:amount|date|title|name|description|type|goal|category|month|loan|liability|limit)(?: it)? to|set (?:it|the amount|the date|the title|the category) to|update (?:it |the amount |the date )?to|it should be|should be|it was|use|call it|name it|title it|rename it to)\s+(.+)$/i;
const TITLE_LEADS = /^(?:call it|name it|title it|rename it to|change (?:the )?(?:title|name|description)(?: it)? to|set (?:it|the title) to)$/i;
const NAMING_LEADS = /category|call it|name it|rename|use|title it/i;

// "make it 600 instead" / "use the HDFC loan, please": a trailing softener is not part of the new value.
const TRAILING_SOFTENER = /[,\s]+(?:instead|please|rather|though|then|actually)$/i;
const editText = (text) => stripPolite(text).replace(/[.!]+$/, '').replace(TRAILING_SOFTENER, '');
const editMatch = (text) => EDIT_LEAD.exec(editText(text));

function parseTransactionEdit(text) {
  const m = editMatch(text);
  if (!m) return null;
  const lead = m[1].toLowerCase();
  const rest = m[2].trim();
  if (TITLE_LEADS.test(lead)) {
    const title = rest.replace(/^["“']|["”']$/g, '').trim();
    return title ? { patch: { title: capitalize(title), titleRaw: title } } : null;
  }
  const patch = {};
  const amount = chooseAmount(rest);
  if (amount.status === 'many') return { ambiguous: 'amount' };
  if (amount.status === 'one') patch.amount = amount.value;
  const date = findDate(rest, undefined);
  if (date.kind === 'ok') patch.date = date.date;
  else if (date.kind === 'needs-local') {                                 // resolved by the caller from localDate
    patch.relativeDate = /\b(?:day before yesterday|yesterday|today|tonight|this morning|this evening|this afternoon)\b/i.exec(rest)[0].toLowerCase();
  } else if (date.kind === 'unsupported') patch.dateIssue = 'unsupported';
  const c = clean(rest);
  if (/\b(?:income|received|earned|credit)\b/.test(c) && !/\b(?:expense|spent|paid)\b/.test(c)) patch.type = 'income';
  else if (/\b(?:expense|spent|paid|debit)\b/.test(c) && !/\b(?:income|received|earned)\b/.test(c)) patch.type = 'expense';
  return Object.keys(patch).length ? { patch } : null;
}

function parseGoalEdit(text) {
  const m = editMatch(text);
  if (!m) return null;
  const rest = m[2].trim();
  const amount = chooseAmount(rest);
  if (amount.status === 'many') return { ambiguous: 'amount' };
  if (amount.status === 'one') return { patch: { amount: amount.value } };
  if (/\d/.test(rest)) return null;
  const goalPhrase = cleanGoalPhrase(rest);
  return goalPhrase ? { patch: { goalPhrase } } : null;
}

function parseRepaymentEdit(text) {
  const m = editMatch(text);
  if (!m) return null;
  const rest = m[2].trim();
  const amount = chooseAmount(rest);
  if (amount.status === 'many') return { ambiguous: 'amount' };
  if (amount.status === 'one') return { patch: { amount: amount.value } };
  if (/\d/.test(rest)) return null;
  const phrase = rest.replace(/[.!?"“”]+/g, '').trim().replace(/^(?:my|the|our)\s+/i, '');
  if (!phrase) return null;
  return { patch: { namePhrase: phrase.replace(/\s+(?:loans?|emis?|liabilit(?:y|ies))$/i, '').trim(), rawPhrase: phrase } };
}

function parseBudgetEdit(text) {
  const t = editText(text);
  // "for next month" / "in November 2026": a bare month phrase edits the month
  const bare = /^(?:(?:yes|yeah|yep|yup|sure|ok|okay|no|nope|nah)[,.\s]+(?:but\s+)?)?(?:for|in|during)\s+(.+)$/i.exec(t);
  if (bare && findBudgetMonth(bare[1], '2000-01-01').kind !== 'none') return { patch: { monthText: bare[1].trim() } };
  const m = EDIT_LEAD.exec(t);
  if (!m) return null;
  const lead = m[1].toLowerCase();
  const rest = m[2].trim();
  const patch = {};
  const month = findBudgetMonth(rest, '2000-01-01');
  if (month.kind !== 'none') { patch.monthText = rest; return { patch }; }
  const amount = chooseAmount(rest);
  if (amount.status === 'many') return { ambiguous: 'amount' };
  if (amount.status === 'one') { patch.amount = amount.value; return { patch }; }
  if (NAMING_LEADS.test(lead) && !/\d/.test(rest)) {
    const category = cleanBudgetCategory(rest);
    return category ? { patch: { categoryPhrase: category } } : null;
  }
  return null;
}

const EDITORS = {
  create_transaction: parseTransactionEdit,
  contribute_to_goal: parseGoalEdit,
  record_liability_repayment: parseRepaymentEdit,
  set_budget: parseBudgetEdit,
};
// An unknown kind has no grammar (null), never another kind's.
export const parseEdit = (text, kind) => (EDITORS[kind] ? EDITORS[kind](text) : null);

// ── 2. The turn handler ──────────────────────────────────────────────────────────────────────────────────────────

const NOT_HANDLED = { handled: false };

export function createAssistantActions(deps) {
  const { db, normalizeTransactionInput, normalizeContributionInput, normalizeRepaymentInput, normalizeBudgetInput, formatRupees } = deps;
  const ttlSeconds = deps.ttlSeconds ?? PROPOSAL_TTL_SECONDS;
  const MAX_ATTEMPTS = 2;

  const view = (p, status) => ({
    proposalId: p.id, kind: p.kind, status, summary: p.summary, display: p.display, expiresAt: p.expiresAt,
  });
  const store = (userId, kind, status, payload, summary, display) =>
    db.replaceActiveProposal({ id: randomUUID(), userId, kind, status, payload, summary, display, ttlSeconds });

  const handled = (reply, action = null) => ({ handled: true, reply, action });
  const withNotice = (preface, reply) => (preface ? `${preface} ${reply}` : reply);

  async function cancelActive(userId, active) {
    if (!active) return null;
    await db.cancelProposal(userId, active.id);
    return {
      proposalId: active.id, kind: active.kind, status: 'cancelled',
      notice: `I cancelled the ${labelOf(active)}. Nothing was saved.`,
    };
  }
  // Ends the open proposal (if any) and answers with `reply`; nothing is proposed.
  async function stopWith(ctx, reply) {
    const c = await cancelActive(ctx.userId, ctx.active);
    return handled(withNotice(ctx.preface, reply), c && { proposalId: c.proposalId, kind: c.kind, status: 'cancelled' });
  }
  // A clarifying question: stored as a draft so the next message is read as its answer.
  async function askDraft(ctx, kind, payload, question) {
    const draft = await store(ctx.userId, kind, 'draft', ctx.interpreted ? { ...payload, interpreted: ctx.interpreted } : payload, question, []);
    return handled(withNotice(ctx.preface, question), view(draft, 'needs_clarification'));
  }
  // A complete, previewed proposal waiting for the user's explicit confirmation.
  async function propose(ctx, kind, payload, summary, display) {
    // What the typo fixes / spoken numbers were read as, so the user can check it on the card before confirming.
    const rows = ctx.interpreted ? [...display, { label: 'Interpreted', value: ctx.interpreted }] : display;
    const pending = await store(ctx.userId, kind, 'pending', ctx.interpreted ? { ...payload, interpreted: ctx.interpreted } : payload, summary, rows);
    return handled(withNotice(ctx.preface, summary), view(pending, 'pending'));
  }
  // Nothing in the reply moved the draft forward: ask once more, then give up (never loops).
  async function retryOrGiveUp(ctx, p) {
    const attempts = (p.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      return stopWith(ctx, `I couldn't work out what you meant, so I cancelled the ${labelOf(ctx.active)}. Nothing was saved.`);
    }
    return KINDS[p.kind].retry(ctx, p, attempts);
  }

  // ═════════════ create_transaction ═════════════
  const askAbout = (want, f) => {
    const amt = f.amount != null ? formatRupees(f.amount) : null;
    switch (want) {
      case 'type': return 'Was that money you spent or money you received?';
      case 'amount-many': return "I found more than one amount, or one I couldn't read exactly. How much was it?";
      case 'amount': return f.type === 'income'
        ? `How much did you receive${f.titleRaw ? ` for ${f.titleRaw}` : ''}?`
        : `How much did you spend${f.titleRaw ? ` on ${f.titleRaw}` : ''}?`;
      case 'title': return f.type === 'income' ? `What was the ${amt} income from?` : `What was the ${amt} expense for?`;
      default: return 'What date was this? You can say today, yesterday, or a date like 2026-10-05.';
    }
  };

  const whenWords = (date, localDate) => (date === localDate ? 'today' : localDate && date === shiftDate(localDate, -1) ? 'yesterday' : date);

  async function advanceTransaction(ctx, fields, attempts = 0) {
    const { userId, localDate } = ctx;
    const f = { ...fields };
    if (!f.date && !f.dateIssue && localDate) f.date = localDate;       // the product's default (the manual form also starts at today)
    let want = null;
    if (!f.type) want = 'type';
    else if (f.amountAmbiguous) want = 'amount-many';
    else if (f.amount == null) want = 'amount';
    else if (!f.title) want = 'title';
    else if (f.dateIssue || !f.date) want = 'date';
    if (want) {
      return askDraft(ctx, 'create_transaction', { kind: 'create_transaction', stage: 'missing', want, fields: f, attempts }, askAbout(want, f));
    }
    const input = { title: f.title, amount: f.amount, type: f.type, date: f.date };
    const checked = normalizeTransactionInput(input);
    if (!checked.ok) return stopWith(ctx, `I can't add that: ${checked.error}.`);
    const v = checked.value;
    const abs = Math.abs(v.amount);
    const noun = v.type === 'income' ? 'income' : 'expense';
    const when = whenWords(v.date, localDate);
    const named = f.titleRaw ?? v.title;
    const summary = v.type === 'income'
      ? `I'll add ${formatRupees(abs)} ${named} income for ${when}. Should I add it?`
      : `I'll add a ${formatRupees(abs)} ${named} expense for ${when}. Should I add it?`;
    const display = [
      { label: 'Type', value: v.type === 'income' ? 'Income' : 'Expense' },
      { label: 'Amount', value: formatRupees(abs) },
      { label: 'Title', value: v.title },
      { label: 'Date', value: when === v.date ? v.date : `${v.date} (${when})` },
      { label: 'Category', value: v.category },
      { label: 'Classification', value: 'Unclassified' },
    ];
    void userId;
    return propose(ctx, 'create_transaction',
      { kind: 'create_transaction', fields: { ...f, date: v.date }, input: { title: v.title, amount: abs, type: v.type, date: v.date }, shortLabel: `${formatRupees(abs)} ${noun}` },
      summary, display);
  }

  async function startTransaction(ctx, t) {
    if (!looksLikeTransaction(t)) return null;
    const ex = extractTransaction(t, { localDate: ctx.localDate });
    if (ex.unsupportedClassification) {
      return handled(withNotice(ctx.preface, "I can't record refunds or transfers from chat yet. Add them on the Transactions page, where you can pick the classification."));
    }
    const fields = { ...ex.fields };
    if (ex.issues.amountAmbiguous) fields.amountAmbiguous = true;
    if (ex.issues.dateIssue) fields.dateIssue = ex.issues.dateIssue;
    return advanceTransaction(ctx, fields);
  }

  async function continueTransactionDraft(ctx, text, p) {
    // "I paid 5k" -> "What was it for?" -> "my bike loan": that is a loan repayment, not an expense titled "Bike loan".
    if (p.want === 'title' && p.fields.amount != null && LIAB_NOUN.test(text) && !/\bbudgets?\b|\bgoals?\b/i.test(text)) {
      const asRepayment = await startRepayment(ctx, `paid ${p.fields.amount} to ${stripPolite(text)}`);
      if (asRepayment) return asRepayment;
    }
    const got = extractTransaction(text, { localDate: ctx.localDate, allowForCue: false });
    const f = { ...p.fields };
    let progress = false;
    for (const key of ['type', 'title', 'titleRaw', 'amount', 'date']) {
      if (f[key] == null && got.fields[key] != null) { f[key] = got.fields[key]; if (key !== 'titleRaw') progress = true; }
    }
    if (f.amountAmbiguous && got.fields.amount != null) { f.amount = got.fields.amount; delete f.amountAmbiguous; progress = true; }
    if (f.dateIssue && got.fields.date) { f.date = got.fields.date; delete f.dateIssue; progress = true; }
    if (got.issues.dateIssue && !f.dateIssue && !p.fields.date) f.dateIssue = got.issues.dateIssue;
    if (!progress) return retryOrGiveUp(ctx, p);
    return advanceTransaction(ctx, f);
  }

  async function editTransaction(ctx, text, p, edit) {
    if (edit.ambiguous) return handled('I found more than one amount. Please tell me the one you want, or cancel.', view(ctx.active, 'pending'));
    const f = { ...p.fields, ...edit.patch };
    delete f.relativeDate;
    if (edit.patch.relativeDate) {
      const d = findDate(edit.patch.relativeDate, ctx.localDate);
      if (d.kind === 'ok') f.date = d.date; else { delete f.date; f.dateIssue = d.kind; }
    }
    if (edit.patch.date) delete f.dateIssue;
    return advanceTransaction({ ...ctx, preface: '' }, f);
  }

  // ═════════════ contribute_to_goal ═════════════
  const goalLine = (g) => `“${g.title}” (${formatRupees(g.currentAmount)} saved of ${formatRupees(g.targetAmount)}, due ${g.targetDate})`;
  const asGoalCandidate = (g) => ({ id: g.id, title: g.title, current: g.currentAmount, target: g.targetAmount, targetDate: g.targetDate });

  async function askGoal(ctx, fields, candidates, intro, attempts = 0) {
    const lines = candidates.map((g, i) => `${i + 1}. ${goalLine({ title: g.title, currentAmount: g.current, targetAmount: g.target, targetDate: g.targetDate })}`);
    const question = candidates.length === 1
      ? `${intro} Did you mean ${lines[0].slice(3)}? Say yes, or cancel.`
      : `${intro} Which one? ${lines.join(' ')} Say the number.`;
    return askDraft(ctx, 'contribute_to_goal', { kind: 'contribute_to_goal', stage: 'choose_goal', fields, candidates, attempts }, question);
  }

  async function buildGoalProposal(ctx, goal, amountRaw, fields) {
    const checked = normalizeContributionInput({ amount: amountRaw });
    if (!checked.ok) return stopWith(ctx, `I can't add that: ${checked.error}.`);
    const amount = checked.value.amount;
    const preview = await db.previewGoalContribution(ctx.userId, goal.id, amount);
    if (!preview) return stopWith(ctx, "I couldn't find that goal any more, so nothing was saved.");
    if (preview.complete) return stopWith(ctx, `“${preview.title}” is already complete, so I can't add to it.`);
    if (preview.exceeds) return stopWith(ctx, `Adding ${formatRupees(amount)} would go past the target of “${preview.title}”; only ${formatRupees(preview.remaining)} is left. Nothing was saved.`);
    const summary = `I'll add ${formatRupees(amount)} to your ${preview.title} goal. Should I add it?`;
    const display = [
      { label: 'Goal', value: preview.title },
      { label: 'Contribution', value: formatRupees(amount) },
      { label: 'Current', value: formatRupees(preview.current) },
      { label: 'After', value: formatRupees(preview.after) },
      { label: 'Target', value: formatRupees(preview.target) },
    ];
    return propose(ctx, 'contribute_to_goal',
      { kind: 'contribute_to_goal', goalId: goal.id, goalTitle: preview.title, amount, fields: { ...fields, amount }, shortLabel: `${formatRupees(amount)} contribution to ${preview.title}` },
      summary, display);
  }

  async function askGoalAmount(ctx, goal, fields, attempts = 0) {
    return askDraft(ctx, 'contribute_to_goal',
      { kind: 'contribute_to_goal', stage: 'amount', fields, goalId: goal.id, goalTitle: goal.title, attempts },
      `How much would you like to add to ${goal.title}?`);
  }

  // Resolve the goal for a (possibly partial) request and move to the next step. `goals` are the caller's own.
  // True when a typo / speech correction landed inside the words that picked an entity ("bike lon" -> "bike loan"):
  // even an exact-looking match is then confirmed with the user first. (Entity names themselves are never rewritten.)
  function nameTouched(ctx, ...phrases) {
    return (ctx.corrections ?? []).some((c) => c.kind !== 'filler' && c.to && phrases.some((ph) => ph && new RegExp(`\\b${c.to}\\b`, 'i').test(ph)));
  }

  async function advanceGoal(ctx, fields, goals, attempts = 0) {
    const phrase = fields.namePhrase ?? '';
    const live = goals.filter((g) => g.currentAmount < g.targetAmount);
    const exact = phrase ? exactGoalMatches(goals, phrase, fields.rawPhrase) : [];
    if (exact.length > 1) return askGoal(ctx, fields, exact.map(asGoalCandidate), `You have ${exact.length} goals called “${exact[0].title}”.`, attempts);
    const reachedByCorrection = exact.length === 1 && nameTouched(ctx, phrase, fields.rawPhrase);
    if (exact.length === 0 || reachedByCorrection) {
      if (goals.length === 0) return stopWith(ctx, "You don't have any savings goals yet. You can create one on the Goals page.");
      const pool = reachedByCorrection ? exact : phrase ? nearGoalMatches(goals, phrase) : live.slice(0, 5);
      if (pool.length === 0) return stopWith(ctx, `I couldn't find a goal called “${phrase}”. Your goals: ${goals.slice(0, 5).map((g) => `“${g.title}”`).join(', ')}.`);
      const intro = reachedByCorrection ? `I wasn't sure about “${fields.rawPhrase || phrase}”.` : phrase ? `I couldn't find a goal called “${phrase}”.` : 'Which goal is this for?';
      return askGoal(ctx, fields, pool.map(asGoalCandidate), intro, attempts);
    }
    const goal = exact[0];
    if (fields.amountAmbiguous || fields.amount == null) return askGoalAmount(ctx, goal, fields, attempts);
    return buildGoalProposal(ctx, goal, fields.amount, fields);
  }

  async function startGoal(ctx, t) {
    const goalReq = extractGoalContribution(t);
    if (!goalReq) return null;
    const goals = await db.listGoalsByUser(ctx.userId);
    const exact = exactGoalMatches(goals, goalReq.namePhrase, goalReq.rawPhrase);
    const near = nearGoalMatches(goals, goalReq.namePhrase);
    // "Add ₹100 to <name>" is a goal request unless the sentence is plainly about a transaction ("... to expenses").
    const ours = goalReq.strongVerb || goalReq.hasGoalWord || exact.length > 0 || near.length > 0 || !TXN_NOUN.test(t);
    if (!ours) return null;
    const fields = { namePhrase: goalReq.namePhrase, rawPhrase: goalReq.rawPhrase };
    if (goalReq.amount.status === 'one') fields.amount = goalReq.amount.value;
    if (goalReq.amount.status === 'many') fields.amountAmbiguous = true;
    return advanceGoal(ctx, fields, goals);
  }

  async function continueGoalDraft(ctx, text, p) {
    const goals = await db.listGoalsByUser(ctx.userId);
    if (p.stage === 'choose_goal') {
      const idx = pickCandidate(text, p.candidates);
      let goal = idx != null ? goals.find((g) => g.id === p.candidates[idx].id) : null;
      if (!goal) {
        const typed = exactGoalMatches(goals, stripPolite(text).replace(/\s+goals?$/i, ''));
        if (typed.length === 1) goal = typed[0];
      }
      if (!goal) return retryOrGiveUp(ctx, p);
      const fields = { ...p.fields, namePhrase: goal.title, rawPhrase: goal.title };
      if (fields.amountAmbiguous || fields.amount == null) return askGoalAmount(ctx, goal, fields);
      return buildGoalProposal(ctx, goal, fields.amount, fields);
    }
    // stage 'amount'
    const goal = goals.find((g) => g.id === p.goalId);
    if (!goal) return retryOrGiveUp(ctx, p);
    const amount = chooseAmount(text);
    if (amount.status === 'one') return buildGoalProposal(ctx, goal, amount.value, { ...p.fields, amount: amount.value });
    if (amount.status === 'many') return askGoalAmount(ctx, goal, { ...p.fields, amountAmbiguous: true }, p.attempts);
    return retryOrGiveUp(ctx, p);
  }

  async function retryGoal(ctx, p, attempts) {
    if (p.stage === 'choose_goal') return askGoal(ctx, p.fields, p.candidates, "I didn't catch which goal.", attempts);
    const goals = await db.listGoalsByUser(ctx.userId);
    const goal = goals.find((g) => g.id === p.goalId);
    return goal ? askGoalAmount(ctx, goal, p.fields, attempts) : stopWith(ctx, 'Sorry, I lost track of that goal. Nothing was saved.');
  }

  async function editGoal(ctx, text, p, edit) {
    if (edit.ambiguous) return handled('I found more than one amount. Please tell me the one you want, or cancel.', view(ctx.active, 'pending'));
    const goals = await db.listGoalsByUser(ctx.userId);
    const fields = { ...p.fields, ...(edit.patch.amount != null ? { amount: edit.patch.amount } : {}) };
    if (edit.patch.goalPhrase) {
      fields.namePhrase = edit.patch.goalPhrase; fields.rawPhrase = edit.patch.goalPhrase;
      return advanceGoal({ ...ctx, preface: '' }, fields, goals);
    }
    const goal = goals.find((g) => g.id === p.goalId);
    if (!goal) return handled('I lost track of that goal. Nothing was saved.');
    return buildGoalProposal({ ...ctx, preface: '' }, goal, fields.amount, fields);
  }

  // ═════════════ record_liability_repayment ═════════════
  const liabType = (type) => String(type).replace(/_/g, ' ');
  const liabLine = (l) => `“${l.title}” (${liabType(l.type)}, ${formatRupees(l.outstanding)} outstanding)`;
  const asLiabCandidate = (l) => ({ id: l.id, title: l.name, type: l.type, outstanding: l.outstandingAmount, monthlyPayment: l.monthlyPayment });

  async function askLiability(ctx, fields, candidates, intro, attempts = 0) {
    const lines = candidates.map((c, i) => `${i + 1}. ${liabLine(c)}`);
    const question = candidates.length === 1
      ? `${intro} Did you mean ${lines[0].slice(3)}? Say yes, or cancel.`
      : `${intro} Which one? ${lines.join(' ')} Say the number.`;
    return askDraft(ctx, 'record_liability_repayment', { kind: 'record_liability_repayment', stage: 'choose_liability', fields, candidates, attempts }, question);
  }

  // The amount is always asked for; a liability's monthly payment is only MENTIONED, never used as the repayment.
  async function askRepaymentAmount(ctx, liability, fields, attempts = 0) {
    const emi = fields.hasEmi && liability.monthlyPayment > 0 ? ` (Its monthly payment is ${formatRupees(liability.monthlyPayment)}.)` : '';
    const question = fields.amountAmbiguous
      ? `I found more than one amount, or one I couldn't read exactly. How much did you repay on ${liability.name}?`
      : `How much did you repay on ${liability.name}?${emi}`;
    return askDraft(ctx, 'record_liability_repayment',
      { kind: 'record_liability_repayment', stage: 'amount', fields, liabilityId: liability.id, liabilityName: liability.name, monthlyPayment: liability.monthlyPayment, attempts }, question);
  }

  async function buildRepaymentProposal(ctx, liability, amountRaw, fields) {
    const checked = normalizeRepaymentInput({ amount: amountRaw });
    if (!checked.ok) return stopWith(ctx, `I can't record that: ${checked.error}.`);
    const amount = checked.value.amount;
    const preview = await db.previewLiabilityRepayment(ctx.userId, liability.id, amount);
    if (!preview) return stopWith(ctx, "I couldn't find that liability any more, so nothing was saved.");
    if (preview.paidOff) return stopWith(ctx, `“${preview.name}” is already paid off, so there is nothing to repay.`);
    if (preview.exceeds) return stopWith(ctx, `Repaying ${formatRupees(amount)} is more than the outstanding balance of “${preview.name}” (${formatRupees(preview.outstanding)}). Nothing was saved.`);
    const paidOff = preview.after === 0;
    const summary = `I'll record a ${formatRupees(amount)} repayment on your ${preview.name}. Its outstanding balance will go from ${formatRupees(preview.outstanding)} to ${formatRupees(preview.after)}${paidOff ? ', so it will be paid off' : ''}. Should I record it?`;
    const display = [
      { label: 'Liability', value: `${preview.name} (${liabType(preview.type)})` },
      { label: 'Repayment', value: formatRupees(amount) },
      { label: 'Outstanding now', value: formatRupees(preview.outstanding) },
      { label: 'Outstanding after', value: formatRupees(preview.after) },
      ...(paidOff ? [{ label: 'Result', value: 'Paid off after this repayment' }] : []),
      { label: 'Note', value: 'Records a liability repayment only; no expense transaction will be added.' },
    ];
    return propose(ctx, 'record_liability_repayment',
      {
        kind: 'record_liability_repayment', liabilityId: liability.id, liabilityName: preview.name, amount,
        fields: { ...fields, amount }, shortLabel: `${formatRupees(amount)} repayment on ${preview.name}`, expect: { outstanding: preview.outstanding },
      },
      summary, display);
  }

  async function advanceRepayment(ctx, fields, liabilities, attempts = 0) {
    if (liabilities.length === 0) return stopWith(ctx, "You don't have any saved liabilities yet. You can add one on the Liabilities page.");
    const phrase = fields.namePhrase ?? '';
    const live = liabilities.filter((l) => l.outstandingAmount > 0);
    const exact = phrase || fields.rawPhrase ? exactLiabilityMatches(liabilities, phrase, fields.rawPhrase) : [];
    if (exact.length > 1) return askLiability(ctx, fields, exact.map(asLiabCandidate), `You have ${exact.length} liabilities called “${exact[0].name}”.`, attempts);
    const reachedByCorrection = exact.length === 1 && nameTouched(ctx, phrase, fields.rawPhrase);
    if (exact.length === 0 || reachedByCorrection) {
      const pool = reachedByCorrection ? exact.filter((l) => l.outstandingAmount > 0) : phrase || fields.rawPhrase ? nearLiabilityMatches(live, phrase || fields.rawPhrase) : live.slice(0, 5);
      const label = fields.rawPhrase || phrase;     // what the user said ("car loan"), not the trimmed matching form
      if (reachedByCorrection && pool.length > 0) {
        return askLiability(ctx, fields, pool.map(asLiabCandidate), `I wasn't sure about “${label}”.`, attempts);
      }
      if (reachedByCorrection) return stopWith(ctx, `“${exact[0].name}” is already paid off, so there is nothing to repay.`);
      if (pool.length === 0) {
        return stopWith(ctx, label
          ? `I couldn't find a liability called “${label}”. Your liabilities: ${live.slice(0, 5).map((l) => `“${l.name}”`).join(', ') || 'none are open'}.`
          : 'All of your liabilities are already paid off, so there is nothing to repay.');
      }
      return askLiability(ctx, fields, pool.map(asLiabCandidate), label ? `I couldn't find a liability called “${label}”.` : 'Which loan is this for?', attempts);
    }
    const liability = exact[0];
    if (liability.outstandingAmount === 0) return stopWith(ctx, `“${liability.name}” is already paid off, so there is nothing to repay.`);
    if (fields.amountAmbiguous || fields.amount == null) return askRepaymentAmount(ctx, liability, fields, attempts);
    return buildRepaymentProposal(ctx, liability, fields.amount, fields);
  }

  async function startRepayment(ctx, t) {
    const ex = extractRepayment(t);
    if (!ex) return null;
    const liabilities = await db.listLiabilitiesByUser(ctx.userId);
    const fields = { namePhrase: ex.namePhrase, rawPhrase: ex.rawPhrase, hasEmi: ex.hasEmi };
    if (ex.amount.status === 'one') fields.amount = ex.amount.value;
    if (ex.amount.status === 'many') fields.amountAmbiguous = true;
    return advanceRepayment(ctx, fields, liabilities);
  }

  async function continueRepaymentDraft(ctx, text, p) {
    const liabilities = await db.listLiabilitiesByUser(ctx.userId);
    if (p.stage === 'choose_liability') {
      const idx = pickCandidate(text, p.candidates);
      let liability = idx != null ? liabilities.find((l) => l.id === p.candidates[idx].id) : null;
      if (!liability) {
        const typed = exactLiabilityMatches(liabilities, stripPolite(text).replace(/\s+loans?$/i, ''), stripPolite(text));
        if (typed.length === 1) liability = typed[0];
      }
      if (!liability) return retryOrGiveUp(ctx, p);
      const fields = { ...p.fields, namePhrase: liability.name, rawPhrase: liability.name };
      if (liability.outstandingAmount === 0) return stopWith(ctx, `“${liability.name}” is already paid off, so there is nothing to repay.`);
      if (fields.amountAmbiguous || fields.amount == null) return askRepaymentAmount(ctx, liability, fields);
      return buildRepaymentProposal(ctx, liability, fields.amount, fields);
    }
    const liability = liabilities.find((l) => l.id === p.liabilityId);
    if (!liability) return retryOrGiveUp(ctx, p);
    const amount = chooseAmount(text);
    if (amount.status === 'one') return buildRepaymentProposal(ctx, liability, amount.value, { ...p.fields, amount: amount.value });
    if (amount.status === 'many') return askRepaymentAmount(ctx, liability, { ...p.fields, amountAmbiguous: true }, p.attempts);
    return retryOrGiveUp(ctx, p);
  }

  async function retryRepayment(ctx, p, attempts) {
    if (p.stage === 'choose_liability') return askLiability(ctx, p.fields, p.candidates, "I didn't catch which loan.", attempts);
    const liabilities = await db.listLiabilitiesByUser(ctx.userId);
    const liability = liabilities.find((l) => l.id === p.liabilityId);
    return liability ? askRepaymentAmount(ctx, liability, p.fields, attempts) : stopWith(ctx, 'Sorry, I lost track of that loan. Nothing was saved.');
  }

  async function editRepayment(ctx, text, p, edit) {
    if (edit.ambiguous) return handled('I found more than one amount. Please tell me the one you want, or cancel.', view(ctx.active, 'pending'));
    const liabilities = await db.listLiabilitiesByUser(ctx.userId);
    const fields = { ...p.fields, ...(edit.patch.amount != null ? { amount: edit.patch.amount } : {}) };
    if (edit.patch.namePhrase !== undefined) {
      fields.namePhrase = edit.patch.namePhrase; fields.rawPhrase = edit.patch.rawPhrase;
      return advanceRepayment({ ...ctx, preface: '' }, fields, liabilities);
    }
    const liability = liabilities.find((l) => l.id === p.liabilityId);
    if (!liability) return handled('I lost track of that loan. Nothing was saved.');
    return buildRepaymentProposal({ ...ctx, preface: '' }, liability, fields.amount, fields);
  }

  // ═════════════ set_budget ═════════════
  const paise = (n) => Math.round(Number(n) * 100);   // exact integer paise for the 2-decimal amounts the database holds
  const SAFE_PAISE = 1e12;                              // above this (a trillion rupees) skip the derived lines rather than risk precision
  const nearKey = (a, b) => a.includes(b) || b.includes(a);

  async function askBudget(ctx, fields, want, attempts = 0) {
    const amt = fields.amount != null ? formatRupees(fields.amount) : null;
    let question;
    if (want === 'category') question = amt ? `Which category is the ${amt} budget for?` : 'Which category is the budget for?';
    else if (want === 'amount-many') question = "I found more than one amount, or one I couldn't read exactly. How much should the budget be?";
    else if (want === 'amount') question = `How much should the ${fields.categoryPhrase} budget be${fields.month ? ` for ${monthLabel(fields.month)}` : ''}?`;
    else if (fields.monthIssue === 'needs-year') question = `Which year do you mean for ${capitalize(fields.monthName)}?`;
    else question = 'Which month do you mean? You can say this month, next month, or a month and year like October 2026.';
    return askDraft(ctx, 'set_budget', { kind: 'set_budget', stage: 'missing', want, fields, attempts }, question);
  }

  async function advanceBudget(ctx, fields, attempts = 0) {
    const f = { ...fields };
    if (!f.month && !f.monthIssue && ctx.localDate) f.month = ctx.localDate.slice(0, 7);   // the budget form's default too: the current local month
    if (!f.categoryPhrase) return askBudget(ctx, f, 'category', attempts);
    if (f.amountAmbiguous) return askBudget(ctx, f, 'amount-many', attempts);
    if (f.amount == null) return askBudget(ctx, f, 'amount', attempts);
    if (f.monthIssue || !f.month) return askBudget(ctx, f, 'month', attempts);
    return buildBudgetProposal(ctx, f);
  }

  async function buildBudgetProposal(ctx, f) {
    const checked = normalizeBudgetInput({ month: f.month, category: f.categoryPhrase, amount: f.amount });
    if (!checked.ok) return stopWith(ctx, `I can't set that budget: ${checked.error}.`);
    const v = checked.value;                       // { month, label, amount }
    const list = await db.listBudgetsByUserAndMonth(ctx.userId, v.month);
    const key = v.label.trim().toLowerCase();      // the canonical key the database derives: lower(btrim(label))
    const existing = list.find((b) => b.categoryKey === key);
    const others = list.filter((b) => b.categoryKey !== key);
    const near = [...others.filter((b) => nearKey(b.categoryKey, key)), ...fuzzyCandidates(others, v.label, (b) => b.category)]
      .filter((b, i, all) => all.indexOf(b) === i).slice(0, 3);
    const when = monthLabel(v.month);
    const newLimit = formatRupees(v.amount);
    const fieldsOut = { categoryPhrase: f.categoryPhrase, month: v.month, amount: v.amount };

    if (existing) {
      if (existing.amount === v.amount && existing.category === v.label) {
        return stopWith(ctx, `Your ${existing.category} budget for ${when} is already ${newLimit}, so there is nothing to change.`);
      }
      const spent = existing.actualSpent;
      const derive = paise(v.amount) < SAFE_PAISE && paise(spent) < SAFE_PAISE;
      const remainingP = paise(v.amount) - paise(spent);     // integer paise: exact
      const display = [
        { label: 'Month', value: `${when} (${v.month})` },
        { label: 'Category', value: existing.category },
        ...(existing.category !== v.label ? [{ label: 'Label', value: `Will change from “${existing.category}” to “${v.label}”` }] : []),
        { label: 'Current limit', value: formatRupees(existing.amount) },
        { label: 'New limit', value: newLimit },
        ...(derive ? [
          { label: 'Spent so far', value: formatRupees(spent) },
          { label: 'Remaining after', value: remainingP >= 0 ? formatRupees(remainingP / 100) : `${formatRupees(-remainingP / 100)} over` },
          { label: 'Status after', value: remainingP < 0 ? 'Over budget' : remainingP === 0 ? 'Exactly at budget' : 'Under budget' },
        ] : []),
      ];
      const summary = `Your ${existing.category} budget for ${when} is ${formatRupees(existing.amount)}. I'll change it to ${newLimit}. Should I update it?`;
      return propose(ctx, 'set_budget',
        { kind: 'set_budget', month: v.month, label: v.label, amount: v.amount, fields: fieldsOut, shortLabel: `${newLimit} ${v.label} budget for ${when}`, expect: { exists: true, id: existing.id, amount: existing.amount } },
        summary, display);
    }
    const nearNote = near.length ? `You also have ${near.map((b) => `“${b.category}”`).join(', ')} for this month.` : null;
    const display = [
      { label: 'Month', value: `${when} (${v.month})` },
      { label: 'Category', value: v.label },
      { label: 'New limit', value: newLimit },
      { label: 'Status', value: 'New budget' },
      ...(nearNote ? [{ label: 'Note', value: nearNote }] : []),
    ];
    const summary = `I'll create a ${v.label} budget of ${newLimit} for ${when}.${nearNote ? ` ${nearNote}` : ''} Should I create it?`;
    return propose(ctx, 'set_budget',
      { kind: 'set_budget', month: v.month, label: v.label, amount: v.amount, fields: fieldsOut, shortLabel: `${newLimit} ${v.label} budget for ${when}`, expect: { exists: false } },
      summary, display);
  }

  // "Set dining to ten thousand next month": only when "dining" is an existing budget of that month.
  async function startImplicitBudget(ctx, t) {
    const im = extractImplicitBudget(t, { localDate: ctx.localDate });
    if (!im) return null;
    const month = im.fields.month ?? (im.issues.monthIssue ? null : ctx.localDate?.slice(0, 7));
    if (!month) return null;
    const list = await db.listBudgetsByUserAndMonth(ctx.userId, month);
    const key = im.fields.categoryPhrase.trim().toLowerCase();
    if (!list.some((b) => b.categoryKey === key)) return null;
    const fields = { ...im.fields };
    if (im.issues.amountAmbiguous) fields.amountAmbiguous = true;
    if (im.issues.monthIssue) { fields.monthIssue = im.issues.monthIssue; if (im.issues.monthName) fields.monthName = im.issues.monthName; }
    return advanceBudget(ctx, fields);
  }

  async function startBudget(ctx, t) {
    const ex = extractBudget(t, { localDate: ctx.localDate });
    if (!ex) return startImplicitBudget(ctx, t);
    if (ex.relative) {
      return handled(withNotice(ctx.preface, "I can set a budget to an exact amount, for example “Set food budget to ₹8,000”, but I can't add to or reduce one by an amount."));
    }
    const fields = { ...ex.fields };
    if (ex.issues.amountAmbiguous) fields.amountAmbiguous = true;
    if (ex.issues.monthIssue) { fields.monthIssue = ex.issues.monthIssue; if (ex.issues.monthName) fields.monthName = ex.issues.monthName; }
    return advanceBudget(ctx, fields);
  }

  // Applies one resolved month phrase to a budget's fields (shared by the answer to a month question and by edits).
  function applyMonthText(f, monthText, localDate) {
    const m = findBudgetMonth(monthText, localDate);
    delete f.month; delete f.monthIssue; delete f.monthName;
    if (m.kind === 'ok') f.month = m.month;
    else if (m.kind === 'needs-year') { f.monthIssue = 'needs-year'; f.monthName = m.name; }
    else f.monthIssue = m.kind === 'needs-local' ? 'needs-local' : 'ambiguous';
    return m.kind === 'ok';
  }

  async function continueBudgetDraft(ctx, text, p) {
    const f = { ...p.fields };
    const want = p.want;
    let progress = false;
    if (want === 'category') {
      const category = cleanBudgetCategory(text);
      if (category) { f.categoryPhrase = category; progress = true; }
    } else if (want === 'amount' || want === 'amount-many') {
      const a = chooseAmount(text);
      if (a.status === 'one') { f.amount = a.value; delete f.amountAmbiguous; progress = true; }
    } else {
      // month: a full phrase ("October 2026", "next month") or, after "Which year?", just the year ("2026")
      const year = /^\s*((?:19|20)\d\d)\s*[.!]?\s*$/.exec(text);
      if (year && p.fields.monthName) {
        f.month = `${year[1]}-${String(monthIndex(p.fields.monthName)).padStart(2, '0')}`;
        delete f.monthIssue; delete f.monthName; progress = true;
      } else if (applyMonthText(f, text, ctx.localDate)) progress = true;
    }
    if (!progress) return retryOrGiveUp(ctx, p);
    return advanceBudget(ctx, f);
  }

  async function editBudget(ctx, text, p, edit) {
    if (edit.ambiguous) return handled('I found more than one amount. Please tell me the one you want, or cancel.', view(ctx.active, 'pending'));
    const f = { ...p.fields, ...edit.patch };
    delete f.monthText;
    if (edit.patch.monthText) applyMonthText(f, edit.patch.monthText, ctx.localDate);
    return advanceBudget({ ...ctx, preface: '' }, f);
  }

  // ═════════════ the per-kind table ═════════════
  // Everything kind-specific lives here; the turn handler below only looks a kind up. A kind that is not in the table
  // has no behaviour at all (there is no "default" kind).
  //   draftLabel     what a cancelled, unfinished clarification is called
  //   matches(t)     does this text look like a NEW request of this kind (used while a clarification is open)
  //   start(ctx, t)  a new request: a handled result, or null when the text is not this kind of request
  //   continueDraft  the user's answer to this kind's open question
  //   retry          ask the same question again
  //   parseEdit      this kind's own edit grammar ("make it ₹600", "for next month", ...)
  //   edit           apply an edit and show a NEW preview
  const KINDS = {
    create_transaction: {
      draftLabel: 'unfinished transaction',
      matches: (t) => looksLikeTransaction(t),
      start: startTransaction,
      continueDraft: continueTransactionDraft,
      retry: (ctx, p, attempts) => advanceTransaction(ctx, p.fields, attempts),
      parseEdit: parseTransactionEdit,
      edit: editTransaction,
    },
    contribute_to_goal: {
      draftLabel: 'unfinished goal contribution',
      matches: (t) => extractGoalContribution(t) !== null,
      start: startGoal,
      continueDraft: continueGoalDraft,
      retry: retryGoal,
      parseEdit: parseGoalEdit,
      edit: editGoal,
    },
    record_liability_repayment: {
      draftLabel: 'unfinished repayment',
      matches: (t) => extractRepayment(t) !== null,
      start: startRepayment,
      continueDraft: continueRepaymentDraft,
      retry: retryRepayment,
      parseEdit: parseRepaymentEdit,
      edit: editRepayment,
    },
    set_budget: {
      draftLabel: 'unfinished budget change',
      matches: (t) => extractBudget(t) !== null,
      start: startBudget,
      continueDraft: continueBudgetDraft,
      retry: (ctx, p, attempts) => advanceBudget(ctx, p.fields, attempts),
      parseEdit: parseBudgetEdit,
      edit: editBudget,
    },
  };
  // Order matters: loans / EMIs and budgets are claimed before goals ("Add ₹5,000 to my car loan" is not a goal), and the
  // broad transaction reading comes last.
  const START_ORDER = ['record_liability_repayment', 'set_budget', 'contribute_to_goal', 'create_transaction'];

  function labelOf(p) {
    return p.payload?.shortLabel ?? KINDS[p.kind]?.draftLabel ?? 'unfinished request';
  }

  // ═════════════ language-model fallback (Issue #77) ═════════════
  // Only for a NEW request that no deterministic parser understood. The model's answer is a hint: it is schema-checked,
  // grounded in the user's words, and converted back into the same fields the deterministic parsers produce, so entity
  // resolution, previews and explicit confirmation are exactly the ones every other action uses.
  const askWhichAction = (ctx) => handled(withNotice(ctx.preface, 'I\'m not sure what that payment is for. Is it an expense, a loan repayment, money for a savings goal, or a budget?'));
  const helpOrChat = (ctx, text) => (clearlyAnAction(text) ? handled(withNotice(ctx.preface, ACTION_HELP)) : NOT_HANDLED);

  async function startStructured(ctx, text) {
    if (!deps.extractStructured || !looksLikeActionAttempt(text)) return null;
    let result;
    try { result = await deps.extractStructured(text); } catch { result = { status: 'unavailable' }; }
    if (!result || result.status !== 'ok') return helpOrChat(ctx, text);
    const ex = result.extraction;
    if (ex.intent === 'none') return NOT_HANDLED;

    const prov = validateProvenance(ex, {
      original: ctx.original ?? text, normalized: text, toOriginal: ctx.toOriginal, localDate: ctx.localDate,
      resolvers: { directionCue, findDate, findBudgetMonth, shiftDate, shiftMonth },
    });
    if (!prov.ok) return helpOrChat(ctx, text);
    const f = prov.fields;

    // The intent must be supported by the user's own words, or by one of THEIR entities that the phrase resolves to.
    const lexical = [];
    if (LIAB_NOUN.test(text)) lexical.push('record_liability_repayment');
    if (BUDGET_WORD.test(text) || /\blimit\b/i.test(text)) lexical.push('set_budget');
    if (/\bgoals?\b/i.test(text)) lexical.push('contribute_to_goal');
    if (lexical.length > 1) return askWhichAction(ctx);
    if (lexical.length === 1 && lexical[0] !== ex.intent) return askWhichAction(ctx);

    const target = f.targetText ?? '';
    const fieldsCommon = {};
    if (f.amount != null) fieldsCommon.amount = f.amount;
    if (f.amountAmbiguous) fieldsCommon.amountAmbiguous = true;

    if (ex.intent === 'create_transaction') {
      if (lexical.length) return askWhichAction(ctx);
      if (UNSUPPORTED_CLASS.test(text)) return handled(withNotice(ctx.preface, "I can't record refunds or transfers from chat yet. Add them on the Transactions page, where you can pick the classification."));
      if (!f.type && !TXN_VERB.test(text)) return askWhichAction(ctx);
      const fields = { ...fieldsCommon };
      if (f.type) fields.type = f.type;
      const title = f.title ?? (target ? capitalize(target) : undefined);
      if (title) { fields.title = title; fields.titleRaw = f.titleRaw ?? target; }
      if (f.date) fields.date = f.date;
      if (f.dateIssue) fields.dateIssue = f.dateIssue;
      return advanceTransaction(ctx, fields);
    }
    if (ex.intent === 'contribute_to_goal') {
      const goals = await db.listGoalsByUser(ctx.userId);
      if (!lexical.length && !(target && nearGoalMatches(goals, cleanGoalPhrase(target)).length)) return askWhichAction(ctx);
      const rawPhrase = target.replace(/^(?:my|the|our)\s+/i, '');
      return advanceGoal(ctx, { ...fieldsCommon, namePhrase: cleanGoalPhrase(target), rawPhrase }, goals);
    }
    if (ex.intent === 'record_liability_repayment') {
      const liabilities = await db.listLiabilitiesByUser(ctx.userId);
      const rawPhrase = target.replace(/^(?:my|the|our)\s+/i, '').trim();
      const namePhrase = rawPhrase.replace(/\s+(?:loans?|emis?|liabilit(?:y|ies)|repayments?)$/i, '').trim();
      if (!lexical.length && !(rawPhrase && nearLiabilityMatches(liabilities, rawPhrase).length)) return askWhichAction(ctx);
      return advanceRepayment(ctx, { ...fieldsCommon, namePhrase, rawPhrase, hasEmi: /\bemis?\b/i.test(text) }, liabilities);
    }
    // set_budget
    if (/\b(?:increase|raise|reduce|lower|cut|decrease|add|top up)\b/i.test(text) && /\bby\b|\badd\b/i.test(text)) {
      return handled(withNotice(ctx.preface, "I can set a budget to an exact amount, for example “Set food budget to ₹8,000”, but I can't add to or reduce one by an amount."));
    }
    const category = target ? cleanBudgetCategory(target) : '';
    if (!lexical.length) {
      // no "budget" / "limit" in the sentence: the category has to be one of their budgets, and the verb has to be a "set"
      const month = f.month ?? ctx.localDate?.slice(0, 7);
      const list = month ? await db.listBudgetsByUserAndMonth(ctx.userId, month) : [];
      const known = category && list.some((b) => b.categoryKey === category.trim().toLowerCase());
      if (!known || !/\b(?:set|make|change|update|put)\b/i.test(text)) return askWhichAction(ctx);
    }
    const fields = { ...fieldsCommon };
    if (category) fields.categoryPhrase = category;
    if (f.month) fields.month = f.month;
    if (f.monthIssue) { fields.monthIssue = f.monthIssue; if (f.monthName) fields.monthName = f.monthName; }
    return advanceBudget(ctx, fields);
  }

  // `allowModel` is false whenever an earlier request was open: the language model is never consulted mid-conversation.
  async function startNew(ctx, text, { allowModel = false } = {}) {
    const t = stripPolite(text);
    if (!t || isQuestion(t)) return NOT_HANDLED;
    for (const kind of START_ORDER) {
      const result = await KINDS[kind].start(ctx, t);
      if (result) return result;
    }
    if (allowModel) {
      const viaModel = await startStructured(ctx, t);
      if (viaModel) return viaModel;
    }
    return NOT_HANDLED;
  }

  // Typos and speech slips are fixed first (actionNormalization.js). The user's own goal / loan / budget names are passed
  // as protected so a name that happens to look like a typo is never rewritten.
  async function prepare(userId, localDate, text) {
    let n = normalizeActionText(text);
    if (n.corrections.some((c) => c.kind !== 'filler')) {
      const [goals, liabilities, budgets] = await Promise.all([
        db.listGoalsByUser(userId),
        db.listLiabilitiesByUser(userId),
        localDate ? db.listBudgetsByUserAndMonth(userId, localDate.slice(0, 7)) : [],
      ]);
      n = normalizeActionText(text, { protect: [...goals.map((g) => g.title), ...liabilities.map((l) => l.name), ...budgets.map((b) => b.category)] });
    }
    const corrections = n.corrections.filter((c) => c.kind !== 'filler');
    const parts = [];
    const fixed = describeCorrections(corrections);
    if (fixed) parts.push(fixed);
    for (const sp of chooseAmount(n.text).spoken ?? []) parts.push(`“${sp.raw}” → ${formatRupees(sp.value)}`);
    return { n, corrections, interpreted: parts.join('; ') };
  }

  // Entry point, called once per chat message with the caller's verified id.
  //   -> { handled: true, reply, action }                the whole answer (clarification, proposal, cancellation)
  //   -> { handled: false, cancelNotice?, action? }      not an action: answer normally (after cancelling any open one)
  async function handleTurn({ userId, text: rawText, localDate }) {
    const active = await db.getActiveProposal(userId);
    const { n, corrections, interpreted } = await prepare(userId, localDate, rawText);
    const text = n.text;
    const t = stripPolite(text);
    const ctx = { userId, localDate, active, preface: '', corrections, interpreted, original: rawText, toOriginal: n.toOriginal };

    if (!active) return startNew(ctx, text, { allowModel: true });

    const yn = parseYesNo(text);
    if (yn === 'no') {
      const c = await cancelActive(userId, active);
      return handled('Okay, I cancelled that. Nothing was saved.', { proposalId: c.proposalId, kind: c.kind, status: 'cancelled' });
    }
    const p = active.payload;
    // what earlier turns of this request were read as (typo fixes, spoken amounts) stays on the card
    if (p?.interpreted) ctx.interpreted = [...new Set(`${p.interpreted}; ${ctx.interpreted}`.split('; ').filter(Boolean))].join('; ');
    const handler = KINDS[active.kind];
    if (handler && active.status === 'pending') {
      if (yn === 'yes') {
        // Confirmation only ever executes through the confirm endpoint; a "yes" typed into chat is just a reminder.
        return handled('Tap Confirm to go ahead, or say cancel.', view(active, 'pending'));
      }
      const edit = isQuestion(t) ? null : handler.parseEdit(text);
      if (edit) return handler.edit(ctx, text, p, edit);
    } else if (handler && !isQuestion(t)) {
      // An open clarification: the message is (probably) the answer, unless it is a brand-new request.
      const looksNew = START_ORDER.some((kind) => KINDS[kind].matches(t)) && chooseAmount(t).status !== 'none';
      if (!looksNew) return handler.continueDraft(ctx, text, p);
    }
    // A brand-new request, or an unrelated message: the open proposal is cancelled and the user is told.
    const c = await cancelActive(userId, active);
    const fresh = await startNew({ ...ctx, active: null, preface: c.notice }, text);
    if (fresh.handled) return fresh;
    return { handled: false, cancelNotice: c.notice, action: { proposalId: c.proposalId, kind: c.kind, status: 'cancelled' } };
  }

  return { handleTurn };
}
