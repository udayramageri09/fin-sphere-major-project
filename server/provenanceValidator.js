// provenanceValidator.js - does the model's reading of a message actually come FROM the message? (Issue #77)
//
// A structured extraction (structuredActionExtractor.js) is only a hint about where to look in the user's own words. This
// module re-derives every consequential value on the server and rejects the extraction when it cannot:
//   - every span the model returns (amount / title / target / date / month) must appear verbatim in the message
//     (case- and whitespace-insensitive, on word boundaries), either in the normalized text or in the original;
//   - the amount is NEVER taken from the model: the amount phrase is parsed again with numberParser.js, and a different
//     amount found in the message by the deterministic parser is a conflict (the user is asked), not a silent choice;
//   - dates and months are resolved by the server from the client's validated local date, and only when the span really
//     contains the matching words ("yesterday", "next month"); a month name without a year still asks for the year;
//   - the direction (income / expense) comes from cue words the user wrote; the model can only agree with them.
// The language-specific resolvers are injected (see assistantActions.js), which keeps this module free of circular imports.
//
// Pure functions, no I/O.
import { chooseAmount, parseMoneyText } from './numberParser.js';
import { parseLiabilityNumbers, hasRateEvidence, hasPaymentEvidence, parseTermSpan } from './liabilityLanguage.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reject = (reason) => ({ ok: false, reason });

