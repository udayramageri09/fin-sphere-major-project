import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { formatMoney } from '../../utils/spendingAnalytics';

const SOURCE = { yours: 'Your category', detected: 'Auto-detected', none: 'Not categorised' };

// Read-only category details; transaction changes belong in Activity.
function CategoryDrilldown({ category, rows, period, onClose }) {
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, [category]);
  const title = category;
  const sum = rows.reduce((s, r) => s + (r.role === 'refund' ? -Math.abs(r.amount) : Math.abs(r.amount)), 0);
  return (
    <section aria-labelledby="drill-title" data-testid="drilldown" className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 id="drill-title" ref={heading} tabIndex={-1} className="text-lg font-bold text-zinc-900 outline-none">{title}</h4>
          <p className="text-sm text-zinc-600">{rows.length} {rows.length === 1 ? 'transaction' : 'transactions'} in {period.label}{rows.length > 0 && <> · net {formatMoney(Math.max(sum, 0))}</>}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close the transaction list" className="rounded-full p-2 text-zinc-600 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"><X size={18} aria-hidden="true" /></button>
      </div>
      <p className="text-sm text-zinc-500 mt-2">To make changes, edit the transaction in Activity.</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-600" data-testid="drill-empty">No transactions are left here. They moved to the categories you chose.</p>
      ) : (
        <ul className="mt-2 m-0 p-0 list-none divide-y divide-zinc-100" data-testid="drill-rows">
          {rows.map((r) => (
            <li key={r.key} className="py-2.5 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 items-center" data-testid="drill-row">
              <div className="min-w-0">
                <p className="font-medium text-zinc-900 truncate [overflow-wrap:anywhere]">{r.title}</p>
                <p className="text-xs text-zinc-500">{r.date} · {SOURCE[r.source]}{r.role === 'refund' ? ' · Refund' : ''}</p>
              </div>
              <p className={`tabular-nums font-semibold ${r.role === 'refund' ? 'text-emerald-700' : 'text-zinc-900'}`}>{r.role === 'refund' ? '+' : '−'}{formatMoney(Math.abs(r.amount))}</p>

            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default CategoryDrilldown;
