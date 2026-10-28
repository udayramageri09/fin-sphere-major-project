const accountSeeds = [
  ['HDFC Bank', 'SAVINGS', 'XX4582', 84250.75],
  ['State Bank of India', 'SAVINGS', 'XX1024', 126400.00],
  ['ICICI Bank', 'SAVINGS', 'XX7718', 58320.40],
  ['Axis Bank', 'CURRENT', 'XX3341', 91750.10],
  ['Kotak Mahindra Bank', 'SAVINGS', 'XX9182', 45210.65],
  ['Canara Bank', 'SAVINGS', 'XX6407', 38990.00],
  ['IDFC FIRST Bank', 'SAVINGS', 'XX2256', 106840.25],
  ['HDFC Bank', 'TERM-DEPOSIT', 'FD-0019', 150000.00],
  ['State Bank of India', 'RECURRING-DEPOSIT', 'RD-0084', 36000.00],
  ['Zerodha / Mutual Funds', 'MUTUAL-FUND', 'MF-4201', 218750.35]
];

const descriptions = [
  'Salary Credit', 'Grocery Store', 'Electricity Bill', 'Restaurant',
  'Mutual Fund SIP', 'Online Shopping', 'Rent Transfer', 'Fuel Station',
  'Insurance Premium', 'Subscription Payment'
];

export function createAccounts() {
  return accountSeeds.map(([fipName, type, suffix, balance], index) => ({
    accountId: `FS-DEMO-${String(index + 1).padStart(3, '0')}`,
    fipId: `FIP-${String(index + 1).padStart(2, '0')}`,
    fipName,
    type,
    maskedNumber: type === 'TERM-DEPOSIT' || type === 'RECURRING-DEPOSIT' || type === 'MUTUAL-FUND' ? suffix : `XXXXXX${suffix.replace('XX', '')}`,
    balance,
    currency: 'INR',
    linked: true
  }));
}

// Relative to "now" (never a hardcoded calendar date) so the generated history is always
// in the past, however long after this was written the simulator happens to be run.
function ymdDaysAgo(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
}

export function createTransactions(accounts) {
  const transactions = [];
  let sequence = 1;
  accounts.forEach((account, accountIndex) => {
    const base = account.balance;
    const rows = [
      { amount: Math.round(Math.max(500, base * 0.12)), type: 'CREDIT', description: 'Salary Credit', category: 'INCOME', daysAgo: 28 },
      { amount: 850 + accountIndex * 75, type: 'DEBIT', description: descriptions[(accountIndex + 1) % descriptions.length], category: 'EXPENSE', daysAgo: 23 },
      { amount: 1250 + accountIndex * 110, type: 'DEBIT', description: descriptions[(accountIndex + 3) % descriptions.length], category: 'EXPENSE', daysAgo: 18 },
      { amount: 500 + accountIndex * 50, type: 'DEBIT', description: descriptions[(accountIndex + 5) % descriptions.length], category: 'EXPENSE', daysAgo: 13 }
    ];
    rows.forEach((row) => {
      transactions.push({
        transactionId: `AA-TX-${String(sequence++).padStart(4, '0')}`,
        accountId: account.accountId,
        date: ymdDaysAgo(row.daysAgo),
        amount: row.amount,
        type: row.type,
        description: row.description,
        category: row.category,
        source: 'ACCOUNT_AGGREGATOR'
      });
    });
  });
  return transactions;
}

// A real-format PAN (ABCDE1234F) or the documented demo token (DEMO-PAN-001..999).
// This simulator never contacts a real PAN registry; verification is purely synthetic.
export const PAN_FORMAT = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const DEMO_PAN_FORMAT = /^DEMO-PAN-\d{3}$/i;

export function isValidSyntheticPan(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().toUpperCase();
  return PAN_FORMAT.test(trimmed) || DEMO_PAN_FORMAT.test(trimmed);
}

// Only the masked form is ever stored; the raw PAN exists only for the duration of this call.
export function maskPan(pan) {
  const trimmed = pan.trim().toUpperCase();
  const visible = trimmed.slice(-3);
  return `${'*'.repeat(Math.max(0, trimmed.length - 3))}${visible}`;
}

// Note: UPI simulation (apps, connections, transactions) lives in server/upiSimulator.js, not
// here. That keeps the one authenticated FinSphere API as the only thing the frontend ever talks
// to for UPI, with no second unauthenticated network hop - see docs/AA_SIMULATOR.md.
