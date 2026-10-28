import express from 'express';
import { AaProviderError } from './aaProvider.js';
import { normalizeAaAccount, normalizeAaTransaction, normalizeUpiTransaction } from './accountAggregatorNormalize.js';

// "FinSphere Local Account Aggregator Development Simulator" integration routes.
//
// This is a ReBIT-inspired LOCAL simulation for academic/demo purposes - NOT a certified Account
// Aggregator, a real bank connection, or a real UPI integration. See aa_simulator/README.md and
// docs/AA_SIMULATOR.md. Every route below requires the same session cookie as the rest of the
// FinSphere API (the `authenticate` middleware), so this never weakens existing auth, and every
// piece of per-user state here is keyed by the authenticated FinSphere user id - never shared
// globally - so one user's demo connections can never be read through another user's session.

// Deterministic, one-way-looking, non-guessable-in-practice mapping from a FinSphere user id to
// an opaque Account Aggregator customer handle. It is never treated as a secret (the simulator
// has no concept of authorization of its own); the ownership checks below are what actually
// stop one FinSphere user from acting on another's consent/FI-request/UPI state.
const aaIdFor = (userId) => `fs-user-${userId}@finsphere.local`;

function sendProviderError(res, err, fallbackMessage) {
  if (err instanceof AaProviderError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`${fallbackMessage}:`, err?.code ?? err?.message);
  return res.status(500).json({ error: fallbackMessage });
}

