export const demoIdentity = 'DEMO-PAN-001';

export const demoOverview = {
  currency: 'INR',
  bankAccounts: [
    { id: 'demo-bank-1', name: 'Demo savings account', maskedNumber: '•••• 1101', balance: 28410.50 },
    { id: 'demo-bank-2', name: 'Demo current account', maskedNumber: '•••• 2202', balance: 7600 }
  ],
  transactions: [
    { accountId: 'demo-bank-1', date: '2026-03-02', title: '[Sandbox] Salary', amount: 35000, type: 'income', category: 'Salary', classification: 'income' },
    { accountId: 'demo-bank-1', date: '2026-03-04', title: '[Sandbox] Annapoorna Cafe', amount: -240, type: 'expense', category: 'Food', classification: 'expense' },
    { accountId: 'demo-bank-2', date: '2026-03-06', title: '[Sandbox] Demo Fuel Station', amount: -1250, type: 'expense', category: 'Petrol', classification: 'expense' }
  ],
  investments: [{ name: 'Demo index fund', detail: 'Sample current value', amount: 42000 }],
  loans: [{ name: 'Demo education loan', detail: 'Sample outstanding balance', amount: 82000 }],
  insurance: [{ name: 'Demo health policy', detail: 'Sample coverage amount', amount: 500000 }]
};
