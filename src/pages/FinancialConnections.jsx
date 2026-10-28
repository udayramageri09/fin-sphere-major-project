import { useEffect, useRef, useState } from 'react';
import {
  Landmark, Smartphone, ShieldCheck, CheckCircle2, AlertCircle, Loader2,
  ChevronRight, ChevronLeft, X, Link2, Unlink
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useGuardedFetch } from '../hooks/useGuardedFetch';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api';

const money = (n) => Number(n).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inputClass = 'w-full px-3 py-2 rounded-xl border border-zinc-200 bg-white text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/20';
const labelClass = 'text-xs font-medium text-zinc-500';
const primaryBtn = 'inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed';
const secondaryBtn = 'inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-zinc-700 border border-zinc-200 bg-white hover:bg-zinc-100 disabled:opacity-60 disabled:cursor-not-allowed';

function ErrorBox({ message }) {
  if (!message) return null;
  return (
    <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-xl bg-zinc-100 border border-zinc-200 text-sm text-zinc-700">
      <AlertCircle size={16} className="mt-0.5 shrink-0 text-zinc-500" />
      <span className="min-w-0 wrap-break-word">{message}</span>
    </div>
  );
}

function StepDots({ step, steps }) {
  const index = steps.indexOf(step);
  return (
    <div className="flex items-center gap-1.5 mb-4" aria-hidden="true">
      {steps.map((s, i) => (
        <span key={s} className={`h-1.5 rounded-full transition-all ${i <= index ? 'bg-zinc-900 w-6' : 'bg-zinc-200 w-3'}`} />
      ))}
    </div>
  );
}

// A plain settings-style summary card. No AA/UPI lifecycle terminology here by design - that
// detail lives inside the connection flow it opens, where it actually helps the user.
function ConnectionCard({ icon: Icon, title, loading, summary, buttonLabel, onManage }) {
  return (
    <div className="glass-panel p-6 flex flex-col gap-4 min-w-0">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-zinc-100 text-zinc-700 shrink-0"><Icon size={22} /></div>
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-zinc-900">{title}</h3>
          <p className="text-sm text-zinc-500">{loading ? 'Loading…' : summary}</p>
        </div>
      </div>
      <button type="button" onClick={onManage} className={`${secondaryBtn} self-start`}>
        {buttonLabel} <ChevronRight size={16} />
      </button>
    </div>
  );
}

