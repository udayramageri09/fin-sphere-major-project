/* eslint-disable no-undef */
// AccountAggregatorProvider adapter boundary (Issue: local AA simulator).
//
// FinSphere's financial-connections routes (see financialConnections.js) talk only to this
// interface, never directly to a provider's HTTP API. Today the only implementation is
// LocalAaSimulatorProvider, which calls the synthetic aa_simulator/ service over HTTP. A future
// real provider (e.g. an actual ReBIT-compliant Account Aggregator such as Finvu) would be added
// as a second class implementing the same five-method shape below and selected by
// createAaProvider(); FinSphere's routes and normalization logic would not change at all.
//
// Provider contract (every method is async and throws AaProviderError on failure):
//   verifyPan(aaId, pan)              -> { panStatus, maskedPan }
//   getPanStatus(aaId)                -> { panStatus, maskedPan }
//   discoverAccounts(aaId)            -> { accounts: [...] }
//   createConsent(aaId, { purpose, accountIds, dateRange }) -> consent
//   getConsent(consentId)             -> consent
//   approveConsent(consentId)         -> consent
//   rejectConsent(consentId)          -> consent
//   createFiRequest(consentId, accountIds) -> fiRequest
//   getFiRequestStatus(fiRequestId)   -> { status }
//   getFiRequestData(fiRequestId)     -> { accounts, transactions }

export class AaProviderError extends Error {
  constructor(message, { status = 502 } = {}) {
    super(message);
    this.name = 'AaProviderError';
    this.status = status;
  }
}

async function call(baseUrl, method, path, body) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new AaProviderError('Could not reach the Account Aggregator simulator. Is it running (npm run start --prefix aa_simulator)?', { status: 503 });
  }
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new AaProviderError(data?.error || 'Account Aggregator simulator request failed', { status: res.status });
  return data;
}

// Wraps the local synthetic simulator (aa_simulator/). This is NOT a certified Account
// Aggregator, a real bank connection, or a real PAN verification service - see aa_simulator/README.md.
export function createLocalAaProvider({ baseUrl } = {}) {
  const base = baseUrl || process.env.AA_SIMULATOR_URL || 'http://localhost:7100';
  return {
    providerName: 'local-simulator',
    verifyPan: (aaId, pan) => call(base, 'POST', '/v1/pan/verify', { aaId, pan }),
    getPanStatus: (aaId) => call(base, 'GET', `/v1/pan/${encodeURIComponent(aaId)}`),
    discoverAccounts: (aaId) => call(base, 'GET', `/v1/customers/${encodeURIComponent(aaId)}/accounts`),
    createConsent: (aaId, { purpose, accountIds, dateRange } = {}) =>
      call(base, 'POST', '/v1/consents', { aaId, purpose, accountIds, dateRange }),
    getConsent: (consentId) => call(base, 'GET', `/v1/consents/${encodeURIComponent(consentId)}`),
    approveConsent: (consentId) => call(base, 'POST', `/v1/consents/${encodeURIComponent(consentId)}/approve`),
    rejectConsent: (consentId) => call(base, 'POST', `/v1/consents/${encodeURIComponent(consentId)}/reject`),
    createFiRequest: (consentId, accountIds) => call(base, 'POST', '/v1/fi-requests', { consentId, accountIds }),
    getFiRequestStatus: (fiRequestId) => call(base, 'GET', `/v1/fi-requests/${encodeURIComponent(fiRequestId)}/status`),
    getFiRequestData: (fiRequestId) => call(base, 'GET', `/v1/fi-requests/${encodeURIComponent(fiRequestId)}/data`)
  };
}

// Selects a provider by AA_PROVIDER (default/only supported value today: "local"). This is the
// single place a future real provider would be wired in.
//
// Production safety boundary: the local simulator fabricates synthetic bank/UPI data under real
// institution names (HDFC, SBI, ICICI, ...). Running it in a real production deployment without
// an explicit, conscious opt-in would let FinSphere present synthetic financial connections as if
// they were real ones. So a production start-up refuses to use it unless
// AA_ALLOW_LOCAL_SIMULATOR_IN_PRODUCTION=true is set - the moment a real, certified provider is
// implemented here (a different providerName), this check no longer applies to it at all.
export function createAaProvider(env = process.env) {
  const kind = env.AA_PROVIDER || 'local';
  if (kind !== 'local') {
    throw new Error(`Unknown AA_PROVIDER "${kind}". Only "local" (the synthetic simulator) is implemented.`);
  }
  const provider = createLocalAaProvider({ baseUrl: env.AA_SIMULATOR_URL });
  if (env.NODE_ENV === 'production' && provider.providerName === 'local-simulator' && env.AA_ALLOW_LOCAL_SIMULATOR_IN_PRODUCTION !== 'true') {
    throw new Error(
      'Refusing to start in production with the synthetic local Account Aggregator simulator (it would present fabricated bank/UPI data as if real). ' +
      'Configure a real AA_PROVIDER, or set AA_ALLOW_LOCAL_SIMULATOR_IN_PRODUCTION=true only if this production deployment is intentionally running on synthetic data.'
    );
  }
  return provider;
}
