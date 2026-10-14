// planIntelligence.js - turns the server's analysis into what the Plans page shows (Issue #80).
//
// PURE PRESENTATION. Every figure here was computed by the server (the rule-based health score and plan, the ML forecast,
// anomalies and clusters): this module only picks, groups, slices and FORMATS them. It never computes a ratio, a score, a
// threshold test or a ranking: the server already returned the actions in their final deterministic order (priority, then a
// fixed category order), and `kind` / `method` / `evidence` / `action` say what each one is.
import { DESTINATIONS } from './assistantIntent';

const UNAVAILABLE_TEXT = {
  dti: {
    no_income: 'Unavailable: no income recorded in this period',
    debt_total_unavailable: "Unavailable: the monthly debt total couldn't be worked out",
  },
  emergency_coverage: {
    no_fund: 'Not set up: add your emergency fund to see this',
    no_spending: 'Unavailable: no spending recorded to measure it against',
  },
};

const RATIO_NAMES = {
  savings_rate: 'Savings rate',
  expense_ratio: 'Expense control',
  dti: 'Debt-to-income',
  emergency_coverage: 'Emergency coverage',
  investment_rate: 'Investment rate',
  cash_flow_positivity: 'Cash flow',
};
export const ratioName = (key) => RATIO_NAMES[key] ?? key;