// Finds `span` in `haystack` on word boundaries. -> { start, end } | null
export function findSpan(haystack, span) {
  const words = String(span).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const re = new RegExp(`(?<![A-Za-z0-9])${words.map(escapeRe).join('\\s+')}(?![A-Za-z0-9])`, 'i');
  const m = re.exec(haystack);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

// -> { text: 'normalized' | 'original', start, end, original: { start, end } } | null
export function groundSpan(span, { original, normalized, toOriginal }) {
  const inNormalized = findSpan(normalized, span);
  if (inNormalized) return { source: 'normalized', ...inNormalized, original: toOriginal ? toOriginal(inNormalized.start, inNormalized.end) : inNormalized };
  const inOriginal = findSpan(original, span);
  if (inOriginal) return { source: 'original', ...inOriginal, original: inOriginal };
  return null;
}

const DATE_WORDS = {
  today: /\b(?:today|tonight|this morning|this evening|this afternoon)\b/i,
  yesterday: /\byesterday\b/i,
  day_before_yesterday: /\bday before yesterday\b/i,
  iso: /\b\d{4}-\d{2}-\d{2}\b/,
};
const DATE_OFFSET = { today: 0, yesterday: -1, day_before_yesterday: -2 };
const MONTH_WORDS = {
  this: /\b(?:this month|current month)\b/i,
  next: /\bnext month\b/i,
  last: /\b(?:last month|previous month)\b/i,
};

const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const windowAround = (g, normalized, original) => {
  const text = g.source === 'normalized' ? normalized : original;
  return { before: text.slice(Math.max(0, g.start - 40), g.start), after: text.slice(g.end, g.end + 30) };
};

// Numbers of a new liability. The deterministic role parse (liabilityLanguage.js) is the authority: a model span can fill a
// role the sentence parse could not, but any disagreement about WHICH number is which becomes a question, not a choice.
// -> null | { ok: false, reason }; writes fields.liability = { outstanding?, rate?, payment?, term?, conflicts: [] }
function liabilityProvenance(extraction, { normalized, original, spans, fields, notes }) {
  const det = parseLiabilityNumbers(normalized);
  const out = { conflicts: [] };
  fields.liability = out;
  const named = ['amount', 'rate', 'payment', 'term'].filter((n) => spans[n]);
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      if (overlaps(spans[named[i]].original, spans[named[j]].original)) return reject('overlapping-spans');
    }
  }
  const roleOf = (value) => [['outstanding', det.outstanding], ['payment', det.payment], ['rate', det.rate]].find(([, d]) => d && d.value === value)?.[0];

  // outstanding balance
  const detOut = det.outstanding?.value;
  if (extraction.amount) {
    const parsed = parseMoneyText(extraction.amount.text);
    if (parsed.status === 'none') return reject('amount-not-a-number');
    if (parsed.status !== 'ok') { out.conflicts.push('outstanding'); notes.push(`amount-${parsed.status}`); }
    else if ((detOut !== undefined && detOut !== parsed.value) || (roleOf(parsed.value) && roleOf(parsed.value) !== 'outstanding') || det.issues.outstandingAmbiguous) {
      out.conflicts.push('outstanding'); notes.push('amount-conflict');
    } else out.outstanding = parsed.value;
  } else if (detOut !== undefined) out.outstanding = detOut;
  if (out.outstanding === undefined && det.issues.outstandingAmbiguous && !out.conflicts.includes('outstanding')) out.outstandingAmbiguous = det.issues.outstandingAmbiguous;

  // interest rate: the span must say it is a rate, and must be 0-100
  if (extraction.rate) {
    const w = windowAround(spans.rate, normalized, original);
    if (!hasRateEvidence(w.before, extraction.rate.text)) return reject('rate-no-evidence');
    const probe = parseLiabilityNumbers(/%|percent|per\s?cent/i.test(extraction.rate.text) ? extraction.rate.text : `${extraction.rate.text}%`);
    if (probe.issues.rateInvalid) return reject('rate-out-of-range');
    if (!probe.rate) return reject('rate-not-a-rate');
    const value = probe.rate.value;
    if ((det.rate && det.rate.value !== value) || (roleOf(value) && roleOf(value) !== 'rate' && !det.rate)) { out.conflicts.push('rate'); notes.push('rate-conflict'); }
    else out.rate = value;
  } else if (det.rate) out.rate = det.rate.value;
  if (det.issues.rateInvalid || det.issues.rateAmbiguous) out.rateInvalid = true;

  // monthly payment: must sit next to an EMI / monthly cue
  if (extraction.payment) {
    const parsed = parseMoneyText(extraction.payment.text);
    if (parsed.status === 'none') return reject('payment-not-a-number');
    const w = windowAround(spans.payment, normalized, original);
    if (!hasPaymentEvidence(w.before, w.after, extraction.payment.text)) return reject('payment-no-evidence');
    if (parsed.status !== 'ok') { out.conflicts.push('payment'); notes.push(`payment-${parsed.status}`); }
    else if ((det.payment && det.payment.value !== parsed.value) || (det.outstanding && det.outstanding.value === parsed.value && !det.payment)) { out.conflicts.push('payment'); notes.push('payment-conflict'); }
    else out.payment = parsed.value;
  } else if (det.payment) out.payment = det.payment.value;
  if (det.issues.paymentAmbiguous) out.paymentAmbiguous = true;

  // term: a length of time, never money; recognised but not stored
  if (extraction.term) {
    const term = parseTermSpan(extraction.term.text);
    if (!term) return reject('term-not-a-term');
    out.term = term;
  } else if (det.term) out.term = { n: det.term.n, unit: det.term.unit };
  return null;
}

