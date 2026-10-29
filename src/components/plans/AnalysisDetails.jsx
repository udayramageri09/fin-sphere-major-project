import { memo } from 'react';
// AnalysisDetails - the outputs behind the findings (Issue #80): forecast, anomalies and spending clusters.
// Collapsed by default. A section that failed reads "Unavailable" while the others still render.
// Presentation only, and deliberately free of model/algorithm names, formulas or statistical
// metrics - this is a finished-product screen, not an ML implementation debug view.
import { Activity, BarChart2, Minus, Target, TrendingDown, TrendingUp } from 'lucide-react';
import { sectionFailed } from '../../utils/planIntelligence';
import ForecastChart from './ForecastChart';

const signedRupees = (v) => typeof v !== 'number' || !Number.isFinite(v) ? 'Unavailable' : `${v < 0 ? '−' : ''}₹${Math.abs(v).toLocaleString('en-IN')}`;

function TrendIcon({ direction }) {
  if (direction === 'rising') return <TrendingUp size={14} className="trend-up" />;
  if (direction === 'falling') return <TrendingDown size={14} className="trend-down" />;
  return <Minus size={14} className="trend-stable" />;
}

function AnalysisDetails({ data, months = 3 }) {
  const forecast = sectionFailed(data, 'forecast') ? null : data.forecast;
  const anomalies = sectionFailed(data, 'anomalies') ? null : data.anomalies;
  const clusters = sectionFailed(data, 'clusters') ? null : data.clusters;
  const breakdown = sectionFailed(data, 'health') ? null : data.health?.breakdown;
  const categories = breakdown?.spending_by_category;
  const caveats = Array.isArray(data?.plan?.forecast_caveats) ? data.plan.forecast_caveats : [];

  return (
    <div className="analysis-content">

      <div className="ml-card details-card" data-avatar-target="forecast-section">
        <div className="ml-card-header">
          <BarChart2 size={16} /><h3 className="section-heading">{months}-month forecast</h3>
        </div>
        {!forecast ? <p className="unavailable-block">Unavailable</p> : (
          <>
            <div className="forecast-trends">
              <div className="trend-pill">Income <TrendIcon direction={forecast.insights?.income_momentum} /><strong>{forecast.insights?.income_momentum}</strong></div>
              <div className="trend-pill">Spending <TrendIcon direction={forecast.insights?.expense_momentum} /><strong>{forecast.insights?.expense_momentum}</strong></div>
              <div className="trend-pill">Projected savings over {months} months <strong>{signedRupees(forecast.insights?.projected_savings_total ?? (months === 3 ? forecast.insights?.projected_savings_3m : undefined))}</strong></div>
            </div>
            <p className="explain-note">An estimate based on your recorded activity, not a guarantee.</p>
            {caveats.length > 0 && <details className="metric-note"><summary>Forecast limitations</summary>{caveats.map(c => <p key={c}>{c}</p>)}</details>}
            <ForecastChart historical={forecast.historical} forecast={forecast.forecast} />
          </>
        )}
      </div>

<details className="analysis-details" data-testid="analysis-details">
      <summary>Spending patterns and unusual transactions</summary>
      <section className="ml-card details-card" aria-labelledby="intelligence-categories">
        <div className="ml-card-header"><Target size={16} /><h3 id="intelligence-categories" className="section-heading">Where spending goes</h3><span className="method-tag">Recorded categories · net spending</span></div>
        <p className="explain-note">Categories come from your saved transactions. Refunds reduce spending within each category and month; transfers are excluded. These labels are separate from the size groups below.</p>
        {Array.isArray(categories) && categories.length ? <div className="explain-breakdown"><table className="explain-table">
          <caption>Top categories for the analysed period</caption>
          <thead><tr><th scope="col">Category</th><th scope="col">Net spending</th><th scope="col">Share</th></tr></thead>
          <tbody>{categories.map((category) => <tr key={category.category}><th scope="row">{category.category}</th><td>{signedRupees(category.net_spending)}</td><td>{category.share_pct}%</td></tr>)}
          {breakdown.other_net_spending > 0 && <tr><th scope="row">Other categories</th><td>{signedRupees(breakdown.other_net_spending)}</td><td>Remaining</td></tr>}</tbody>
        </table></div> : <p className="findings-none">No category breakdown available for this analysis.</p>}
      </section>

      <div className="ml-card details-card anomaly-card" data-avatar-target="anomaly-section">
        <div className="ml-card-header">
          <Activity size={16} /><h3 className="section-heading">Unusual transactions</h3>
        </div>
        <p className="explain-note">These are statistical signals from your own history. A flag does not establish fraud or an error.</p>
        {!anomalies ? <p className="unavailable-block">Unavailable</p> : anomalies.total_flagged > 0 ? (
          <div className="anomaly-list">
            {(anomalies.anomalies || []).map((a, i) => (
              <div key={a.id ?? i} className={`anomaly-item ${a.severity}`}>
                <div className="anomaly-dot" />
                <div className="anomaly-info">
                  <span className="anomaly-title">{a.title}</span>
                  <span className="anomaly-amount">₹{Math.abs(a.amount).toLocaleString('en-IN')}</span>
                </div>
                <div className="anomaly-reason">{a.reason}</div>
              </div>
            ))}
          </div>
        ) : <p className="findings-none">Nothing unusual was flagged.</p>}
      </div>

      <div className="ml-card details-card" data-avatar-target="cluster-section">
        <div className="ml-card-header">
          <Target size={16} /><h3 className="section-heading">Spending by transaction size</h3>
        </div>
        <p className="explain-note">Groups describe transaction sizes, not merchant categories. Percentages represent the share of spending value; income, refunds and transfers are excluded.</p>
        {!clusters ? <p className="unavailable-block">Unavailable</p> : (clusters.clusters || []).length === 0 ? (
          <p className="findings-none">Not enough spending transactions to group yet.</p>
        ) : (
          <div className="cluster-grid">
            {clusters.clusters.map((cl) => (
              <div key={cl.id} className="cluster-card">
                <div className="cluster-label">{cl.label}</div>
                <div className="cluster-pct">{cl.pct_of_total}%</div>
                <div className="cluster-bar-track" aria-hidden="true"><div className="cluster-bar-fill" style={{ width: `${Math.max(0, Math.min(100, cl.pct_of_total))}%` }} /></div>
                <div className="cluster-desc">{cl.description}</div>
                <div className="cluster-count">{cl.transaction_count} transactions · avg {signedRupees(cl.centroid_amount)}</div>
                {cl.examples?.length > 0 && <details className="cluster-examples">
                  <summary>See supporting transactions</summary>
                  <ul>{cl.examples.map((example, index) => <li key={index}>
                    <strong>{example.title}</strong><span>{example.category || 'Uncategorised'} · {example.date} · {signedRupees(example.amount)}</span>
                  </li>)}</ul>
                </details>}
              </div>
            ))}
          </div>
        )}
      </div>
      </details>
    </div>
  );
}

export default memo(AnalysisDetails);
