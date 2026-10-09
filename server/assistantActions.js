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

export const PROPOSAL_TTL_SECONDS = 180;

// ── 1. Pure text helpers ─────────────────────────────────────────────────────────────────────────────────────────

const POLITE_PREFIX = /^(?:(?:hey|hi|ok|okay)\s+finsphere[,\s]+|finsphere[,\s]+)?(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:i(?:'d| would)?\s+(?:want|like)\s+(?:you\s+)?to\s+)?/i;
const POLITE_SUFFIX = /[\s,]+(?:please|thanks|thank you|for me)[.!\s]*$/i;

export const stripPolite = (text) => String(text ?? '').trim().replace(POLITE_PREFIX, '').replace(POLITE_SUFFIX, '').trim();

const QUESTION_START = /^(?:how|what|whats|what's|why|when|where|which|who|whose|is|are|was|were|do|does|did|am|have|has|should|will|shall|can|could|would|tell|show|explain|give|list|summari[sz]e|compare|calculate)\b/i;
export const isQuestion = (text) => /\?/.test(text) || QUESTION_START.test(stripPolite(text));

const clean = (s) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();

// Whole-utterance yes / no (used for open clarifications and for a confirmation that reaches the chat endpoint).
const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'confirm', 'confirmed', 'go ahead', 'do it', 'add it', 'haan', 'yes please', 'yes confirm', 'yes go ahead', 'yes do it', 'yes add it', 'please do', 'that one', 'that is right', 'correct']);
const NO = new Set(['no', 'nope', 'nah', 'cancel', 'cancel it', 'stop', "don't", 'dont', "don't add it", 'dont add it', 'never mind', 'nevermind', 'forget it', 'leave it', 'no thanks', 'no cancel', 'nahi', 'nahin', 'abort']);
export function parseYesNo(text) {
  const c = clean(text);
  if (YES.has(c)) return 'yes';
  if (NO.has(c)) return 'no';
  return null;
}

// ── Amounts: "₹450", "500", "5k", "1.5k", "1 lakh", "1.5 lakh", "1,25,000", "2 crore" ───────────────────────────────
const UNIT = { k: 1000, thousand: 1000, lakh: 100000, lakhs: 100000, lac: 100000, lacs: 100000, crore: 10000000, crores: 10000000, cr: 10000000 };
const AMOUNT_RE = /(?<![\w.])((?:₹|rs\.?|inr)\s*)?(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?(?:\s*(k|thousand|lakhs?|lacs?|crores?|cr)\b)?(\s*(?:rupees?|rs\b\.?|inr\b))?(?![A-Za-z0-9])/gi;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;

// Exact decimal scaling with BigInt (1.5 lakh -> 150000, 0.1 k -> 100); never floating-point multiplication.
function scaleDecimal(intDigits, fracDigits, multiplier) {
  const frac = fracDigits ?? '';
  const scaled = (BigInt(intDigits + frac) * BigInt(multiplier)).toString().padStart(frac.length + 1, '0');
  const whole = frac ? scaled.slice(0, scaled.length - frac.length) : scaled;
  const decimals = frac ? scaled.slice(scaled.length - frac.length).replace(/0+$/, '') : '';
  return Number(decimals ? `${whole}.${decimals}` : whole);
}

export function findAmounts(text) {
  const masked = String(text).replace(new RegExp(ISO_DATE_RE.source, 'g'), (m) => ' '.repeat(m.length));   // dates are not amounts
  const found = [];
  for (const m of masked.matchAll(AMOUNT_RE)) {
    const unit = m[4] ? UNIT[m[4].toLowerCase()] : 1;
    const digits = m[2].replace(/,/g, '');
    found.push({
      raw: m[0],
      index: m.index,
      value: scaleDecimal(digits, m[3], unit),
      marked: Boolean(m[1] || m[4] || m[5]),    // has a currency sign / unit / "rupees"
    });
  }
  return found;
}

// status: 'none' | 'one' | 'many'. Amounts with a currency sign or unit win over bare numbers ("₹450 for 2 people").
export function chooseAmount(text) {
  const all = findAmounts(text);
  const marked = all.filter((a) => a.marked);
  const group = marked.length ? marked : all;
  const distinct = [...new Set(group.map((a) => a.value))];
  if (distinct.length === 0) return { status: 'none' };
  if (distinct.length > 1) return { status: 'many', values: distinct };
  return { status: 'one', value: distinct[0], spans: all.map((a) => a.raw) };
}

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
  const hasAmount = findAmounts(t).length > 0;
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
  return goals.filter((g) => {
    const k = normKey(g.title);
    return k.includes(p) || p.includes(k) || tokens.some((tok) => k.split(/[^a-z0-9]+/).includes(tok) || k.includes(tok));
  }).slice(0, limit);
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

// ── Edits to a pending proposal ("make it ₹600", "change it to yesterday", "use the Goa Trip goal") ───────────────────
const EDIT_LEAD = /^(?:(?:yes|no|ok|okay)[,.\s]+(?:but\s+)?)?(?:actually[,.\s]+)?(?:please\s+)?(make it|make that|change it to|change (?:the )?(?:amount|date|title|name|description|type|goal)(?: it)? to|set (?:it|the amount|the date|the title) to|update (?:it |the amount |the date )?to|it should be|should be|it was|use|call it|name it|title it|rename it to)\s+(.+)$/i;
const TITLE_LEADS = /^(?:call it|name it|title it|rename it to|change (?:the )?(?:title|name|description)(?: it)? to|set (?:it|the title) to)$/i;

export function parseEdit(text, kind) {
  const m = EDIT_LEAD.exec(stripPolite(text).replace(/[.!]+$/, ''));
  if (!m) return null;
  const lead = m[1].toLowerCase();
  const rest = m[2].trim();
  if (kind === 'create_transaction') {
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
    }
    else if (date.kind === 'unsupported') patch.dateIssue = 'unsupported';
    const c = clean(rest);
    if (/\b(?:income|received|earned|credit)\b/.test(c) && !/\b(?:expense|spent|paid)\b/.test(c)) patch.type = 'income';
    else if (/\b(?:expense|spent|paid|debit)\b/.test(c) && !/\b(?:income|received|earned)\b/.test(c)) patch.type = 'expense';
    return Object.keys(patch).length ? { patch } : null;
  }
  // contribute_to_goal
  const amount = chooseAmount(rest);
  if (amount.status === 'many') return { ambiguous: 'amount' };
  if (amount.status === 'one') return { patch: { amount: amount.value } };
  if (/\d/.test(rest)) return null;
  const goalPhrase = cleanGoalPhrase(rest);
  return goalPhrase ? { patch: { goalPhrase } } : null;
}

// ── 2. The turn handler ──────────────────────────────────────────────────────────────────────────────────────────

const NOT_HANDLED = { handled: false };

export function createAssistantActions(deps) {
  const { db, normalizeTransactionInput, normalizeContributionInput, formatRupees } = deps;
  const ttlSeconds = deps.ttlSeconds ?? PROPOSAL_TTL_SECONDS;
  const MAX_ATTEMPTS = 2;

  const view = (p, status) => ({
    proposalId: p.id, kind: p.kind, status, summary: p.summary, display: p.display, expiresAt: p.expiresAt,
  });
  const store = (userId, kind, status, payload, summary, display) =>
    db.replaceActiveProposal({ id: randomUUID(), userId, kind, status, payload, summary, display, ttlSeconds });

  const labelOf = (p) => p.payload?.shortLabel ?? (p.kind === 'contribute_to_goal' ? 'unfinished goal contribution' : 'unfinished transaction');
  async function cancelActive(userId, active) {
    if (!active) return null;
    await db.cancelProposal(userId, active.id);
    return {
      proposalId: active.id, kind: active.kind, status: 'cancelled',
      notice: `I cancelled the ${labelOf(active)}. Nothing was saved.`,
    };
  }
  const handled = (reply, action = null) => ({ handled: true, reply, action });
  const withNotice = (preface, reply) => (preface ? `${preface} ${reply}` : reply);

  // ----- transactions -----
  const askAbout = (want, f) => {
    const amt = f.amount != null ? formatRupees(f.amount) : null;
    switch (want) {
      case 'type': return 'Was that money you spent or money you received?';
      case 'amount-many': return 'I found more than one amount. How much was it?';
      case 'amount': return f.type === 'income'
        ? `How much did you receive${f.titleRaw ? ` for ${f.titleRaw}` : ''}?`
        : `How much did you spend${f.titleRaw ? ` on ${f.titleRaw}` : ''}?`;
      case 'title': return f.type === 'income' ? `What was the ${amt} income from?` : `What was the ${amt} expense for?`;
      default: return 'What date was this? You can say today, yesterday, or a date like 2026-10-05.';
    }
  };

  const whenWords = (date, localDate) => (date === localDate ? 'today' : localDate && date === shiftDate(localDate, -1) ? 'yesterday' : date);

  async function advanceTransaction(ctx, fields, attempts = 0) {
    const { userId, localDate, preface, active } = ctx;
    const f = { ...fields };
    if (!f.date && !f.dateIssue && localDate) f.date = localDate;       // the product's default (the manual form also starts at today)
    let want = null;
    if (!f.type) want = 'type';
    else if (f.amountAmbiguous) want = 'amount-many';
    else if (f.amount == null) want = 'amount';
    else if (!f.title) want = 'title';
    else if (f.dateIssue || !f.date) want = 'date';
    if (want) {
      const question = askAbout(want, f);
      const draft = await store(userId, 'create_transaction', 'draft',
        { kind: 'create_transaction', stage: 'missing', want, fields: f, attempts },
        question, []);
      return handled(withNotice(preface, question), view(draft, 'needs_clarification'));
    }
    const input = { title: f.title, amount: f.amount, type: f.type, date: f.date };
    const checked = normalizeTransactionInput(input);
    if (!checked.ok) {
      const c = await cancelActive(userId, active);
      return handled(withNotice(preface, `I can't add that: ${checked.error}.`), c && { proposalId: c.proposalId, kind: c.kind, status: 'cancelled' });
    }
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
    const pending = await store(userId, 'create_transaction', 'pending',
      { kind: 'create_transaction', fields: { ...f, date: v.date }, input: { title: v.title, amount: abs, type: v.type, date: v.date }, shortLabel: `${formatRupees(abs)} ${noun}` },
      summary, display);
    return handled(withNotice(preface, summary), view(pending, 'pending'));
  }

  // ----- goal contributions -----
  const goalLine = (g) => `“${g.title}” (${formatRupees(g.currentAmount)} saved of ${formatRupees(g.targetAmount)}, due ${g.targetDate})`;
  const asCandidate = (g) => ({ id: g.id, title: g.title, current: g.currentAmount, target: g.targetAmount, targetDate: g.targetDate });

  async function askGoal(ctx, fields, candidates, intro, attempts = 0) {
    const lines = candidates.map((g, i) => `${i + 1}. ${goalLine({ title: g.title, currentAmount: g.current, targetAmount: g.target, targetDate: g.targetDate })}`);
    const question = candidates.length === 1
      ? `${intro} Is it ${lines[0].slice(3)}? Say yes, or cancel.`
      : `${intro} Which one? ${lines.join(' ')} Say the number.`;
    const draft = await store(ctx.userId, 'contribute_to_goal', 'draft',
      { kind: 'contribute_to_goal', stage: 'choose_goal', fields, candidates, attempts }, question, []);
    return handled(withNotice(ctx.preface, question), view(draft, 'needs_clarification'));
  }

  async function buildGoalProposal(ctx, goal, amountRaw, fields) {
    const checked = normalizeContributionInput({ amount: amountRaw });
    if (!checked.ok) {
      const c = await cancelActive(ctx.userId, ctx.active);
      return handled(withNotice(ctx.preface, `I can't add that: ${checked.error}.`), c && { proposalId: c.proposalId, kind: c.kind, status: 'cancelled' });
    }
    const amount = checked.value.amount;
    const preview = await db.previewGoalContribution(ctx.userId, goal.id, amount);
    const stop = async (reply) => {
      const c = await cancelActive(ctx.userId, ctx.active);
      return handled(withNotice(ctx.preface, reply), c && { proposalId: c.proposalId, kind: c.kind, status: 'cancelled' });
    };
    if (!preview) return stop("I couldn't find that goal any more, so nothing was saved.");
    if (preview.complete) return stop(`“${preview.title}” is already complete, so I can't add to it.`);
    if (preview.exceeds) return stop(`Adding ${formatRupees(amount)} would go past the target of “${preview.title}”; only ${formatRupees(preview.remaining)} is left. Nothing was saved.`);
    const summary = `I'll add ${formatRupees(amount)} to your ${preview.title} goal. Should I add it?`;
    const display = [
      { label: 'Goal', value: preview.title },
      { label: 'Contribution', value: formatRupees(amount) },
      { label: 'Current', value: formatRupees(preview.current) },
      { label: 'After', value: formatRupees(preview.after) },
      { label: 'Target', value: formatRupees(preview.target) },
    ];
    const pending = await store(ctx.userId, 'contribute_to_goal', 'pending',
      { kind: 'contribute_to_goal', goalId: goal.id, goalTitle: preview.title, amount, fields: { ...fields, amount }, shortLabel: `${formatRupees(amount)} contribution to ${preview.title}` },
      summary, display);
    return handled(withNotice(ctx.preface, summary), view(pending, 'pending'));
  }

  async function askGoalAmount(ctx, goal, fields, attempts = 0) {
    const question = `How much would you like to add to ${goal.title}?`;
    const draft = await store(ctx.userId, 'contribute_to_goal', 'draft',
      { kind: 'contribute_to_goal', stage: 'amount', fields, goalId: goal.id, goalTitle: goal.title, attempts }, question, []);
    return handled(withNotice(ctx.preface, question), view(draft, 'needs_clarification'));
  }

  // Resolve the goal for a (possibly partial) request and move to the next step. `goals` are the caller's own.
  async function advanceGoal(ctx, fields, goals, attempts = 0) {
    const phrase = fields.namePhrase ?? '';
    const live = goals.filter((g) => g.currentAmount < g.targetAmount);
    const exact = phrase ? exactGoalMatches(goals, phrase, fields.rawPhrase) : [];
    const stopWith = async (reply) => {
      const c = await cancelActive(ctx.userId, ctx.active);
      return handled(withNotice(ctx.preface, reply), c && { proposalId: c.proposalId, kind: c.kind, status: 'cancelled' });
    };
    if (exact.length > 1) return askGoal(ctx, fields, exact.map(asCandidate), `You have ${exact.length} goals called “${exact[0].title}”.`, attempts);
    if (exact.length === 0) {
      if (goals.length === 0) return stopWith("You don't have any savings goals yet. You can create one on the Goals page.");
      const pool = phrase ? nearGoalMatches(goals, phrase) : live.slice(0, 5);
      if (pool.length === 0) return stopWith(`I couldn't find a goal called “${phrase}”. Your goals: ${goals.slice(0, 5).map((g) => `“${g.title}”`).join(', ')}.`);
      return askGoal(ctx, fields, pool.map(asCandidate), phrase ? `I couldn't find a goal called “${phrase}”.` : 'Which goal is this for?', attempts);
    }
    const goal = exact[0];
    if (fields.amountAmbiguous) return askGoalAmount({ ...ctx }, goal, fields, attempts);
    if (fields.amount == null) return askGoalAmount(ctx, goal, fields, attempts);
    return buildGoalProposal(ctx, goal, fields.amount, fields);
  }

  async function startNew(ctx, text) {
    const t = stripPolite(text);
    if (!t || isQuestion(t)) return NOT_HANDLED;
    const goalReq = extractGoalContribution(t);
    if (goalReq) {
      const goals = await db.listGoalsByUser(ctx.userId);
      const exact = exactGoalMatches(goals, goalReq.namePhrase, goalReq.rawPhrase);
      const near = nearGoalMatches(goals, goalReq.namePhrase);
      // "Add ₹100 to <name>" is a goal request unless the sentence is plainly about a transaction ("... to expenses").
      const ours = goalReq.strongVerb || goalReq.hasGoalWord || exact.length > 0 || near.length > 0 || !TXN_NOUN.test(t);
      if (ours) {
        const fields = { namePhrase: goalReq.namePhrase, rawPhrase: goalReq.rawPhrase };
        if (goalReq.amount.status === 'one') fields.amount = goalReq.amount.value;
        if (goalReq.amount.status === 'many') fields.amountAmbiguous = true;
        return advanceGoal(ctx, fields, goals);
      }
    }
    if (!looksLikeTransaction(t)) return NOT_HANDLED;
    const ex = extractTransaction(t, { localDate: ctx.localDate });
    if (ex.unsupportedClassification) {
      return handled(withNotice(ctx.preface, "I can't record refunds or transfers from chat yet. Add them on the Transactions page, where you can pick the classification."));
    }
    const fields = { ...ex.fields };
    if (ex.issues.amountAmbiguous) fields.amountAmbiguous = true;
    if (ex.issues.dateIssue) fields.dateIssue = ex.issues.dateIssue;
    return advanceTransaction(ctx, fields);
  }

  // ----- continuing an open proposal -----
  async function continueTransactionDraft(ctx, text, p) {
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

  async function continueGoalDraft(ctx, text, p) {
    const goals = await db.listGoalsByUser(ctx.userId);
    if (p.stage === 'choose_goal') {
      let idx = pickCandidate(text, p.candidates);
      let goal = idx != null ? goals.find((g) => g.id === p.candidates[idx].id) : null;
      if (!goal) {
        const typed = exactGoalMatches(goals, stripPolite(text).replace(/\s+goals?$/i, ''));
        if (typed.length === 1) goal = typed[0];
      }
      if (!goal) return retryOrGiveUp(ctx, p);
      const fields = { ...p.fields, namePhrase: goal.title, rawPhrase: goal.title };
      if (fields.amountAmbiguous) return askGoalAmount(ctx, goal, fields);
      if (fields.amount == null) return askGoalAmount(ctx, goal, fields);
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

  // Nothing in the reply moved the draft forward: ask once more, then give up (never loops).
  async function retryOrGiveUp(ctx, p) {
    const attempts = (p.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      const c = await cancelActive(ctx.userId, ctx.active);
      return handled(withNotice(ctx.preface, `I couldn't work out what you meant, so I cancelled the ${labelOf(ctx.active)}. Nothing was saved.`),
        c && { proposalId: c.proposalId, kind: c.kind, status: 'cancelled' });
    }
    if (p.kind === 'create_transaction') return advanceTransaction(ctx, p.fields, attempts);
    const goals = await db.listGoalsByUser(ctx.userId);
    if (p.stage === 'choose_goal') return askGoal(ctx, p.fields, p.candidates, 'I didn\'t catch which goal.', attempts);
    const goal = goals.find((g) => g.id === p.goalId);
    return goal ? askGoalAmount(ctx, goal, p.fields, attempts) : handled('Sorry, I lost track of that goal. Nothing was saved.');
  }

  async function editPending(ctx, text, p, edit) {
    if (edit.ambiguous) {
      return handled('I found more than one amount. Please tell me the one you want, or cancel.', view(ctx.active, 'pending'));
    }
    if (p.kind === 'create_transaction') {
      const f = { ...p.fields, ...edit.patch };
      delete f.relativeDate;
      if (edit.patch.relativeDate) {
        const d = findDate(edit.patch.relativeDate, ctx.localDate);
        if (d.kind === 'ok') f.date = d.date; else { delete f.date; f.dateIssue = d.kind; }
      }
      if (edit.patch.date) delete f.dateIssue;
      return advanceTransaction({ ...ctx, preface: '' }, f);
    }
    const goals = await db.listGoalsByUser(ctx.userId);
    const fields = { ...p.fields, ...(edit.patch.amount != null ? { amount: edit.patch.amount } : {}) };
    if (edit.patch.goalPhrase) { fields.namePhrase = edit.patch.goalPhrase; fields.rawPhrase = edit.patch.goalPhrase; return advanceGoal({ ...ctx, preface: '' }, fields, goals); }
    const goal = goals.find((g) => g.id === p.goalId);
    if (!goal) return handled('I lost track of that goal. Nothing was saved.');
    return buildGoalProposal({ ...ctx, preface: '' }, goal, fields.amount, fields);
  }

  // Entry point, called once per chat message with the caller's verified id.
  //   -> { handled: true, reply, action }                the whole answer (clarification, proposal, cancellation)
  //   -> { handled: false, cancelNotice?, action? }      not an action: answer normally (after cancelling any open one)
  async function handleTurn({ userId, text, localDate }) {
    const active = await db.getActiveProposal(userId);
    const t = stripPolite(text);
    const ctx = { userId, localDate, active, preface: '' };

    if (!active) return startNew(ctx, text);

    const yn = parseYesNo(text);
    if (yn === 'no') {
      const c = await cancelActive(userId, active);
      return handled('Okay, I cancelled that. Nothing was saved.', { proposalId: c.proposalId, kind: c.kind, status: 'cancelled' });
    }
    const p = active.payload;
    if (active.status === 'pending') {
      if (yn === 'yes') {
        // Confirmation only ever executes through the confirm endpoint; a "yes" typed into chat is just a reminder.
        return handled('Tap Confirm to go ahead, or say cancel.', view(active, 'pending'));
      }
      const edit = isQuestion(t) ? null : parseEdit(text, p.kind);
      if (edit) return editPending(ctx, text, p, edit);
    } else if (!isQuestion(t)) {
      // An open clarification: the message is (probably) the answer, unless it is a brand-new request.
      const fresh = (extractGoalContribution(t) && chooseAmount(t).status !== 'none') || (looksLikeTransaction(t) && chooseAmount(t).status !== 'none');
      if (!fresh) {
        return p.kind === 'create_transaction' ? continueTransactionDraft(ctx, text, p) : continueGoalDraft(ctx, text, p);
      }
    }
    // A brand-new request, or an unrelated message: the open proposal is cancelled and the user is told.
    const c = await cancelActive(userId, active);
    const fresh = await startNew({ userId, localDate, active: null, preface: c.notice }, text);
    if (fresh.handled) return fresh;
    return { handled: false, cancelNotice: c.notice, action: { proposalId: c.proposalId, kind: c.kind, status: 'cancelled' } };
  }

  return { handleTurn };
}
