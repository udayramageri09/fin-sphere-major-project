/* eslint-disable no-undef */
import express from 'express';
import crypto from 'node:crypto';
import { createAccounts, createTransactions, isValidSyntheticPan, maskPan } from './mockData.js';

const app = express();
const PORT = Number(process.env.PORT || 7100);
app.use(express.json({ limit: '100kb' }));

// ---------------------------------------------------------------------------------------------
// FinSphere Local Account Aggregator Development Simulator
//
// This is a ReBIT-inspired LOCAL simulator for academic/demo purposes only. It does not
// represent a certified Account Aggregator, a real bank connection, or a real PAN verification
// service. Every account, balance and transaction below is synthetic. See aa_simulator/README.md.
// ---------------------------------------------------------------------------------------------

// In-memory only: state does not survive a restart of this process. Each key ("aaId") is an
// opaque identifier the caller controls; the main FinSphere server derives one deterministically
// per authenticated user (see server/aaProvider.js), which is what gives different FinSphere
// users independent, non-overlapping simulator state.
const state = {
  customers: new Map(),   // aaId -> { customerId, aaId, name, accounts, pan }
  consents: new Map(),    // consentId -> consent
  fiRequests: new Map()   // fiRequestId -> fi request
};

function id(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

// Any aaId is auto-provisioned on first touch with the same deterministic 10 synthetic accounts
// (createAccounts() takes no random input), so restarting this simulator reproduces identical
// demo data for a given aaId - "the same demo customer gets predictable results".
function getOrCreateCustomer(aaId) {
  let customer = state.customers.get(aaId);
  if (!customer) {
    customer = { customerId: aaId, aaId, name: 'Demo Customer', accounts: createAccounts(), pan: null };
    state.customers.set(aaId, customer);
  }
  return customer;
}

function requireConsent(consentId) {
  return state.consents.get(consentId) ?? null;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'finsphere-aa-simulator', syntheticOnly: true });
});

// ── PAN linking (simulated) ─────────────────────────────────────────────────────────────────
// Synthetic development data only. This simulator is not a certified Account Aggregator and
// never contacts any external PAN registry. The raw PAN is validated for shape and then
// discarded; only a masked representation and a verification timestamp are ever stored.
app.post('/v1/pan/verify', (req, res) => {
  const { aaId, pan } = req.body ?? {};
  if (!aaId || typeof aaId !== 'string') return res.status(400).json({ error: 'aaId is required' });
  if (!isValidSyntheticPan(pan)) {
    return res.status(400).json({ error: 'Enter a 10-character PAN (e.g. ABCDE1234F) or a demo PAN such as DEMO-PAN-001.' });
  }
  const customer = getOrCreateCustomer(aaId);
  const maskedPan = maskPan(pan);
  customer.pan = { maskedPan, status: 'VERIFIED', verifiedAt: new Date().toISOString() };
  res.json({ aaId, panStatus: 'VERIFIED', maskedPan, synthetic: true });
});

app.get('/v1/pan/:aaId', (req, res) => {
  const customer = state.customers.get(req.params.aaId);
  if (!customer?.pan) return res.json({ aaId: req.params.aaId, panStatus: 'NOT_VERIFIED', maskedPan: null });
  res.json({ aaId: req.params.aaId, panStatus: customer.pan.status, maskedPan: customer.pan.maskedPan });
});

// ── Account discovery ───────────────────────────────────────────────────────────────────────
// Discovery follows PAN linking in the real ReBIT flow, so it is gated the same way here.
app.get('/v1/customers/:aaId/accounts', (req, res) => {
  const customer = getOrCreateCustomer(req.params.aaId);
  if (customer.pan?.status !== 'VERIFIED') {
    return res.status(409).json({ error: 'PAN verification is required before accounts can be discovered' });
  }
  res.json({ aaId: customer.aaId, accounts: customer.accounts });
});

// ── Consent lifecycle ───────────────────────────────────────────────────────────────────────
app.post('/v1/consents', (req, res) => {
  const { aaId, purpose, dataTypes = ['PROFILE', 'SUMMARY', 'TRANSACTIONS'], dateRange, accountIds } = req.body ?? {};
  if (!aaId || !purpose) return res.status(400).json({ error: 'aaId and purpose are required' });
  const customer = getOrCreateCustomer(aaId);
  if (customer.pan?.status !== 'VERIFIED') {
    return res.status(409).json({ error: 'PAN verification is required before a consent can be created' });
  }
  const knownIds = new Set(customer.accounts.map((a) => a.accountId));
  const selected = Array.isArray(accountIds) && accountIds.length
    ? accountIds.filter((accId) => knownIds.has(accId))
    : customer.accounts.map((a) => a.accountId);
  if (!selected.length) return res.status(400).json({ error: 'No valid accounts selected' });

  const consentId = id('consent');
  const consent = {
    consentId,
    aaId,
    purpose,
    dataTypes,
    accountIds: selected,
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

// ── Financial Information request lifecycle ────────────────────────────────────────────────
// Conceptually FI_REQUEST_CREATED -> PROCESSING -> READY. Generation is deterministic and
// synchronous here (synthetic data, nothing to actually wait on), so a request is READY as soon
// as it is created; the status/data endpoints stay separate so the FinSphere client can poll
// them exactly as it would against a real provider.
app.post('/v1/fi-requests', (req, res) => {
  const { consentId, accountIds } = req.body ?? {};
  const consent = consentId ? requireConsent(consentId) : null;
  if (!consent) return res.status(404).json({ error: 'Consent not found' });
  if (consent.status !== 'ACTIVE') return res.status(409).json({ error: 'Active consent is required' });

  const allowed = new Set(consent.accountIds);
  const selected = Array.isArray(accountIds) && accountIds.length
    ? accountIds.filter((accId) => allowed.has(accId))
    : consent.accountIds;
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
  res.json({ fiRequestId: request.fiRequestId, aaId: request.aaId, status: request.status });
});

app.get('/v1/fi-requests/:fiRequestId/data', (req, res) => {
  const request = state.fiRequests.get(req.params.fiRequestId);
  if (!request) return res.status(404).json({ error: 'FI request not found' });
  if (request.status !== 'READY') return res.status(409).json({ error: 'Financial information is not ready' });

  const customer = getOrCreateCustomer(request.aaId);
  const accounts = customer.accounts.filter((a) => request.accountIds.includes(a.accountId));
  const transactions = createTransactions(accounts);

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
  console.log(`FinSphere AA simulator listening on http://localhost:${PORT} (synthetic data only)`);
});
