// Explain - "Why?" and "What caused this?" for one action (Issue #80).
// Everything shown is the `evidence` the SERVER returned; nothing is computed here. Deliberately
// has no "How calculated?"/"Show breakdown" control: this is a finished-product screen, so it
// never exposes formulas, ratio weights or internal scores - only what the result means.
import { useState } from 'react';
import { contributorLine, formatValue, thresholdText } from '../../utils/planIntelligence';

const CONTROLS = [
  ['why', 'Why?'],
  ['cause', 'What caused this?'],
];

export default function Explain({ step, controls }) {
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
      {open === 'cause' && (
        <div id={`${panelId}-cause`} className="explain-panel" data-panel="cause">
          <ul className="explain-list">
            {e.contributors.map((c, i) => <li key={`${i}-${c.id ?? c.category ?? c.label ?? ''}`}>{contributorLine(c)}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
