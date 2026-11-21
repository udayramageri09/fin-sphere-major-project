import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, BadgeCheck, Landmark, ShieldCheck, TrendingUp, Wallet } from 'lucide-react';
import { demoIdentity } from '../../server/accountAggregatorDemoData.js';
import { parseLocalDate } from '../utils/finance';
import { formatMoney } from '../utils/spendingAnalytics';
import './AccountAggregatorSandbox.css';

const sections = [
  { key: 'investments', label: 'Investments', Icon: TrendingUp },
  { key: 'loans', label: 'Loans', Icon: Wallet },
  { key: 'insurance', label: 'Insurance', Icon: ShieldCheck }
];
const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export default function AccountAggregatorSandbox({ request, sample, selection, onSelect }) {
  const [approved, setApproved] = useState(false);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const accountFilterId = useId();
  const previewHeading = useRef(null);
  const [accountFilter, setAccountFilter] = useState('');
  const readOnly = Boolean(sample);

  useEffect(() => { if (preview) previewHeading.current?.focus(); }, [preview]);

  const run = async (action, body) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const data = await request(action, body);
      if (action === 'consent') setPreview(data);
      else setResult(data);
    } catch (err) {
      setError(err.message || 'The sandbox could not complete this request.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const reset = () => {
    setAccountFilter('');
    setApproved(false);
    setPreview(null);
    setResult(null);
    setError('');
  };

  const overview = preview?.overview;
  const selectedSection = sections.find(({ key }) => key === selection);
  const transactions = overview?.transactions.filter((transaction) => !accountFilter || transaction.accountId === accountFilter)
    .sort((a, b) => b.date.localeCompare(a.date));
  return (
    <div className="aa-sandbox">
      <div className="aa-notice">
        <ShieldCheck aria-hidden="true" size={20} />
        <p><strong>Fictional data only.</strong> No connection to OneMoney or any financial institution. Never enter a real PAN.</p>
        {!readOnly && <a href="/sandbox-demo">Open standalone demo <ArrowUpRight aria-hidden="true" size={14} /></a>}
      </div>
      {!overview ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!approved) return;
          if (readOnly) setPreview({ overview: sample });
          else void run('consent', { identity: demoIdentity, approved });
        }}>
          <div className="aa-identity"><span>Demo identity</span> <code>{demoIdentity}</code></div>
          <label>
            <input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} disabled={busy} />
            {selectedSection ? `I approve mock consent to preview sample ${selectedSection.label.toLowerCase()}.` : 'I approve mock consent to preview sample bank accounts, transactions, investments, loans, and insurance.'}
          </label>
          <button type="submit" className="aa-sandbox-primary" disabled={!approved || busy}>{busy ? 'Loading demo records…' : 'Preview demo records'}</button>
        </form>
      ) : selectedSection ? (
        <>
          <h3 ref={previewHeading} tabIndex={-1}>Sample {selectedSection.label.toLowerCase()}</h3>
          <ul className="aa-summary">
            {overview[selection].map(record => (
              <li className="aa-card" key={record.name}>
                <strong>{record.name}</strong>
                <p>{record.detail}: {formatMoney(record.amount)}</p>
                <button className="aa-sandbox-primary" type="button" onClick={() => onSelect(record)}>Use {record.name}</button>
              </li>
            ))}
          </ul>
          <p className="aa-footnote">Review the fictional entry in the form before saving it to your account.</p>
          <div className="aa-sandbox-actions"><button type="button" onClick={reset}>Close preview</button></div>
        </>
      ) : (
        <>
          <div className="aa-section-heading">
            <div>
              <h3 ref={previewHeading} tabIndex={-1}>Sample financial overview</h3>
              <p>March 2026 · INR</p>
            </div>
            <span className="aa-tag"><BadgeCheck aria-hidden="true" size={14} /> Mock consent approved</span>
          </div>
          <ul className="aa-sandbox-accounts" aria-label="Sample bank accounts">
            {overview.bankAccounts.map((account) => (
              <li key={account.id} className="aa-card">
                <span className="aa-icon"><Landmark aria-hidden="true" size={18} /></span>
                <div><strong>{account.name}</strong><p>{account.maskedNumber}</p></div>
                <div className="aa-account-balance"><span>Balance</span><strong>{formatMoney(account.balance)}</strong></div>
              </li>
            ))}
          </ul>
          <div className="aa-ledger">
            <div className="aa-section-heading aa-ledger-heading">
              <div><h4>Bank transactions</h4><p>Showing {transactions.length} of {overview.transactions.length}</p></div>
              <div className="aa-filter">
                <label htmlFor={accountFilterId}>Account</label>
                <select id={accountFilterId} value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
                  <option value="">All accounts</option>
                  {overview.bankAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                </select>
              </div>
            </div>
            {transactions.length ? (
              <ul className="aa-transaction-list" aria-label="Sample bank transactions">
                {transactions.map((transaction) => {
                  const credit = transaction.amount > 0;
                  const Icon = credit ? ArrowDownLeft : ArrowUpRight;
                  const account = overview.bankAccounts.find(({ id }) => id === transaction.accountId);
                  return (
                    <li key={`${transaction.accountId}:${transaction.date}:${transaction.title}`} className="aa-transaction">
                      <span className={`aa-icon ${credit ? 'aa-credit-icon' : ''}`}><Icon aria-hidden="true" size={17} /></span>
                      <div className="aa-transaction-description">
                        <strong>{transaction.title.replace(/^\[Sandbox\] /, '')}</strong>
                        <p><time dateTime={transaction.date}>{dateFormat.format(parseLocalDate(transaction.date))}</time> · {account?.maskedNumber}</p>
                      </div>
                      <span className="aa-transaction-category">{transaction.category}</span>
                      <div className={`aa-transaction-amount ${credit ? 'aa-credit' : ''}`}>
                        <strong>{credit ? '+' : ''}{formatMoney(transaction.amount)}</strong>
                        <span>{credit ? 'Money in' : 'Money out'}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="aa-empty">No sample transactions for this account.</p>}
          </div>
          <div className="aa-summary">
            {sections.map(({ key, label, Icon }) => (
              <div className="aa-card" key={key}>
                <h4><Icon aria-hidden="true" size={16} /> {label}</h4>
                <ul>{overview[key].map((record) => (
                  <li key={record.name}><strong>{record.name}</strong><p>{record.detail}</p><strong>{formatMoney(record.amount)}</strong></li>
                ))}</ul>
              </div>
            ))}
          </div>
          <p className="aa-footnote">{readOnly ? 'This standalone preview is read-only. Nothing is sent to an API or saved.' : 'Import adds all sample bank transactions, not just the filtered view. Possible duplicates are skipped. To use a sample loan or investment, open Liabilities or Portfolio.'}</p>
          <div className="aa-sandbox-actions">
            {!readOnly && !result && <button className="aa-sandbox-primary" type="button" disabled={busy} onClick={() => run('import', { consent: preview.consent })}>
              {busy ? 'Importing…' : 'Import sample bank transactions'}
            </button>}
            <button type="button" disabled={busy} onClick={reset}>{result ? 'Start a new preview' : 'Close preview'}</button>
          </div>
          {result && <p className="aa-notice" role="status">Imported {result.count} sample bank transaction{result.count === 1 ? '' : 's'}. Skipped {result.skipped} possible or likely duplicate{result.skipped === 1 ? '' : 's'}.</p>}
        </>
      )}
      {error && <p className="aa-sandbox-error" role="alert">{error}</p>}
    </div>
  );
}
