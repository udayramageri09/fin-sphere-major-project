"""
health_scorer.py — Financial Health Composite Scorer

Computes standard financial ratios and produces a weighted composite score (0–100).
Letter grades: A (85+), B (70–84), C (55–69), D (<55)

Ratios:
  1. Savings Rate          = (Income - Expenses) / Income × 100         [weight: 25%]
  2. Expense Ratio         = Expenses / Income × 100 (lower is better)  [weight: 20%]
  3. Debt-to-Income (DTI)  = Monthly Debt Payments / Monthly Income × 100 [weight: 20%]
  4. Emergency Coverage    = Emergency Fund / Monthly Expenses (months)  [weight: 15%]
  5. Investment Rate       = Investment Credits / Income × 100           [weight: 10%]
  6. Cash Flow Positivity  = Positive Cash Flow Months / Total Months    [weight: 10%]

Ratios 1, 2, 5 and 6 come from the transactions alone. Ratio 3 needs the user's total monthly
debt payments (the sum of the monthly payments of their saved liabilities); ratio 4 needs an
emergency fund, which FinSphere does not store yet. When such an input is missing (None), or
the denominator cannot be computed, that ratio is OMITTED: it is never replaced by a default,
and the composite is renormalised over the ratios that exist. Missing is not zero: a real 0
counts as supplied and is scored as 0 (no debt payments -> DTI 0).

DTI is the conventional debt-service ratio: what share of monthly income goes to debt
payments. Outstanding balances (principal) and interest rates are not part of it.
Monthly income is the transactions' total income divided by the number of calendar months
that have any transaction (months with no transactions are not invented).
"""

import math

import numpy as np
import pandas as pd
from typing import Optional


_GRADE_THRESHOLDS = [
    (85, 'A', 'Excellent', '🟢'),
    (70, 'B', 'Good',      '🟡'),
    (55, 'C', 'Fair',      '🟠'),
    (0,  'D', 'Needs Work','🔴'),
]

_BENCHMARKS = {
    'savings_rate':      {'ideal': 30, 'acceptable': 20, 'poor': 10},
    'expense_ratio':     {'ideal': 50, 'acceptable': 70, 'poor': 85},  # lower is better
    # Lower is better. These are conventional MONTHLY debt-service DTI levels: the 36% guideline
    # (back-end DTI above ~36% is a strain), lenders' ~43% ceiling, and 50% as a danger zone.
    'dti':               {'ideal': 20, 'acceptable': 36, 'poor': 50},
    'emergency_months':  {'ideal': 6,  'acceptable': 3,  'poor': 1},
    'investment_rate':   {'ideal': 15, 'acceptable': 10, 'poor': 5},
    'positive_cf_rate':  {'ideal': 80, 'acceptable': 60, 'poor': 40},
}

# Score weights, summing to 1.0 when every ratio is available.
_WEIGHTS = {
    'savings_rate':         0.25,
    'expense_ratio':        0.20,
    'dti':                  0.20,
    'emergency_coverage':   0.15,
    'investment_rate':      0.10,
    'cash_flow_positivity': 0.10,
}

_LABELS = {
    'savings_rate':         'Savings Rate',
    'expense_ratio':        'Expense Control',
    'dti':                  'Debt-to-Income',
    'emergency_coverage':   'Emergency Coverage',
    'investment_rate':      'Investment Rate',
    'cash_flow_positivity': 'Cash Flow',
}


def _score_higher_better(value: float, ideal: float, acceptable: float, poor: float) -> float:
    """Scores a metric where higher is better. Returns 0–100."""
    if value >= ideal:
        return 100.0
    elif value >= acceptable:
        return 60 + (value - acceptable) / (ideal - acceptable) * 40
    elif value >= poor:
        return 20 + (value - poor) / (acceptable - poor) * 40
    else:
        return max(0, value / poor * 20)


def _score_lower_better(value: float, ideal: float, acceptable: float, poor: float) -> float:
    """Scores a metric where lower is better. Returns 0–100."""
    if value <= ideal:
        return 100.0
    elif value <= acceptable:
        return 60 + (acceptable - value) / (acceptable - ideal) * 40
    elif value <= poor:
        return 20 + (poor - value) / (poor - acceptable) * 40
    else:
        return max(0, (poor * 2 - value) / poor * 20)


def _grade(score: float) -> dict:
    for threshold, grade, label, emoji in _GRADE_THRESHOLDS:
        if score >= threshold:
            return {'grade': grade, 'label': label, 'emoji': emoji}
    return {'grade': 'D', 'label': 'Needs Work', 'emoji': '🔴'}


