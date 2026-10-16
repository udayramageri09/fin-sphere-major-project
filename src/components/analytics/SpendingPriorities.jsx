import { useEffect, useState } from 'react';
import { priorityBreakdown, priorityStorageKey, readPriorityPreferences } from '../../utils/spendingPriorities';
import { formatMoney } from '../../utils/spendingAnalytics';

const COLORS = { Needs: '#40566d', Wants: '#879b8e', Other: '#a59b8b' };
export default function SpendingPriorities({ transactions, monthKeys, owner }) {
  const [preferences, setPreferences] = useState(() => readPriorityPreferences(owner));
  const [filter, setFilter] = useState(null);
  const [limit, setLimit] = useState(10);
  useEffect(() => {
    const refresh = e => { if (e.key === null || e.key === priorityStorageKey(owner) || e.detail === priorityStorageKey(owner)) setPreferences(readPriorityPreferences(owner)); };
    window.addEventListener('storage', refresh); window.addEventListener('finsphere-priorities-updated', refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('finsphere-priorities-updated', refresh); };
  }, [owner]);
  const breakdown = priorityBreakdown(transactions, monthKeys, preferences);
  const rows = filter ? breakdown.rows.filter(r => r.label === filter) : breakdown.rows;
  return <section className="spending-priorities" data-testid="spending-priorities" aria-labelledby="priorities-title">
    <h4 id="priorities-title">Needs &amp; wants</h4>
    <p>Suggested · Edit in Activity</p>
    <p className="priority-note">Before refunds.</p>
    <div className="priority-summary">{breakdown.groups.map(group => <button key={group.label} type="button" aria-pressed={filter === group.label} onClick={() => { setFilter(filter === group.label ? null : group.label); setLimit(10); }}>
      <span>{group.label}</span><strong>{formatMoney(group.paise / 100)}</strong><b>{(group.share * 100).toFixed(1)}%</b>
      <span className="priority-track" aria-hidden="true"><i style={{ width: `${group.share * 100}%`, background: COLORS[group.label] }} /></span>
    </button>)}</div>
    <details className="priority-review" open={filter !== null || undefined}>
      <summary>View {filter ? filter.toLowerCase() : 'all'} expenses · {rows.length}</summary>
      <p className="priority-note">Other includes unclear expenses.</p>
      <ul>{rows.slice(0, limit).map(r => <li key={r.id}>
        <div className="priority-row-title"><strong>{r.title}</strong><strong>{formatMoney(r.paise / 100)}</strong></div>
        <p className="priority-note">{r.date} · {r.label} · {r.source}</p>
      </li>)}</ul>
      {rows.length > limit && <button type="button" className="priority-more" onClick={() => setLimit(limit + 10)}>Show 10 more expenses</button>}
    </details>
  </section>;
}
