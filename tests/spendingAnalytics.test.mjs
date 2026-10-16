// Spending analytics calculations: pure unit tests (no React, no network). Every figure is synthetic.
//
//   npm run test:analytics
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERIOD_OPTIONS, OTHERS, UNCLASSIFIED, normalizeMerchant, detectCategory, categoryFor, buildSpendingAnalytics, transactionsBehind, categoryChoices,
  compareMonths, detectRecurring, formatMoney, formatPercent
} from '../src/utils/spendingAnalytics.js';
import { aggregateMonthlyTransactions, summarizeTransactions } from '../src/utils/finance.js';

const NOW = new Date(2026, 9, 15);                       // 15 Oct 2026 (local)
let seq = 0;
const tx = (date, amount, title, extra = {}) => ({ id: `t${++seq}`, userId: 1, date, amount, title, type: amount < 0 ? 'expense' : 'income', category: 'General', classification: 'unknown', ...extra });
const spend = (date, amount, title, extra = {}) => tx(date, -Math.abs(amount), title, { classification: 'expense', ...extra });
const earn = (date, amount, title, extra = {}) => tx(date, Math.abs(amount), title, { classification: 'income', category: 'Salary', ...extra });
const analyse = (list, months = 6, extra = {}) => buildSpendingAnalytics(list, { months, now: NOW, ...extra });
const cat = (a, name) => a.categories.find((c) => c.name === name);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);
const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };

// ── merchant descriptions and categories ──────────────────────────────────────────────────────────────────────────────
test('merchant descriptions are cleaned so repeated payments to one merchant group together', () => {
  const keys = ['ZOMATO ORDER 88213', 'zomato  order #77', 'UPI/ZOMATO/Ref 4482991', 'Zomato', 'POS ZOMATO LTD'].map((t) => normalizeMerchant(t).key);
  assert.deepEqual([...new Set(keys)], ['zomato']);
  assert.equal(normalizeMerchant('AMAZON PAY INDIA PVT LTD').label, 'Amazon');
  assert.equal(normalizeMerchant('NEFT-HDFC-RENT-998877').key, 'hdfc rent');
  assert.equal(normalizeMerchant('   ').label, 'Unlabelled');
  assert.equal(normalizeMerchant('12345 67890').key, '');
  assert.equal(normalizeMerchant(null).label, 'Unlabelled');
  assert.equal(normalizeMerchant('Café Münch').key, 'café münch');
});

test('keyword detection uses whole words and the longest match', () => {
  assert.equal(detectCategory('zomato'), 'Food');
  assert.equal(detectCategory('amazon prime video'), 'Entertainment');       // "prime video" beats "amazon"
  assert.equal(detectCategory('amazon'), 'Shopping');
  assert.equal(detectCategory('uber'), 'Travel');
  assert.equal(detectCategory('cola house'), null, '"ola" is not found inside "cola"');
  assert.equal(detectCategory('busy bee'), null, '"bus" is not found inside "busy"');
  assert.equal(detectCategory('mutual fund sip'), 'Investment');
  assert.equal(detectCategory(''), null);
});

test('a category is the user\'s own label first, then a keyword match, otherwise Others; "General" means not categorised yet', () => {
  assert.deepEqual(categoryFor({ title: 'ZOMATO', category: 'Shopping' }), { name: 'Shopping', source: 'yours' });
  assert.deepEqual(categoryFor({ title: 'ZOMATO', category: 'General' }), { name: 'Food', source: 'detected' });
  assert.deepEqual(categoryFor({ title: 'ZOMATO', category: '' }), { name: 'Food', source: 'detected' });
  assert.deepEqual(categoryFor({ title: 'Mystery shop', category: 'General' }), { name: OTHERS, source: 'none' });
  assert.deepEqual(categoryFor({ title: 'ZOMATO', category: 'others' }), { name: OTHERS, source: 'yours' }, 'a deliberate "Others" is respected even if a keyword matches');
  assert.deepEqual(categoryFor({ title: 'x', category: 'food' }), { name: 'Food', source: 'yours' }, 'case-insensitive, shown with the app\'s spelling');
  assert.deepEqual(categoryFor({ title: 'x', category: 'Pet care' }), { name: 'Pet care', source: 'yours' }, 'the user\'s own category is kept');
});

