import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
let invalidations = 0;
globalThis.__fcAuth = { user: { id: 1 }, invalidateSession: () => { invalidations++; }, retryIdentityCheck: () => {} };
const vite = await createServer({
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
  plugins: [{
    name: 'financial-connections-auth', enforce: 'pre',
    resolveId(id) { if (id.endsWith('/context/AuthContext')) return '\0auth'; },
    load(id) { if (id === '\0auth') return 'export const useAuth=()=>globalThis.__fcAuth;'; }
  }]
});

// ── A tiny in-memory fake of the real /api/aa/* and /api/upi/* routes ────────────────────────
// This test exercises the REACT COMPONENT (rendering, state wiring, click handling, request
// shapes) against a minimal fake backend. The real backend's business rules (PAN gating, consent
// lifecycle, idempotency, cross-account isolation) are already verified end-to-end against the
// actual authenticated API in server/tests/financialConnectionsServer.test.mjs.
const ACCOUNTS = Array.from({ length: 10 }, (_, i) => ({
  institution: `Demo Bank ${i + 1}`, fipId: `FIP-${i + 1}`, accountId: `FS-DEMO-${String(i + 1).padStart(3, '0')}`,
  accountType: 'SAVINGS', maskedAccountNumber: `XXXXXX${1000 + i}`, balance: 50000 + i * 1000, currency: 'INR', linked: true
}));
const UPI_APPS = [
  { id: 'gpay', name: 'Google Pay', handle: 'demo@okaxis' }, { id: 'phonepe', name: 'PhonePe', handle: 'demo@ybl' },
  { id: 'paytm', name: 'Paytm', handle: 'demo@paytm' }, { id: 'bhim', name: 'BHIM', handle: 'demo@upi' }
];
const state = { panVerified: false, consents: new Map(), fiRequests: new Map(), connected: false, connectedAccounts: 0, upiConnected: new Set(), upiSynced: new Set(), calls: [] };
const upiTx = (appId) => Array.from({ length: 6 }, (_, i) => ({ transactionId: `${appId}-${i}`, appId, appName: UPI_APPS.find((a) => a.id === appId).name, upiId: 'demo@x', date: '2026-10-01', amount: 100 + i, direction: i === 0 ? 'CREDIT' : 'DEBIT', merchant: 'Demo Merchant', status: 'SUCCESS', source: 'UPI_SIMULATOR' }));

globalThis.fetch = async (url, opts = {}) => {
  const path = url.replace(/^https?:\/\/[^/]+\/api/, '');
  const method = opts.method ?? 'GET';
  const body = opts.body ? JSON.parse(opts.body) : {};
  state.calls.push(`${method} ${path}`);
  const json = (status, data) => ({ status, ok: status < 400, json: async () => data });

  if (method === 'POST' && path === '/aa/pan/verify') { state.panVerified = true; return json(200, { panStatus: 'VERIFIED', maskedPan: '*********001' }); }
  if (method === 'GET' && path === '/aa/accounts') return state.panVerified ? json(200, { accounts: ACCOUNTS }) : json(409, { error: 'PAN verification is required' });
  if (method === 'POST' && path === '/aa/consents') {
    const consentId = 'consent-1';
    const consent = { consentId, status: 'PENDING', purpose: 'Personal financial management', dataTypes: ['PROFILE', 'SUMMARY', 'TRANSACTIONS'], dateRange: { from: '2026-04-01', to: '2026-10-31' }, accountIds: body.accountIds };
    state.consents.set(consentId, consent);
    return json(201, consent);
  }
  if (method === 'POST' && /^\/aa\/consents\/.+\/approve$/.test(path)) {
    const consent = state.consents.get(path.split('/')[3]);
    consent.status = 'ACTIVE';
    return json(200, consent);
  }
  if (method === 'POST' && path === '/aa/fi-requests') {
    const fiRequestId = 'fi-1';
    state.fiRequests.set(fiRequestId, { fiRequestId, status: 'READY' });
    return json(201, { fiRequestId, status: 'READY' });
  }
  if (method === 'POST' && /^\/aa\/fi-requests\/.+\/connect$/.test(path)) {
    const already = state.connected;
    if (!already) state.connectedAccounts = state.consents.get('consent-1').accountIds.length;
    state.connected = true;
    return json(200, { connected: true, alreadyConnected: already, transactionsAdded: already ? 0 : 16 });
  }
  if (method === 'GET' && path === '/aa/status') {
    return json(200, { panVerified: state.panVerified, maskedPan: state.panVerified ? '*********001' : null, accountsDiscovered: state.panVerified ? 10 : 0, financialDataConnected: state.connected, connectedAccounts: state.connectedAccounts, upiConnectedApps: state.upiConnected.size });
  }
  if (method === 'GET' && path === '/upi/apps') return json(200, { apps: UPI_APPS.map((a) => ({ ...a, connected: state.upiConnected.has(a.id) })) });
  if (method === 'POST' && /^\/upi\/apps\/.+\/connect$/.test(path)) { const id = path.split('/')[3]; state.upiConnected.add(id); return json(200, { ...UPI_APPS.find((a) => a.id === id), connected: true }); }
  if (method === 'POST' && /^\/upi\/apps\/.+\/disconnect$/.test(path)) { const id = path.split('/')[3]; state.upiConnected.delete(id); return json(200, { ...UPI_APPS.find((a) => a.id === id), connected: false }); }
  if (method === 'GET' && path === '/upi/transactions') return json(200, { transactions: [...state.upiConnected].flatMap(upiTx) });
  if (method === 'GET' && path === '/upi/summary') {
    const txs = [...state.upiConnected].flatMap(upiTx);
    return json(200, { connectedApps: state.upiConnected.size, transactions: txs.length, totalSpent: txs.filter((t) => t.direction === 'DEBIT').reduce((s, t) => s + t.amount, 0), totalReceived: txs.filter((t) => t.direction === 'CREDIT').reduce((s, t) => s + t.amount, 0) });
  }
  if (method === 'POST' && path === '/upi/sync') {
    const toSync = [...state.upiConnected].filter((id) => !state.upiSynced.has(id));
    toSync.forEach((id) => state.upiSynced.add(id));
    return json(200, { syncedApps: toSync, transactionsAdded: toSync.length * 6 });
  }
  throw new Error(`Unhandled fetch in test: ${method} ${path}`);
};