function FinancialConnections() {
  const { invalidateSession } = useAuth();
  const guardedFetch = useGuardedFetch();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState('');

  // Used by action handlers (never from an effect directly - see the mount effect below, which
  // inlines its own fetch instead, following React's own guidance for data fetching in effects).
  const loadStatus = async () => {
    try {
      const data = await request('GET', '/aa/status');
      if (mounted.current) { setStatus(data); setStatusError(''); }
    } catch (e) { if (mounted.current) setStatusError(e.message); }
    finally { if (mounted.current) setStatusLoading(false); }
  };
  const retryStatus = () => { setStatusLoading(true); setStatusError(''); loadStatus(); };

  // All requests go through FinSphere's own authenticated API - never directly to the simulator.
  async function request(method, path, body) {
    const res = await guardedFetch(`${API}${path}`, {
      method, credentials: 'include', headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    if (res.status === 401) { invalidateSession(); throw new Error('Your session ended. Sign in again.'); }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'Something went wrong. Please try again.');
    return data;
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await request('GET', '/aa/status');
        if (!cancelled) { setStatus(data); setStatusError(''); }
      } catch (e) { if (!cancelled) setStatusError(e.message); }
      finally { if (!cancelled) setStatusLoading(false); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `request` is redefined every render but only closes over stable (hook-provided) references; adding it here would re-run this effect on every render for no benefit.
  }, []);

  // ── Account Aggregator flow ────────────────────────────────────────────
  const AA_STEPS = ['pan', 'accounts', 'consent', 'processing', 'connected'];
  const [aaOpen, setAaOpen] = useState(false);
  const [aaStep, setAaStep] = useState('pan');
  const [aaBusy, setAaBusy] = useState(false);
  const [aaError, setAaError] = useState('');
  const [pan, setPan] = useState('DEMO-PAN-001');
  const [maskedPan, setMaskedPan] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [consent, setConsent] = useState(null);
  const [fiRequest, setFiRequest] = useState(null);
  const [connectResult, setConnectResult] = useState(null);

  const openAa = () => {
    setAaOpen(true); setAaStep('pan'); setAaError(''); setConsent(null); setFiRequest(null); setConnectResult(null);
  };
  const closeAa = () => setAaOpen(false);

  const submitPan = async (e) => {
    e.preventDefault();
    setAaBusy(true); setAaError('');
    try {
      const result = await request('POST', '/aa/pan/verify', { pan });
      if (!mounted.current) return;
      setMaskedPan(result.maskedPan);
      setAaStep('accounts');
      const found = await request('GET', '/aa/accounts');
      if (!mounted.current) return;
      setAccounts(found.accounts);
      setSelected(new Set(found.accounts.map((a) => a.accountId)));
    } catch (e) { if (mounted.current) setAaError(e.message); }
    finally { if (mounted.current) setAaBusy(false); }
  };

  const toggleAccount = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAll = () => setSelected(new Set(accounts.map((a) => a.accountId)));
  const deselectAll = () => setSelected(new Set());

  const continueToConsent = async () => {
    setAaBusy(true); setAaError('');
    try {
      const created = await request('POST', '/aa/consents', { accountIds: [...selected] });
      if (mounted.current) { setConsent(created); setAaStep('consent'); }
    } catch (e) { if (mounted.current) setAaError(e.message); }
    finally { if (mounted.current) setAaBusy(false); }
  };

  const approveConsent = async () => {
    setAaBusy(true); setAaError('');
    try {
      const approved = await request('POST', `/aa/consents/${consent.consentId}/approve`);
      if (!mounted.current) return;
      setConsent(approved);
      setAaStep('processing');
      const created = await request('POST', '/aa/fi-requests', { consentId: approved.consentId });
      if (!mounted.current) return;
      setFiRequest(created);
      const connected = await request('POST', `/aa/fi-requests/${created.fiRequestId}/connect`);
      if (!mounted.current) return;
      setConnectResult(connected);
      setAaStep('connected');
      loadStatus();
    } catch (e) { if (mounted.current) { setAaError(e.message); setAaStep('consent'); } }
    finally { if (mounted.current) setAaBusy(false); }
  };

  const rejectConsent = async () => {
    setAaBusy(true); setAaError('');
    try {
      const rejected = await request('POST', `/aa/consents/${consent.consentId}/reject`);
      if (mounted.current) setConsent(rejected);
    } catch (e) { if (mounted.current) setAaError(e.message); }
    finally { if (mounted.current) setAaBusy(false); }
  };

  // ── UPI flow ─────────────────────────────────────────────────────────────
  const [upiOpen, setUpiOpen] = useState(false);
  const [upiApps, setUpiApps] = useState([]);
  const [upiLoading, setUpiLoading] = useState(true);
  const [upiError, setUpiError] = useState('');
  const [upiBusyApp, setUpiBusyApp] = useState(null);
  const [upiTransactions, setUpiTransactions] = useState([]);
  const [upiSummary, setUpiSummary] = useState(null);
  const [upiSyncing, setUpiSyncing] = useState(false);
  const [upiNotice, setUpiNotice] = useState('');

  const loadUpi = async () => {
    setUpiLoading(true); setUpiError('');
    try {
      const [appsRes, txRes, summaryRes] = await Promise.all([
        request('GET', '/upi/apps'), request('GET', '/upi/transactions'), request('GET', '/upi/summary')
      ]);
      if (!mounted.current) return;
      setUpiApps(appsRes.apps); setUpiTransactions(txRes.transactions); setUpiSummary(summaryRes);
    } catch (e) { if (mounted.current) setUpiError(e.message); }
    finally { if (mounted.current) setUpiLoading(false); }
  };

  const openUpi = () => { setUpiOpen(true); setUpiNotice(''); loadUpi(); };
  const closeUpi = () => setUpiOpen(false);

  const toggleUpiApp = async (app) => {
    setUpiBusyApp(app.id); setUpiError('');
    try {
      await request('POST', `/upi/apps/${app.id}/${app.connected ? 'disconnect' : 'connect'}`);
      await loadUpi();
    } catch (e) { if (mounted.current) setUpiError(e.message); }
    finally { if (mounted.current) setUpiBusyApp(null); }
  };

  const syncUpi = async () => {
    setUpiSyncing(true); setUpiError(''); setUpiNotice('');
    try {
      const result = await request('POST', '/upi/sync');
      setUpiNotice(result.transactionsAdded > 0
        ? `Synchronized ${result.transactionsAdded} UPI transaction${result.transactionsAdded === 1 ? '' : 's'} into your FinSphere transactions.`
        : 'Already up to date - nothing new to synchronize.');
      loadStatus();
    } catch (e) { if (mounted.current) setUpiError(e.message); }
    finally { if (mounted.current) setUpiSyncing(false); }
  };

  const connectedUpiCount = upiApps.filter((a) => a.connected).length;

  return (
    <div className="animate-fade-in">
      <h2 style={{ fontSize: '2rem' }}>Financial Connections</h2>
      <p className="text-sm text-zinc-500 mt-1 mb-1 max-w-2xl">Connect your finances</p>
      <p className="text-sm text-zinc-500 mb-4 max-w-2xl">Bring your accounts and UPI activity into FinSphere.</p>

      {statusError && (
        <div className="mb-6 max-w-2xl flex flex-col items-start gap-2">
          <ErrorBox message={statusError} />
          <button type="button" onClick={retryStatus} className={secondaryBtn}>Retry</button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-4">
        <ConnectionCard
          icon={Landmark}
          title="Bank Accounts"
          loading={statusLoading}
          summary={status?.connectedAccounts > 0 ? `${status.connectedAccounts} connected` : 'Not connected yet'}
          buttonLabel="Manage accounts"
          onManage={openAa}
        />
        <ConnectionCard
          icon={Smartphone}
          title="UPI"
          loading={statusLoading}
          summary={status?.upiConnectedApps > 0 ? `${status.upiConnectedApps} app${status.upiConnectedApps === 1 ? '' : 's'} connected` : 'Not connected yet'}
          buttonLabel="Manage UPI"
          onManage={openUpi}
        />
      </div>

      <p className="text-xs text-zinc-400 mb-6">Demo environment · Synthetic financial data</p>

      {/* ── AA flow panel ────────────────────────────────────────────────── */}
      {aaOpen && (
        <div className="glass-panel p-6 mb-6 max-w-2xl flex flex-col gap-4" role="region" aria-label="Account Aggregator connection">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-zinc-900">Connect Financial Accounts</h3>
            <button type="button" onClick={closeAa} aria-label="Close" className="p-1.5 rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"><X size={16} /></button>
          </div>
          {aaStep !== 'connected' && <StepDots step={aaStep} steps={AA_STEPS} />}

          {aaStep === 'pan' && (
            <form onSubmit={submitPan} className="flex flex-col gap-3">
              <p className="text-sm text-zinc-500">Enter your PAN to simulate verification through FinSphere's local Account Aggregator.</p>
              <div className="flex flex-col gap-1">
                <label htmlFor="aa-pan" className={labelClass}>PAN (demo)</label>
                <input id="aa-pan" type="text" required value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} className={inputClass} placeholder="DEMO-PAN-001" />
                <span className="text-xs text-zinc-400">Use a demo token like DEMO-PAN-001, or any 10-character synthetic PAN (e.g. ABCDE1234F). Never enter a real PAN.</span>
              </div>
              {aaError && <ErrorBox message={aaError} />}
              <button type="submit" disabled={aaBusy} className={`${primaryBtn} self-start`}>
                {aaBusy ? <><Loader2 size={16} className="animate-spin" /> Verifying...</> : 'Continue'}
              </button>
            </form>
          )}

          {aaStep === 'accounts' && (
            accounts.length === 0 ? (
              <p className="text-sm text-zinc-500 flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Finding financial accounts...</p>
            ) : (
              <div className="flex flex-col gap-3">
                {maskedPan && <p className="text-xs text-zinc-500 flex items-center gap-1.5"><ShieldCheck size={14} className="text-zinc-700" /> PAN verified · {maskedPan}</p>}
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-600">{selected.size} of {accounts.length} selected</span>
                  <div className="flex gap-2">
                    <button type="button" onClick={selectAll} className="text-xs font-semibold text-zinc-700 hover:underline">Select all</button>
                    <button type="button" onClick={deselectAll} className="text-xs font-semibold text-zinc-700 hover:underline">Deselect</button>
                  </div>
                </div>
                <ul className="flex flex-col gap-2 max-h-80 overflow-y-auto pr-1">
                  {accounts.map((a) => (
                    <li key={a.accountId}>
                      <label className="flex items-center gap-3 p-3 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 cursor-pointer">
                        <input type="checkbox" checked={selected.has(a.accountId)} onChange={() => toggleAccount(a.accountId)} className="h-4 w-4 accent-zinc-900" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-zinc-900">{a.institution}</div>
                          <div className="text-xs text-zinc-500">{a.accountType.replace('-', ' ')} · {a.maskedAccountNumber}</div>
                        </div>
                        <div className="text-sm font-semibold text-zinc-900 shrink-0">{money(a.balance)}</div>
                      </label>
                    </li>
                  ))}
                </ul>
                {aaError && <ErrorBox message={aaError} />}
                <div className="flex gap-2">
                  <button type="button" onClick={continueToConsent} disabled={aaBusy || selected.size === 0} className={primaryBtn}>
                    {aaBusy ? <><Loader2 size={16} className="animate-spin" /> Continuing...</> : <>Continue <ChevronRight size={16} /></>}
                  </button>
                  <button type="button" onClick={() => setAaStep('pan')} className={secondaryBtn}><ChevronLeft size={16} /> Back</button>
                </div>
              </div>
            )
          )}

          {aaStep === 'consent' && consent && (
            <div className="flex flex-col gap-3">
              <h4 className="text-base font-semibold text-zinc-900">Account Aggregator Consent</h4>
              <p className="text-sm text-zinc-600">FinSphere is requesting access to:</p>
              <ul className="text-sm text-zinc-700 flex flex-col gap-1 pl-1">
                {consent.dataTypes.map((t) => (
                  <li key={t} className="flex items-center gap-2"><CheckCircle2 size={14} className="text-zinc-700" /> {t === 'PROFILE' ? 'Account profile' : t === 'SUMMARY' ? 'Account summary' : 'Transaction history'}</li>
                ))}
              </ul>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-zinc-500 block text-xs">Purpose</span><span className="text-zinc-900">{consent.purpose}</span></div>
                <div><span className="text-zinc-500 block text-xs">Date range</span><span className="text-zinc-900">{consent.dateRange.from} to {consent.dateRange.to}</span></div>
                <div><span className="text-zinc-500 block text-xs">Selected accounts</span><span className="text-zinc-900">{consent.accountIds.length}</span></div>
                <div><span className="text-zinc-500 block text-xs">Status</span><span className="text-zinc-900">{consent.status}</span></div>
              </div>
              <p className="text-xs text-zinc-400">Consent ID {consent.consentId}</p>
              {aaError && <ErrorBox message={aaError} />}
              {consent.status === 'PENDING' && (
                <div className="flex gap-2">
                  <button type="button" onClick={approveConsent} disabled={aaBusy} className={primaryBtn}>
                    {aaBusy ? <><Loader2 size={16} className="animate-spin" /> Processing...</> : 'Approve Consent'}
                  </button>
                  <button type="button" onClick={rejectConsent} disabled={aaBusy} className={secondaryBtn}>Reject</button>
                </div>
              )}
              {consent.status === 'REJECTED' && <p className="text-sm text-zinc-500">Consent rejected. No data was requested.</p>}
            </div>
          )}

          {aaStep === 'processing' && (
            <div className="flex flex-col items-start gap-2 text-sm text-zinc-600">
              <p className="flex items-center gap-2"><CheckCircle2 size={16} className="text-zinc-900" /> Consent approved</p>
              <p className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Requesting financial information...</p>
            </div>
          )}

          {aaStep === 'connected' && connectResult && (
            <div className="flex flex-col gap-3">
              <p className="flex items-center gap-2 text-sm font-medium text-zinc-900"><CheckCircle2 size={18} className="text-zinc-900" /> Accounts connected</p>
              <p className="text-sm text-zinc-600">
                {connectResult.alreadyConnected
                  ? 'This financial data was already synchronized into your FinSphere transactions.'
                  : `${connectResult.transactionsAdded} synthetic transactions were added to your FinSphere transactions.`}
              </p>
              {fiRequest && <p className="text-xs text-zinc-400">FI Request ID {fiRequest.fiRequestId}</p>}
              <button type="button" onClick={closeAa} className={`${secondaryBtn} self-start`}>Done</button>
            </div>
          )}
        </div>
      )}

      {/* ── UPI flow panel ───────────────────────────────────────────────── */}
      {upiOpen && (
        <div className="glass-panel p-6 mb-6 max-w-2xl flex flex-col gap-4" role="region" aria-label="UPI connections">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-zinc-900">UPI Connections</h3>
            <button type="button" onClick={closeUpi} aria-label="Close" className="p-1.5 rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"><X size={16} /></button>
          </div>
          <p className="text-xs text-zinc-500">Demo UPI connection. Synthetic transactions only - this never calls a real Google Pay, PhonePe, Paytm or BHIM API.</p>

          {upiLoading ? (
            <p className="text-sm text-zinc-500 flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Loading UPI apps...</p>
          ) : upiError && upiApps.length === 0 ? (
            <div className="flex flex-col items-start gap-2">
              <ErrorBox message={upiError} />
              <button type="button" onClick={loadUpi} className={secondaryBtn}>Retry</button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {upiApps.map((app) => (
                  <div key={app.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-zinc-200 bg-white">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-zinc-900">{app.name}</div>
                      <div className="text-xs text-zinc-500 wrap-break-word">{app.handle}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleUpiApp(app)}
                      disabled={upiBusyApp === app.id}
                      className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-60 ${app.connected ? 'text-zinc-700 border border-zinc-200 bg-white hover:bg-zinc-100' : 'bg-zinc-900 text-white hover:bg-zinc-800'}`}
                    >
                      {upiBusyApp === app.id ? <Loader2 size={14} className="animate-spin" /> : app.connected ? <Unlink size={14} /> : <Link2 size={14} />}
                      {app.connected ? 'Disconnect' : 'Connect'}
                    </button>
                  </div>
                ))}
              </div>

              {upiError && <ErrorBox message={upiError} />}

              {connectedUpiCount > 0 && (
                <div className="flex flex-col gap-3 pt-3 border-t border-zinc-100">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-zinc-900">UPI Activity</h4>
                    <button type="button" onClick={syncUpi} disabled={upiSyncing} className={secondaryBtn}>
                      {upiSyncing ? <><Loader2 size={14} className="animate-spin" /> Synchronizing...</> : 'Synchronize'}
                    </button>
                  </div>
                  {upiNotice && <p className="text-xs text-zinc-500">{upiNotice}</p>}
                  {upiSummary && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div><span className="text-zinc-500 block text-xs">Connected Apps</span><strong className="text-zinc-900">{upiSummary.connectedApps}</strong></div>
                      <div><span className="text-zinc-500 block text-xs">Transactions</span><strong className="text-zinc-900">{upiSummary.transactions}</strong></div>
                      <div><span className="text-zinc-500 block text-xs">Total Spent</span><strong className="text-zinc-900">{money(upiSummary.totalSpent)}</strong></div>
                      <div><span className="text-zinc-500 block text-xs">Total Received</span><strong className="text-zinc-900">{money(upiSummary.totalReceived)}</strong></div>
                    </div>
                  )}
                  {upiTransactions.length === 0 ? (
                    <p className="text-sm text-zinc-500">No UPI transactions yet.</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-zinc-100 max-h-72 overflow-y-auto">
                      {upiTransactions.map((t) => (
                        <li key={t.transactionId} className="flex items-center justify-between gap-3 py-2 text-sm">
                          <div className="min-w-0">
                            <div className="text-zinc-900 font-medium wrap-break-word">{t.merchant}</div>
                            <div className="text-xs text-zinc-500">{t.appName} · {t.date}</div>
                          </div>
                          <span className={`shrink-0 font-semibold ${t.direction === 'CREDIT' ? 'text-zinc-900' : 'text-zinc-700'}`}>
                            {t.direction === 'CREDIT' ? '+' : '-'}{money(t.amount)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default FinancialConnections;
