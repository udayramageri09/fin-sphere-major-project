import { categoryRuleKey, detectMerchantCategory } from './merchantCategories.js';

export const PDF_REVIEW_THRESHOLD = 70;
export const PDF_CLASSIFICATIONS = {
  income: ['income', 'refund', 'transfer'],
  expense: ['expense', 'transfer']
};
export const PDF_CATEGORIES = ['Groceries', 'Housing', 'Healthcare', 'Education', 'Subscriptions', 'Insurance',
  'Loan Repayment', 'Bank Fees', 'Interest', 'Dividends', 'Transfers', 'Cash', 'General'];
const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
const DATE = /(?<![\w/-])(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/. ](?:\d{1,2}|[a-z]{3,9})[-/. ](?:\d{4}|\d{2}))(?![\w/-])/gi;
const MONEY = /(?<![\w./-])([+-]? *(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2})(?:\s*(CR|DR|CREDIT|DEBIT)\b)?(?![\w./])/gi;
const BALANCE_LINE = /\b(?:opening|closing|brought forward|carried forward)\s*(?:balance|b\/f|c\/f)?\b|\bbalance\s+(?:brought|carried)\s+forward\b/i;
const CELL_AMOUNT = /^(?:₹\s*)?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?$/;
const label = (item) => item.text.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();

function statementDate(raw) {
  const [a, b, c] = raw.toLowerCase().split(/[-/. ]/);
  const yearFirst = a.length === 4;
  const year = yearFirst ? a : c.length === 2 ? `20${c}` : c;
  const month = Number(b) || MONTHS.indexOf(b.slice(0, 3)) + 1;
  const day = Number(yearFirst ? c : a);
  const result = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${result}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === result ? result : '';
}

const moneyTokens = (text) => [...text.matchAll(MONEY)].map((match) => {
  const raw = match[1].replace(/[\s,]/g, '');
  const sign = raw.startsWith('-') ? -1 : raw.startsWith('+') ? 1 : 0;
  const marker = match[2] ? (/^(?:cr|credit)$/i.test(match[2]) ? 1 : -1) : 0;
  return {
    paise: Math.round(Math.abs(Number(raw)) * 100),
    sign: sign || marker,
    conflict: Boolean(sign && marker && sign !== marker),
    index: match.index
  };
});

export function pdfRuleKey(title, type) {
  const merchant = categoryRuleKey(title);
  return /[\p{L}]{3}/u.test(merchant) && merchant.length <= 120 && PDF_CLASSIFICATIONS[type] ? `${type}:${merchant}` : '';
}

const NARRATION_RULES = [
  ['income', 'Interest', 'income', /\b(?:interest (?:paid|credited|payment|on savings)|(?:savings|sb|deposit) interest|int(?:erest)? pd)\b/i],
  ['income', 'Dividends', 'income', /\b(?:dividend|div payout)\b/i],
  ['income', 'Salary', 'income', /\b(?:salary|payroll|paycheck)\b/i],
  ['expense', 'Bills', 'expense', /\b(?:electricity bill|mobile recharge)\b/i],
  ['expense', 'Bank Fees', 'expense', /\b(?:bank charges?|(?:annual|debit card|service|atm) fees?|minimum balance (?:fee|charges?)|sms charges?)\b/i],
  ['expense', 'Loan Repayment', 'expense', /\b(?:loan repayment|emi|equated monthly instal[l]?ment)\b/i],
  ['expense', 'Healthcare', 'expense', /\b(?:pharmacy|hospital|clinic|diagnostics|medical store)\b/i],
  ['expense', 'Education', 'expense', /\b(?:tuition|school fees?|college fees?|university fees?)\b/i],
  ['expense', 'Housing', 'expense', /\b(?:house rent|rent payment|apartment rent)\b/i],
  ['expense', 'Insurance', 'expense', /\b(?:insurance premium|life insurance|health insurance)\b/i],
  ['expense', 'Groceries', 'expense', /\b(?:grocer(?:y|ies)|supermarket|bigbasket|dmart|zepto|blinkit|instamart)\b/i]
];

export function pdfHistoryRules(transactions = []) {
  const matches = new Map();
  for (const { id, title, type, classification, category } of transactions) {
    const key = pdfRuleKey(title, type);
    if (!key || !id || !PDF_CLASSIFICATIONS[type]?.includes(classification) || !category?.trim()
      || /^(?:general|others?|p2p)$/i.test(category.trim())) continue;
    const previous = matches.get(key) ?? { category, classification, ids: new Set(), conflict: false };
    previous.conflict ||= previous.category !== category || previous.classification !== classification;
    previous.ids.add(id);
    matches.set(key, previous);
  }
  return new Map([...matches].filter(([, match]) => match.conflict || match.ids.size >= 2));
}

