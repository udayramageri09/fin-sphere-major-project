// Shared, pure helpers for transaction-derived dashboard figures. Dashboard cards and
// the cash-flow chart both go through these, so they cannot disagree.
//
// Analytical semantics (Issue #61) - the same rule as server/db/index.js (SQL) and the
// health scorer (Python); the test suites prove they agree:
//   classification 'income'   -> income
//   classification 'expense'  -> spending
//   classification 'refund'   -> not income; reduces spending
//   classification 'transfer' -> neither income nor spending
//   'unknown' / missing / unrecognised -> fallback by the direction of the signed amount
//     (> 0 income, < 0 spending), so historical and imported rows keep counting.
// Net spending of a period = max(gross spending - refunds, 0). Money is summed as integer
// paise, so there is no float drift. The Balance card is NOT analytical: it stays the raw
// signed total of everything recorded (money in minus money out, transfers and refunds included).

// Keep rule changes aligned with server SQL and Python analytics before changing any one layer.
// A transfer affects raw cash balance but must never inflate analytical income or spending.
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// Parses a YYYY-MM-DD calendar date as LOCAL midnight. new Date('YYYY-MM-DD') is
// parsed as UTC, which lands on the previous day for viewers west of UTC.
// Returns null for anything that is not a real calendar date.
export function parseLocalDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  // The Date constructor rolls impossible dates over (Feb 30 -> Mar 2); reject those.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

// 'YYYY-MM' key for the local calendar month of a Date.
export function getMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// The last `count` calendar month keys ending with the month of `now`, oldest first.
export function getRecentMonthKeys(count, now = new Date()) {
  const keys = [];
  for (let i = count - 1; i >= 0; i--) {
    keys.push(getMonthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  }
  return keys;
}

// { kind, value } with value as a positive magnitude, or null for amounts that
// cannot be classified (zero, non-numeric, non-finite). Direction only: 'income' for > 0,
// 'expense' for < 0. Kept for callers that need the raw direction.
export function classifyTransactionAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) return null;
  return amount > 0 ? { kind: 'income', value: amount } : { kind: 'expense', value: -amount };
}

const toPaise = (value) => Math.round(value * 100);

// { role: 'income' | 'spending' | 'refund', paise } for a transaction, or null when it counts
// for neither (a transfer, or an unusable amount). See the semantics at the top of this file.
export function analyticalRole(transaction) {
  const amount = transaction?.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) return null;
  const paise = toPaise(Math.abs(amount));
  switch (transaction.classification) {
    case 'income': return { role: 'income', paise };
    case 'expense': return { role: 'spending', paise };
    case 'refund': return { role: 'refund', paise };
    case 'transfer': return null;
    default: return { role: amount > 0 ? 'income' : 'spending', paise };   // unknown / missing: by direction
  }
}

const emptyBucket = () => ({ income: 0, spending: 0, refunds: 0 });   // integer paise
const addToBucket = (bucket, role) => {
  if (role.role === 'income') bucket.income += role.paise;
  else if (role.role === 'spending') bucket.spending += role.paise;
  else bucket.refunds += role.paise;
};
const netSpendingPaise = (bucket) => Math.max(bucket.spending - bucket.refunds, 0);

// { 'YYYY-MM': { income, expenses } } for every transaction with a usable amount and a
// real calendar date. Income is analytical income; expenses are the month's NET spending
// (expenses minus refunds, floored at 0, transfers excluded).
export function aggregateMonthlyTransactions(transactions) {
  const buckets = {};
  for (const t of transactions) {
    const role = analyticalRole(t);
    const date = parseLocalDate(t?.date);
    if (!role || !date) continue;
    addToBucket(buckets[getMonthKey(date)] ?? (buckets[getMonthKey(date)] = emptyBucket()), role);
  }
  const months = {};
  for (const [key, bucket] of Object.entries(buckets)) {
    months[key] = { income: bucket.income / 100, expenses: netSpendingPaise(bucket) / 100 };
  }
  return months;
}

// All figures the dashboard summary needs. All-time totals ignore the date (a
// recorded amount is real money even if its date is unusable); month figures
// only include rows with a valid date.
// - totalIncome / totalExpenses: analytical all-time income and net spending.
// - balance: the raw signed sum of every recorded amount (not analytical, see the top).
export function summarizeTransactions(transactions, now = new Date()) {
  const all = emptyBucket();
  let signedPaise = 0;
  for (const t of transactions) {
    const amount = t?.amount;
    if (typeof amount === 'number' && Number.isFinite(amount)) signedPaise += toPaise(amount);
    const role = analyticalRole(t);
    if (role) addToBucket(all, role);
  }

  const months = aggregateMonthlyTransactions(transactions);
  const [previousKey, currentKey] = getRecentMonthKeys(2, now);
  return {
    totalIncome: all.income / 100,
    totalExpenses: netSpendingPaise(all) / 100,
    balance: signedPaise / 100 || 0,
    currentMonth: months[currentKey] ?? { income: 0, expenses: 0 },
    previousMonth: months[previousKey] ?? { income: 0, expenses: 0 },
  };
}

// Percentage change from previous to current, or null when no meaningful
// comparison exists (previous is zero/invalid), so callers never show Infinity/NaN.
export function percentChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}
