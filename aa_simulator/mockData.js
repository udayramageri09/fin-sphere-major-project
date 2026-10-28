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

export const DEMO_APPS = [
  { id: 'gpay', name: 'Google Pay', handle: 'demo@okaxis', accent: 'G' },
  { id: 'phonepe', name: 'PhonePe', handle: 'demo@ybl', accent: 'P' },
  { id: 'paytm', name: 'Paytm', handle: 'demo@paytm', accent: '₹' },
  { id: 'bhim', name: 'BHIM', handle: 'demo@upi', accent: 'B' }
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

export function createTransactions(accounts) {
  const transactions = [];
  let sequence = 1;
  accounts.forEach((account, accountIndex) => {
    const base = account.balance;
    const rows = [
      { amount: Math.round(Math.max(500, base * 0.12)), type: 'CREDIT', description: 'Salary Credit', category: 'INCOME' },
      { amount: 850 + accountIndex * 75, type: 'DEBIT', description: descriptions[(accountIndex + 1) % descriptions.length], category: 'EXPENSE' },
      { amount: 1250 + accountIndex * 110, type: 'DEBIT', description: descriptions[(accountIndex + 3) % descriptions.length], category: 'EXPENSE' },
      { amount: 500 + accountIndex * 50, type: 'DEBIT', description: descriptions[(accountIndex + 5) % descriptions.length], category: 'EXPENSE' }
    ];
    rows.forEach((row, rowIndex) => {
      transactions.push({
        transactionId: `AA-TX-${String(sequence++).padStart(4, '0')}`,
        accountId: account.accountId,
        date: `2026-10-${String(2 + rowIndex * 5).padStart(2, '0')}`,
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

export function createUpiTransactions() {
  const apps = DEMO_APPS;
  const merchants = ['Swiggy', 'Amazon', 'Uber', 'Bharat Petroleum', 'BookMyShow', 'BigBasket', 'Electricity Board', 'College Canteen'];
  return Array.from({ length: 24 }, (_, index) => {
    const app = apps[index % apps.length];
    const amount = [349, 799, 220, 1450, 299, 560, 1825, 120][index % 8];
    const direction = index % 7 === 0 ? 'CREDIT' : 'DEBIT';
    return {
      transactionId: `UPI-TX-${String(index + 1).padStart(4, '0')}`,
      appId: app.id,
      appName: app.name,
      upiId: app.handle,
      date: `2026-10-${String((index % 20) + 1).padStart(2, '0')}`,
      amount,
      direction,
      merchant: direction === 'CREDIT' ? 'Demo Refund' : merchants[index % merchants.length],
      status: 'SUCCESS',
      source: 'UPI_SIMULATOR'
    };
  });
}
