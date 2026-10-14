"""
plan_generator.py — Rule-Based Financial Plan Generator

Consumes the outputs of the forecaster, anomaly detector, clustering and health scorer to produce a structured,
prioritised financial action plan.

This is NOT an LLM and NOT a trained model: it is a deterministic rule engine operating on quantified thresholds.
Some rules read an ML output (the forecast, the anomaly list, the clusters); those steps are labelled method
'ml_signal'. The health-score rules (HS-*) read only the deterministic health scorer and are labelled method 'rule'.

Every step carries structured `evidence` (the value, the threshold, the formula, the inputs and the contributors) so a
client can answer "why?", "how was it calculated?" and "what caused this?" without recomputing anything.

Ordering (Issue #80): priority first (critical, high, medium, low); within a priority a FIXED category order breaks ties
(cash-flow survival, debt, emergency fund, savings and spending, transaction review, behaviour and opportunity), then the
step id. There is no score: the order is a pure function of the rules that fired.
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

_SRC_HEALTH = 'Health score rules'
_SRC_FORECAST = 'LinearRegression forecast'
_SRC_ANOMALY = 'IsolationForest'
_SRC_CLUSTER = 'Agglomerative clustering (Ward)'

# kind: risk | opportunity | maintenance   method: rule | ml_signal   order: the fixed tie-break category (1..6)
# destination: a key of the app's navigation destinations (src/utils/assistantIntent.js DESTINATIONS), or None
_STEP_META = {
    'FC-03': {'kind': 'risk',        'method': 'ml_signal', 'source': _SRC_FORECAST, 'order': 1, 'destination': 'budgets'},
    'HS-01': {'kind': 'risk',        'method': 'rule',      'source': _SRC_HEALTH,   'order': 1, 'destination': 'budgets'},
    'HS-03': {'kind': 'risk',        'method': 'rule',      'source': _SRC_HEALTH,   'order': 2, 'destination': 'liabilities'},
    'HS-04': {'kind': 'risk',        'method': 'rule',      'source': _SRC_HEALTH,   'order': 2, 'destination': 'liabilities'},
    'HS-05': {'kind': 'risk',        'method': 'rule',      'source': _SRC_HEALTH,   'order': 3, 'destination': 'emergency-fund'},
    'HS-06': {'kind': 'risk',        'method': 'rule',      'source': _SRC_HEALTH,   'order': 3, 'destination': 'emergency-fund'},
    'HS-02': {'kind': 'risk',        'method': 'rule',      'source': _SRC_HEALTH,   'order': 4, 'destination': 'budgets'},
    'FC-01': {'kind': 'risk',        'method': 'ml_signal', 'source': _SRC_FORECAST, 'order': 4, 'destination': 'budgets'},
    'AN-01': {'kind': 'risk',        'method': 'ml_signal', 'source': _SRC_ANOMALY,  'order': 5, 'destination': 'transactions'},
    'CL-01': {'kind': 'risk',        'method': 'ml_signal', 'source': _SRC_CLUSTER,  'order': 6, 'destination': None},
    'CL-02': {'kind': 'maintenance', 'method': 'ml_signal', 'source': _SRC_CLUSTER,  'order': 6, 'destination': 'budgets'},
    'FC-02': {'kind': 'opportunity', 'method': 'ml_signal', 'source': _SRC_FORECAST, 'order': 6, 'destination': None},
}


def _inp(label: str, value: Any, unit: str = None, period_months: int = None) -> dict:
    item = {'label': label, 'value': value, 'unit': unit}
    if period_months is not None:
        item['period_months'] = period_months
    return item


def _evidence(metric: str, label: str, value: Any, unit: str, formula: str, inputs: list,
              threshold: dict = None, contributors: list = None, caveats: list = None) -> dict:
    return {
        'metric': metric,
        'label': label,
        'value': value,
        'unit': unit,
        'threshold': threshold,
        'formula': formula,
        'inputs': inputs,
        'contributors': contributors or [],
        'caveats': caveats or [],
    }


def _make_step(
    step_id: str,
    title: str,
    description: str,
    priority: str,
    timeline: str,
    expected_outcome: str,
    metric_value: Any = None,
    action_type: str = 'advisory',
    evidence: dict = None
) -> dict:
    meta = _STEP_META[step_id]
    return {
        'step_id': step_id,
        'title': title,
        'description': description,
        'priority': priority,
        'priority_rank': _PRIORITY_MAP.get(priority, 4),
        'timeline': timeline,
        'expected_outcome': expected_outcome,
        'source_model': meta['source'],
        'method': meta['method'],
        'kind': meta['kind'],
        'category_order': meta['order'],
        'action': {'destination': meta['destination']} if meta['destination'] else None,
        'evidence': evidence,
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


def forecast_caveats(forecast: dict) -> list:
    """Plain-language limits of the forecast, computed here (never in the browser) from the model's own outputs."""
    caveats = []
    if not forecast or 'forecast' not in forecast:
        return caveats
    months = forecast.get('insights', {}).get('months_analyzed')
    if isinstance(months, (int, float)) and months < 3:
        caveats.append(
            f'Forecast is based on {int(months)} month(s) of history. With fewer than 3 months a constant average is used, '
            f'so it is not a trend.'
        )
    fc = forecast['forecast']
    weak = []
    for key, name in (('income', 'income'), ('expenses', 'spending')):
        series = fc.get(key, {})
        r2 = series.get('r2')
        if series.get('model') == 'linear_regression' and isinstance(r2, (int, float)) and r2 < 0.3:
            weak.append(f'{name} R² {r2:.2f}')
    if weak:
        caveats.append(f'Low fit ({", ".join(weak)}): the straight-line trend explains little of the month-to-month change, so treat the projection as rough.')
    return caveats