// extraction: a validated object from validateExtraction().
// context: { original, normalized, toOriginal?, localDate, resolvers: { directionCue(text), findDate(text, localDate), findBudgetMonth(text, localDate), shiftDate(iso, days) } }
// -> { ok: false, reason } | { ok: true, intent, fields, spans, notes }
//    fields use the same names the deterministic parsers produce: type, amount, amountAmbiguous, titleRaw, title,
//    targetText, date, dateIssue, month, monthIssue, monthName
export function validateProvenance(extraction, context) {
  const { original, normalized, localDate, resolvers } = context;
  const where = { original, normalized, toOriginal: context.toOriginal };
  if (extraction.intent === 'none') return { ok: true, intent: 'none', fields: {}, spans: {}, notes: [] };

  const spans = {};
  const notes = [];
  for (const name of ['amount', 'title', 'target', 'date', 'month', 'rate', 'payment', 'term']) {
    const f = extraction[name];
    if (!f) continue;
    const g = groundSpan(f.text, where);
    if (!g) return reject(`ungrounded-${name}`);
    spans[name] = g;
  }

  const fields = {};

  // amount: re-parsed from the user's words; never the model's number
  if (extraction.intent === 'create_liability') {
    const bad = liabilityProvenance(extraction, { normalized, original, spans, fields, notes });
    if (bad) return bad;
  } else if (extraction.amount) {
    const parsed = parseMoneyText(extraction.amount.text);
    if (parsed.status === 'none') return reject('amount-not-a-number');
    if (parsed.status === 'ok') {
      const det = chooseAmount(normalized);
      if (det.status === 'one' && det.value !== parsed.value) { fields.amountAmbiguous = true; notes.push('amount-conflict'); }
      else if (det.status === 'many') { fields.amountAmbiguous = true; notes.push('amount-ambiguous'); }
      else fields.amount = parsed.value;
    } else {
      fields.amountAmbiguous = true;                         // several amounts, or one that cannot be read exactly
      notes.push(`amount-${parsed.status}`);
    }
  } else {
    const det = chooseAmount(normalized);
    if (det.status === 'one') fields.amount = det.value;      // the message itself had it even though the model did not point at it
    else if (det.status === 'many') fields.amountAmbiguous = true;
  }

  // direction: from cue words in the message; the model may only agree
  const cue = resolvers.directionCue(normalized);
  if (cue === 'income' || cue === 'expense') {
    fields.type = cue;
    if (extraction.direction && extraction.direction !== cue) notes.push('direction-overruled');
  } else if (cue === 'conflict') {
    notes.push('direction-conflict');
  } else if (extraction.direction) {
    notes.push('direction-unsupported');                     // no cue word in the message: ask instead of trusting the model
  }

  if (extraction.title) { fields.titleRaw = extraction.title.text; fields.title = extraction.title.text.charAt(0).toUpperCase() + extraction.title.text.slice(1); }
  if (extraction.target) fields.targetText = extraction.target.text;

  // date: resolved by the server, and only from words that really say it
  if (extraction.date) {
    const { text, kind } = extraction.date;
    if (!DATE_WORDS[kind].test(text)) return reject('date-kind-not-in-text');
    const d = resolvers.findDate(text, localDate);
    if (d.kind === 'ok') {
      if (kind !== 'iso' && localDate && d.date !== resolvers.shiftDate(localDate, DATE_OFFSET[kind])) return reject('date-kind-mismatch');
      fields.date = d.date;
    } else if (d.kind === 'needs-local') fields.dateIssue = 'needs-local';
    else fields.dateIssue = 'unsupported';
  }

  // month: resolved by the server; a month name without a year asks for the year
  if (extraction.month) {
    const { text, kind, year } = extraction.month;
    if (kind !== 'named' && !MONTH_WORDS[kind].test(text)) return reject('month-kind-not-in-text');
    if (year !== undefined && !new RegExp(`(?<!\\d)${year}(?!\\d)`).test(text)) return reject('month-year-not-in-text');
    const m = resolvers.findBudgetMonth(text, localDate);
    if (m.kind === 'ok') {
      if (kind !== 'named') {
        const expected = resolvers.shiftMonth(localDate.slice(0, 7), kind === 'next' ? 1 : kind === 'last' ? -1 : 0);
        if (m.month !== expected) return reject('month-kind-mismatch');
      }
      fields.month = m.month;
    } else if (m.kind === 'needs-year') { fields.monthIssue = 'needs-year'; fields.monthName = m.name; }
    else if (m.kind === 'needs-local') fields.monthIssue = 'needs-local';
    else if (m.kind === 'ambiguous') fields.monthIssue = 'ambiguous';
    else return reject('month-not-recognized');
  }

  return { ok: true, intent: extraction.intent, fields, spans, notes };
}