const container = document.getElementById('root');
const root = createRoot(container);
let checks = 0;
const check = (v, m) => { assert.ok(v, m); checks++; };
const click = async (text) => {
  const b = [...container.querySelectorAll('button')].find((b) => b.textContent.includes(text));
  assert.ok(b, `button containing "${text}"`);
  await act(async () => b.click());
};
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

try {
  const { default: FinancialConnections } = await vite.ssrLoadModule('/src/pages/FinancialConnections.jsx');
  await act(async () => { root.render(React.createElement(FinancialConnections)); });
  await flush();

  check(container.textContent.includes('Financial Connections'), 'page renders its title');
  check(container.textContent.includes('Connect your finances'), 'the simplified landing copy is shown');
  check(container.textContent.includes('Demo environment') && container.textContent.includes('Synthetic financial data'), 'the short, unobtrusive synthetic-data disclosure is always visible');
  check(!container.textContent.includes('ReBIT'), 'implementation terminology is not shown prominently on the normal page');
  check(container.textContent.includes('Bank Accounts') && container.textContent.includes('UPI'), 'the two plain connection cards are shown');
  check([...container.querySelectorAll('h3')].filter((h) => h.textContent === 'Bank Accounts' || h.textContent === 'UPI').length === 2, 'Bank Accounts and UPI are each a plain card title');
  const cardText = () => container.querySelector('.grid').textContent;
  check(cardText().includes('Not connected yet'), 'both cards start as not connected, with no AA/UPI lifecycle terminology on the landing page');

  // ── Account Aggregator flow ──────────────────────────────────────────────
  await click('Manage accounts');
  check(container.textContent.includes('Connect Financial Accounts'), 'AA panel opens');
  await act(async () => {
    const panInput = container.querySelector('#aa-pan');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(panInput, 'DEMO-PAN-001');
    panInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  await flush();
  check(container.textContent.includes('PAN verified'), 'PAN verification success is shown');
  check(container.querySelectorAll('input[type=checkbox]').length === 10, 'all 10 discovered accounts are listed with checkboxes');
  check([...container.querySelectorAll('input[type=checkbox]')].every((c) => c.checked), 'every account starts selected');

  await click('Deselect');
  check([...container.querySelectorAll('input[type=checkbox]')].every((c) => !c.checked), 'Deselect clears every selection');
  await act(async () => container.querySelectorAll('input[type=checkbox]')[0].click());
  await act(async () => container.querySelectorAll('input[type=checkbox]')[1].click());
  check(container.textContent.includes('2 of 10 selected'), 'the selected count reflects individual toggles');

  await click('Continue');
  await flush();
  check(container.textContent.includes('Account Aggregator Consent'), 'consent review screen is shown');
  check(container.textContent.includes('Selected accounts'), 'consent shows the selected-accounts summary');
  check(state.consents.get('consent-1').accountIds.length === 2, 'the server received exactly the 2 selected account ids');

  await click('Approve Consent');
  await flush();
  check(container.textContent.includes('Accounts connected'), 'connect flow reaches the connected confirmation');
  check(container.textContent.includes('16 synthetic transactions'), 'the number of inserted transactions is shown to the user');

  await click('Done');
  check(!container.textContent.includes('Connect Financial Accounts'), 'closing the AA panel hides it');
  await flush();
  check(cardText().includes('2 connected'), 'the Bank Accounts card plainly shows the connected count, with no AA terminology');

  // ── UPI flow ───────────────────────────────────────────────────────────────
  await click('Manage UPI');
  check(container.textContent.includes('UPI Connections'), 'UPI panel opens');
  await flush();
  check(container.textContent.includes('Google Pay') && container.textContent.includes('PhonePe') && container.textContent.includes('Paytm') && container.textContent.includes('BHIM'), 'all 4 demo UPI apps are listed');

  const gpayConnectButtons = () => [...container.querySelectorAll('button')].filter((b) => b.textContent.includes('Connect') && !b.textContent.includes('Disconnect'));
  await act(async () => gpayConnectButtons()[0].click());
  await flush();
  check(container.textContent.includes('UPI Activity'), 'connecting an app reveals the UPI activity summary');
  check(container.textContent.includes('Connected Apps'), 'summary tiles are shown');

  await click('Synchronize');
  await flush();
  check(container.textContent.includes('Synchronized 6 UPI transaction'), 'sync reports how many transactions were added');
  check(cardText().includes('1 app connected'), 'the UPI card plainly shows the connected app count, with no UPI lifecycle terminology');

  console.log(`Financial Connections UI: ${checks} checks passed`);
} finally {
  await act(async () => root.unmount());
  await vite.close();
  dom.window.close();
  delete globalThis.__fcAuth;
}
