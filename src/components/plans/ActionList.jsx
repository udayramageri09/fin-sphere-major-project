// ActionList - the prioritised next actions (Issue #80), in the order the server returned them.
// Each action shows its severity, whether it is a rule or an ML signal, a button to the page where it can be acted on
// (when the server named one) and the explain controls.
import { useState } from 'react';
import { ArrowRight, Zap } from 'lucide-react';
import Explain from './Explain';
import { destinationFor, explainControls, methodLabel } from '../../utils/planIntelligence';

export default function ActionList({ plan, planFailed, health, onNavigate }) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const [showAll, setShowAll] = useState(false);
  const visibleSteps = showAll ? steps : steps.slice(0, 3);
  return (
    <section className="ml-card plan-card" aria-labelledby="actions-heading" data-avatar-target="plan-section">
      <div className="ml-card-header">
        <Zap size={16} /><h2 id="actions-heading" className="section-heading">Next actions</h2>
      </div>
      {planFailed ? (
        <p className="findings-none">Unavailable</p>
      ) : steps.length === 0 ? (
        <p className="findings-none">No next actions identified for this analysis.</p>
      ) : (
        <>
          <ol className="action-list" data-testid="action-list">
            {visibleSteps.map((step, i) => {
              const dest = destinationFor(step);
              return (
                <li key={step.step_id} className="action-item" data-avatar-target={`plan-step-${step.step_id}`} data-step-id={step.step_id}>
                  <div className="action-head">
                    <span className="action-index">{i + 1}</span>
                    <span className="action-title">{step.title}</span>
                    <span className={`step-priority-badge priority-${step.priority}`}>{step.priority}</span>
                  </div>
                  <div className="action-foot">
                    {dest && (
                      <button type="button" className="action-go" onClick={() => onNavigate(dest.navigation)}>
                        Go to {dest.label} <ArrowRight size={13} aria-hidden="true" />
                      </button>
                    )}
                    <details className="action-evidence">
                      <summary>Why this matters</summary>
                      <p className="action-reason">{step.description}</p>
                      <p className="action-meta"><span>{methodLabel(step)}</span><span>{step.timeline}</span><span>{step.expected_outcome}</span></p>
                      <Explain step={step} controls={explainControls(step, health)} health={health} />
                    </details>
                  </div>
                </li>
              );
            })}
          </ol>
          {steps.length > 3 && <button type="button" className="show-actions" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer actions' : `View all ${steps.length} actions`}
          </button>}
        </>
      )}
    </section>
  );
}
