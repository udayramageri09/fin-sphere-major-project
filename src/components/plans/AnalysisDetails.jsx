// AnalysisDetails - the ML outputs behind the findings (Issue #80): forecast, anomalies and spending clusters.
// Collapsed by default. Each section is tagged with the model that really produced it, and a section that failed
// reads "Unavailable" while the others still render. Presentation only.
import { Activity, BarChart2, Minus, Target, TrendingDown, TrendingUp } from 'lucide-react';
import { sectionFailed } from '../../utils/planIntelligence';
import ForecastChart from './ForecastChart';

const signedRupees = (v) => `${v < 0 ? '−' : ''}₹${Math.abs(v).toLocaleString('en-IN')}`;

function TrendIcon({ direction }) {
  if (direction === 'rising') return <TrendingUp size={14} className="trend-up" />;
  if (direction === 'falling') return <TrendingDown size={14} className="trend-down" />;
  return <Minus size={14} className="trend-stable" />;
}

export default function AnalysisDetails({ data }) {
  const forecast = sectionFailed(data, 'forecast') ? null : data.forecast;
  const anomalies = sectionFailed(data, 'anomalies') ? null : data.anomalies;
  const clusters = sectionFailed(data, 'clusters') ? null : data.clusters;
  const caveats = Array.isArray(data?.plan?.forecast_caveats) ? data.plan.forecast_caveats : [];

  return (
    <details className="analysis-details" data-testid="analysis-details">
      <summary>Analysis details: forecast, anomalies and spending clusters</summary>

      <div className="ml-card details-card" data-avatar-target="forecast-section">
        <div className="ml-card-header">
          <BarChart2 size={16} /><h3 className="section-heading">3-month forecast</h3>
          <span className="model-tag">ML · LinearRegression{forecast?.forecast?.income?.r2 !== undefined ? ` (R² ${forecast.forecast.income.r2})` : ''}</span>
        </div>
        {!forecast ? <p className="unavailable-block">Unavailable</p> : (
          <>
            <div className="forecast-trends">
              <div className="trend-pill">Income <TrendIcon direction={forecast.insights?.income_momentum} /><strong>{forecast.insights?.income_momentum}</strong></div>
              <div className="trend-pill">Spending <TrendIcon direction={forecast.insights?.expense_momentum} /><strong>{forecast.insights?.expense_momentum}</strong></div>
              <div className="trend-pill">Projected savings <strong>{signedRupees(forecast.insights?.projected_savings_3m || 0)}</strong></div>
            </div>
            {caveats.map((c) => <p key={c} className="explain-note">{c}</p>)}
            <ForecastChart historical={forecast.historical} forecast={forecast.forecast} />
          </>
        )}
      </div>

      <div className="ml-card details-card anomaly-card" data-avatar-target="anomaly-section">
        <div className="ml-card-header">
          <Activity size={16} /><h3 className="section-heading">Unusual transactions</h3>
          <span className="model-tag">ML · IsolationForest</span>
        </div>
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
          <span className="model-tag">ML · Agglomerative (Ward){clusters?.model_metrics?.silhouette_score !== undefined ? ` · silhouette ${clusters.model_metrics.silhouette_score}` : ''}</span>
        </div>
        {!clusters ? <p className="unavailable-block">Unavailable</p> : (clusters.clusters || []).length === 0 ? (
          <p className="findings-none">Not enough spending transactions to group yet.</p>
        ) : (
          <div className="cluster-grid">
            {clusters.clusters.map((cl) => (
              <div key={cl.id} className="cluster-card">
                <div className="cluster-label">{cl.label}</div>
                <div className="cluster-pct">{cl.pct_of_total}%</div>
                <div className="cluster-bar-track"><div className="cluster-bar-fill" style={{ width: `${cl.pct_of_total}%` }} /></div>
                <div className="cluster-desc">{cl.description}</div>
                <div className="cluster-count">{cl.transaction_count} transactions · avg ₹{cl.centroid_amount.toLocaleString('en-IN')}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