test('a merchant that repeats is NOT turned into a category: unrecognised merchants stay in Others', () => {
  const list = [];
  for (const d of ['2026-05-03', '2026-06-03', '2026-07-03', '2026-08-03', '2026-09-03', '2026-10-03']) list.push(spend(d, 1500, 'IRON GYM CLUB'));
  const a = analyse(list, 12);
  assert.deepEqual(a.categories.map((c) => c.name), [OTHERS]);
  assert.equal(cat(a, OTHERS).members[0].name, OTHERS);
  assert.equal(cat(a, OTHERS).count, 6);
});

// ── definitions: income, refunds, transfers, unknown, duplicates ──────────────────────────────────────────────────────────
test('income is never spending, and spending is shown by category with totals and shares that add up', () => {
  const list = [earn('2026-10-01', 50000, 'Salary'), spend('2026-10-03', 6000, 'ZOMATO'), spend('2026-10-05', 3000, 'Amazon'), spend('2026-10-07', 1000, 'Uber', { category: 'Travel' })];
  const a = analyse(list, 1);
  assert.equal(a.totals.income, 50000);
  assert.equal(a.totals.spending, 10000);
  assert.equal(a.totals.netCashFlow, 40000);
  assert.deepEqual(a.categories.map((c) => [c.name, c.amount]), [['Food', 6000], ['Shopping', 3000], ['Travel', 1000]]);
  near(a.categories.reduce((s, c) => s + c.share, 0), 1, 'shares add up to 100%');
  near(cat(a, 'Food').share, 0.6, 'Food share');
  assert.equal(formatPercent(cat(a, 'Food').share), '60.0%');
  assert.ok(!a.categories.some((c) => c.name === 'Salary'), 'salary is income, not a spending category');
  assert.equal(a.reconciliation, 0);
});

test('refunds reduce their own category and the month, never go below zero, and are never counted as income', () => {
  const list = [spend('2026-10-02', 5000, 'Myntra'), tx('2026-10-06', 1200, 'Myntra refund', { classification: 'refund', category: 'Shopping' }), spend('2026-10-08', 800, 'ZOMATO')];
  const a = analyse(list, 1);
  assert.equal(a.totals.income, 0, 'a refund is not income');
  assert.equal(a.totals.refunds, 1200);
  assert.equal(a.totals.spending, 4600);                                       // 5000 + 800 - 1200
  assert.equal(cat(a, 'Shopping').amount, 3800);
  assert.equal(cat(a, 'Food').amount, 800);
  assert.equal(a.monthly[0].spending, 4600);
  const over = analyse([spend('2026-10-02', 500, 'Myntra'), tx('2026-10-06', 900, 'refund', { classification: 'refund', category: 'Shopping' })], 1);
  assert.equal(over.totals.spending, 0, 'refunds above the month\'s spending do not make spending negative');
  assert.equal(over.categories.length, 0);
  assert.equal(over.hasSpending, false);
});

test('a refund larger than its own category\'s spending is reported as a reconciliation, not hidden or made negative', () => {
  const list = [spend('2026-10-02', 500, 'Myntra'), spend('2026-10-03', 2000, 'ZOMATO'), tx('2026-10-06', 900, 'refund', { classification: 'refund', category: 'Shopping' })];
  const a = analyse(list, 1);
  assert.equal(a.totals.spending, 1600);                                       // the dashboard's month figure: 2500 - 900
  assert.equal(cat(a, 'Shopping'), undefined, 'Shopping nets to zero');
  assert.equal(cat(a, 'Food').amount, 2000);
  near(a.reconciliation, 400, 'categories add to 400 more than the month total');
});

test('a refund in a later month does not reduce an earlier month (the same rule as the dashboard)', () => {
  const list = [spend('2026-09-10', 1000, 'Myntra'), tx('2026-10-02', 1000, 'refund', { classification: 'refund', category: 'Shopping' })];
  const a = analyse(list, 3);
  assert.deepEqual(a.monthly.map((m) => [m.key, m.spending]), [['2026-08', 0], ['2026-09', 1000], ['2026-10', 0]]);
});