def _is_supplied(value) -> bool:
    """True for a real, finite, non-negative number. 0 counts as supplied;
    None, NaN, infinity, booleans and negative amounts count as missing."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value >= 0
    )


def run_health_scorer(
    transactions: list[dict],
    monthly_debt_payments: Optional[float] = None,
    emergency_fund: Optional[float] = None
) -> dict:
    """
    Main entry point for financial health scoring.

    monthly_debt_payments / emergency_fund are optional user-supplied amounts. None means "not
    available" (the matching ratio is omitted); 0 is a real value. monthly_debt_payments is the
    total of the user's monthly debt payments in rupees per month.

    Returns:
    {
        "composite_score": float (0–100, over the ratios that were available),
        "grade": { grade, label, emoji },
        "ratios": {
            "savings_rate": { value, score, benchmark, status },
            "expense_ratio": { ... },
            "dti": { ... },                  # omitted when debt payments or monthly income are unavailable
            "emergency_coverage": { ... },   # omitted when the emergency fund is unavailable
            "investment_rate": { ... },
            "cash_flow_positivity": { ... }
        },
        "unavailable_ratios": [str],         # e.g. ["dti", "emergency_coverage"]
        "strengths": [...str],
        "weaknesses": [...str],
        "recommendations": [...str]
    }
    """
    if not transactions:
        return {'error': 'No transaction data provided'}

    df = pd.DataFrame(transactions)
    df['amount'] = pd.to_numeric(df['amount'], errors='coerce').fillna(0)
    df['date'] = pd.to_datetime(df['date'], errors='coerce')
    df['year_month'] = df['date'].dt.to_period('M')

    total_income = float(df[df['amount'] > 0]['amount'].sum())
    total_expenses = float(df[df['amount'] < 0]['amount'].abs().sum())
    investment_credits = float(
        df[(df['amount'] > 0) & (df.get('category', pd.Series(dtype=str)).str.lower().str.contains('invest|dividend|mutual|stock', na=False))]['amount'].sum()
    )

    # Monthly cash flow positivity
    monthly = df.groupby('year_month')['amount'].sum()
    n_months = len(monthly)
    positive_months = int((monthly > 0).sum())
    positive_cf_rate = (positive_months / n_months * 100) if n_months > 0 else 0

    # Monthly expense average (for emergency coverage)
    avg_monthly_expenses = float(df[df['amount'] < 0]['amount'].abs().sum() / max(n_months, 1))

    # Ratios computed from the transactions alone
    savings_rate = ((total_income - total_expenses) / total_income * 100) if total_income > 0 else 0
    expense_ratio = (total_expenses / total_income * 100) if total_income > 0 else 100
    investment_rate = (investment_credits / total_income * 100) if total_income > 0 else 0

    # Ratios that need user-supplied data. Missing is not zero: without the input, or
    # without a usable denominator, the ratio is not produced at all.
    # Monthly income: real income transactions averaged over the months that have transactions.
    # No months with a valid date -> no monthly income -> no DTI (never income / 1 as a stand-in).
    monthly_income = (total_income / n_months) if n_months > 0 else 0.0
    dti = None
    if _is_supplied(monthly_debt_payments) and monthly_income > 0:
        dti = monthly_debt_payments / monthly_income * 100
    emergency_months = None
    if _is_supplied(emergency_fund) and avg_monthly_expenses > 0:
        emergency_months = emergency_fund / avg_monthly_expenses

    # Individual scores (only for ratios that exist)
    s_savings   = _score_higher_better(savings_rate, **_BENCHMARKS['savings_rate'])
    s_expense   = _score_lower_better(expense_ratio, **_BENCHMARKS['expense_ratio'])
    s_dti       = _score_lower_better(dti, **_BENCHMARKS['dti']) if dti is not None else None
    s_emergency = _score_higher_better(emergency_months, **_BENCHMARKS['emergency_months']) if emergency_months is not None else None
    s_invest    = _score_higher_better(investment_rate, **_BENCHMARKS['investment_rate'])
    s_cf        = _score_higher_better(positive_cf_rate, **_BENCHMARKS['positive_cf_rate'])

    scores = {'savings_rate': s_savings, 'expense_ratio': s_expense}
    if s_dti is not None:
        scores['dti'] = s_dti
    if s_emergency is not None:
        scores['emergency_coverage'] = s_emergency
    scores['investment_rate'] = s_invest
    scores['cash_flow_positivity'] = s_cf

    # Weighted composite, renormalised over the components that exist so it stays a true
    # 0–100 (with all six present the weights already sum to 1.0, so nothing changes).
    weight_total = sum(_WEIGHTS[key] for key in scores)
    composite = float(sum(_WEIGHTS[key] * score for key, score in scores.items()) / weight_total)

    def _status(s: float) -> str:
        if s >= 80: return 'good'
        elif s >= 50: return 'fair'
        return 'poor'

    ratios = {
        'savings_rate': {
            'value': round(savings_rate, 1),
            'score': round(s_savings, 1),
            'unit': '%',
            'benchmark': f"Ideal: ≥{_BENCHMARKS['savings_rate']['ideal']}%",
            'status': _status(s_savings),
            'description': 'Percentage of income saved'
        },
        'expense_ratio': {
            'value': round(expense_ratio, 1),
            'score': round(s_expense, 1),
            'unit': '%',
            'benchmark': f"Ideal: ≤{_BENCHMARKS['expense_ratio']['ideal']}%",
            'status': _status(s_expense),
            'description': 'Expenses as a share of income'
        },
    }
    if dti is not None:
        ratios['dti'] = {
            'value': round(dti, 1),
            'score': round(s_dti, 1),
            'unit': '%',
            'benchmark': f"Ideal: ≤{_BENCHMARKS['dti']['ideal']}%",
            'status': _status(s_dti),
            'description': 'Monthly debt payments as a share of monthly income'
        }
    if emergency_months is not None:
        ratios['emergency_coverage'] = {
            'value': round(emergency_months, 1),
            'score': round(s_emergency, 1),
            'unit': 'months',
            'benchmark': f"Ideal: ≥{_BENCHMARKS['emergency_months']['ideal']} months",
            'status': _status(s_emergency),
            'description': 'Emergency fund runway'
        }
    ratios['investment_rate'] = {
        'value': round(investment_rate, 1),
        'score': round(s_invest, 1),
        'unit': '%',
        'benchmark': f"Ideal: ≥{_BENCHMARKS['investment_rate']['ideal']}%",
        'status': _status(s_invest),
        'description': 'Investments as share of income'
    }
    ratios['cash_flow_positivity'] = {
        'value': round(positive_cf_rate, 1),
        'score': round(s_cf, 1),
        'unit': '%',
        'benchmark': f"Ideal: ≥{_BENCHMARKS['positive_cf_rate']['ideal']}%",
        'status': _status(s_cf),
        'description': 'Months with positive net cash flow'
    }

    unavailable_ratios = [key for key in ('dti', 'emergency_coverage') if key not in ratios]

    # Strengths and weaknesses (available components only)
    sorted_scores = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    strengths = [f"{_LABELS[key]} ({round(sc, 0):.0f}/100)" for key, sc in sorted_scores if sc >= 70]
    weaknesses = [f"{_LABELS[key]} ({round(sc, 0):.0f}/100)" for key, sc in sorted_scores if sc < 55]

    # Recommendations
    recommendations = []
    if s_savings < 60:
        shortfall = max(0, 20 - savings_rate)
        recommendations.append(f"Increase savings rate by {shortfall:.1f}% — target ₹{(total_income * shortfall / 100):.0f}/month more in savings")
    if s_expense > 0 and s_expense < 60:
        recommendations.append(f"Expense ratio is {expense_ratio:.1f}%. Trim discretionary spending to reach 70% ratio")
    if s_dti is not None and s_dti < 60:
        recommendations.append(f"Monthly debt payments take {dti:.1f}% of your monthly income — above the safe threshold. Prioritise paying down the highest-interest debt")
    if s_emergency is not None and s_emergency < 60:
        months_needed = 6 - emergency_months
        recommendations.append(f"Emergency fund covers only {emergency_months:.1f} months. Build ₹{months_needed * avg_monthly_expenses:,.0f} more")
    if s_invest < 50:
        recommendations.append(f"Investment rate is {investment_rate:.1f}%. Allocate at least 15% of income to growth assets")
    if not recommendations:
        if unavailable_ratios:
            recommendations.append("No issues found in the metrics that could be computed from your transactions")
        else:
            recommendations.append("Financial health is strong — consider tax-loss harvesting and international diversification")

    grade_info = _grade(composite)

    return {
        'composite_score': round(composite, 1),
        'grade': grade_info,
        'ratios': ratios,
        'unavailable_ratios': unavailable_ratios,
        'strengths': strengths[:3],
        'weaknesses': weaknesses[:3],
        'recommendations': recommendations,
        'metadata': {
            'total_income_analyzed': round(total_income, 2),
            'total_expenses_analyzed': round(total_expenses, 2),
            'months_analyzed': n_months,
            # Inputs the DTI was actually computed from (None when DTI is unavailable).
            'monthly_debt_payments_used': monthly_debt_payments if dti is not None else None,
            'monthly_income_used': round(monthly_income, 2) if dti is not None else None,
            'emergency_fund_used': emergency_fund if emergency_months is not None else None
        }
    }
