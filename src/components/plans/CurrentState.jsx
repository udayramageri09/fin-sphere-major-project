// CurrentState - the user's computed position, results first (Issue #80). Presentation only: `state` comes from
// buildCurrentState() (src/utils/planIntelligence.js), whose figures were all computed by the server.
import { Shield } from 'lucide-react';

function Score({ score }) {
  return (
    <div className="state-score" data-testid="health-score">
      <div className="state-score-number">{score.value}<span>/100</span></div>
      <div className="state-score-grade">Grade {score.grade} · {score.label} {score.emoji}</div>
      <div className="state-score-note">
        Rule-based score{score.ratiosUsed < score.ratiosTotal ? ` · from ${score.ratiosUsed} of ${score.ratiosTotal} ratios` : ''}
      </div>
    </div>
  );
}

export default function CurrentState({ state }) {
  return (
    <section className="ml-card state-card" aria-labelledby="state-heading" data-avatar-target="health-score-section">
      <div className="ml-card-header">
        <Shield size={16} /><h2 id="state-heading" className="section-heading">Your financial position</h2>
        <span className="model-tag">Rule-based</span>
      </div>
      <div className="state-body">
        {state.score ? <Score score={state.score} /> : <div className="state-score unavailable-block">Health score unavailable</div>}
        <dl className="state-rows">
          {state.rows.map((r) => (
            <div key={r.key} className={`state-row ${r.unavailable ? 'is-unavailable' : ''}`}>
              <dt>{r.label}</dt>
              <dd>
                <strong>{r.value}</strong>
                {r.note && <small>{r.note}</small>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {state.period && <p className="state-period">Based on {state.period}. Income and spending are analytical: refunds are not income and transfers are excluded.</p>}
    </section>
  );
}
