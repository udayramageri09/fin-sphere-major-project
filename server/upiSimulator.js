// Synthetic development data only. This is a local UPI connection simulator: it never calls a
// real Google Pay/PhonePe/Paytm/BHIM API and never claims to access a user's real UPI account.
// State lives in process memory, keyed by the authenticated FinSphere user id (see
// financialConnections.js), so it does not survive a server restart and never leaks between users.

// The handle is rendered directly in the Financial Connections UI, so it is a plain placeholder
// (never the literal word "demo"/"test"/"sample") - see src/pages/FinancialConnections.jsx.
export const UPI_APPS = [
  { id: 'gpay', name: 'Google Pay', handle: 'yourname@okaxis' },
  { id: 'phonepe', name: 'PhonePe', handle: 'yourname@ybl' },
  { id: 'paytm', name: 'Paytm', handle: 'yourname@paytm' },
  { id: 'bhim', name: 'BHIM', handle: 'yourname@upi' }
];

const MERCHANTS = ['Swiggy', 'Amazon', 'Uber', 'Bharat Petroleum', 'BookMyShow', 'BigBasket', 'Electricity Board', 'College Canteen'];
const AMOUNTS = [349, 799, 220, 1450, 299, 560, 1825, 120];

// Tiny deterministic PRNG so the same (userId, appId) always generates the same transactions.
function seededRandom(seedStr) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (Math.imul(31, h) + seedStr.charCodeAt(i)) | 0;
  let a = h;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ymdDaysAgo(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return d.toISOString().slice(0, 10);
}

// 6 transactions per connected app (24 total once all 4 apps are connected, matching the demo spec).
function generateTransactionsForApp(userId, app, count = 6) {
  const rng = seededRandom(`upi:${userId}:${app.id}`);
  const transactions = [];
  for (let i = 0; i < count; i++) {
    const direction = i % 5 === 0 ? 'CREDIT' : 'DEBIT';
    const amount = AMOUNTS[Math.floor(rng() * AMOUNTS.length)];
    const merchant = direction === 'CREDIT' ? 'Demo Refund' : MERCHANTS[Math.floor(rng() * MERCHANTS.length)];
    const daysAgo = Math.floor(rng() * 60); // within the last ~2 months, never in the future
    transactions.push({
      transactionId: `UPI-${app.id}-${userId}-${String(i + 1).padStart(3, '0')}`,
      appId: app.id,
      appName: app.name,
      upiId: app.handle,
      date: ymdDaysAgo(daysAgo),
      amount,
      direction,
      merchant,
      status: 'SUCCESS',
      source: 'UPI_SIMULATOR'
    });
  }
  return transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function createUpiSimulator() {
  const byUser = new Map(); // userId -> { connected: Set<appId>, transactions: Map<appId, tx[]>, synced: Set<appId> }

  function userState(userId) {
    let state = byUser.get(userId);
    if (!state) {
      state = { connected: new Set(), transactions: new Map(), synced: new Set() };
      byUser.set(userId, state);
    }
    return state;
  }

  function appById(appId) {
    return UPI_APPS.find((a) => a.id === appId) ?? null;
  }

  return {
    listApps(userId) {
      const state = userState(userId);
      return UPI_APPS.map((app) => ({ ...app, connected: state.connected.has(app.id) }));
    },
    connect(userId, appId) {
      const app = appById(appId);
      if (!app) return null;
      const state = userState(userId);
      state.connected.add(appId);
      if (!state.transactions.has(appId)) state.transactions.set(appId, generateTransactionsForApp(userId, app));
      return { ...app, connected: true };
    },
    disconnect(userId, appId) {
      const app = appById(appId);
      if (!app) return null;
      userState(userId).connected.delete(appId);
      return { ...app, connected: false };
    },
    isConnected(userId, appId) {
      return userState(userId).connected.has(appId);
    },
    transactions(userId) {
      const state = userState(userId);
      return [...state.connected]
        .flatMap((appId) => state.transactions.get(appId) ?? [])
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    },
    summary(userId) {
      const txs = this.transactions(userId);
      const totalSpent = txs.filter((t) => t.direction === 'DEBIT').reduce((sum, t) => sum + t.amount, 0);
      const totalReceived = txs.filter((t) => t.direction === 'CREDIT').reduce((sum, t) => sum + t.amount, 0);
      return { connectedApps: userState(userId).connected.size, transactions: txs.length, totalSpent, totalReceived };
    },
    // Idempotency for POST /api/upi/sync: each connected app's transactions are normalized into
    // FinSphere's real transaction table at most once per app per user (see financialConnections.js).
    markSynced(userId, appId) {
      userState(userId).synced.add(appId);
    },
    isSynced(userId, appId) {
      return userState(userId).synced.has(appId);
    }
  };
}
