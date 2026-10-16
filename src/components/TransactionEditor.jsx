import { useEffect, useRef, useState } from 'react';
import CategoryPicker from './CategoryPicker';
import { analyticalRole } from '../utils/finance';
import { normalizeMerchant } from '../utils/spendingAnalytics';
import { PRIORITIES, priorityFor, readPriorityPreferences, savePriorityPreference } from '../utils/spendingPriorities';
import './analytics/Analytics.css';

const CLASSIFICATIONS = { expense: ['expense', 'transfer', 'unknown'], income: ['income', 'refund', 'transfer', 'unknown'] };
const initialFields = t => ({ title: t.title, amount: String(Math.abs(t.amount)), date: String(t.date).slice(0, 10), type: t.type, category: t.category || 'General', classification: t.classification || 'unknown' });
export default function TransactionEditor({ transaction, choices, onSave }) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState(() => initialFields(transaction));
  const [priority, setPriority] = useState('');
  const [remember, setRemember] = useState(false);
  const [removeRule, setRemoveRule] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const opener = useRef(null), titleInput = useRef(null), inFlight = useRef(false);
  useEffect(() => { if (open) titleInput.current?.focus(); }, [open]);
  const close = () => { setOpen(false); setTimeout(() => opener.current?.focus(), 0); };
  const edit = () => {
    const prefs = readPriorityPreferences(transaction.userId);
    setFields(initialFields(transaction)); setPriority(Object.hasOwn(prefs.transactions ?? {}, String(transaction.id)) ? prefs.transactions[transaction.id] : '');
    setRemember(false); setRemoveRule(false); setError(''); setMessage(''); setOpen(true);
  };
  const field = (key, value) => setFields(previous => ({ ...previous, [key]: value }));
  const prefs = readPriorityPreferences(transaction.userId);
  const merchant = normalizeMerchant(fields.title).key;
  const isExpense = analyticalRole({ ...fields, amount: (fields.type === 'expense' ? -1 : 1) * Number(fields.amount) })?.role === 'spending';
  const automatic = priorityFor({ ...transaction, ...fields }, { merchants: removeRule ? {} : prefs.merchants }).label;
  const submit = async e => {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setMessage('');
    try {
      await onSave(transaction.id, { ...fields, amount: fields.amount });
      const saved = !isExpense || savePriorityPreference(transaction.userId, transaction.id, priority, merchant, remember, removeRule);
      setMessage(saved ? 'Transaction saved.' : 'Transaction saved. Priority could not be saved in this browser.');
      close();
    } catch (err) { setError(err.message || 'Could not save the transaction.'); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <div className="transaction-editor" data-testid="transaction-editor">
    {!open && <button ref={opener} type="button" className="transaction-edit-button" aria-label={`Edit transaction ${transaction.title}`} onClick={edit}>Edit</button>}
    {message && <p role="status">{message}</p>}
    {open && <form onSubmit={submit} aria-label={`Edit transaction ${transaction.title}`} onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented && !busy) { e.preventDefault(); close(); } }}>
      <fieldset disabled={busy} className="transaction-edit-fields"><legend>Edit transaction</legend>
        <label>Description<input ref={titleInput} required maxLength={120} value={fields.title} onChange={e => field('title', e.target.value)} /></label>
        <label>Amount (₹)<input type="number" inputMode="decimal" required min="0.01" max="100000000" step="0.01" value={fields.amount} onChange={e => field('amount', e.target.value)} /></label>
        <label>Date<input type="date" required value={fields.date} onChange={e => field('date', e.target.value)} /></label>
        <label>Direction<select value={fields.type} onChange={e => setFields(old => ({ ...old, type: e.target.value, classification: 'unknown' }))}><option value="expense">Money out</option><option value="income">Money in</option></select></label>
        <label>Classification<select value={fields.classification} onChange={e => field('classification', e.target.value)}>{CLASSIFICATIONS[fields.type].map(c => <option key={c} value={c}>{c === 'unknown' ? 'Not specified' : c[0].toUpperCase() + c.slice(1)}</option>)}</select></label>
        <div className="transaction-edit-category"><CategoryPicker value={fields.category} choices={choices} onChange={value => field('category', value)} label={`Category for ${transaction.title}`} hint="Saved with this transaction." /></div>
        {isExpense && <div className="transaction-edit-priority"><label>Needs / Wants<select value={priority} onChange={e => { setPriority(e.target.value); if (!e.target.value) setRemember(false); }}><option value="">Automatic · {automatic}</option>{PRIORITIES.map(p => <option key={p}>{p}</option>)}</select></label>
          <p>Optional. Your priority choices are saved for your account in this browser.</p>
          {merchant && <><label className="transaction-edit-check"><input type="checkbox" checked={remember} disabled={!priority} onChange={e => { setRemember(e.target.checked); if (e.target.checked) setRemoveRule(false); }} />Remember this choice for matching merchant expenses</label>{Object.hasOwn(prefs.merchants ?? {}, merchant) && <label className="transaction-edit-check"><input type="checkbox" checked={removeRule} onChange={e => { setRemoveRule(e.target.checked); if (e.target.checked) setRemember(false); }} />Remove the saved merchant rule</label>}</>}
        </div>}
        <div className="transaction-edit-actions"><button type="submit">{busy ? 'Saving…' : 'Save changes'}</button><button type="button" onClick={close}>Cancel</button></div>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>}
  </div>;
}