def _top_categories(health: dict, limit: int = 3) -> list:
    rows = (health or {}).get('breakdown', {}).get('spending_by_category', []) or []
    return [
        {'category': r.get('category'), 'net_spending': r.get('net_spending'), 'share_pct': r.get('share_pct')}
        for r in rows[:limit]
    ]


def generate_plan(
    forecast: dict,
    anomalies: dict,
    clusters: dict,
    health: dict
) -> dict:
    """
    Rule engine that reads the health, forecast, anomaly and cluster outputs and generates a structured plan.

    Returns:
    {
        "plan_title": str,
        "plan_summary": str,
        "overall_score": float | None,   # None when there is no health result
        "steps": [ { step_id, title, description, priority, kind, method, source_model, category_order,
                     action, evidence, ... } ],
        "forecast_caveats": [str],
        "ml_signals": { ... },
        "generated_at": str
    }
    """
    steps = []
    ml_signals = {}
    meta_h = (health or {}).get('metadata', {}) or {}
    period_months = meta_h.get('months_analyzed')

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
        exact = _exact_emergency_coverage(meta_h) if emergency_months is not None else None

        def _savings_evidence(threshold_value: float, meaning: str) -> dict:
            return _evidence(
                'savings_rate', 'Savings rate', savings_rate, '%',
                '(Income − Net spending) ÷ Income × 100',
                [
                    _inp('Income', meta_h.get('total_income_analyzed'), '₹', period_months),
                    _inp('Net spending', meta_h.get('total_expenses_analyzed'), '₹', period_months),
                ],
                threshold={'comparator': '<', 'value': threshold_value, 'meaning': meaning},
                contributors=_top_categories(health),
            )

        if savings_rate is not None and savings_rate < 10:
            steps.append(_make_step(
                'HS-01', 'Critical: Savings Rate Below Safe Threshold',
                f'Your savings rate is {savings_rate:.1f}%, well below the 20% minimum. '
                f'Immediate restructuring of monthly budget is required.',
                'critical', '1–2 weeks',
                f'Increase savings rate to ≥20% ({abs(savings_rate - 20):.1f} percentage points to close)',
                savings_rate, 'alert', _savings_evidence(10, 'critical floor')
            ))
        elif savings_rate is not None and savings_rate < 20:
            steps.append(_make_step(
                'HS-02', 'Improve Savings Rate to 20%+ Target',
                f'Current savings rate: {savings_rate:.1f}%. The standard benchmark is 20–30%. '
                f'Identify and reduce 2–3 recurring discretionary expenses.',
                'high', '1 month',
                f'Lift savings rate from {savings_rate:.1f}% to 20%+',
                savings_rate, 'advisory', _savings_evidence(20, 'standard minimum')
            ))

        def _dti_evidence(threshold_value: float, meaning: str) -> dict:
            return _evidence(
                'dti', 'Debt-to-income', dti, '%',
                'Monthly debt payments ÷ Monthly income × 100',
                [
                    _inp('Monthly debt payments (active liabilities)', meta_h.get('monthly_debt_payments_used'), '₹/month'),
                    _inp('Monthly income', meta_h.get('monthly_income_used'), '₹/month', period_months),
                ],
                threshold={'comparator': '>', 'value': threshold_value, 'meaning': meaning},
            )

        if dti is not None and dti > 50:
            steps.append(_make_step(
                'HS-03', 'Debt-to-Income Ratio Is Dangerously High',
                f'Your monthly debt payments are {dti:.1f}% of your monthly income (danger zone: >50%). '
                f'Lenders typically want this debt-to-income ratio at or below 43%. '
                f'Prioritise prepaying highest-interest debt first (avalanche method).',
                'critical', 'Immediate',
                'Bring monthly debt payments below 36% of monthly income within 6 months',
                dti, 'alert', _dti_evidence(50, 'danger zone')
            ))
        elif dti is not None and dti > 36:
            steps.append(_make_step(
                'HS-04', 'Reduce Debt Load — DTI Above Acceptable',
                f'Your monthly debt payments are {dti:.1f}% of your monthly income. Acceptable range is ≤36%. Make one extra EMI payment per quarter.',
                'high', '3 months',
                'Reduce monthly debt payments by ~5 percentage points of income per quarter',
                dti, 'advisory', _dti_evidence(36, 'acceptable ceiling')
            ))

        if exact is not None:
            fund, total, months = exact
            # months of coverage = fund * months / total; compare against N months as fund * months vs N * total
            raw_months = float(fund * months / total)
            # Shown to 2 decimals, always rounded DOWN so 2.999 never reads as "3.00".
            shown_months = math.floor(raw_months * 100) / 100
            monthly_expenses = float(total / months)

            def _emergency_evidence(threshold_months: int, meaning: str) -> dict:
                return _evidence(
                    'emergency_coverage', 'Emergency coverage', shown_months, 'months',
                    'Emergency fund ÷ Average monthly net spending',
                    [
                        _inp('Emergency fund', float(fund), '₹'),
                        _inp('Average monthly net spending', round(monthly_expenses, 2), '₹/month', int(months)),
                    ],
                    threshold={'comparator': '<', 'value': threshold_months, 'meaning': meaning},
                )

            if fund * months < 3 * total:
                shortfall = 3 * monthly_expenses - float(fund)
                steps.append(_make_step(
                    'HS-05', 'Build Emergency Fund — Coverage Critical',
                    f'Your emergency fund covers only {shown_months:.2f} months of expenses. Minimum safe buffer is 3 months '
                    f'(about ₹{3 * monthly_expenses:,.0f}), so you are about ₹{shortfall:,.0f} short. '
                    f'Set up a regular monthly transfer to emergency savings, kept somewhere you can reach quickly.',
                    'critical', '3–6 months',
                    '3+ months emergency coverage',
                    shown_months, 'advisory', _emergency_evidence(3, 'minimum safe buffer')
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
                    shown_months, 'advisory', _emergency_evidence(6, 'full resilience')
                ))

    # ── FORECAST SIGNALS ─────────────────────────────────────────────────────
    fc_caveats = forecast_caveats(forecast)
    if forecast and 'forecast' in forecast:
        fc = forecast['forecast']
        insights = forecast.get('insights', {})
        income_trend = insights.get('income_momentum', 'stable')
        expense_trend = insights.get('expense_momentum', 'stable')
        savings_rate_fc = insights.get('savings_rate_pct', 0)  # noqa: F841  (kept: part of the forecast insights contract)
        projected_savings = insights.get('projected_savings_3m', 0)
        ml_signals['income_trend'] = income_trend
        ml_signals['expense_trend'] = expense_trend
        ml_signals['projected_3m_savings'] = projected_savings
        income_slope = fc.get('income', {}).get('slope')
        expense_slope = fc.get('expenses', {}).get('slope')
        trend_note = 'A trend is "rising" when the fitted straight line gains more than ₹500 per month.'

        if expense_trend == 'rising' and income_trend != 'rising':
            steps.append(_make_step(
                'FC-01', 'Alert: Expenses Rising Faster Than Income',
                f'The linear-regression trend shows spending is rising while income is {income_trend}. '
                f'Projected 3-month savings: ₹{projected_savings:,.0f}. '
                f'Conduct a category-level spend audit immediately.',
                'high', 'Immediate',
                'Stabilise expense-to-income ratio',
                None, 'alert',
                _evidence(
                    'expense_trend', 'Spending trend', expense_trend, None,
                    'Slope of a straight-line fit to monthly net spending and to monthly income. ' + trend_note,
                    [
                        _inp('Spending trend (slope)', None if expense_slope is None else round(expense_slope, 2), '₹/month per month'),
                        _inp('Income trend (slope)', None if income_slope is None else round(income_slope, 2), '₹/month per month'),
                        _inp('Income trend', income_trend, None),
                    ],
                    threshold={'comparator': 'is', 'value': 'rising', 'meaning': 'spending rising while income is not rising'},
                    contributors=_top_categories(health),
                    caveats=fc_caveats,
                )
            ))

        if income_trend == 'rising':
            steps.append(_make_step(
                'FC-02', 'Opportunity: Income Is Trending Upward',
                f'The forecast trend shows positive income momentum. Allocate 50% of any income increase '
                f'to investments — avoid lifestyle inflation.',
                'medium', 'Ongoing',
                'Capture income growth as long-term wealth',
                None, 'opportunity',
                _evidence(
                    'income_trend', 'Income trend', income_trend, None,
                    'Slope of a straight-line fit to monthly income. ' + trend_note,
                    [_inp('Income trend (slope)', None if income_slope is None else round(income_slope, 2), '₹/month per month')],
                    threshold={'comparator': 'is', 'value': 'rising', 'meaning': 'income gaining over time'},
                    caveats=fc_caveats,
                )
            ))

        if projected_savings < 0:
            months_f = fc.get('months', [])
            inc_p = fc.get('income', {}).get('predictions', [])
            exp_p = fc.get('expenses', {}).get('predictions', [])
            fc_inputs = []
            for i, month in enumerate(months_f):
                if i < len(inc_p):
                    fc_inputs.append(_inp(f'Forecast income {month}', inc_p[i], '₹'))
                if i < len(exp_p):
                    fc_inputs.append(_inp(f'Forecast net spending {month}', exp_p[i], '₹'))
            steps.append(_make_step(
                'FC-03', 'Forecast Predicts Negative Cash Flow Next 3 Months',
                f'The forecast projects a ₹{abs(projected_savings):,.0f} cash shortfall over the next 3 months. '
                f'Delay non-essential purchases and review upcoming EMIs.',
                'critical', 'Next 3 months',
                'Achieve positive cash flow projection',
                projected_savings, 'alert',
                _evidence(
                    'projected_savings_3m', 'Projected savings, next 3 months', projected_savings, '₹',
                    'Sum over the next 3 months of (forecast income − forecast net spending)',
                    fc_inputs,
                    threshold={'comparator': '<', 'value': 0, 'meaning': 'projected shortfall'},
                    contributors=_top_categories(health),
                    caveats=fc_caveats,
                )
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
            flagged, 'alert',
            _evidence(
                'anomalies_flagged', 'Flagged transactions', flagged, 'transactions',
                'IsolationForest isolates transactions whose amount and timing pattern is unusual for your own history',
                [
                    _inp('Flagged transactions', flagged, 'transactions'),
                    _inp('Total amount in flagged transactions', total_amt, '₹'),
                    _inp('Contamination rate (expected share of unusual transactions)', anomalies.get('contamination_rate'), None),
                ],
                contributors=[
                    {'id': a.get('id'), 'title': a.get('title'), 'amount': a.get('amount'), 'date': a.get('date'),
                     'severity': a.get('severity'), 'reason': a.get('reason')}
                    for a in (anomalies.get('anomalies') or [])[:5]
                ],
                caveats=['A statistical flag is not proof of fraud or an error: it only says the transaction is unusual for you.'],
            )
        ))

    # ── CLUSTER SIGNALS ────────────────────────────────────────────────────────
    if clusters and clusters.get('clusters'):
        cl_insights = clusters.get('insights', {})
        high_value_pct = cl_insights.get('high_value_exposure_pct', 0)
        fragmentation = cl_insights.get('spending_fragmentation', 'balanced')
        ml_signals['spending_fragmentation'] = fragmentation
        ml_signals['high_value_cluster_pct'] = high_value_pct
        silhouette = clusters.get('model_metrics', {}).get('silhouette_score')
        cluster_contrib = [
            {'label': c.get('label'), 'pct_of_total': c.get('pct_of_total'), 'transaction_count': c.get('transaction_count'),
             'avg_amount': c.get('centroid_amount')}
            for c in clusters['clusters']
        ]
        cluster_caveats = [f'Clusters group transactions by amount only (silhouette {silhouette}); they describe size, not purpose.'] if silhouette is not None else []

        if high_value_pct > 70:
            steps.append(_make_step(
                'CL-01', 'High Concentration in Large Transactions',
                f'Spending clustering (Agglomerative, Ward) shows {high_value_pct:.1f}% of your spending is in high-value transactions. '
                f'This indicates high fixed-cost exposure (EMIs, rent). '
                f'Consider restructuring fixed liabilities for more flexible cash flow.',
                'high', '2–3 months',
                'Reduce fixed-cost concentration below 60%',
                high_value_pct, 'advisory',
                _evidence(
                    'high_value_exposure_pct', 'Spending in the largest-amount cluster', high_value_pct, '%',
                    'Share of total spending value that sits in the highest-amount cluster',
                    [_inp('Share in the highest-amount cluster', high_value_pct, '%')],
                    threshold={'comparator': '>', 'value': 70, 'meaning': 'high concentration'},
                    contributors=cluster_contrib, caveats=cluster_caveats,
                )
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
                micro_cluster['transaction_count'], 'advisory',
                _evidence(
                    'micro_transaction_count', 'Small transactions', micro_cluster['transaction_count'], 'transactions',
                    'Number of spending transactions in the smallest-amount cluster',
                    [
                        _inp('Small transactions', micro_cluster['transaction_count'], 'transactions'),
                        _inp('Average amount', micro_cluster['centroid_amount'], '₹'),
                        _inp('Total amount', micro_cluster['total_amount'], '₹'),
                    ],
                    threshold={'comparator': '>', 'value': 20, 'meaning': 'many small transactions'},
                    contributors=cluster_contrib, caveats=cluster_caveats,
                )
            ))

    # ── Sort: priority, then the fixed category order, then the step id ───────
    steps.sort(key=lambda x: (x['priority_rank'], x['category_order'], x['step_id']))

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
    score_text = f"Overall health score: {score:.0f}/100 (rule-based). " if score is not None else ""
    plan_summary = (
        f"{score_text}"
        f"{len(steps)} action items from rule-based health checks and ML signals "
        f"(forecast, anomalies, spending clusters)."
    )

    from datetime import datetime, timezone
    return {
        'plan_title': plan_title,
        'plan_summary': plan_summary,
        'overall_score': score,
        'steps': steps,
        'forecast_caveats': fc_caveats,
        'ml_signals': ml_signals,
        'step_count': len(steps),
        'critical_count': critical_count,
        'high_count': high_count,
        'generated_at': datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + 'Z'
    }
