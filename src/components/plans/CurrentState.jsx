import { memo } from 'react';
// CurrentState - the user's computed position, results first (Issue #80). Presentation only: `state` comes from
// buildCurrentState() (src/utils/planIntelligence.js), whose figures were all computed by the server.
import { Shield } from 'lucide-react';

function Score({ score }) {
  return (
    <div className="state-score" data-testid="health-score">
      <div className="state-score-number">{score.value}<span>/100</span></div>
      <div className="state-score-grade">Grade {score.grade} · {score.label}</div>
    </div>
  );
}

function CurrentState({ state }) {
  return (
    <section className="ml-card state-card" aria-labelledby="state-heading" data-avatar-target="health-score-section">
      <div className="ml-card-header">
        <Shield size={16} /><h2 id="state-heading" className="section-heading">Your financial position</h2>

      </div>
      <div className="state-body">
        {state.score ? <Score score={state.score} /> : <div className="state-score unavailable-block">Health score unavailable</div>}
        <dl className="state-rows">
          {state.rows.filter(row => row.key !== 'forecast').map((r) => (
            <div key={r.key} className={`state-row ${r.unavailable ? 'is-unavailable' : ''}`}>
              <dt>{r.label}</dt>
              <dd>
                <strong>{r.unavailable ? 'Unavailable' : r.value}</strong>
                {r.unavailable && <p className="metric-note">{r.value}</p>}
                {r.note && <p className="metric-note">{r.note}</p>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {state.period && <p className="state-period">Based on {state.period}.</p>}
    </section>
  );
}

export default memo(CurrentState);
