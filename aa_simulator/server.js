import express from 'express';
import crypto from 'node:crypto';

const app = express();
const PORT = Number(process.env.PORT || 7100);
app.use(express.json({ limit: '100kb' }));

// Local development simulator only. It does not represent a certified Account Aggregator.
const state = {
  consents: new Map(),
  fiRequests: new Map(),
  customers: new Map([
    ['customer1@finsphere', {
      customerId: 'customer1',
      aaId: 'customer1@finsphere',
      name: 'Demo Customer',
      accounts: [
        {
          fipId: 'finsphere-bank',
          accountId: 'FSB-SAV-001',
          type: 'SAVINGS',
          maskedNumber: 'XXXXXX4582',
          balance: 84250.75,
          currency: 'INR'
        }
      ]
    }]
  ])
};

function id(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function requireCustomer(aaId) {
  return state.customers.get(aaId);
}

function requireConsent(consentId) {
  const consent = state.consents.get(consentId);
  if (!consent) return null;
  return consent;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'finsphere-aa-simulator', syntheticOnly: true });
});

app.get('/v1/customers/:aaId/accounts', (req, res) => {
  const customer = requireCustomer(req.params.aaId);
  if (!customer) return res.status(404).json({ error: 'Unknown AA customer' });
  res.json({ aaId: customer.aaId, accounts: customer.accounts });
});

app.post('/v1/consents', (req, res) => {
  const { aaId, purpose, dataTypes = ['PROFILE', 'SUMMARY', 'TRANSACTIONS'], dateRange } = req.body ?? {};
  if (!aaId || !purpose) return res.status(400).json({ error: 'aaId and purpose are required' });
  if (!requireCustomer(aaId)) return res.status(404).json({ error: 'Unknown AA customer' });

  const consentId = id('consent');
  const consent = {
    consentId,
    aaId,
    purpose,
    dataTypes,
    dateRange: dateRange ?? { from: '2026-04-01', to: '2026-10-31' },
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    approvedAt: null
  };
  state.consents.set(consentId, consent);
  res.status(201).json(consent);
});

app.get('/v1/consents/:consentId', (req, res) => {
  const consent = requireConsent(req.params.consentId);
  if (!consent) return res.status(404).json({ error: 'Consent not found' });
  res.json(consent);
});

app.post('/v1/consents/:consentId/approve', (req, res) => {
  const consent = requireConsent(req.params.consentId);
  if (!consent) return res.status(404).json({ error: 'Consent not found' });
  if (consent.status !== 'PENDING') return res.status(409).json({ error: `Consent is already ${consent.status}` });
  consent.status = 'ACTIVE';
  consent.approvedAt = new Date().toISOString();
  res.json(consent);
});

app.post('/v1/consents/:consentId/reject', (req, res) => {
  const consent = requireConsent(req.params.consentId);
  if (!consent) return res.status(404).json({ error: 'Consent not found' });
  if (consent.status !== 'PENDING') return res.status(409).json({ error: `Consent is already ${consent.status}` });
  consent.status = 'REJECTED';
  res.json(consent);
});

app.post('/v1/fi-requests', (req, res) => {
  const { consentId, accountIds } = req.body ?? {};
  const consent = consentId ? requireConsent(consentId) : null;
  if (!consent) return res.status(404).json({ error: 'Consent not found' });
  if (consent.status !== 'ACTIVE') return res.status(409).json({ error: 'Active consent is required' });

  const customer = requireCustomer(consent.aaId);
  const allowed = new Set(customer.accounts.map((a) => a.accountId));
  const selected = Array.isArray(accountIds) && accountIds.length
    ? accountIds.filter((accountId) => allowed.has(accountId))
    : customer.accounts.map((a) => a.accountId);
  if (!selected.length) return res.status(400).json({ error: 'No valid accounts selected' });

  const fiRequestId = id('fi');
  const request = {
    fiRequestId,
    consentId,
    aaId: consent.aaId,
    accountIds: selected,
    status: 'READY',
    createdAt: new Date().toISOString()
  };
  state.fiRequests.set(fiRequestId, request);
  res.status(201).json(request);
});

app.get('/v1/fi-requests/:fiRequestId/status', (req, res) => {
  const request = state.fiRequests.get(req.params.fiRequestId);
  if (!request) return res.status(404).json({ error: 'FI request not found' });
  res.json({ fiRequestId: request.fiRequestId, status: request.status });
});

app.get('/v1/fi-requests/:fiRequestId/data', (req, res) => {
  const request = state.fiRequests.get(req.params.fiRequestId);
  if (!request) return res.status(404).json({ error: 'FI request not found' });
  if (request.status !== 'READY') return res.status(409).json({ error: 'Financial information is not ready' });

  const customer = requireCustomer(request.aaId);
  const accounts = customer.accounts.filter((a) => request.accountIds.includes(a.accountId));
  const transactions = [
    { transactionId: 'TX-1001', accountId: 'FSB-SAV-001', date: '2026-10-02', amount: 52000, type: 'CREDIT', description: 'Salary Credit', category: 'INCOME' },
    { transactionId: 'TX-1002', accountId: 'FSB-SAV-001', date: '2026-10-04', amount: 850, type: 'DEBIT', description: 'Grocery Store', category: 'FOOD' },
    { transactionId: 'TX-1003', accountId: 'FSB-SAV-001', date: '2026-10-07', amount: 2400, type: 'DEBIT', description: 'Electricity Bill', category: 'UTILITIES' },
    { transactionId: 'TX-1004', accountId: 'FSB-SAV-001', date: '2026-10-11', amount: 1200, type: 'DEBIT', description: 'Restaurant', category: 'FOOD' },
    { transactionId: 'TX-1005', accountId: 'FSB-SAV-001', date: '2026-10-14', amount: 3000, type: 'DEBIT', description: 'Mutual Fund SIP', category: 'INVESTMENT' }
  ];

  res.json({
    fiRequestId: request.fiRequestId,
    customer: { customerId: customer.customerId, name: customer.name },
    accounts,
    transactions,
    generatedAt: new Date().toISOString(),
    synthetic: true
  });
});

app.listen(PORT, () => {
  console.log(`FinSphere AA simulator listening on http://localhost:${PORT}`);
});
