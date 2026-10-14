// Explain - "Why?", "How calculated?", "What caused this?" and "Show breakdown" for one action (Issue #80).
// Everything shown is the `evidence` (and the health breakdown) the SERVER returned; nothing is computed here.
import { useState } from 'react';
import { contributorLine, formatInr, formatValue, ratioName, thresholdText, unavailableText } from '../../utils/planIntelligence';

const CONTROLS = [
  ['why', 'Why?'],
  ['how', 'How calculated?'],
  ['cause', 'What caused this?'],
  ['breakdown', 'Show breakdown'],
];

function Breakdown({ health }) {
  const ratios = Object.entries(health.ratios ?? {});
  const reasons = health.unavailable_reasons ?? {};
  const b = health.breakdown ?? {};
  return (
    <div className="explain-breakdown">
      <table className="explain-table">
        <thead><tr><th>Ratio</th><th>Value</th><th>Score</th><th>Weight</th></tr></thead>
        <tbody>
          {ratios.map(([key, r]) => (
            <tr key={key}>
              <td>{ratioName(key)}</td>
              <td>{r.value}{r.unit === 'months' ? ' months' : r.unit}</td>
              <td>{r.score}/100</td>
              <td>{r.weight_pct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      {Object.keys(reasons).map((key) => (
        <p key={key} className="explain-note">{ratioName(key)}: {unavailableText(key, reasons[key])}</p>
      ))}
      <p className="explain-note">The score is the weighted average of the ratios above (rule-based; weights are shown after renormalising over the ratios available).</p>
      {Array.isArray(b.spending_by_category) && b.spending_by_category.length > 0 && (
        <>
          <h4 className="explain-sub">Spending by category</h4>
          <ul className="explain-list">
            {b.spending_by_category.map((c) => (
              <li key={c.category}>{c.category}: {formatInr(c.net_spending)} ({c.share_pct}%)</li>
            ))}
            {b.other_net_spending > 0 && <li>Other categories: {formatInr(b.other_net_spending)}</li>}
          </ul>
          <p className="explain-note">{b.basis} Total: {formatInr(b.categories_total)}.</p>
        </>
      )}
    </div>
  );
}

export default function Explain({ step, controls, health }) {
  const [open, setOpen] = useState(null);
  const e = step.evidence;
  const available = CONTROLS.filter(([key]) => controls[key]);
  if (!e || available.length === 0) return null;
  const panelId = `explain-${step.step_id}`;
  const th = thresholdText(e.threshold, e.unit);

  return (
    <div className="explain" data-testid={`explain-${step.step_id}`}>
      <div className="explain-buttons" role="group" aria-label="Explain this action">
        {available.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`explain-btn ${open === key ? 'active' : ''}`}
            aria-expanded={open === key}
            aria-controls={`${panelId}-${key}`}
            onClick={() => setOpen(open === key ? null : key)}
          >
            {label}
          </button>
        ))}
      </div>

      {open === 'why' && (
        <div id={`${panelId}-why`} className="explain-panel" data-panel="why">
          <p><strong>{e.label}: {formatValue(e.value, e.unit)}</strong></p>
          {th && <p>Flagged when it is {th}.</p>}
          {e.caveats.map((c) => <p key={c} className="explain-note">{c}</p>)}
        </div>
      )}
      {open === 'how' && (
        <div id={`${panelId}-how`} className="explain-panel" data-panel="how">
          <p>{e.formula}</p>
          {e.inputs.length > 0 && (
            <ul className="explain-list">
              {e.inputs.map((i) => (
                <li key={i.label}>{i.label}: {formatValue(i.value, i.unit)}{i.period_months ? ` (over ${i.period_months} month${i.period_months === 1 ? '' : 's'})` : ''}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {open === 'cause' && (
        <div id={`${panelId}-cause`} className="explain-panel" data-panel="cause">
          <ul className="explain-list">
            {e.contributors.map((c, i) => <li key={`${i}-${c.id ?? c.category ?? c.label ?? ''}`}>{contributorLine(c)}</li>)}
          </ul>
        </div>
      )}
      {open === 'breakdown' && (
        <div id={`${panelId}-breakdown`} className="explain-panel" data-panel="breakdown">
          <Breakdown health={health} />
        </div>
      )}
    </div>
  );
}