function suggest(title, type, rules, history) {
  const key = pdfRuleKey(title, type);
  const learned = rules.get(key);
  if (learned?.category && PDF_CLASSIFICATIONS[type]?.includes(learned.classification)) {
    return { category: learned.category, classification: learned.classification, score: 98, reason: 'Remembered correction' };
  }
  const category = detectMerchantCategory(title) ?? '';
  if (!type) return { category, classification: '', score: 0, reason: 'Check the amount and direction' };
  const past = history.get(key);
  const explicitRefund = type === 'income' && /\b(?:refund|reversal|cashback)\b/i.test(title);
  const explicitTransfer = /\b(?:self transfer|own accounts?|transfer to self|transfer from self|between own accounts)\b/i.test(title);
  const cardPayment = type === 'expense' && /\b(?:credit card (?:bill|payment)|(?:payment|paid) (?:to|towards) (?:my )?credit card)\b/i.test(title);
  const match = NARRATION_RULES.find(([direction, , , narration]) => direction === type && narration.test(title));
  if (past?.conflict || (explicitRefund && explicitTransfer)
    || (past && ((explicitRefund && past.classification !== 'refund') || (explicitTransfer && past.classification !== 'transfer')
      || (match && !explicitRefund && past.classification !== match[2])))) {
    return { category, classification: '', score: 45, reason: 'Conflicting classification clues' };
  }
  if (past) return { category: past.category, classification: past.classification, score: 90, reason: 'Matches classified account history' };
  if (explicitRefund) return { category: category || 'General', classification: 'refund', score: category && category !== 'P2P' ? 85 : 60, reason: 'Refund wording in the description', provisional: !category || category === 'P2P' };
  if (explicitTransfer) return { category: 'Transfers', classification: 'transfer', score: 92, reason: 'Explicit own-account transfer' };
  if (cardPayment) return { category: 'Bills', classification: '', score: 45, reason: 'Check whether this card payment is a transfer to avoid counting the spending twice' };
  if (match && !/\b(?:reversal|refund)\b/i.test(title)) {
    return { category: match[1], classification: match[2], score: 88, reason: 'Recognized bank description' };
  }
  if (type === 'expense' && category && category !== 'P2P' && category !== 'Salary' && category !== 'Investment'
      && !/\b(?:transfer|refund|reversal)\b/i.test(title)) {
    return { category, classification: 'expense', score: 80, reason: 'Recognized merchant' };
  }
  if (category === 'P2P') {
    return { category, classification: type, score: 72, reason: type === 'income' ? 'UPI payment received from a person' : 'UPI payment to a person', provisional: true };
  }
  return {
    category: category || 'General',
    classification: type,
    score: category ? 55 : 35,
    reason: type === 'income' ? 'Suggested income from money in; check for refunds or transfers' : 'Suggested expense from money out; check for transfers',
    provisional: true
  };
}

export function emptyPdfRow(id, source = '') {
  return { id, source, title: '', date: '', amount: '', type: '', category: '', classification: '', confidence: 0, reviewed: false, excluded: false, remember: false };
}