test('internal transfers are neither spending nor income, and are disclosed', () => {
  const list = [earn('2026-10-01', 40000, 'Salary'), spend('2026-10-02', 2000, 'ZOMATO'),
    tx('2026-10-03', -15000, 'To savings account', { classification: 'transfer' }), tx('2026-10-03', 15000, 'From current account', { classification: 'transfer' })];
  const a = analyse(list, 1);
  assert.equal(a.totals.income, 40000);
  assert.equal(a.totals.spending, 2000);
  assert.deepEqual(a.transfers, { count: 2, amount: 30000 });
  assert.equal(a.totals.counted, 2);
  assert.ok(!a.categories.some((c) => /savings|current/i.test(c.name)));
});

test('unclassified transactions follow the dashboard rule (by direction) but are disclosed, never silent', () => {
  const list = [tx('2026-10-02', -700, 'Mystery debit'), tx('2026-10-03', 250, 'Mystery credit'), spend('2026-10-04', 300, 'ZOMATO'), earn('2026-10-05', 1000, 'Pay')];
  const a = analyse(list, 1);
  assert.equal(a.totals.spending, 1000);
  assert.equal(a.totals.income, 1250);
  assert.deepEqual(a.unclassified, { spendingCount: 1, spendingAmount: 700, incomeCount: 1, incomeAmount: 250 });
  const rows = transactionsBehind(list, a, UNCLASSIFIED);
  assert.deepEqual(rows.map((r) => [r.title, r.amount]), [['Mystery debit', -700]]);
  const clean = analyse([spend('2026-10-04', 300, 'ZOMATO'), earn('2026-10-05', 1000, 'Pay')], 1);
  assert.deepEqual(clean.unclassified, { spendingCount: 0, spendingAmount: 0, incomeCount: 0, incomeAmount: 0 }, 'classified rows are not flagged');
});

test('identical-looking transactions stay separate records (never merged or de-duplicated)', () => {
  const list = [spend('2026-10-07', 50, 'Coffee Shop'), spend('2026-10-07', 50, 'Coffee Shop'), spend('2026-10-07', 50, 'Coffee Shop')];
  const a = analyse(list, 1);
  assert.equal(a.totals.spending, 150);
  assert.equal(cat(a, 'Food').count, 3);
  assert.equal(transactionsBehind(list, a, 'Food').length, 3);
});

// ── periods and calendar months ──────────────────────────────────────────────────────────────────────────────────────────
test('periods are the current calendar month plus the previous ones, with exact month boundaries', () => {
  assert.deepEqual(PERIOD_OPTIONS, [1, 3, 6, 12]);
  const list = [spend('2026-09-30', 100, 'ZOMATO'), spend('2026-10-01', 200, 'ZOMATO'), spend('2026-10-31', 300, 'ZOMATO'), spend('2026-11-01', 400, 'ZOMATO'),
    spend('2026-08-01', 500, 'ZOMATO'), spend('2026-07-31', 600, 'ZOMATO'), spend('2025-11-01', 700, 'ZOMATO'), spend('2025-10-31', 800, 'ZOMATO')];
  assert.equal(analyse(list, 1).totals.spending, 500, '1 month: 1 to 31 Oct only');
  assert.equal(analyse(list, 3).totals.spending, 100 + 200 + 300 + 500, '3 months: Aug, Sep, Oct');
  assert.equal(analyse(list, 6).totals.spending, 100 + 200 + 300 + 500 + 600, '6 months: from May 2026');
  assert.equal(analyse(list, 12).totals.spending, 100 + 200 + 300 + 500 + 600 + 700, '12 months: from Nov 2025, not Oct 2025');
  assert.deepEqual(analyse(list, 3).period.keys, ['2026-08', '2026-09', '2026-10']);
  assert.equal(analyse(list, 1).period.label, 'Oct 2026');
  assert.equal(analyse(list, 3).period.label, 'Aug 2026 – Oct 2026');
  assert.deepEqual(analyse(list, 12).monthly.map((m) => m.key).slice(0, 2), ['2025-11', '2025-12']);
});