export function financialConnectionsRouter(authenticate, { createTransactionFor, aaProvider, upiSimulator, limiter }) {
  const router = express.Router();
  router.use(authenticate);
  if (limiter) router.use(limiter);

  // In-memory bookkeeping that belongs to FinSphere, not to the AA domain itself: which FI
  // requests have already had their data inserted into the real transactions table, so
  // POST .../connect is idempotent (repeat calls never duplicate transactions). Keyed by
  // `${userId}:${fiRequestId}`. Lost on a server restart, same as the rest of this simulator's state.
  const connectedFiRequests = new Set();

  // ── PAN linking (simulated) ─────────────────────────────────────────────────────────────────
  router.post('/aa/pan/verify', async (req, res) => {
    const { pan } = req.body ?? {};
    if (typeof pan !== 'string') return res.status(400).json({ error: 'A PAN is required.' });
    try {
      const result = await aaProvider.verifyPan(aaIdFor(req.user.id), pan);
      res.json({ panStatus: result.panStatus, maskedPan: result.maskedPan });
    } catch (err) { sendProviderError(res, err, 'Could not verify PAN'); }
  });

  router.get('/aa/pan', async (req, res) => {
    try {
      const result = await aaProvider.getPanStatus(aaIdFor(req.user.id));
      res.json({ panStatus: result.panStatus, maskedPan: result.maskedPan });
    } catch (err) { sendProviderError(res, err, 'Could not load PAN status'); }
  });

  // ── Account discovery ───────────────────────────────────────────────────────────────────────
  router.get('/aa/accounts', async (req, res) => {
    try {
      const result = await aaProvider.discoverAccounts(aaIdFor(req.user.id));
      res.json({ accounts: result.accounts.map(normalizeAaAccount) });
    } catch (err) { sendProviderError(res, err, 'Could not discover accounts'); }
  });

  // ── Consent lifecycle ───────────────────────────────────────────────────────────────────────
  router.post('/aa/consents', async (req, res) => {
    const { accountIds, purpose } = req.body ?? {};
    if (accountIds !== undefined && (!Array.isArray(accountIds) || !accountIds.every((a) => typeof a === 'string'))) {
      return res.status(400).json({ error: 'accountIds must be an array of account id strings.' });
    }
    try {
      const consent = await aaProvider.createConsent(aaIdFor(req.user.id), {
        purpose: typeof purpose === 'string' && purpose.trim() ? purpose.trim() : 'Personal financial management',
        accountIds
      });
      res.status(201).json(consent);
    } catch (err) { sendProviderError(res, err, 'Could not create consent'); }
  });

  // Loads a consent and refuses it (404, same as a missing one) unless it belongs to this user.
  async function ownConsentOr404(req, res, consentId) {
    const consent = await aaProvider.getConsent(consentId);
    if (consent.aaId !== aaIdFor(req.user.id)) { res.status(404).json({ error: 'Consent not found' }); return null; }
    return consent;
  }

  router.get('/aa/consents/:id', async (req, res) => {
    try {
      const consent = await ownConsentOr404(req, res, req.params.id);
      if (consent) res.json(consent);
    } catch (err) { sendProviderError(res, err, 'Could not load consent'); }
  });

  router.post('/aa/consents/:id/approve', async (req, res) => {
    try {
      const consent = await ownConsentOr404(req, res, req.params.id);
      if (!consent) return;
      res.json(await aaProvider.approveConsent(req.params.id));
    } catch (err) { sendProviderError(res, err, 'Could not approve consent'); }
  });

  router.post('/aa/consents/:id/reject', async (req, res) => {
    try {
      const consent = await ownConsentOr404(req, res, req.params.id);
      if (!consent) return;
      res.json(await aaProvider.rejectConsent(req.params.id));
    } catch (err) { sendProviderError(res, err, 'Could not reject consent'); }
  });

  // ── Financial Information request lifecycle ────────────────────────────────────────────────
  router.post('/aa/fi-requests', async (req, res) => {
    const { consentId } = req.body ?? {};
    if (typeof consentId !== 'string') return res.status(400).json({ error: 'consentId is required.' });
    try {
      const consent = await ownConsentOr404(req, res, consentId);
      if (!consent) return;
      res.status(201).json(await aaProvider.createFiRequest(consentId));
    } catch (err) { sendProviderError(res, err, 'Could not create a financial information request'); }
  });

  // Loads FI data and refuses it (404) unless it belongs to this user; also used by /connect.
  async function ownFiDataOr404(req, res, fiRequestId) {
    const data = await aaProvider.getFiRequestData(fiRequestId);
    if (data.customer.customerId !== aaIdFor(req.user.id)) { res.status(404).json({ error: 'FI request not found' }); return null; }
    return data;
  }

  router.get('/aa/fi-requests/:id/status', async (req, res) => {
    try {
      const status = await aaProvider.getFiRequestStatus(req.params.id);
      if (status.aaId !== aaIdFor(req.user.id)) return res.status(404).json({ error: 'FI request not found' });
      res.json({ fiRequestId: status.fiRequestId, status: status.status });
    } catch (err) { sendProviderError(res, err, 'Could not load financial information status'); }
  });

  router.get('/aa/fi-requests/:id/data', async (req, res) => {
    try {
      const data = await ownFiDataOr404(req, res, req.params.id);
      if (!data) return;
      res.json({
        fiRequestId: data.fiRequestId,
        accounts: data.accounts.map(normalizeAaAccount),
        transactions: data.transactions.map(normalizeAaTransaction),
        synthetic: data.synthetic
      });
    } catch (err) { sendProviderError(res, err, 'Could not load financial information'); }
  });

  // The integration step: normalizes this FI request's transactions into FinSphere's real,
  // existing transactions table via createTransactionFor - the exact function POST /api/transactions
  // uses - so connected AA data goes through the same validation and ownership stamping as any
  // manually entered transaction, and shows up in the existing Transactions/Dashboard/analytics
  // with no parallel storage of its own. Idempotent: a repeat call never inserts twice.
  router.post('/aa/fi-requests/:id/connect', async (req, res) => {
    try {
      const data = await ownFiDataOr404(req, res, req.params.id);
      if (!data) return;
      const key = `${req.user.id}:${req.params.id}`;
      if (connectedFiRequests.has(key)) {
        return res.json({ connected: true, alreadyConnected: true, transactionsAdded: 0 });
      }
      let added = 0;
      for (const transaction of data.transactions.map(normalizeAaTransaction)) {
        const outcome = await createTransactionFor(req.user.id, transaction);
        if (outcome.ok) added++;
      }
      connectedFiRequests.add(key);
      res.json({ connected: true, alreadyConnected: false, transactionsAdded: added });
    } catch (err) { sendProviderError(res, err, 'Could not connect this financial data'); }
  });

  // ── Overview for the "Financial Connections" page ──────────────────────────────────────────
  router.get('/aa/status', async (req, res) => {
    const aaId = aaIdFor(req.user.id);
    try {
      const pan = await aaProvider.getPanStatus(aaId);
      let accountsDiscovered = 0;
      if (pan.panStatus === 'VERIFIED') {
        accountsDiscovered = (await aaProvider.discoverAccounts(aaId)).accounts.length;
      }
      let connectedAccounts = 0;
      for (const key of connectedFiRequests) {
        if (key.startsWith(`${req.user.id}:`)) connectedAccounts += 1;
      }
      res.json({
        panVerified: pan.panStatus === 'VERIFIED',
        maskedPan: pan.maskedPan,
        accountsDiscovered,
        financialDataConnected: connectedAccounts > 0,
        upiConnectedApps: upiSimulator.listApps(req.user.id).filter((a) => a.connected).length
      });
    } catch (err) { sendProviderError(res, err, 'Could not load connection status'); }
  });

  // ── UPI simulator ───────────────────────────────────────────────────────────────────────────
  // Synthetic development data only. Never calls a real Google Pay/PhonePe/Paytm/BHIM API.
  router.get('/upi/apps', (req, res) => {
    res.json({ apps: upiSimulator.listApps(req.user.id) });
  });

  router.post('/upi/apps/:id/connect', (req, res) => {
    const app = upiSimulator.connect(req.user.id, req.params.id);
    if (!app) return res.status(404).json({ error: 'Unknown UPI app' });
    res.json(app);
  });

  router.post('/upi/apps/:id/disconnect', (req, res) => {
    const app = upiSimulator.disconnect(req.user.id, req.params.id);
    if (!app) return res.status(404).json({ error: 'Unknown UPI app' });
    res.json(app);
  });

  router.get('/upi/transactions', (req, res) => {
    res.json({ transactions: upiSimulator.transactions(req.user.id) });
  });

  router.get('/upi/summary', (req, res) => {
    res.json(upiSimulator.summary(req.user.id));
  });

  // Normalizes every connected-but-not-yet-synced app's transactions into the real transactions
  // table, reusing createTransactionFor exactly like the AA /connect route above. Idempotent per app.
  router.post('/upi/sync', async (req, res) => {
    try {
      const apps = upiSimulator.listApps(req.user.id).filter((a) => a.connected && !upiSimulator.isSynced(req.user.id, a.id));
      let added = 0;
      for (const app of apps) {
        for (const transaction of upiSimulator.transactions(req.user.id).filter((t) => t.appId === app.id).map(normalizeUpiTransaction)) {
          const outcome = await createTransactionFor(req.user.id, transaction);
          if (outcome.ok) added++;
        }
        upiSimulator.markSynced(req.user.id, app.id);
      }
      res.json({ syncedApps: apps.map((a) => a.id), transactionsAdded: added });
    } catch (err) { sendProviderError(res, err, 'Could not synchronize UPI transactions'); }
  });

  return router;
}
