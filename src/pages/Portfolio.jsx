import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useGuardedFetch } from '../hooks/useGuardedFetch';
import { localDateString } from '../utils/localDate';
import { colorFor } from '../utils/categoryColors';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api';
const CLASSES = ['Stocks', 'Mutual funds', 'Bonds', 'Deposits', 'Gold', 'Other'];
const money = n => (n / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
const blank = () => ({ name: '', assetClass: 'Stocks', invested: '', current: '', valuedOn: localDateString() });
const inputClass = 'w-full rounded-lg border border-zinc-300 bg-white p-3 text-zinc-900';
const buttonClass = 'rounded-lg bg-zinc-900 text-white px-4 py-3 font-semibold disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-blue-600';
const panel = 'glass-panel p-5 sm:p-6 min-w-0';

// Decimal text is converted exactly once; zero is an explicit valuation, never a missing value.
function amountPaise(value) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(n) && n <= 1e12 ? n : null;
}

function Portfolio() {
  const { invalidateSession } = useAuth();
  const guardedFetch = useGuardedFetch();   // names the account this tab shows; a refusal re-checks the session
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null); // null = closed; 'new' = create
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(null);
  const lock = useRef(false);
  const nameRef = useRef(null);
  const addRef = useRef(null);
  const mounted = useRef(false);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (editing !== null) nameRef.current?.focus(); }, [editing]);
  useEffect(() => { if (!busy && editing === null && notice) addRef.current?.focus(); }, [busy, editing, notice]);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await guardedFetch(`${API}/holdings`, { credentials: 'include' });
        if (cancelled) return;
        if (res.status === 401) { setHoldings([]); invalidateSession(); return; }
        if (!res.ok) throw new Error('Could not load your holdings. Try again.');
        const rows = await res.json();
        if (!cancelled) { setHoldings(rows); setLoadError(''); }
      } catch (e) { if (!cancelled) setLoadError(e.message); }
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [invalidateSession, guardedFetch]);

  const request = async (method, id, body) => {
    const res = await guardedFetch(`${API}/holdings${id ? `/${id}` : ''}`, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (res.status === 401) { setHoldings([]); invalidateSession(); throw new Error('Your session ended. Sign in again.'); }
    if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Could not save your changes.'); }
    return res.status === 204 ? null : res.json();
  };
  const close = () => { setEditing(null); setError(''); addRef.current?.focus(); };
  const open = h => {
    setRemoving(null); setError(''); setNotice('');
    setEditing(h?.id ?? 'new');
    setForm(h ? { name: h.name, assetClass: h.assetClass, invested: (h.investedPaise / 100).toFixed(2), current: (h.currentPaise / 100).toFixed(2), valuedOn: h.valuedOn } : blank());
  };
  const submit = async e => {
    e.preventDefault();
    if (lock.current) return;
    const investedPaise = amountPaise(form.invested), currentPaise = amountPaise(form.current);
    if (investedPaise === null || currentPaise === null) { setError('Enter nonnegative amounts with up to two decimal places (maximum ₹10,00,00,00,000).'); return; }
    lock.current = true; setBusy(true); setError('');
    try {
      const row = await request(editing === 'new' ? 'POST' : 'PUT', editing === 'new' ? null : editing, { name: form.name, assetClass: form.assetClass, investedPaise, currentPaise, valuedOn: form.valuedOn });
      if (!mounted.current) return;
      setHoldings(old => editing === 'new' ? [...old, row] : old.map(h => h.id === row.id ? row : h));
      close(); setNotice('Holding saved. Portfolio totals updated.');
    } catch (e) { if (mounted.current) setError(e.message); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const remove = async id => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      await request('DELETE', id);
      if (!mounted.current) return;
      setHoldings(old => old.filter(h => h.id !== id)); setRemoving(null); setNotice('Holding deleted. Portfolio totals updated.'); addRef.current?.focus();
    } catch (e) { if (mounted.current) setError(e.message); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const invested = holdings.reduce((s, h) => s + h.investedPaise, 0);
  const current = holdings.reduce((s, h) => s + h.currentPaise, 0);
  const allocation = CLASSES.map(name => ({ name, value: holdings.filter(h => h.assetClass === name).reduce((s, h) => s + h.currentPaise, 0) })).filter(a => a.value > 0);
  const update = e => setForm(old => ({ ...old, [e.target.name]: e.target.value }));

  return <div className="animate-fade-in space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-3xl font-bold tracking-tight">Your Portfolio</h2><p className="text-zinc-600 mt-2">The investments you record, valued by you in INR.</p></div>
      <button ref={addRef} className={buttonClass} onClick={() => open(null)} disabled={loading || !!loadError || busy}>Add holding</button>
    </header>
    <p role="status" className="text-sm text-teal-800">{notice}</p>
    {loading ? <p role="status">Loading your holdings…</p> : loadError ? <div role="alert" className={panel}><p>{loadError}</p><button className={buttonClass} onClick={() => window.location.reload()}>Retry</button></div> : <>
      {holdings.length === 0 ? <section className={panel}><h3 className="text-xl font-bold">No investment holdings yet</h3><p className="text-zinc-600 mt-2">Add an investment with its invested amount and latest value to see your portfolio. Bank statement imports do not create holdings.</p></section> : <>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[['Invested amount', money(invested)], ['Recorded current value', money(current)], ['Unrealised gain / loss', money(current - invested)]].map(([label, value]) => <div key={label} className={panel}><dt className="text-sm text-zinc-600">{label}</dt><dd className="text-2xl font-bold mt-2 break-words">{value}</dd></div>)}
        </dl>
        <p className="text-sm text-zinc-600">Manual valuations, not live market prices. Gain / loss is recorded value minus invested amount; it excludes realised proceeds, dividends, fees and taxes. Valuation dates may differ between holdings.</p>
        <section className={panel} aria-labelledby="allocation-title">
          <h3 id="allocation-title" className="text-xl font-bold mb-4">Asset allocation</h3>
          {current === 0 ? <p>All recorded values are zero, so allocation percentages are unavailable.</p> : <ul className="space-y-4">{allocation.map(a => <li key={a.name}><div className="flex flex-wrap justify-between gap-2 text-sm mb-2"><strong>{a.name}</strong><span>{money(a.value)} · {(a.value / current * 100).toFixed(1)}%</span></div><div className="h-3 rounded-full bg-zinc-100" aria-hidden="true"><div className="h-3 rounded-full" style={{ width: `${a.value / current * 100}%`, background: colorFor(a.name) }} /></div></li>)}</ul>}
        </section>
        <section className={panel} aria-labelledby="holdings-title">
          <h3 id="holdings-title" className="text-xl font-bold mb-4">Your holdings</h3>
          <ul className="divide-y divide-zinc-200">{holdings.map(h => <li key={h.id} className="py-4 flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 break-words"><h4 className="font-semibold">{h.name}</h4><p className="text-sm text-zinc-600">{h.assetClass} · Valued {h.valuedOn}</p><p className="text-sm mt-1">Invested {money(h.investedPaise)} · Value {money(h.currentPaise)}</p></div>
            <div className="flex flex-wrap gap-2"><button className="rounded-lg border border-zinc-300 p-3" aria-label={`Edit ${h.name}`} onClick={() => open(h)} disabled={busy}>Edit</button><button className="rounded-lg border border-zinc-300 p-3" aria-label={`Delete ${h.name}`} onClick={() => { setEditing(null); setRemoving(h.id); setError(''); }} disabled={busy}>Delete</button></div>
            {removing === h.id && <div className="w-full rounded-lg bg-zinc-50 p-4"><p>Delete {h.name}? This removes this holding from your portfolio.</p><div className="flex gap-3 mt-3"><button className={buttonClass} disabled={busy} onClick={() => remove(h.id)}>Confirm deletion</button><button className="p-3" disabled={busy} onClick={() => setRemoving(null)}>Cancel deletion</button></div></div>}
          </li>)}</ul>
        </section>
      </>}
      {editing !== null && <section className={panel} aria-labelledby="holding-editor">
        <h3 id="holding-editor" className="text-xl font-bold mb-4">{editing === 'new' ? 'Add holding' : 'Edit holding'}</h3>
        <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="sm:col-span-2">Investment name<input ref={nameRef} className={inputClass} name="name" value={form.name} onChange={update} maxLength={100} required disabled={busy} /></label>
          <label>Asset class<select className={inputClass} name="assetClass" value={form.assetClass} onChange={update} disabled={busy}>{CLASSES.map(c => <option key={c}>{c}</option>)}</select></label>
          <label>Valuation date<input className={inputClass} type="date" name="valuedOn" value={form.valuedOn} onChange={update} min="1900-01-01" max={localDateString()} required disabled={busy} /></label>
          <label>Invested amount (INR)<input className={inputClass} inputMode="decimal" name="invested" value={form.invested} onChange={update} required disabled={busy} /></label>
          <label>Current value (INR)<input className={inputClass} inputMode="decimal" name="current" value={form.current} onChange={update} required disabled={busy} /></label>
          <p className="sm:col-span-2 text-sm text-zinc-600">Enter the total cost and latest total value for this position. Updating a value replaces the current record; it does not create performance history.</p>
          <div className="flex gap-3 sm:col-span-2"><button className={buttonClass} disabled={busy}>{busy ? 'Saving…' : 'Save holding'}</button><button type="button" className="p-3" onClick={close} disabled={busy}>Cancel</button></div>
        </form>
      </section>}
      {error && <p role="alert" className="text-red-800">{error}</p>}
      <section className={panel}><h3 className="font-semibold">Investment performance</h3><p className="text-sm text-zinc-600 mt-2">No investment valuation history available. Historical returns and growth cannot be calculated. Bank transactions and spending cash flow do not measure investment performance.</p></section>
    </>}
  </div>;
}
export default Portfolio;
