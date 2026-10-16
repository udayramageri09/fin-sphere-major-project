// Spending analytics for the Transactions page: pure functions over the signed-in user's own transactions (no network, no React).
//
// It uses the SAME definitions as the dashboard (src/utils/finance.js): income is analytical income; spending is analytical spending
// minus refunds (net, per calendar month, never below zero); transfers are neither; a transaction with no classification counts by the
// direction of its amount (and is disclosed, never silent). Months are LOCAL calendar months. Money is summed as integer paise.
//
// Nothing is merged or dropped silently: two identical-looking transactions are two records. A merchant that appears often is not a new
// category: a category is the user's own label, or a keyword match from merchantCategories.js, otherwise the transaction is "Others".
import { analyticalRole, getMonthKey, getRecentMonthKeys, parseLocalDate, percentChange } from './finance.js';
import { CATEGORY_KEYWORDS, NOISE_WORDS, TAXONOMY } from './merchantCategories.js';

export const PERIOD_OPTIONS = [1, 3, 6, 12];
export const OTHERS = 'Others';
export const UNCLASSIFIED = '__unclassified__';
const UNSET = new Set(['', 'general', 'uncategorized', 'uncategorised', 'misc', 'miscellaneous']);
const KNOWN_CLASSIFICATIONS = new Set(['income', 'expense', 'refund', 'transfer']);
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const monthLabel = (key) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;
export const monthLabelLong = (key) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
export function formatMoney(value) {
  const digits = Number.isInteger(value) ? 0 : 2;
  return value.toLocaleString('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export const formatPercent = (fraction) => `${(Math.round(fraction * 1000) / 10).toFixed(1)}%`;

// ── merchant descriptions ──────────────────────────────────────────────────────────────────────────────────────────────
const titleCase = (text) => text.replace(/\b\p{L}/gu, (c) => c.toLocaleUpperCase());

// "UPI/ZOMATO ORDER 88213" and "zomato  order #77" both become the merchant "Zomato". References, ids and bank words are removed.
export function normalizeMerchant(title) {
  const tokens = String(title ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean)
    .filter((t) => !NOISE_WORDS.has(t) && !/^\d+$/.test(t) && !/\d{3,}/.test(t));
  const key = tokens.slice(0, 3).join(' ');
  return { key, label: key ? titleCase(key) : 'Unlabelled', text: tokens.join(' ') };
}

const KEYWORD_LIST = Object.entries(CATEGORY_KEYWORDS).flatMap(([category, words]) => words.map((word) => ({ category, word })))
  .sort((a, b) => b.word.length - a.word.length);
export function detectCategory(cleanText) {
  const padded = ` ${cleanText} `;
  const hit = KEYWORD_LIST.find(({ word }) => padded.includes(` ${word} `));
  return hit ? hit.category : null;
}

const taxonomyByLower = new Map(TAXONOMY.map((name) => [name.toLowerCase(), name]));
// The category a transaction is shown under: the user's own (stored) category first, then a keyword match, otherwise Others.
// "General" is the stored default, so it means "not categorised yet".
export function categoryFor(transaction) {
  const stored = String(transaction?.category ?? '').trim();
  const lower = stored.toLowerCase();
  if (!UNSET.has(lower)) {
    if (lower === 'others' || lower === 'other') return { name: OTHERS, source: 'yours' };
    return { name: taxonomyByLower.get(lower) ?? stored, source: 'yours' };
  }
  const detected = detectCategory(normalizeMerchant(transaction?.title).text);
  return detected ? { name: detected, source: 'detected' } : { name: OTHERS, source: 'none' };
}

// ── collecting ────────────────────────────────────────────────────────────────────────────────────────────────────────
const toPaise = (n) => Math.round(Math.abs(n) * 100);
const isUnclassified = (t) => !KNOWN_CLASSIFICATIONS.has(t?.classification);

function collect(transactions, keys) {
  const keySet = new Set(keys);
  const months = new Map(keys.map((k) => [k, { income: 0, spend: 0, refund: 0, cats: new Map() }]));
  const transfers = { count: 0, paise: 0 };
  const unclassified = { spendingCount: 0, spendingPaise: 0, incomeCount: 0, incomePaise: 0 };
  const names = new Map();                                              // lower-case name -> display name (taxonomy casing preferred)
  const display = (name) => { const l = name.toLowerCase(); if (!names.has(l)) names.set(l, taxonomyByLower.get(l) ?? name); return names.get(l); };
  let counted = 0;
  transactions.forEach((t) => {
    const date = parseLocalDate(t?.date);
    if (!date || !keySet.has(getMonthKey(date))) return;
    const amount = t?.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) return;
    const role = analyticalRole(t);
    if (!role) { transfers.count++; transfers.paise += toPaise(amount); return; }          // a transfer: neither income nor spending
    const month = months.get(getMonthKey(date));
    counted++;
    if (role.role === 'income') {
      month.income += role.paise;
      if (isUnclassified(t)) { unclassified.incomeCount++; unclassified.incomePaise += role.paise; }
      return;
    }
    const cat = categoryFor(t);
    const name = display(cat.name);
    if (!month.cats.has(name)) month.cats.set(name, { gross: 0, refund: 0, count: 0 });
    const slot = month.cats.get(name);
    if (role.role === 'refund') { month.refund += role.paise; slot.refund += role.paise; return; }
    month.spend += role.paise; slot.gross += role.paise; slot.count++;
    if (isUnclassified(t)) { unclassified.spendingCount++; unclassified.spendingPaise += role.paise; }
  });
  return { months, transfers, unclassified, counted };
}

// net spending of a month = the dashboard's definition: max(spending - refunds, 0)
const monthNet = (m) => Math.max(m.spend - m.refund, 0);
// a category's net in a month: its spending minus ITS refunds, never below zero (the same rule budgets use per category)
const catNet = (slot) => Math.max(slot.gross - slot.refund, 0);

export function periodKeys(months, now = new Date()) { return getRecentMonthKeys(months, now); }

// Inclusive calendar months, including empty months and year boundaries.
export function monthRangeKeys(startMonth, endMonth) {
  const valid = key => typeof key === 'string' && /^(?:19|[2-9]\d)\d{2}-(?:0[1-9]|1[0-2])$/.test(key);
  if (!valid(startMonth) || !valid(endMonth)) throw new RangeError('Choose a valid month and year.');
  if (startMonth > endMonth) throw new RangeError('The end month must be the same as or after the start month.');
  const index = key => Number(key.slice(0, 4)) * 12 + Number(key.slice(5)) - 1;
  const from = index(startMonth), to = index(endMonth);
  return Array.from({ length: to - from + 1 }, (_, i) => { const n = from + i; return String(Math.floor(n / 12)).padStart(4, '0') + '-' + String(n % 12 + 1).padStart(2, '0'); });
}
export function defaultMonthRange(now = new Date()) {
  const keys = getRecentMonthKeys(6, now);
  return { startMonth: keys[0], endMonth: keys.at(-1) };
}

// ── the full picture for one period ─────────────────────────────────────────────────────────────────────────────────────
// months: 1, 3, 6 or 12 = the current calendar month plus the previous ones. Returns plain data (money in rupees).
export function buildSpendingAnalytics(transactions, { months = 6, startMonth, endMonth, now = new Date(), maxCategories = 6, minShare = 0.03 } = {}) {
  const list = Array.isArray(transactions) ? transactions : [];
  const keys = startMonth !== undefined || endMonth !== undefined ? monthRangeKeys(startMonth, endMonth) : getRecentMonthKeys(months, now);
  const { months: bucket, transfers, unclassified, counted } = collect(list, keys);

  let incomeP = 0, spendP = 0, refundP = 0;
  const perCategory = new Map();                                           // name -> { paise, count }
  for (const key of keys) {
    const m = bucket.get(key);
    incomeP += m.income; spendP += monthNet(m); refundP += m.refund;
    for (const [name, slot] of m.cats) {
      const entry = perCategory.get(name) ?? perCategory.set(name, { paise: 0, count: 0 }).get(name);
      entry.paise += catNet(slot); entry.count += slot.count;
    }
  }
  const categorySumP = [...perCategory.values()].reduce((s, c) => s + c.paise, 0);

  // Which categories are shown on their own: the biggest ones that are not trivially small. The rest (and the user's/unrecognised
  // "Others") are grouped as Others, with the members kept so they can still be inspected.
  const ranked = [...perCategory.entries()].filter(([name, c]) => name !== OTHERS && c.paise > 0).sort((a, b) => b[1].paise - a[1].paise || a[0].localeCompare(b[0]));
  const shown = [], folded = new Set();
  for (const [name, c] of ranked) {
    const share = categorySumP ? c.paise / categorySumP : 0;
    if (shown.length < maxCategories && !(c.count < 2 && share < minShare)) shown.push(name); else folded.add(name);
  }
  folded.add(OTHERS);
  const finalName = (name) => (folded.has(name) ? OTHERS : name);

  const categories = shown.map((name) => ({ name, paise: perCategory.get(name).paise, count: perCategory.get(name).count, isOthers: false, members: [] }));
  const members = [...folded].filter((n) => perCategory.has(n) && perCategory.get(n).paise > 0).map((n) => ({ name: n, amount: perCategory.get(n).paise / 100, count: perCategory.get(n).count }));
  const othersP = members.reduce((s, m) => s + Math.round(m.amount * 100), 0);
  if (othersP > 0) categories.push({ name: OTHERS, paise: othersP, count: members.reduce((s, m) => s + m.count, 0), isOthers: true, members: members.sort((a, b) => b.amount - a.amount) });
  for (const c of categories) { c.amount = c.paise / 100; c.share = categorySumP ? c.paise / categorySumP : 0; delete c.paise; }

  const seriesNames = categories.map((c) => c.name);
  const monthly = keys.map((key) => {
    const m = bucket.get(key);
    const byCategory = Object.fromEntries(seriesNames.map((n) => [n, 0]));
    for (const [name, slot] of m.cats) { const f = finalName(name); if (f in byCategory) byCategory[f] += catNet(slot); }
    for (const n of seriesNames) byCategory[n] = byCategory[n] / 100;
    return { key, label: monthLabel(key), income: m.income / 100, spending: monthNet(m) / 100, refunds: m.refund / 100, byCategory };
  });

  const hasAnyTransactions = list.length > 0;
  return {
    period: { months: keys.length, keys, label: keys.length === 1 ? monthLabelLong(keys[0]) : `${monthLabelLong(keys[0])} – ${monthLabelLong(keys[keys.length - 1])}` },
    hasAnyTransactions, hasPeriodData: counted > 0, hasSpending: spendP > 0, hasIncome: incomeP > 0,
    totals: { income: incomeP / 100, spending: spendP / 100, refunds: refundP / 100, netCashFlow: (incomeP - spendP) / 100, counted },
    categories, folded: [...folded], monthly,
    // spending the categories add up to beyond the net total: refunds that exceed their own category's spending in a month
    reconciliation: Math.max(categorySumP - spendP, 0) / 100,
    transfers: { count: transfers.count, amount: transfers.paise / 100 },
    unclassified: { spendingCount: unclassified.spendingCount, spendingAmount: unclassified.spendingPaise / 100, incomeCount: unclassified.incomeCount, incomeAmount: unclassified.incomePaise / 100 }
  };
}

// ── the transactions behind a figure ─────────────────────────────────────────────────────────────────────────────────────
// category: a category name from analytics.categories (Others includes every folded member) or UNCLASSIFIED. Newest first.
export function transactionsBehind(transactions, analytics, category) {
  const keySet = new Set(analytics.period.keys);
  const folded = new Set(analytics.folded);
  const rows = [];
  (Array.isArray(transactions) ? transactions : []).forEach((t, index) => {
    const date = parseLocalDate(t?.date);
    if (!date || !keySet.has(getMonthKey(date))) return;
    const role = analyticalRole(t);
    if (!role || role.role === 'income') return;
    const cat = categoryFor(t);
    const finalCat = folded.has(cat.name) ? OTHERS : cat.name;
    if (category === UNCLASSIFIED ? !(role.role === 'spending' && isUnclassified(t)) : finalCat !== category) return;
    rows.push({ key: `${index}:${t.id}`, id: t.id, title: t.title, date: t.date, amount: t.amount, role: role.role, category: cat.name, storedCategory: t.category ?? '', source: cat.source, classification: t.classification ?? 'unknown', _order: index });
  });
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a._order - b._order));
  return rows.map((row) => { const { _order: order, ...rest } = row; return order === undefined ? row : rest; });
}

