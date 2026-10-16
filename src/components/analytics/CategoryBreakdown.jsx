import { formatMoney, formatPercent } from '../../utils/spendingAnalytics';
import { colorFor } from '../../utils/categoryColors';

// Where the money went: a labelled, inspectable row per category with amount, share, count and its own bar.
// Choosing a category opens the transactions behind it. The buttons are the chart's keyboard interface.
function CategoryBreakdown({ analytics, selected, onSelect, registerButton }) {
  const { categories } = analytics;
  const biggest = Math.max(...categories.map((c) => c.amount), 1);
  return (
    <div data-testid="category-breakdown">
      <ul className="m-0 p-0 list-none flex flex-col gap-2">
        {categories.map((c) => {
          const isSelected = selected === c.name;
          return (
            <li key={c.name}>
              <button
                type="button" ref={(el) => registerButton(c.name, el)} onClick={() => onSelect(isSelected ? null : c.name)} aria-pressed={isSelected} data-category={c.name}
                aria-label={`${c.name}: ${formatMoney(c.amount)}, ${formatPercent(c.share)} of spending, ${c.count} ${c.count === 1 ? 'transaction' : 'transactions'}. ${isSelected ? 'Hide' : 'Show'} the transactions.`}
                className={`w-full text-left rounded-xl border px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-600 focus-visible:ring-offset-2 ${isSelected ? 'border-zinc-900 bg-zinc-50' : 'border-zinc-200 bg-white hover:bg-zinc-50'}`}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-2 min-w-0 font-semibold text-zinc-900">
                    <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0 rounded-sm" style={{ background: colorFor(c.name) }} />
                    <span className="truncate">{c.name}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-zinc-900">{formatMoney(c.amount)} <span className="text-zinc-400 text-sm" aria-hidden="true">· </span><strong className="text-zinc-900 text-sm font-bold">{formatPercent(c.share)}</strong></span>
                </span>
                <span aria-hidden="true" className="mt-2 block h-1.5 w-full rounded-full bg-zinc-100">
                  <span className="block h-1.5 rounded-full" style={{ width: `${Math.max((c.amount / biggest) * 100, 2)}%`, background: colorFor(c.name) }} />
                </span>
                <span className="mt-1 block text-xs text-zinc-500">
                  {c.count} {c.count === 1 ? 'transaction' : 'transactions'}
                  {c.isOthers && c.members.length > 0 && <> · includes {c.members.slice(0, 4).map((m) => (m.name === 'Others' ? 'uncategorised' : m.name)).join(', ')}{c.members.length > 4 ? ` and ${c.members.length - 4} more` : ''}</>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default CategoryBreakdown;