export function pdfTableRows(items, inherited = null) {
  const cells = items.filter((item) => item.str?.trim() && item.transform).map((item) => ({
    text: item.str.trim(), x: item.transform[4], y: item.transform[5], end: item.transform[4] + item.width
  }));
  const withdrawal = cells.find((cell) => /^(?:withdrawal|debit)(?: amount)?$/.test(label(cell)));
  const deposit = cells.find((cell) => withdrawal && Math.abs(cell.y - withdrawal.y) < 14 && /^(?:deposit|credit)(?: amount)?$/.test(label(cell)));
  const balance = cells.find((cell) => deposit && Math.abs(cell.y - deposit.y) < 14 && /^(?:running )?balance$/.test(label(cell)));
  const remarks = cells.find((cell) => withdrawal && Math.abs(cell.y - withdrawal.y) < 20 && /^(?:transaction remarks|remarks|particulars|description|narration)$/.test(label(cell)));
  const heading = cells.find((cell) => remarks && Math.abs(cell.y - remarks.y) < 20 && /^(?:transaction|txn)(?: date)?$|^date$/.test(label(cell)) && cell.x < remarks.x);
  const found = heading && withdrawal && deposit && balance && heading.x < remarks.x && remarks.x < withdrawal.x
    && withdrawal.end < deposit.end && deposit.end < balance.end;
  const layout = found ? {
    dateMin: heading.x - 25, dateMax: (heading.end + remarks.x) / 2,
    descriptionMin: remarks.x - Math.min(60, (remarks.x - heading.end) / 2),
    amountMin: withdrawal.x - 18,
    ends: [withdrawal.end, deposit.end, balance.end]
  } : inherited;
  if (!layout) return { layout: null, rows: [] };
  const anchors = cells.filter((cell) => cell.x >= layout.dateMin && cell.x < layout.dateMax
    && (!found || cell.y < Math.min(heading.y, remarks.y) - 4)
    && [...cell.text.matchAll(DATE)].some((match) => match[0] === cell.text))
    .sort((a, b) => b.y - a.y);
  if (!anchors.length) return { layout, rows: [] };
  const column = (cell) => {
    const distances = layout.ends.map((end) => Math.abs(end - cell.end));
    const min = Math.min(...distances);
    return min > 25 || distances.filter((distance) => distance === min).length > 1 ? -1 : distances.indexOf(min);
  };
  const rows = anchors.map((anchor, index) => {
    const upper = index ? (anchors[index - 1].y + anchor.y) / 2 : anchor.y + 15;
    const lower = index + 1 < anchors.length ? (anchors[index + 1].y + anchor.y) / 2 : anchor.y - 15;
    const description = cells.filter((cell) => cell.y <= upper && cell.y > lower && cell.x >= layout.descriptionMin
      && (cell.end < layout.amountMin || (cell.x < layout.amountMin && !CELL_AMOUNT.test(cell.text))))
      .sort((a, b) => b.y - a.y || a.x - b.x).map((cell) => cell.text).join(' ');
    const fields = [[], [], []];
    let unreadable = false;
    for (const cell of cells.filter((item) => Math.abs(item.y - anchor.y) < 3 && item.end > layout.amountMin && item.x > layout.descriptionMin
      && !(item.x < layout.amountMin && !CELL_AMOUNT.test(item.text)))) {
      if (/^(?:-|–|—)$/.test(cell.text)) continue;
      const position = column(cell);
      if (position === -1 || !CELL_AMOUNT.test(cell.text)) { unreadable = true; continue; }
      fields[position].push(Number(cell.text.replace(/[₹,\s]/g, '')));
    }
    const [debits, credits, balances] = fields;
    const debit = debits[0] || 0;
    const credit = credits[0] || 0;
    const known = !unreadable && fields.every((values) => values.length <= 1) && Boolean(debit) !== Boolean(credit);
    return {
      date: statementDate(anchor.text), title: description,
      type: known ? debit ? 'expense' : 'income' : '',
      amount: known ? (debit || credit).toFixed(2) : '',
      source: [anchor.text, description, ...debits.map((n) => `Withdrawal: ${n}`), ...credits.map((n) => `Deposit: ${n}`),
        ...balances.map((n) => `Balance: ${n}`)].join(' | ')
    };
  });
  return { layout, rows };
}