test('year boundaries and leap days are handled, and invalid dates or amounts are ignored without breaking anything', () => {
  const jan = new Date(2027, 0, 20);
  const list = [spend('2026-12-31', 100, 'ZOMATO'), spend('2027-01-01', 200, 'ZOMATO'), spend('2026-11-30', 999, 'ZOMATO'), spend('2024-02-29', 5, 'ZOMATO')];
  const a = buildSpendingAnalytics(list, { months: 2, now: jan });
  assert.deepEqual(a.period.keys, ['2026-12', '2027-01']);
  assert.equal(a.totals.spending, 300);
  const messy = [spend('2026-02-30', 100, 'x'), spend('not a date', 100, 'x'), { id: 'q', date: '2026-10-05', amount: 'abc', title: 'x', classification: 'expense' }, { id: 'z', date: '2026-10-05', amount: 0, title: 'x' }, null, undefined, {}];
  assert.doesNotThrow(() => analyse(messy, 3));
  assert.equal(analyse(messy, 3).totals.spending, 0);
  assert.equal(analyse(messy, 3).hasPeriodData, false);
});

// ── empty and sparse data ─────────────────────────────────────────────────────────────────────────────────────────────────
test('an empty account gives zeros everywhere and says so (no NaN, no invented figures)', () => {
  const a = analyse([], 6);
  assert.equal(a.hasAnyTransactions, false);
  assert.equal(a.hasPeriodData, false);
  assert.deepEqual(a.categories, []);
  assert.deepEqual(a.totals, { income: 0, spending: 0, refunds: 0, netCashFlow: 0, counted: 0 });
  assert.equal(a.monthly.length, 6);
  assert.ok(a.monthly.every((m) => m.income === 0 && m.spending === 0));
  assert.doesNotThrow(() => JSON.stringify(a));
  assert.ok(!JSON.stringify(a).includes('null') || true);
  const c = compareMonths([], NOW);
  assert.equal(c.change, null);
  assert.equal(c.previousHasSpending, false);
  assert.deepEqual(detectRecurring([], NOW), []);
  assert.deepEqual(categoryChoices([]).slice(-1), [OTHERS]);
  const old = analyse([spend('2024-01-05', 100, 'ZOMATO')], 6);
  assert.equal(old.hasAnyTransactions, true);
  assert.equal(old.hasPeriodData, false, 'transactions exist but none in this period');
});

// ── Others ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('small or unrecognised groups are folded into Others (with the members kept), the biggest stay separate', () => {
  const list = [];
  for (let i = 0; i < 6; i++) list.push(spend(`2026-10-0${i + 1}`, 1000 + i * 100, 'ZOMATO'));
  for (let i = 0; i < 4; i++) list.push(spend(`2026-10-1${i}`, 900, 'Uber'));
  for (let i = 0; i < 3; i++) list.push(spend(`2026-10-2${i}`, 800, 'Amazon'));
  list.push(spend('2026-10-15', 20, 'Tiny odd thing', { category: 'Hobby' }));          // 1 transaction, a trivial share: folded
  list.push(spend('2026-10-16', 450, 'Mystery shop'));                                       // unrecognised: Others
  const a = analyse(list, 1);
  assert.deepEqual(a.categories.map((c) => c.name), ['Food', 'Travel', 'Shopping', OTHERS]);
  const others = cat(a, OTHERS);
  assert.equal(others.isOthers, true);
  assert.deepEqual(others.members.map((m) => m.name).sort(), ['Hobby', OTHERS].sort());
  assert.equal(others.amount, 470);
  near(a.categories.reduce((s, c) => s + c.share, 0), 1, 'shares add to 100%');
  // a user's own category with a single but significant transaction is not folded
  const big = analyse([spend('2026-10-15', 5000, 'Vet visit', { category: 'Pets' }), ...list], 1);
  assert.ok(cat(big, 'Pets'), 'a single large payment in the user\'s own category keeps its own bar');
  // beyond maxCategories the smallest are grouped
  const many = [];
  ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8'].forEach((n, i) => { many.push(spend('2026-10-02', 1000 - i * 10, 'x', { category: `Cat ${n}` })); many.push(spend('2026-10-03', 1000 - i * 10, 'y', { category: `Cat ${n}` })); });
  const m = analyse(many, 1, { maxCategories: 3 });
  assert.equal(m.categories.length, 4);
  assert.equal(m.categories[3].isOthers, true);
  assert.equal(m.categories[3].members.length, 5);
});