// The choices for correcting a category: the app's own categories, the user's existing ones, and Others.
export function categoryChoices(transactions) {
  const seen = new Map(TAXONOMY.map((n) => [n.toLowerCase(), n]));
  for (const t of Array.isArray(transactions) ? transactions : []) {
    const name = String(t?.category ?? '').trim();
    const lower = name.toLowerCase();
    if (!UNSET.has(lower) && lower !== 'other' && lower !== 'others' && !seen.has(lower)) seen.set(lower, name);
  }
  return [...seen.values(), OTHERS];
}

// ── this month against last month ──────────────────────────────────────────────────────────────────────────────────────
export function compareMonths(transactions, now = new Date()) {
  const [previousKey, currentKey] = getRecentMonthKeys(2, now);
  const { months } = collect(Array.isArray(transactions) ? transactions : [], [previousKey, currentKey]);
  const cur = months.get(currentKey), prev = months.get(previousKey);
  const current = monthNet(cur) / 100, previous = monthNet(prev) / 100;
  const names = new Set([...cur.cats.keys(), ...prev.cats.keys()]);
  const deltas = [...names].map((name) => ({
    name, current: catNet(cur.cats.get(name) ?? { gross: 0, refund: 0 }) / 100, previous: catNet(prev.cats.get(name) ?? { gross: 0, refund: 0 }) / 100
  })).map((d) => ({ ...d, delta: Math.round((d.current - d.previous) * 100) / 100 })).filter((d) => d.delta !== 0);
  const increases = deltas.filter((d) => d.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 3);
  const decreases = deltas.filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3);
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return {
    currentKey, previousKey, current, previous, change: percentChange(current, previous),
    previousHasSpending: previous > 0, currentHasSpending: current > 0,
    increases, decreases,
    inProgress: { day: now.getDate(), of: lastDay, partial: now.getDate() < lastDay }
  };
}

