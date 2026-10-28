// Normalization layer (Issue: local AA simulator). Converts the local simulator's response shapes
// into the shapes FinSphere's existing models already expect, so none of the simulator's own
// field names ever leak past this file. Pure functions only - no I/O, no database access.

// AA simulator account -> the display shape described for the "Financial Connections" UI.
// { institution, fipId, accountId, accountType, maskedAccountNumber, balance, currency, linked }
export function normalizeAaAccount(account) {
  return {
    institution: account.fipName,
    fipId: account.fipId,
    accountId: account.accountId,
    accountType: account.type,
    maskedAccountNumber: account.maskedNumber,
    balance: account.balance,
    currency: account.currency,
    linked: account.linked
  };
}

// AA simulator transaction -> the exact shape server.js's existing transaction validator/writer
// (normalizeTransactionInput / createTransactionFor) already accepts. Like any statement import,
// an Account Aggregator feed only knows a transaction's direction, never the user's intent behind
// it, so classification is always 'unknown' here - the same rule normalizeImportedRows() uses for
// CSV/XLSX statement imports (never 'income'/'expense'/'refund'/'transfer' guessed from a feed).
export function normalizeAaTransaction(transaction) {
  return {
    title: transaction.description,
    amount: transaction.amount,
    date: transaction.date,
    type: transaction.type === 'CREDIT' ? 'income' : 'expense',
    category: transaction.category === 'INCOME' ? 'Income' : transaction.category === 'EXPENSE' ? 'General' : transaction.category,
    classification: 'unknown'
  };
}

// UPI simulator transaction -> the same FinSphere transaction input shape.
export function normalizeUpiTransaction(transaction) {
  return {
    title: `${transaction.merchant} (${transaction.appName})`,
    amount: transaction.amount,
    date: transaction.date,
    type: transaction.direction === 'CREDIT' ? 'income' : 'expense',
    category: transaction.direction === 'CREDIT' ? 'Income' : 'UPI Payments',
    classification: 'unknown'
  };
}