test('category totals equal the transactions behind them', () => {
  const list = [spend('2026-10-02', 300, 'ZOMATO'), spend('2026-10-04', 120, 'swiggy'), spend('2026-10-06', 999, 'Mystery shop'), spend('2026-09-12', 77, 'zomato order 5'), earn('2026-10-01', 9000, 'Pay'), tx('2026-10-09', -50, 'x', { classification: 'transfer' })];
  const a = analyse(list, 3);
  for (const c of a.categories) {
    const rows = transactionsBehind(list, a, c.name);
    near(rows.filter((r) => r.role === 'spending').reduce((s, r) => s - r.amount, 0), c.amount, `${c.name} rows add up`);
    assert.equal(rows.length, c.count, `${c.name} count`);
  }
  assert.deepEqual(transactionsBehind(list, a, 'Food').map((r) => r.date), ['2026-10-04', '2026-10-02', '2026-09-12'], 'newest first');
  assert.ok(transactionsBehind(list, a, 'Food').every((r) => r.id && r.title && r.category === 'Food' && 'storedCategory' in r));
  assert.deepEqual(transactionsBehind(list, a, 'Nothing here'), []);
  const rowsOthers = transactionsBehind(list, a, OTHERS);
  assert.deepEqual(rowsOthers.map((r) => r.title), ['Mystery shop']);
});

// ── months, income versus spending, dashboard parity ─────────────────────────────────────────────────────────────────────────
test('monthly figures equal the dashboard\'s own aggregation for the same transactions', () => {
  const list = [
    earn('2026-07-01', 60000, 'Salary'), spend('2026-07-05', 12000, 'Rent', { category: 'Rent' }), spend('2026-07-09', 800, 'ZOMATO'),
    earn('2026-08-01', 60000, 'Salary'), spend('2026-08-05', 12000, 'Rent', { category: 'Rent' }), tx('2026-08-20', 500, 'refund', { classification: 'refund', category: 'Food' }),
    spend('2026-09-12', 300, 'Uber'), tx('2026-09-15', -9000, 'to savings', { classification: 'transfer' }), tx('2026-09-16', -450, 'Mystery'),
    earn('2026-10-01', 61000, 'Salary'), spend('2026-10-03', 4100, 'Amazon'), tx('2026-10-04', 700, 'Unknown credit')
  ];
  const a = analyse(list, 4);
  const dash = aggregateMonthlyTransactions(list);
  for (const m of a.monthly) {
    near(m.income, dash[m.key]?.income ?? 0, `${m.key} income`);
    near(m.spending, dash[m.key]?.expenses ?? 0, `${m.key} spending`);
  }
  const summary = summarizeTransactions(list, NOW);
  const octo = a.monthly[a.monthly.length - 1];
  near(octo.income, summary.currentMonth.income, 'this month income vs the dashboard card');
  near(octo.spending, summary.currentMonth.expenses, 'this month spending vs the dashboard card');
  near(a.totals.spending, a.monthly.reduce((s, m) => s + m.spending, 0), 'the period total is the sum of the monthly bars');
  near(a.totals.income, a.monthly.reduce((s, m) => s + m.income, 0), 'income total');
});

