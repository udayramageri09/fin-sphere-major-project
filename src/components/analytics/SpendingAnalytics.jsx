import { useMemo, useRef, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import {
  buildSpendingAnalytics, transactionsBehind, detectRecurring, formatMoney, periodKeys
} from '../../utils/spendingAnalytics';
import { colorFor } from '../../utils/categoryColors';
import PeriodFilter from './PeriodFilter';
import '../TransactionDisclosure.css';
import './Analytics.css';
import BarChart from './BarChart';
import SpendingPriorities from './SpendingPriorities';
import CategoryBreakdown from './CategoryBreakdown';
import CategoryDrilldown from './CategoryDrilldown';

const CARD = 'rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 min-w-0';

function Stat({ label, value, note }) {
  return (
    <div className={CARD}>
      <dt className="text-sm font-medium text-zinc-600">{label}</dt>
      <dd className="mt-1 m-0 text-2xl font-bold tracking-tight text-zinc-900 tabular-nums [overflow-wrap:anywhere]" data-testid={`stat-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{value}</dd>
      <dd className="sr-only">{note}</dd>
    </div>
  );
}

// Spending analytics for the signed-in user's own transactions (passed in by the Transactions page, which gets them from the finance
// context). Everything is calculated in the browser from the transactions already
// loaded for this account (src/utils/spendingAnalytics.js), with the same definitions as the dashboard, so it recalculates whenever a
// transaction is added, imported, deleted or recategorised.
function SpendingAnalytics({ transactions }) {
  const [range, setRange] = useState(() => { const keys = periodKeys(3); return { startMonth: keys[0], endMonth: keys.at(-1) }; });
  const [selected, setSelected] = useState(null);
  const buttons = useRef(new Map());
  const opener = useRef(null);

  // If the transactions ever belong to a different account than the ones first shown, whatever was open (a category, a message) is
  // dropped at once. (In the app the whole page is replaced on sign-out; this is a second safeguard, not the only one.)
  const owner = transactions[0]?.userId;
  const [seenOwner, setSeenOwner] = useState(owner);
  if (owner !== undefined && owner !== seenOwner) {
    setSeenOwner(owner);
    if (seenOwner !== undefined) { setSelected(null); }
  }

  const analytics = useMemo(() => buildSpendingAnalytics(transactions, range), [transactions, range]);
  const recurring = useMemo(() => detectRecurring(transactions, new Date(), analytics.period.keys), [transactions, analytics.period.keys]);
  const rows = useMemo(() => (selected ? transactionsBehind(transactions, analytics, selected) : []), [transactions, analytics, selected]);

  const select = (name) => {
    opener.current = name;
    setSelected(name);
  };
  const closeDrill = () => {
    const back = buttons.current.get(opener.current);
    setSelected(null);
    setTimeout(() => back?.focus(), 0);
  };
  const { totals, hasAnyTransactions, hasPeriodData, hasSpending, period } = analytics;

  const monthData = analytics.monthly;
  const spendingSeries = monthData.map(m => ({ key: m.key, label: m.label, values: [{ name: 'Net spending', value: m.spending, color: '#40566d' }] }));

  return (
    <section aria-labelledby="spending-analytics-title" className="glass-panel p-4 sm:p-6 min-w-0" data-testid="spending-analytics">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="spending-analytics-title" className="text-xl font-bold tracking-tight text-zinc-900 flex items-center gap-2"><BarChart3 size={20} aria-hidden="true" /> Spending insights</h3>
          <p className="text-sm text-zinc-600 mt-1" data-testid="period-label">{period.label}</p>
        </div>
        <PeriodFilter value={range} onChange={(next) => { setRange(next); setSelected(null); }} />
      </div>

      {!hasAnyTransactions && (
        <p className="mt-6 text-zinc-600" data-testid="analytics-empty">No transactions yet. Add one or import a statement and your spending will be broken down here.</p>
      )}
      {hasAnyTransactions && !hasPeriodData && (
        <p className="mt-6 text-zinc-600" data-testid="analytics-empty-period">You have no transactions in {period.label}. Choose another month range.</p>
      )}

      {hasPeriodData && (
        <div className="mt-5 flex flex-col gap-5">
          <dl className="m-0 grid grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Income" value={formatMoney(totals.income)} note="Money in that counts as income. Refunds and transfers are not income." />
            <Stat label="Net spending" value={formatMoney(totals.spending)} note="Spending minus refunds, month by month. Transfers are not spending." />
            <Stat label="Income minus spending" value={`${totals.netCashFlow < 0 ? '−' : ''}${formatMoney(Math.abs(totals.netCashFlow))}`} note={totals.netCashFlow < 0 ? 'You spent more than you earned in this period.' : 'What was left after spending in this period.'} />
            <Stat label="Transactions counted" value={String(totals.counted)} note="Income, spending and refunds in this period." />
          </dl>

          {analytics.reconciliation > 0.005 && <p className="comparison-caveat">Category totals are {formatMoney(analytics.reconciliation)} above net spending due to refunds.</p>}
          {!hasSpending && <p className="text-zinc-600" data-testid="analytics-no-spending">There is no spending in {period.label}, so there is nothing to break down yet.</p>}

          {hasPeriodData && (
            <div className={hasSpending ? "grid grid-cols-1 xl:grid-cols-[0.85fr_1.15fr] gap-5 items-start" : "grid grid-cols-1 gap-5 items-start"}>
              {hasSpending && <div className={CARD}>
                <h4 className="text-lg font-bold text-zinc-900 mb-3">Spending by category</h4>
                <CategoryBreakdown analytics={analytics} selected={selected} onSelect={select} registerButton={(name, el) => { if (el) buttons.current.set(name, el); else buttons.current.delete(name); }} />
              </div>}
              <div className="flex flex-col gap-5 min-w-0">
                <div className={CARD}>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <h4 className="text-lg font-bold text-zinc-900">Spending by month</h4>

                  </div>
                  <BarChart key={`spending-${range.startMonth}-${range.endMonth}`} testId="chart-spending" title="Spending by month" mode="stacked" data={spendingSeries.map((d, i) => ({ ...d, income: monthData[i].income, netSpending: monthData[i].spending, breakdown: analytics.categories.map(c => ({ name: c.name, value: monthData[i].byCategory[c.name] ?? 0, color: colorFor(c.name) })) }))}
                    summary={`Net spending for each month of ${period.label}. Refunds are taken off spending.`} />
                </div>
              </div>
            </div>
          )}

          {selected && (
            <CategoryDrilldown category={selected} rows={rows} period={period} onClose={closeDrill} />
          )}



          {hasSpending && <SpendingPriorities key={owner ?? "session"} transactions={transactions} monthKeys={monthData.map(m => m.key)} owner={owner} />}
          <div className="grid grid-cols-1 gap-5 items-start">
            <section className={CARD} data-testid="recurring"><h4 className="text-lg font-bold text-zinc-900 mb-2">Recurring payments</h4>

              <p className="text-sm text-zinc-600 mb-2">Selected range. <span className="sr-only">Historical records, not a prediction.</span></p>
              {recurring.length === 0 ? <p className="text-sm text-zinc-600">No recurring payments found.</p> : (
                <ul className="m-0 p-0 list-none divide-y divide-zinc-100">
                  {recurring.slice(0, 6).map((r) => (
                    <li key={r.key} className="py-2 flex items-baseline justify-between gap-3">
                      <span className="min-w-0"><span className="font-medium text-zinc-900 [overflow-wrap:anywhere]">{r.label}</span><span className="block text-xs text-zinc-500">{r.category} · {r.months} months</span></span>
                      <span className="tabular-nums font-semibold text-zinc-900 shrink-0">{formatMoney(r.typicalAmount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>


        </div>
      )}
    </section>
  );
}

export default SpendingAnalytics;
