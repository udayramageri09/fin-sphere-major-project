// Builds the COMPACT context a local (on-device) model needs to explain/discuss an analysis.
// Every figure here was already computed by the server (rule-based health score and plan, ML
// forecast/anomalies/clusters) - this module only selects, slices and renames a small subset of
// what Plans.jsx already has in `data` (the GET /ml/analyze response). It never recomputes a
// ratio, a score or a ranking, and it never includes the raw transaction list: only a handful of
// top categories and example anomalies/findings, each already bounded to a small count.
//
// Deliberately self-contained (no import of ../utils/planIntelligence.js, which itself imports
// other extensionless-relative modules that only Vite resolves): this keeps the module plain
// Node-importable for fast unit tests, with no jsdom/Vite harness needed for pure data shaping.
// The field names read here are the same ones planIntelligence.js's buildCurrentState/
// groupFindings read from the same `data` shape.

const MAX_CATEGORIES = 5;
const MAX_ANOMALY_EXAMPLES = 3;
const MAX_RISKS = 3;
const MAX_OPPORTUNITIES = 2;

function sectionFailed(data, key) {
  if (data?.metadata?.errors?.[key]) return true;
  const section = data?.[key];
  if (!section || typeof section !== 'object' || Object.keys(section).length === 0) return true;
  if (key === 'health') return section.composite_score === undefined || section.composite_score === null;
  if (key === 'forecast') return !section.forecast && !section.insights;
  return false;
}

// data: the Plans page's analysis result (or null/undefined before the first analysis runs).
// forecastPeriodMonths: the currently selected forecast period (3/6/12), shown as-is.
export function buildIntelligenceContext(data, { forecastPeriodMonths } = {}) {
  if (!data) return null;

  const health = sectionFailed(data, 'health') ? null : data.health;
  const forecast = sectionFailed(data, 'forecast') ? null : data.forecast;
  const anomalies = sectionFailed(data, 'anomalies') ? null : data.anomalies;
  const plan = sectionFailed(data, 'plan') ? null : data.plan;
  const meta = health?.metadata ?? {};
  const ratios = health?.ratios ?? {};
  const categories = health?.breakdown?.spending_by_category;
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];

  const position = [];
  if (health) {
    if (meta.monthly_income != null) position.push({ label: 'Average monthly income', value: meta.monthly_income });
    if (meta.avg_monthly_net_spending != null) position.push({ label: 'Average monthly net spending', value: meta.avg_monthly_net_spending });
    if (ratios.savings_rate) position.push({ label: 'Savings rate', value: `${ratios.savings_rate.value}%`, note: ratios.savings_rate.benchmark });
    if (ratios.dti) position.push({ label: 'Debt-to-income', value: `${ratios.dti.value}%`, note: ratios.dti.benchmark });
    if (ratios.emergency_coverage) position.push({ label: 'Emergency coverage', value: `${ratios.emergency_coverage.value} months`, note: ratios.emergency_coverage.benchmark });
  }

  return {
    period: meta.period ? { months: meta.period.months, from: meta.period.first_month, to: meta.period.last_month } : null,
    forecastPeriodMonths: forecastPeriodMonths ?? null,
    healthScore: health ? { value: health.composite_score, grade: health.grade?.grade ?? null, label: health.grade?.label ?? null } : null,
    position,
    topSpendingCategories: Array.isArray(categories)
      ? categories.slice(0, MAX_CATEGORIES).map((c) => ({ category: c.category, netSpending: c.net_spending, sharePct: c.share_pct }))
      : [],
    forecastSummary: forecast ? {
      incomeTrend: forecast.insights?.income_momentum ?? null,
      spendingTrend: forecast.insights?.expense_momentum ?? null,
      projectedSavings3m: Number.isFinite(forecast.insights?.projected_savings_3m) ? forecast.insights.projected_savings_3m : null
    } : null,
    anomalySummary: anomalies ? {
      totalFlagged: anomalies.total_flagged ?? 0,
      examples: (anomalies.anomalies || []).slice(0, MAX_ANOMALY_EXAMPLES).map((a) => ({ title: a.title, amount: a.amount, reason: a.reason, severity: a.severity }))
    } : null,
    risks: steps.filter((s) => s.kind === 'risk').slice(0, MAX_RISKS).map((s) => ({ title: s.title, outcome: s.expected_outcome })),
    opportunities: steps.filter((s) => s.kind === 'opportunity').slice(0, MAX_OPPORTUNITIES).map((s) => ({ title: s.title, detail: s.expected_outcome }))
  };
}