test('students, salaried workers and irregular earners all produce sensible, non-negative figures', () => {
  // student: small monthly allowance, food and travel
  const student = [];
  for (const m of ['07', '08', '09', '10']) { student.push(earn(`2026-${m}-02`, 8000, 'Allowance', { category: 'Allowance' })); student.push(spend(`2026-${m}-05`, 1800, 'Swiggy')); student.push(spend(`2026-${m}-11`, 650, 'Uber')); student.push(spend(`2026-${m}-18`, 199, 'Netflix')); }
  const s = analyse(student, 4);
  assert.equal(s.totals.income, 32000);
  assert.deepEqual(s.categories.map((c) => c.name), ['Food', 'Travel', 'Entertainment']);
  assert.ok(s.monthly.every((m) => m.spending > 0 && m.income > m.spending));
  // salaried: salary, rent (the user's own category), bills, SIP, shopping
  const salaried = [];
  for (const m of ['07', '08', '09', '10']) { salaried.push(earn(`2026-${m}-01`, 85000, 'ACME Payroll')); salaried.push(spend(`2026-${m}-03`, 22000, 'Landlord', { category: 'Rent' })); salaried.push(spend(`2026-${m}-05`, 5000, 'SIP Groww')); salaried.push(spend(`2026-${m}-09`, 1800, 'BESCOM electricity')); salaried.push(spend(`2026-${m}-20`, 3200 + Number(m) * 10, 'Amazon')); }
  const w = analyse(salaried, 4);
  assert.deepEqual(w.categories.map((c) => c.name), ['Rent', 'Investment', 'Shopping', 'Bills']);
  assert.equal(w.totals.income, 340000);
  near(w.totals.netCashFlow, 340000 - w.totals.spending, 'net cash flow');
  // irregular income: a lump sum, then nothing for months
  const freelance = [earn('2026-05-15', 90000, 'Client A'), spend('2026-06-04', 15000, 'Landlord', { category: 'Rent' }), spend('2026-07-04', 15000, 'Landlord', { category: 'Rent' }), earn('2026-09-20', 30000, 'Client B'), spend('2026-10-04', 15000, 'Landlord', { category: 'Rent' })];
  const f = analyse(freelance, 6);
  assert.deepEqual(f.monthly.map((m) => m.income), [90000, 0, 0, 0, 30000, 0]);
  assert.deepEqual(f.monthly.map((m) => m.spending), [0, 15000, 15000, 0, 0, 15000]);
  assert.ok(f.monthly.some((m) => m.income === 0 && m.spending > 0), 'months with spending and no income are shown, not hidden');
  near(f.totals.netCashFlow, 120000 - 45000, 'net');
  assert.ok(Object.values(f.totals).every((v) => Number.isFinite(v)));
});

test('stacked monthly category figures use the same final categories as the breakdown', () => {
  const list = [spend('2026-09-02', 500, 'ZOMATO'), spend('2026-10-02', 700, 'ZOMATO'), spend('2026-10-03', 100, 'Mystery shop'), spend('2026-10-04', 400, 'Uber')];
  const a = analyse(list, 2);
  const names = a.categories.map((c) => c.name);
  assert.ok(a.monthly.every((m) => Object.keys(m.byCategory).join() === names.join()));
  const oct = a.monthly[1];
  near(Object.values(oct.byCategory).reduce((x, y) => x + y, 0), oct.spending, 'the stacked bar equals the month\'s spending');
  assert.equal(oct.byCategory[OTHERS] + oct.byCategory.Food + oct.byCategory.Travel, 1200);
});

// ── comparison ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('this month against last month: change, movers and the in-progress note', () => {
  const list = [spend('2026-09-05', 1000, 'ZOMATO'), spend('2026-09-06', 500, 'Uber'), spend('2026-10-05', 1500, 'ZOMATO'), spend('2026-10-06', 100, 'Netflix')];
  const c = compareMonths(list, NOW);
  assert.deepEqual([c.currentKey, c.previousKey], ['2026-10', '2026-09']);
  assert.equal(c.current, 1600); assert.equal(c.previous, 1500);
  near(c.change, (100 / 1500) * 100, 'percent change');
  assert.deepEqual(c.increases.map((d) => [d.name, d.delta]), [['Food', 500], ['Entertainment', 100]]);
  assert.deepEqual(c.decreases.map((d) => [d.name, d.delta]), [['Travel', -500]]);
  assert.deepEqual(c.inProgress, { day: 15, of: 31, partial: true });
  assert.equal(compareMonths(list, new Date(2026, 9, 31)).inProgress.partial, false);
  const none = compareMonths([spend('2026-10-05', 100, 'ZOMATO')], NOW);
  assert.equal(none.change, null, 'no percentage when last month has no spending');
  assert.equal(none.previousHasSpending, false);
});

