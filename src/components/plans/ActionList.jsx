// ActionList - the prioritised next actions (Issue #80), in the order the server returned them.
// Each action shows its severity, whether it is a rule or an ML signal, a button to the page where it can be acted on
// (when the server named one) and the explain controls.
import { ArrowRight, Zap } from 'lucide-react';
import Explain from './Explain';
import { destinationFor, explainControls, methodLabel } from '../../utils/planIntelligence';

export default function ActionList({ plan, planFailed, health, onNavigate }) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  return (
    <section className="ml-card plan-card" aria-labelledby="actions-heading" data-avatar-target="plan-section">
      <div className="ml-card-header">
        <Zap size={16} /><h2 id="actions-heading" className="section-heading">Next actions</h2>
      </div>
      {planFailed ? (
        <p className="findings-none">Unavailable</p>
      ) : steps.length === 0 ? (
        <p className="findings-none">Nothing needs doing right now. No action rules fired for the data we could analyse.</p>
      ) : (
        <>
          <p className="plan-summary">{plan.plan_summary}</p>
          <ol className="action-list" data-testid="action-list">
            {steps.map((step, i) => {
              const dest = destinationFor(step);
              return (
                <li key={step.step_id} className="action-item" data-avatar-target={`plan-step-${step.step_id}`} data-step-id={step.step_id}>
                  <div className="action-head">
                    <span className="action-index">{i + 1}</span>
                    <span className="action-title">{step.title}</span>
                    <span className={`step-priority-badge priority-${step.priority}`}>{step.priority}</span>
                    <span className={`method-tag method-${step.method}`}>{methodLabel(step)}</span>
                  </div>
                  <p className="action-reason">{step.description}</p>
                  <p className="action-meta"><span>{step.timeline}</span><span>{step.expected_outcome}</span></p>
                  <div className="action-foot">
                    {dest && (
                      <button type="button" className="action-go" onClick={() => onNavigate(dest.navigation)}>
                        Go to {dest.label} <ArrowRight size={13} aria-hidden="true" />
                      </button>
                    )}
                    <Explain step={step} controls={explainControls(step, health)} health={health} />
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
