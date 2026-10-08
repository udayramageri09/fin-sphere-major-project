"""
plan_generator.py — Rule-Based Financial Plan Generator

Consumes ML outputs from forecaster, anomaly detector, clustering, and health scorer
to produce a structured, prioritised financial action plan.

This is NOT an LLM — it is a deterministic rule engine operating on quantified thresholds.
"""

import math
from decimal import Decimal
from typing import Any


_PRIORITY_MAP = {
    'critical': 1,
    'high': 2,
    'medium': 3,
    'low': 4
}


def _make_step(
    step_id: str,
    title: str,
    description: str,
    priority: str,
    timeline: str,
    expected_outcome: str,
    source_model: str,
    metric_value: Any = None,
    action_type: str = 'advisory'
) -> dict:
    return {
        'step_id': step_id,
        'title': title,
        'description': description,
        'priority': priority,
        'priority_rank': _PRIORITY_MAP.get(priority, 4),
        'timeline': timeline,
        'expected_outcome': expected_outcome,
        'source_model': source_model,
        'metric_value': metric_value,
        'action_type': action_type,  # advisory | alert | opportunity
        'completed': False
    }


def _exact_emergency_coverage(metadata: dict):
    """
    The user's emergency coverage in months from the UNROUNDED inputs, never from the one-decimal ratio shown
    to the user (a raw 2.99 months is displayed as 3.0 but is still below the 3-month line).

    Average monthly expenses = total_expenses_analyzed / months_analyzed. total_expenses_analyzed is a sum of
    paise-valued amounts rounded to 2 decimals, so it is exact; monthly_expenses_used (itself rounded to 2
    decimals) would not be exact for e.g. 100.01 / 3. Coverage = emergency_fund_used / that average, i.e.
    emergency_fund_used * months / total expenses. The comparison is done in exact decimal arithmetic so a value
    that is exactly on a threshold (3.0, 6.0) is never pushed to the wrong side by float rounding.

    Returns (fund, total_expenses, months) as Decimals, or None when any input is missing or unusable: no ratio
    is ever invented from missing metadata.
    """
    def _num(value):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return None
        return Decimal(str(value))

    fund = _num(metadata.get('emergency_fund_used'))
    total = _num(metadata.get('total_expenses_analyzed'))
    months = _num(metadata.get('months_analyzed'))
    if fund is None or total is None or months is None or fund < 0 or total <= 0 or months <= 0:
        return None
    return fund, total, months


