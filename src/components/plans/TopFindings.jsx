import { memo } from 'react';
// TopFindings - at most 3 risks and 2 opportunities (Issue #80). The server decided what is a risk and in what order;
// this only shows the first few.
import { AlertTriangle, TrendingUp } from 'lucide-react';

function TopFindings({ findings }) {
  const { risks, opportunities, planFailed } = findings;
  return (
    <section className="ml-card findings-card" aria-labelledby="findings-heading" data-avatar-target="findings-section">
      <div className="ml-card-header">
        <AlertTriangle size={16} /><h2 id="findings-heading" className="section-heading">Top risks and opportunities</h2>
      </div>
      <div className="findings-grid">
        <div>
          <h3 className="findings-sub">Risks</h3>
          {planFailed ? (
            <p className="findings-none">Unavailable</p>
          ) : risks.length === 0 ? (
            <p className="findings-none">No risks found in your current financial position.</p>
          ) : (
            <ul className="findings-list" data-testid="risk-list">
              {risks.map((s) => (
                <li key={s.step_id} className={`finding finding-${s.priority}`}>
                  <span className="finding-chip">{s.priority}</span>
                  <span className="finding-title">{s.title}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="findings-sub">Opportunities</h3>
          {opportunities.length === 0 ? (
            <p className="findings-none">None identified right now.</p>
          ) : (
            <ul className="findings-list" data-testid="opportunity-list">
              {opportunities.map((o) => (
                <li key={o.id} className="finding finding-opportunity">
                  <TrendingUp size={13} aria-hidden="true" />
                  <span className="finding-title">{o.title}{o.detail ? <small> {o.detail}</small> : null}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

export default memo(TopFindings);
