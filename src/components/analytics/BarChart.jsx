import { useEffect, useId, useRef, useState } from 'react';
import { formatMoney } from '../../utils/spendingAnalytics';
import './Analytics.css';

// Keyboard, pointer and touch share the same month details.
const compact = (v) => (v >= 100000 ? `₹${Math.round(v / 1000) / 100}L` : v >= 1000 ? `₹${Math.round(v / 100) / 10}k` : `₹${Math.round(v)}`);

function niceTicks(max) {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(v);
  return { top, ticks };
}

function BarChart({ title, summary, data, mode = 'stacked', testId }) {
  const uid = useId();
  const [inspection, setInspection] = useState({ index: Math.max(data.length - 1, 0), source: 'initial' });
  const figure = useRef(null);
  const inspect = (i, source) => {
    setInspection({ index: i, source });
  };
  useEffect(() => {
    if (!inspection) return;
    const dismiss = e => { if (!figure.current?.contains(e.target)) setInspection(null); };
    const escape = e => { if (e.key === 'Escape') setInspection(null); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [inspection]);
  const [activeRaw, setActive] = useState(Math.max(data.length - 1, 0));
  const active = Math.min(activeRaw, Math.max(data.length - 1, 0));   // never past the end if the period gets shorter
  const groups = useRef([]);
  const plot = useRef(null);
  const [plotWidth, setPlotWidth] = useState(480);
  useEffect(() => {
    const target = plot.current;
    if (!target) return;
    const measure = () => { const measured = Math.floor(target.getBoundingClientRect().width); if (measured > 0) setPlotWidth(measured); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure); observer.observe(target);
    return () => observer.disconnect();
  }, [data.length]);
  const totals = data.map((d) => d.values.reduce((s, v) => s + v.value, 0));
  const peak = Math.max(...(mode === 'stacked' ? totals : data.flatMap((d) => d.values.map((v) => v.value))), 0);
  const { top, ticks } = niceTicks(peak);
  const names = [...new Map(data.flatMap((d) => d.values).map((v) => [v.name, v.color])).entries()];

  const left = 52, right = 8, topPad = 10, bottom = 28, height = 260;
  const width = Math.max(plotWidth, left + right + 48 * data.length);
  const slot = (width - left - right) / Math.max(data.length, 1);
  const plotH = height - topPad - bottom;
  const y = (v) => topPad + plotH - (v / top) * plotH;

  const move = (to) => { const i = Math.min(Math.max(to, 0), data.length - 1); setActive(i); groups.current[i]?.focus(); };
  const onKey = (event, i) => {
    const map = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: data.length - 1 };
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect(i, 'keyboard'); return; }
    if (!(event.key in map)) return;
    event.preventDefault();
    move(map[event.key]);
  };
  const label = (d) => `${d.label}: ${d.values.filter((v) => v.value > 0).map((v) => `${v.name} ${formatMoney(v.value)}`).join(', ') || 'nothing recorded'}${mode === 'stacked' && d.values.length > 1 ? `. Total ${formatMoney(totals[data.indexOf(d)])}` : ''}.`;
  const current = inspection ? data[inspection.index] : null;
  const renderDetails = month => {
    const detailsBreakdown = month.breakdown;
    const detailsTotal = detailsBreakdown?.reduce((sum, v) => sum + v.value, 0) ?? 0;
    const difference = Math.round((month.income ?? 0) * 100) - Math.round((month.netSpending ?? 0) * 100);
    return (      <div id={uid + '-details'} role="region" aria-label={`${month.label} spending details`} className="month-chart-tooltip" data-testid="chart-details">
        <strong className="month-tooltip-title">{month.label}</strong>
        {detailsBreakdown ? <>
          {month.income !== undefined ? <div className="month-cash-summary">
            <div><span className="block text-xs text-slate-500">Income</span><strong>{formatMoney(month.income)}</strong></div>
            <div><span className="block text-xs text-slate-500">Net spending</span><strong>{formatMoney(month.netSpending)}</strong></div>
            <div><span className="block text-xs text-slate-500">{difference < 0 ? 'Spent above income' : difference > 0 ? 'Left after spending' : 'Balanced'}</span><strong>{formatMoney(Math.abs(difference) / 100)}</strong></div>
          </div> : <div className="month-tooltip-total"><span>Net spending</span><strong>{formatMoney(month.netSpending)}</strong></div>}
          <ul>{detailsBreakdown.filter(v => v.value > 0).map(v => <li key={v.name}><span className="month-tooltip-category"><i style={{ background: v.color }} aria-hidden="true" />{v.name}</span><span>{formatMoney(v.value)} <strong>{(detailsTotal > 0 ? (v.value / detailsTotal * 100).toFixed(1) + '%' : '0%')}</strong></span></li>)}</ul>
          {detailsTotal === 0 && <p>No category spending recorded.</p>}
          {Math.abs(detailsTotal - month.netSpending) > 0.005 && <p>Percentages use the category total of {formatMoney(detailsTotal)}. Refunds can make net spending differ.</p>}
        </> : <ul>{month.values.map(v => <li key={v.name}><span>{v.name}</span><strong>{formatMoney(v.value)}</strong></li>)}</ul>}
      </div>
);
  };

  // A single month is a snapshot, not a time series. Keep labels at normal text size.
  if (data.length === 1) {
    const month = data[0];
    const scale = mode === 'stacked' ? totals[0] : peak;
    return <figure ref={figure} className="m-0 min-w-0 single-month-chart" data-testid={testId} aria-label={title} tabIndex={0} onFocus={() => inspect(0, 'keyboard')} onMouseEnter={() => inspect(0, 'hover')} onClick={() => inspect(0, 'tap')} onKeyDown={e => onKey(e, 0)}>
      <figcaption className="single-month-caption">{month.label}</figcaption>
      <ul data-testid="single-month-chart" className="single-month-values">
        {month.values.map(v => <li key={v.name}>
          <div className="single-month-value"><span>{v.name}</span><strong>{formatMoney(v.value)}</strong></div>
          <div className="single-month-track" aria-hidden="true"><span style={{ width: scale > 0 ? `${v.value / scale * 100}%` : '0%', background: v.color }} /></div>
        </li>)}
      </ul>
      {inspection && month.breakdown && renderDetails(month)}
      {mode === 'stacked' && month.values.length > 1 && <p className="single-month-total">Total <strong>{formatMoney(totals[0])}</strong></p>}
    </figure>;
  }

  return (
    <figure ref={figure} className="m-0 min-w-0 month-chart" data-testid={testId}>
      <figcaption className="sr-only" id={`${uid}-cap`}>{title}. {summary}</figcaption>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2 text-xs text-zinc-600" aria-hidden="true">
        {names.map(([name, color]) => (<span key={name} className="inline-flex items-center gap-1.5"><span style={{ background: color }} className="inline-block h-2.5 w-2.5 rounded-sm" />{name}</span>))}
      </div>
      <div ref={plot} className="overflow-x-auto min-w-0 max-w-full" role="region" aria-label={`${title}, scrollable`} tabIndex={width > 380 ? 0 : -1}>
        <svg viewBox={`0 0 ${width} ${height}`} style={{ minWidth: width, width: '100%', height: 260, display: 'block' }} role="group" aria-labelledby={`${uid}-cap`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} stroke="#e4e4e7" strokeWidth="1" strokeDasharray="3 5" />
              <text x={left - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#71717a">{compact(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const x0 = left + slot * i;
            const inner = Math.min(slot * 0.62, 56);
            const base = x0 + (slot - inner) / 2;
            let acc = 0;
            return (
              <g
                key={d.key} ref={(el) => { groups.current[i] = el; }} tabIndex={i === active ? 0 : -1} role="img" aria-label={label(d)} data-month={d.key}
                onFocus={() => { setActive(i); inspect(i, 'keyboard'); }}
                onMouseEnter={() => inspect(i, 'hover')} onClick={() => { setActive(i); inspect(i, 'tap'); }} onKeyDown={(e) => onKey(e, i)}
                aria-describedby={inspection?.index === i ? uid + '-details' : undefined}
                className="outline-none focus-visible:[&>rect.focus-ring]:opacity-100" style={{ cursor: 'pointer' }}
              >
                <rect className="focus-ring" x={x0 + 2} y={topPad} width={slot - 4} height={plotH + 18} rx="6" fill="none" stroke="#475569" strokeWidth="2" opacity={i === active ? 0.0 : 0} />
                <rect x={x0 + 2} y={topPad} width={slot - 4} height={plotH + 18} rx="6" fill={i === (inspection?.index ?? active) ? '#f0f3f5' : 'transparent'} />
                {d.values.map((v, k) => {
                  if (!(v.value > 0)) return null;
                  if (mode === 'stacked') {
                    const h = (v.value / top) * plotH;
                    const rect = <rect key={v.name} x={base} y={y(acc + v.value)} width={inner} height={Math.max(h, 1)} fill={v.color} rx="4" />;
                    acc += v.value;
                    return rect;
                  }
                  const w = inner / d.values.length;
                  return <rect key={v.name} x={base + w * k} y={y(v.value)} width={Math.max(w - 2, 3)} height={Math.max((v.value / top) * plotH, 1)} fill={v.color} rx="2" />;
                })}
                <text x={x0 + slot / 2} y={height - 9} textAnchor="middle" fontSize="11" fill={i === (inspection?.index ?? active) ? '#18181b' : '#71717a'} fontWeight={i === (inspection?.index ?? active) ? 700 : 400}>{d.label}</text>
              </g>
            );
          })}
        </svg>
      </div>


      <div className="month-details-space">
      {current && renderDetails(current)}      </div>
    </figure>
  );
}

export default BarChart;