export function buildPdfDraft(text, { rules = [], usedOcr = false, pages, history = new Map() } = {}) {
  const learned = new Map(rules.map((rule) => [rule.key, rule]));
  if (pages?.length) {
    const rows = pages.flatMap((page) => page.tableRows?.length ? page.tableRows.map((row) => {
      const suggestion = suggest(row.title, row.type, learned, history);
      const complete = row.type && row.date && row.title && row.title.length <= 120;
      return {
        ...emptyPdfRow(0, row.source), ...row, title: row.title.slice(0, 120),
        category: suggestion.category, classification: suggestion.classification,
        confidence: Math.min(suggestion.score, complete ? 96 : 45),
        provisional: Boolean(complete && suggestion.provisional),
        reason: complete ? suggestion.reason : 'Check the statement fields'
      };
    }) : buildPdfDraft(page.text, { rules, usedOcr: page.usedOcr, history }));
    return rows.map((row, id) => ({ ...row, id }));
  }
  const rows = [];
  let previousBalance = null;
  for (const raw of text.split(/\r?\n/)) {
    const source = raw.trim();
    if (!source) continue;
    const dates = [...source.matchAll(DATE)];
    const body = source.replace(DATE, ' ');
    const tokens = moneyTokens(body);
    if (BALANCE_LINE.test(source) && tokens.length === 1 && (!dates.length || BALANCE_LINE.test(source.replace(DATE, '').trim().split(/\d/)[0]))) {
      if (/\b(?:opening|brought)\b/i.test(source) && !tokens[0].conflict) previousBalance = (tokens[0].sign || 1) * tokens[0].paise;
      continue;
    }
    if (!dates.length) {
      // An undated amount may be a broken OCR row or a continuation; never turn it into a signed transaction.
      if (tokens.length && !/^(?:totals?|closing|opening|summary|page|statement|available balance)\b/i.test(source)) {
        rows.push(emptyPdfRow(rows.length, source));
        previousBalance = null;
      }
      continue;
    }
    if (!tokens.length && !/^\d{1,4}[-/. ]/.test(source)) continue;
    const date = statementDate(dates[0][0]);
    const last = tokens.at(-1);
    const canBeBalance = tokens.length >= 2 && !last.conflict;
    const balance = canBeBalance ? (last.sign || 1) * last.paise : null;
    const delta = balance !== null && previousBalance !== null ? balance - previousBalance : null;
    const fields = canBeBalance ? tokens.slice(0, -1) : tokens;
    const candidates = fields.filter((token) => !token.conflict && token.paise > 0);
    const matched = delta ? candidates.filter((token) => token.paise === Math.abs(delta) && (!token.sign || token.sign === Math.sign(delta))) : [];
    const explicit = candidates.filter((token) => token.sign);
    const chosen = matched.length === 1 ? matched[0]
      : delta === null && explicit.length === 1 && candidates.length === 1 ? explicit[0] : null;
    const sign = chosen ? matched.length === 1 ? Math.sign(delta) : chosen.sign : 0;
    const type = sign > 0 ? 'income' : sign < 0 ? 'expense' : '';
    const amountField = chosen ?? (candidates.length === 1 ? candidates[0] : null);
    const title = body.slice(0, tokens[0]?.index).trim().replace(/^[\d\s.,:;|-]+/, '').replace(/\s+/g, ' ');
    const suggestion = suggest(title, type, learned, history);
    const extractionScore = !type || !date || !title || title.length > 120 ? 45 : usedOcr ? 65 : matched.length === 1 ? 97 : 92;
    rows.push({
      ...emptyPdfRow(rows.length, source), title: title.slice(0, 120), date,
      amount: amountField ? (amountField.paise / 100).toFixed(2) : '',
      type, category: suggestion.category, classification: suggestion.classification,
      confidence: Math.min(suggestion.score, extractionScore),
      provisional: Boolean(extractionScore >= PDF_REVIEW_THRESHOLD && suggestion.provisional),
      reason: extractionScore < PDF_REVIEW_THRESHOLD ? 'Check the statement fields' : suggestion.reason
    });
    previousBalance = balance;
  }
  return rows;
}

export const needsPdfReview = (row) => !row.excluded && (!validPdfRow(row)
  || (!row.reviewed && (row.edited || (row.confidence < PDF_REVIEW_THRESHOLD && !row.provisional))));

// Rows the local rules could only guess at (unknown merchant, plain General): the ones worth asking the AI about.
export const aiCandidates = (rows) => rows.filter((row) => row.provisional && row.category === 'General' && PDF_CLASSIFICATIONS[row.type] && row.title.trim())
  .map((row) => ({ index: row.id, title: row.title, type: row.type }));

// Applies validated AI suggestions to those rows only; anything invalid or for another row is ignored.
export function applyAiSuggestions(rows, suggestions) {
  const byIndex = new Map(suggestions.map((suggestion) => [suggestion.index, suggestion]));
  const candidates = new Set(aiCandidates(rows).map((candidate) => candidate.index));
  return rows.map((row) => {
    const suggestion = byIndex.get(row.id);
    if (!suggestion || !candidates.has(row.id) || row.edited || typeof suggestion.category !== 'string'
      || !suggestion.category.trim() || suggestion.category.length > 60 || !PDF_CLASSIFICATIONS[row.type]?.includes(suggestion.classification)) return row;
    return { ...row, category: suggestion.category.trim(), classification: suggestion.classification, confidence: 80, provisional: false, reason: 'AI suggestion' };
  });
}

export function validPdfRow(row) {
  return Boolean(row.title.trim() && row.title.length <= 120 && /^\d{4}-\d{2}-\d{2}$/.test(row.date)
    && /^\d{1,9}(?:\.\d{1,2})?$/.test(row.amount) && Number(row.amount) > 0
    && row.category.trim() && row.category.length <= 60 && PDF_CLASSIFICATIONS[row.type]?.includes(row.classification));
}

export function pdfImportValue(row) {
  return { title: row.title.trim(), date: row.date, type: row.type, amount: Number(row.amount) * (row.type === 'expense' ? -1 : 1), category: row.category.trim(), classification: row.classification };
}