def generate_plan(
    forecast: dict,
    anomalies: dict,
    clusters: dict,
    health: dict
) -> dict:
    """
    Rule engine that reads ML model outputs and generates a structured plan.

    Returns:
    {
        "plan_title": str,
        "plan_summary": str,
        "overall_score": float | None,   # None when there is no health result
        "steps": [ { step_id, title, description, priority, timeline, ... } ],
        "ml_signals": { ... },
        "generated_at": str
    }
    """
    steps = []
    ml_signals = {}

    # ── HEALTH SCORE SIGNALS ─────────────────────────────────────────────────
    # A health result exists only if it carries a composite score; an error payload or an
    # empty dict means there is none, so no score is reported and no health rule runs.
    # Likewise a ratio that is absent (dti / emergency_coverage when the user's monthly debt payments,
    # monthly income, emergency fund or expenses are unknown) stays None and its rules are skipped: missing data is
    # never replaced by a default that would trigger a made-up alert.
    health_score = health.get('composite_score') if health else None
    if health_score is not None:
        score = health_score
        grade = health.get('grade', {}).get('grade')
        ratios = health.get('ratios', {})
        ml_signals['health_score'] = score
        ml_signals['health_grade'] = grade

        savings_rate = ratios.get('savings_rate', {}).get('value')
        # DTI = monthly debt payments / monthly income x 100 (debt service, not outstanding balances).
        dti = ratios.get('dti', {}).get('value')
        # Months of expenses the user's saved emergency fund covers. Absent (None) when no fund is configured or
        # there are no expenses to measure it against; a configured fund of 0 is a real 0.0 and does trigger HS-05.
        # The displayed value is rounded to 1 decimal; the rules below use the exact coverage instead.
        emergency_months = ratios.get('emergency_coverage', {}).get('value')
        exact = _exact_emergency_coverage(health.get('metadata', {})) if emergency_months is not None else None

        if savings_rate is not None and savings_rate < 10:
            steps.append(_make_step(
                'HS-01', 'Critical: Savings Rate Below Safe Threshold',
                f'Your savings rate is {savings_rate:.1f}%, well below the 20% minimum. '
                f'Immediate restructuring of monthly budget is required.',
                'critical', '1–2 weeks',
                f'Increase savings rate to ≥20% (₹{abs(savings_rate - 20):.1f}% gap to close)',
                'HealthScorer', savings_rate, 'alert'
            ))
        elif savings_rate is not None and savings_rate < 20:
            steps.append(_make_step(
                'HS-02', 'Improve Savings Rate to 20%+ Target',
                f'Current savings rate: {savings_rate:.1f}%. The standard benchmark is 20–30%. '
                f'Identify and reduce 2–3 recurring discretionary expenses.',
                'high', '1 month',
                f'Lift savings rate from {savings_rate:.1f}% to 20%+',
                'HealthScorer', savings_rate, 'advisory'
            ))

        if dti is not None and dti > 50:
            steps.append(_make_step(
                'HS-03', 'Debt-to-Income Ratio Is Dangerously High',
                f'Your monthly debt payments are {dti:.1f}% of your monthly income (danger zone: >50%). '
                f'Lenders typically want this debt-to-income ratio at or below 43%. '
                f'Prioritise prepaying highest-interest debt first (avalanche method).',
                'critical', 'Immediate',
                'Bring monthly debt payments below 36% of monthly income within 6 months',
                'HealthScorer', dti, 'alert'
            ))
        elif dti is not None and dti > 36:
            steps.append(_make_step(
                'HS-04', 'Reduce Debt Load — DTI Above Acceptable',
                f'Your monthly debt payments are {dti:.1f}% of your monthly income. Acceptable range is ≤36%. Make one extra EMI payment per quarter.',
                'high', '3 months',
                'Reduce monthly debt payments by ~5 percentage points of income per quarter',
                'HealthScorer', dti, 'advisory'
            ))

        if exact is not None:
            fund, total, months = exact
            # months of coverage = fund * months / total; compare against N months as fund * months vs N * total
            raw_months = float(fund * months / total)
            # Shown to 2 decimals, always rounded DOWN so 2.999 never reads as "3.00".
            shown_months = math.floor(raw_months * 100) / 100
            monthly_expenses = float(total / months)

            if fund * months < 3 * total:
                shortfall = 3 * monthly_expenses - float(fund)
                steps.append(_make_step(
                    'HS-05', 'Build Emergency Fund — Coverage Critical',
                    f'Your emergency fund covers only {shown_months:.2f} months of expenses. Minimum safe buffer is 3 months '
                    f'(about ₹{3 * monthly_expenses:,.0f}), so you are about ₹{shortfall:,.0f} short. '
                    f'Set up a regular monthly transfer to emergency savings, kept somewhere you can reach quickly.',
                    'critical', '3–6 months',
                    '3+ months emergency coverage',
                    'HealthScorer', shown_months, 'advisory'
                ))
            elif fund * months < 6 * total:
                shortfall = 6 * monthly_expenses - float(fund)
                steps.append(_make_step(
                    'HS-06', 'Strengthen Emergency Fund to 6 Months',
                    f'Your emergency fund covers {shown_months:.2f} months of expenses. Target is 6 months for full resilience '
                    f'(about ₹{6 * monthly_expenses:,.0f}), so you are about ₹{shortfall:,.0f} short. '
                    f'Keep adding to your emergency savings with a regular monthly contribution.',
                    'medium', '6 months',
                    '6-month emergency coverage',
                    'HealthScorer', shown_months, 'advisory'
                ))

    # ── FORECAST SIGNALS ─────────────────────────────────────────────────────
    if forecast and 'forecast' in forecast:
        fc = forecast['forecast']
        insights = forecast.get('insights', {})
        income_trend = insights.get('income_momentum', 'stable')
        expense_trend = insights.get('expense_momentum', 'stable')
        savings_rate_fc = insights.get('savings_rate_pct', 0)
        projected_savings = insights.get('projected_savings_3m', 0)
        ml_signals['income_trend'] = income_trend
        ml_signals['expense_trend'] = expense_trend
        ml_signals['projected_3m_savings'] = projected_savings

        if expense_trend == 'rising' and income_trend != 'rising':
            steps.append(_make_step(
                'FC-01', 'Alert: Expenses Rising Faster Than Income',
                f'Linear regression model shows expense trend is rising while income is {income_trend}. '
                f'Projected 3-month savings: ₹{projected_savings:,.0f}. '
                f'Conduct a category-level spend audit immediately.',
                'high', 'Immediate',
                'Stabilise expense-to-income ratio',
                'LinearRegression Forecaster', None, 'alert'
            ))

        if income_trend == 'rising':
            steps.append(_make_step(
                'FC-02', 'Opportunity: Income Is Trending Upward',
                f'Forecast model detects positive income momentum. Allocate 50% of any income increase '
                f'to investments — avoid lifestyle inflation.',
                'medium', 'Ongoing',
                'Capture income growth as long-term wealth',
                'LinearRegression Forecaster', None, 'opportunity'
            ))

        if projected_savings < 0:
            steps.append(_make_step(
                'FC-03', 'Forecast Predicts Negative Cash Flow Next 3 Months',
                f'Model projects ₹{abs(projected_savings):,.0f} cash shortfall over the next 3 months. '
                f'Delay non-essential purchases and review upcoming EMIs.',
                'critical', 'Next 3 months',
                'Achieve positive cash flow projection',
                'LinearRegression Forecaster', projected_savings, 'alert'
            ))

    # ── ANOMALY SIGNALS ───────────────────────────────────────────────────────
    if anomalies and anomalies.get('total_flagged', 0) > 0:
        flagged = anomalies['total_flagged']
        top_anomaly = anomalies.get('anomalies', [{}])[0]
        total_amt = anomalies.get('insights', {}).get('total_amount_in_anomalies', 0)
        ml_signals['anomalies_detected'] = flagged

        steps.append(_make_step(
            'AN-01', f'Review {flagged} Flagged Transactions (Isolation Forest)',
            f'Isolation Forest detected {flagged} statistically anomalous transactions '
            f'totalling ₹{total_amt:,.0f}. '
            f'Most anomalous: "{top_anomaly.get("title", "Unknown")}" '
            f'(₹{abs(top_anomaly.get("amount", 0)):,.0f}). '
            f'Verify these are legitimate — potential fraud or overspend.',
            'high' if flagged > 2 else 'medium',
            'This week',
            'Confirm all flagged transactions are valid',
            'IsolationForest', flagged, 'alert'
        ))

    # ── CLUSTER SIGNALS ────────────────────────────────────────────────────────
    if clusters and clusters.get('clusters'):
        cl_insights = clusters.get('insights', {})
        high_value_pct = cl_insights.get('high_value_exposure_pct', 0)
        fragmentation = cl_insights.get('spending_fragmentation', 'balanced')
        ml_signals['spending_fragmentation'] = fragmentation
        ml_signals['high_value_cluster_pct'] = high_value_pct

        if high_value_pct > 70:
            steps.append(_make_step(
                'CL-01', 'High Concentration in Large Transactions',
                f'K-Means clustering shows {high_value_pct:.1f}% of your spending is in high-value transactions. '
                f'This indicates high fixed-cost exposure (EMIs, rent). '
                f'Consider restructuring fixed liabilities for more flexible cash flow.',
                'high', '2–3 months',
                'Reduce fixed-cost concentration below 60%',
                'KMeans Clustering', high_value_pct, 'advisory'
            ))

        micro_cluster = next((c for c in clusters['clusters'] if c['id'] == 0), None)
        if micro_cluster and micro_cluster['transaction_count'] > 20:
            steps.append(_make_step(
                'CL-02', 'High Frequency of Micro-Transactions',
                f'{micro_cluster["transaction_count"]} small transactions detected (avg ₹{micro_cluster["centroid_amount"]:,.0f}). '
                f'These aggregate to ₹{micro_cluster["total_amount"]:,.0f}. '
                f'Consider using the 50/20/30 budgeting rule for daily spends.',
                'low', 'Ongoing',
                'Reduce micro-spend leakage by 15%',
                'KMeans Clustering', micro_cluster['transaction_count'], 'advisory'
            ))

    # ── Sort by priority rank ──────────────────────────────────────────────────
    steps.sort(key=lambda x: (x['priority_rank'], x['step_id']))

    # ── Plan summary ──────────────────────────────────────────────────────────
    critical_count = sum(1 for s in steps if s['priority'] == 'critical')
    high_count = sum(1 for s in steps if s['priority'] == 'high')

    if critical_count > 0:
        plan_title = f"⚠️ Urgent Financial Recovery Plan ({critical_count} critical actions)"
    elif high_count > 0:
        plan_title = f"📋 Financial Optimisation Plan ({high_count} high-priority actions)"
    else:
        plan_title = "✅ Financial Maintenance Plan — You're on Track"

    score = health_score  # None when there is no health result: nothing is invented
    score_text = f"Overall health score: {score:.0f}/100. " if score is not None else ""
    plan_summary = (
        f"ML models analysed your {len(ml_signals)} financial dimensions. "
        f"{score_text}"
        f"{len(steps)} action items identified across forecasting, anomaly detection, "
        f"spending behaviour clustering, and ratio analysis."
    )

    from datetime import datetime
    return {
        'plan_title': plan_title,
        'plan_summary': plan_summary,
        'overall_score': score,
        'steps': steps,
        'ml_signals': ml_signals,
        'step_count': len(steps),
        'critical_count': critical_count,
        'high_count': high_count,
        'generated_at': datetime.utcnow().isoformat() + 'Z'
    }