// A negative amount reads "-₹1,54,500" (the sign before the currency symbol).
export const formatInr = (n) => `${Number(n) < 0 ? '-' : ''}₹${Math.abs(Number(n)).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// value + unit as the server labelled them -> display text
export function formatValue(value, unit) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  switch (unit) {
    case '₹': return formatInr(value);
    case '₹/month': return `${formatInr(value)}/month`;
    case '₹/month per month': return `${formatInr(value)}/month per month`;
    case '%': return `${value}%`;
    case 'months': return `${value} months`;
    case 'transactions': return `${value} transactions`;
    default: return String(value);
  }
}

export function thresholdText(threshold, unit) {
  if (!threshold) return null;
  const { comparator, value, meaning } = threshold;
  const shown = comparator === 'is' ? `is ${value}` : `${comparator} ${formatValue(value, unit)}`;
  return meaning ? `${shown} (${meaning})` : shown;
}

export function unavailableText(key, reason) {
  return UNAVAILABLE_TEXT[key]?.[reason] ?? 'Unavailable';
}

// Did a section fail, or is it empty? (the server reports `metadata.errors[section] === true`; an empty object is a failure too)
export function sectionFailed(data, key) {
  if (data?.metadata?.errors?.[key]) return true;
  const section = data?.[key];
  if (!section || typeof section !== 'object' || Object.keys(section).length === 0) return true;
  if (key === 'health') return section.composite_score === undefined || section.composite_score === null;
  if (key === 'forecast') return !section.forecast;
  return false;
}

export function periodText(health) {
  const p = health?.metadata?.period;
  if (!p || !p.months) return null;
  const span = p.first_month === p.last_month ? p.first_month : `${p.first_month} to ${p.last_month}`;
  return `${p.months} month${p.months === 1 ? '' : 's'} of transactions (${span})`;
}

// The Current State card: { score, rows }. Rows are { key, label, value, note, unavailable }.
export function buildCurrentState(data) {
  const health = sectionFailed(data, 'health') ? null : data.health;
  const forecast = sectionFailed(data, 'forecast') ? null : data.forecast;
  const caveats = Array.isArray(data?.plan?.forecast_caveats) ? data.plan.forecast_caveats : [];
  const period = health ? periodText(health) : null;
  const ratios = health?.ratios ?? {};
  const reasons = health?.unavailable_reasons ?? {};
  const meta = health?.metadata ?? {};
  const months = meta.period?.months;
  const over = months ? `over ${months} month${months === 1 ? '' : 's'}` : null;

  const row = (key, label, value, note = null, unavailable = false) => ({ key, label, value, note, unavailable });
  const rows = [];
  if (!health) {
    rows.push(row('health', 'Health score', 'Unavailable', null, true));
  } else {
    rows.push(
      meta.monthly_income === null || meta.monthly_income === undefined
        ? row('income', 'Average monthly income', 'Unavailable: no dated transactions', null, true)
        : row('income', 'Average monthly income', formatInr(meta.monthly_income), over),
      meta.avg_monthly_net_spending === null || meta.avg_monthly_net_spending === undefined
        ? row('spending', 'Average monthly net spending', 'Unavailable: no dated transactions', null, true)
        : row('spending', 'Average monthly net spending', formatInr(meta.avg_monthly_net_spending), over),
      ratios.savings_rate ? row('savings', 'Savings rate', `${ratios.savings_rate.value}%`, ratios.savings_rate.benchmark) : row('savings', 'Savings rate', 'Unavailable', null, true),
      ratios.dti ? row('dti', 'Debt-to-income', `${ratios.dti.value}%`, ratios.dti.benchmark) : row('dti', 'Debt-to-income', unavailableText('dti', reasons.dti), null, true),
      ratios.emergency_coverage
        ? row('emergency', 'Emergency coverage', `${ratios.emergency_coverage.value} months`, ratios.emergency_coverage.benchmark)
        : row('emergency', 'Emergency coverage', unavailableText('emergency_coverage', reasons.emergency_coverage), null, true),
    );
  }
  rows.push(forecast
    ? row('forecast', 'Projected savings, next 3 months', formatInr(forecast.insights?.projected_savings_3m ?? 0), caveats.length ? caveats.join(' ') : null)
    : row('forecast', 'Projected savings, next 3 months', 'Unavailable', null, true));

  return {
    score: health ? {
      value: health.composite_score,
      grade: health.grade?.grade ?? null,
      label: health.grade?.label ?? null,
      emoji: health.grade?.emoji ?? '',
      ratiosUsed: meta.ratios_used ?? Object.keys(ratios).length,
      ratiosTotal: meta.ratios_total ?? 6,
    } : null,
    period,
    rows,
  };
}

// Top findings: group and slice only (the server's order is kept). At most 3 risks and 2 opportunities. An opportunity is a
// plan step of kind "opportunity" or one of the health ratios the server marked "good".
export function groupFindings(data) {
  const steps = Array.isArray(data?.plan?.steps) ? data.plan.steps : [];
  const risks = steps.filter((s) => s.kind === 'risk').slice(0, 3);
  const stepOpportunities = steps.filter((s) => s.kind === 'opportunity').map((s) => ({ id: s.step_id, title: s.title, detail: s.expected_outcome, source: 'plan' }));
  const ratios = sectionFailed(data, 'health') ? {} : (data.health.ratios ?? {});
  const strengths = Object.entries(ratios)
    .filter(([, r]) => r.status === 'good')
    .map(([key, r]) => ({ id: `strength-${key}`, title: `${ratioName(key)}: ${r.value}${r.unit === 'months' ? ' months' : r.unit}`, detail: r.benchmark, source: 'health' }));
  return {
    risks,
    opportunities: [...stepOpportunities, ...strengths].slice(0, 2),
    planFailed: sectionFailed(data, 'plan'),
    healthFailed: sectionFailed(data, 'health'),
  };
}

// Which explain controls an action offers. Each needs evidence the server actually returned.
export function explainControls(step, health) {
  const e = step?.evidence;
  return {
    why: Boolean(e && e.value !== undefined),
    how: Boolean(e && e.formula),
    cause: Boolean(e && Array.isArray(e.contributors) && e.contributors.length > 0),
    breakdown: Boolean(e && health?.ratios && Object.keys(health.ratios).length > 0),
  };
}

// The existing navigation destination (src/utils/assistantIntent.js DESTINATIONS, performed by useAvatarActions) for an action.
export function destinationFor(step) {
  const key = step?.action?.destination;
  if (!key || !DESTINATIONS[key]) return null;
  return { navigation: { ...DESTINATIONS[key] }, label: DESTINATIONS[key].label };
}

// "Rule" for the health-score rules, "ML signal" for a rule applied to a forecast / anomaly / cluster output.
export const methodLabel = (step) => (step?.method === 'rule' ? 'Rule' : 'ML signal');

export function contributorLine(c) {
  if (c && c.reason !== undefined) {   // a flagged transaction
    return `${c.title} · ${formatInr(Math.abs(c.amount ?? 0))}${c.date ? ` · ${c.date}` : ''} — ${c.reason}`;
  }
  if (c && c.net_spending !== undefined) return `${c.category}: ${formatInr(c.net_spending)} (${c.share_pct}% of spending)`;
  if (c && c.pct_of_total !== undefined) return `${c.label}: ${c.pct_of_total}% of spending · ${c.transaction_count} transactions`;
  return String(c?.title ?? c?.label ?? '');
}
