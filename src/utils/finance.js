// Shared, pure helpers for transaction-derived dashboard figures. The signed
// amount is the single source of truth: > 0 is income, < 0 is expense. Dashboard
// cards and the cash-flow chart both go through these, so they cannot disagree.

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// Rounds to paise and normalizes -0 (which Intl would print as "-0") to 0.
const roundMoney = (n) => Math.round(n * 100) / 100 || 0;

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
// cannot be classified (zero, non-numeric, non-finite).
export function classifyTransactionAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) return null;
  return amount > 0 ? { kind: 'income', value: amount } : { kind: 'expense', value: -amount };
}

// { 'YYYY-MM': { income, expenses } } for every transaction with a usable amount
// and a real calendar date. Each transaction lands in exactly one bucket.
export function aggregateMonthlyTransactions(transactions) {
  const months = {};
  for (const t of transactions) {
    const classified = classifyTransactionAmount(t?.amount);
    const date = parseLocalDate(t?.date);
    if (!classified || !date) continue;
    const key = getMonthKey(date);
    const bucket = months[key] ?? (months[key] = { income: 0, expenses: 0 });
    if (classified.kind === 'income') bucket.income += classified.value;
    else bucket.expenses += classified.value;
  }
  for (const bucket of Object.values(months)) {
    bucket.income = roundMoney(bucket.income);
    bucket.expenses = roundMoney(bucket.expenses);
  }
  return months;
}

// All figures the dashboard summary needs. All-time totals ignore the date (a
// recorded amount is real money even if its date is unusable); month figures
// only include rows with a valid date.
export function summarizeTransactions(transactions, now = new Date()) {
  let totalIncome = 0;
  let totalExpenses = 0;
  for (const t of transactions) {
    const classified = classifyTransactionAmount(t?.amount);
    if (!classified) continue;
    if (classified.kind === 'income') totalIncome += classified.value;
    else totalExpenses += classified.value;
  }
  totalIncome = roundMoney(totalIncome);
  totalExpenses = roundMoney(totalExpenses);

  const months = aggregateMonthlyTransactions(transactions);
  const [previousKey, currentKey] = getRecentMonthKeys(2, now);
  return {
    totalIncome,
    totalExpenses,
    balance: roundMoney(totalIncome - totalExpenses),
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
