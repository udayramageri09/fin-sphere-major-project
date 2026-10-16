// ForecastChart - recorded and forecast income/spending by month (Financial Intelligence).
// Presentation only: every figure comes from the server's analysis; nothing is recalculated here except the difference between two
// shown figures. Pointer (hover), touch (tap), and keyboard (arrow keys, Home, End, then Enter/Space) all select a month, and the
// selected month's exact figures are written out below the chart, never over the bars. The same values are available as a table.
import { useId, useRef, useState } from 'react';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const rupees = (v) => `${v < 0 ? '−' : ''}₹${Math.abs(v).toLocaleString('en-IN')}`;
const figure = (v) => (finite(v) ? rupees(v) : 'Unavailable');

function difference(income, spending) {
  if (!finite(income) || !finite(spending)) return null;
  const paise = Math.round(income * 100) - Math.round(spending * 100);
  if (paise === 0) return { label: 'Income equals spending', value: rupees(0) };
  return { label: paise > 0 ? 'Left after spending' : 'Spending above income', value: rupees(Math.abs(paise) / 100) };
}

export default function ForecastChart({ historical, forecast }) {
  const uid = useId();
  const buttons = useRef([]);
  const [chosen, setChosen] = useState(null);
  if (!historical?.length) return <div className="no-data">No forecast data</div>;

  const recorded = historical.slice(-4).map((m, i) => ({
    key: `h-${i}`, kind: 'recorded', label: m.month_label ?? String(m.month ?? ''),
    income: finite(m.income) ? m.income : null, spending: finite(m.expenses) ? m.expenses : null,
  }));
  const incomeForecast = forecast?.income?.predictions ?? [];
  const spendingForecast = forecast?.expenses?.predictions ?? [];
  const predicted = (forecast?.months ?? []).map((month, i) => ({
    key: `f-${i}`, kind: 'forecast', label: String(month),
    income: finite(incomeForecast[i]) ? incomeForecast[i] : null, spending: finite(spendingForecast[i]) ? spendingForecast[i] : null,
  }));
  const months = [...recorded, ...predicted];
  const selected = Math.min(chosen ?? recorded.length - 1, months.length - 1);
  const current = months[selected];
  const peak = Math.max(1, ...months.flatMap((m) => [m.income ?? 0, m.spending ?? 0]));
  const gap = difference(current.income, current.spending);
  const r2 = (side) => (finite(forecast?.[side]?.r2) ? forecast[side].r2 : null);

  const move = (to) => {
    const i = Math.min(Math.max(to, 0), months.length - 1);
    setChosen(i);
    buttons.current[i]?.focus();
  };
  const onKeyDown = (event, i) => {
    const target = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: months.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    move(target);
  };
  const basis = (m) => (m.kind === 'forecast' ? 'forecast' : 'recorded');

  return (
    <div className="forecast-bars-wrap">
      <div className="forecast-legend" aria-hidden="true">
        <span><span className="legend-dot income" />Income</span>
        <span><span className="legend-dot expense" />Spending</span>
        <span><span className="legend-dot forecast" />Forecast</span>
      </div>
      <div className="forecast-chart-scroll">
        <div className="bars-container" role="group" aria-label="Income and spending by month, recorded and forecast">
          {months.map((m, i) => (
            <span key={m.key} className="forecast-slot">
              {i === recorded.length && predicted.length > 0 && <span className="forecast-divider" aria-hidden="true" />}
              <button
                type="button" ref={(el) => { buttons.current[i] = el; }} tabIndex={i === selected ? 0 : -1}
                className={`bar-group ${m.kind === 'forecast' ? 'forecast-group' : ''} ${i === selected ? 'is-selected' : ''}`}
                aria-pressed={i === selected} aria-describedby={i === selected ? `${uid}-detail` : undefined}
                aria-label={`${m.label}, ${basis(m)}: income ${figure(m.income)}, spending ${figure(m.spending)}`}
                data-month={m.label} data-kind={m.kind}
                onMouseEnter={() => setChosen(i)} onFocus={() => setChosen(i)} onClick={() => setChosen(i)} onKeyDown={(e) => onKeyDown(e, i)}
              >
                <span className="bar-pair" aria-hidden="true">
                  {m.income !== null && <span className={`bar income-bar ${m.kind === 'forecast' ? 'forecast-bar' : ''}`} style={{ height: `${(m.income / peak) * 100}%` }} />}
                  {m.spending !== null && <span className={`bar expense-bar ${m.kind === 'forecast' ? 'forecast-bar' : ''}`} style={{ height: `${(m.spending / peak) * 100}%` }} />}
                </span>
                <span className="bar-label" aria-hidden="true">{m.label.split(' ')[0]}</span>
                <span className="bar-kind" aria-hidden="true">{m.kind === 'forecast' ? 'Forecast' : 'Recorded'}</span>
              </button>
            </span>
          ))}
        </div>
      </div>

      <div id={`${uid}-detail`} className="forecast-detail" role="region" aria-live="polite" aria-label={`${current.label} ${basis(current)} figures`} data-testid="forecast-detail">
        <div className="forecast-detail-head">
          <strong>{current.label}</strong>
          <span className={`forecast-badge ${current.kind}`}>{current.kind === 'forecast' ? 'Forecast' : 'Recorded'}</span>
        </div>
        <dl className="forecast-detail-figures">
          <div><dt>Income</dt><dd>{figure(current.income)}</dd></div>
          <div><dt>Spending</dt><dd>{figure(current.spending)}</dd></div>
          <div><dt>{gap ? gap.label : 'Left after spending'}</dt><dd>{gap ? gap.value : 'Unavailable'}</dd></div>
        </dl>
        {current.kind === 'forecast' && (
          <p className="forecast-detail-note">
            ML · LinearRegression
            {r2('income') !== null || r2('expenses') !== null
              ? ` · R² ${[r2('income') !== null ? `income ${r2('income')}` : null, r2('expenses') !== null ? `spending ${r2('expenses')}` : null].filter(Boolean).join(', ')}`
              : ''}
          </p>
        )}
      </div>

      <details className="forecast-table-details">
        <summary>View exact values</summary>
        <div className="forecast-table-scroll" role="region" aria-label="Forecast exact values table" tabIndex={0}>
          <table>
            <caption className="sr-only">Income and spending by month, recorded and forecast</caption>
            <thead><tr><th scope="col">Month</th><th scope="col">Basis</th><th scope="col">Income</th><th scope="col">Spending</th></tr></thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.key}><th scope="row">{m.label}</th><td>{m.kind === 'forecast' ? 'Forecast' : 'Recorded'}</td><td>{figure(m.income)}</td><td>{figure(m.spending)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