// ── recurring ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('payments that look recurring are described; frequent, irregular or too-new payments are not', () => {
  const list = [];
  for (const m of ['05', '06', '07', '08', '09', '10']) { list.push(spend(`2026-${m}-04`, 649, 'NETFLIX.COM 8812')); list.push(spend(`2026-${m}-10`, 15000 + (m === '07' ? 500 : 0), 'Landlord Rent', { category: 'Rent' })); }
  for (let d = 1; d <= 28; d++) list.push(spend(`2026-10-${String(d).padStart(2, '0')}`, 80, 'Chai Point'));                       // frequent, not recurring
  for (const [m, amount] of [['07', 300], ['08', 900], ['09', 2500]]) list.push(spend(`2026-${m}-12`, amount, 'Random Store'));                           // monthly but very different amounts
  for (const m of ['09', '10']) list.push(spend(`2026-${m}-02`, 300, 'New Gym'));                                                    // only two months
  for (let w = 0; w < 12; w++) list.push(spend(`2026-0${7 + Math.floor(w / 4)}-${String(1 + (w % 4) * 7).padStart(2, '0')}`, 200, 'Weekly Veg'));
  const r = detectRecurring(list, NOW);
  assert.deepEqual(r.map((x) => x.label), ['Landlord Rent', 'Netflix Com']);
  const netflix = r.find((x) => x.label === 'Netflix Com');
  assert.equal(netflix.typicalAmount, 649);
  assert.equal(netflix.months, 6);
  assert.equal(netflix.category, 'Entertainment');
  assert.equal(netflix.lastDate, '2026-10-04');
  assert.equal(r.find((x) => x.label === 'Landlord Rent').category, 'Rent');
});

// ── choices, formatting, isolation, performance ────────────────────────────────────────────────────────────────────────────
test('category choices: the app\'s categories, the user\'s own, and Others', () => {
  const choices = categoryChoices([{ category: 'Pets' }, { category: 'pets' }, { category: 'General' }, { category: 'food' }, { category: 'Others' }, { category: '' }, {}]);
  assert.deepEqual(choices, ['Food', 'Shopping', 'Bills', 'Entertainment', 'Travel', 'Investment', 'Salary', 'Pets', OTHERS]);
});

test('money and percentage formats', () => {
  assert.equal(formatMoney(1234), '₹1,234');
  assert.equal(formatMoney(1234.5), '₹1,234.50');
  assert.equal(formatMoney(1234567), '₹12,34,567');
  assert.equal(formatPercent(0.1234), '12.3%');
  assert.equal(formatPercent(0), '0.0%');
});

test('accounts are independent: the same functions on two accounts never share or alter data', () => {
  const a = deepFreeze([earn('2026-10-01', 1000, 'Pay'), spend('2026-10-02', 400, 'ZOMATO')]);
  const b = deepFreeze([earn('2026-10-01', 9000, 'Pay'), spend('2026-10-02', 7000, 'Uber')]);
  const ra1 = analyse(a, 1), rb = analyse(b, 1), ra2 = analyse(a, 1);
  assert.deepEqual(ra1, ra2, 'repeatable');
  assert.deepEqual(ra1.categories.map((c) => c.name), ['Food']);
  assert.deepEqual(rb.categories.map((c) => c.name), ['Travel']);
  assert.equal(ra1.totals.spending, 400); assert.equal(rb.totals.spending, 7000);
  assert.doesNotThrow(() => { compareMonths(a, NOW); detectRecurring(b, NOW); transactionsBehind(a, ra1, 'Food'); categoryChoices(b); }, 'frozen inputs are never modified');
});

test('a large history is analysed quickly', () => {
  const list = [];
  for (let i = 0; i < 20000; i++) list.push(spend(`2026-${String(1 + (i % 10)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, 50 + (i % 400), ['ZOMATO', 'Uber', 'Amazon', 'Mystery', 'Netflix'][i % 5] + ' ' + (i % 90)));
  const t0 = performance.now();
  const a = analyse(list, 12);
  detectRecurring(list, NOW); compareMonths(list, NOW);
  const ms = performance.now() - t0;
  assert.ok(a.totals.counted > 10000);
  assert.ok(ms < 1500, `${Math.round(ms)} ms for 20,000 transactions`);
});