// ── repeating payments ─────────────────────────────────────────────────────────────────────────────────────────────────
const median = (values) => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dayNumber = (date) => Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);

// A payment "looks recurring" when the same merchant is paid about once a month, in at least 3 different months of the last 12, for similar
// amounts. A merchant paid every few days (a coffee shop) is frequent, not recurring. Detection only describes the data: it creates no category.
export function detectRecurring(transactions, now = new Date(), monthKeys = null) {
  const keySet = new Set(monthKeys ?? getRecentMonthKeys(12, now));
  const groups = new Map();
  (Array.isArray(transactions) ? transactions : []).forEach((t) => {
    const date = parseLocalDate(t?.date);
    if (!date || !keySet.has(getMonthKey(date))) return;
    const role = analyticalRole(t);
    if (!role || role.role !== 'spending') return;
    const merchant = normalizeMerchant(t.title);
    if (!merchant.key) return;
    const group = groups.get(merchant.key) ?? groups.set(merchant.key, { label: merchant.label, rows: [] }).get(merchant.key);
    group.rows.push({ date, paise: role.paise, category: categoryFor(t).name, iso: t.date });
  });
  const found = [];
  for (const [key, group] of groups) {
    const rows = group.rows.sort((a, b) => a.date - b.date);
    const monthsSeen = new Set(rows.map((r) => getMonthKey(r.date)));
    if (rows.length < 3 || monthsSeen.size < 3 || rows.length / monthsSeen.size > 1.6) continue;
    const typical = median(rows.map((r) => r.paise));
    if (rows.filter((r) => Math.abs(r.paise - typical) <= typical * 0.15).length / rows.length < 0.7) continue;
    const gaps = rows.slice(1).map((r, i) => dayNumber(r.date) - dayNumber(rows[i].date)).filter((g) => g > 0);
    const gap = gaps.length ? median(gaps) : 0;
    if (gap < 20 || gap > 40) continue;
    const counts = new Map();
    for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    found.push({ key, label: group.label, category: [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0], count: rows.length, months: monthsSeen.size, typicalAmount: typical / 100, firstDate: rows[0].iso, lastDate: rows[rows.length - 1].iso });
  }
  return found.sort((a, b) => b.typicalAmount - a.typicalAmount || a.label.localeCompare(b.label));
}
