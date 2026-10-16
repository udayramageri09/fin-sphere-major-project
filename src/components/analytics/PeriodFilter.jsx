import { useEffect, useId, useRef, useState } from 'react';
import { monthRangeKeys, periodKeys } from '../../utils/spendingAnalytics';
import { getMonthKey } from '../../utils/finance';

export default function PeriodFilter({ value, onChange }) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [customOpen, setCustomOpen] = useState(false);
  const [error, setError] = useState('');
  const customButton = useRef(null), fromInput = useRef(null), previouslyOpen = useRef(false);
  useEffect(() => {
    if (customOpen) fromInput.current?.focus();
    else if (previouslyOpen.current) customButton.current?.focus();
    previouslyOpen.current = customOpen;
  }, [customOpen]);
  const now = new Date(), latest = getMonthKey(now);
  const previous = getMonthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const recent = periodKeys(3, now);
  const presets = [
    { label: 'Past month', startMonth: previous, endMonth: previous },
    { label: 'This month', startMonth: latest, endMonth: latest },
    { label: 'Past 3 months', startMonth: recent[0], endMonth: latest }
  ];
  const active = presets.find(p => p.startMonth === value.startMonth && p.endMonth === value.endMonth)?.label;
  const choose = p => { const range = { startMonth: p.startMonth, endMonth: p.endMonth }; setDraft(range); setCustomOpen(false); setError(''); onChange(range); };
  const update = (key, next) => { setDraft(old => ({ ...old, [key]: next })); setError(''); };
  const apply = event => {
    event.preventDefault();
    try {
      monthRangeKeys(draft.startMonth, draft.endMonth);
      if (draft.endMonth > latest) throw new RangeError('Choose an end month no later than the current month.');
      setError(''); onChange({ ...draft }); setCustomOpen(false);
    } catch (err) { setError(err.message); }
  };
  const button = on => `min-h-11 min-w-0 rounded-lg px-3 py-2 text-sm font-semibold leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-600 ${on ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`;
  const inputClass = 'block w-full max-w-full min-w-0 min-h-11 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-600';
  return <div data-testid="period-filter" className="w-full sm:w-auto max-w-full min-w-0">
    <div role="group" aria-label="Time period" className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
      {presets.map(p => <button key={p.label} type="button" aria-pressed={active === p.label && !customOpen} onClick={() => choose(p)} className={button(active === p.label && !customOpen)}>{p.label}</button>)}
      <button ref={customButton} type="button" aria-pressed={!active || customOpen} aria-expanded={customOpen} aria-controls={`${id}-custom`} onClick={() => { if (!customOpen) setDraft(value); setCustomOpen(!customOpen); setError(''); }} className={button(!active || customOpen)}>Custom range</button>
    </div>
    {customOpen && <form id={`${id}-custom`} aria-label="Custom month range" data-testid="custom-range-form" onSubmit={apply} className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 min-w-0">
      <fieldset className="m-0 p-0 border-0 grid grid-cols-1 min-[400px]:grid-cols-2 gap-3 items-end min-w-0">
        <legend className="sr-only">Select month and year range</legend>
        <label className="block min-w-0 text-xs font-medium text-zinc-600" htmlFor={`${id}-from`}>From<input ref={fromInput} id={`${id}-from`} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} name="startMonth" type="month" required min="1900-01" max={latest} value={draft.startMonth} onChange={e => update('startMonth', e.target.value)} className={inputClass} /></label>
        <label className="block min-w-0 text-xs font-medium text-zinc-600" htmlFor={`${id}-to`}>To<input id={`${id}-to`} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} name="endMonth" type="month" required min="1900-01" max={latest} value={draft.endMonth} onChange={e => update('endMonth', e.target.value)} className={inputClass} /></label>
        <button type="submit" className={button(true)}>Apply range</button>
        <button type="button" className={button(false)} onClick={() => { setCustomOpen(false); setError(''); }}>Cancel</button>
      </fieldset>
      {error && <p id={`${id}-error`} role="alert" className="mt-2 mb-0 text-xs leading-5 text-red-700">{error}</p>}
    </form>}
  </div>;
}
