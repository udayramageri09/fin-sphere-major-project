"""
health_scorer.py — Financial Health Composite Scorer

Computes 6 standard financial ratios and produces a weighted composite score (0–100).
Letter grades: A (85+), B (70–84), C (55–69), D (<55)

Ratios:
  1. Savings Rate          = (Income - Expenses) / Income × 100         [weight: 25%]
  2. Expense Ratio         = Expenses / Income × 100 (lower is better)  [weight: 20%]
  3. Debt-to-Income (DTI)  = Liabilities / Annual Income × 100          [weight: 20%]
  4. Emergency Coverage    = Emergency Fund / Monthly Expenses (months)  [weight: 15%]
  5. Investment Rate       = Investment Credits / Income × 100           [weight: 10%]
  6. Cash Flow Positivity  = Positive Cash Flow Months / Total Months    [weight: 10%]
"""

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
    'dti':               {'ideal': 20, 'acceptable': 36, 'poor': 50},  # lower is better
    'emergency_months':  {'ideal': 6,  'acceptable': 3,  'poor': 1},
    'investment_rate':   {'ideal': 15, 'acceptable': 10, 'poor': 5},
    'positive_cf_rate':  {'ideal': 80, 'acceptable': 60, 'poor': 40},
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


def run_health_scorer(
    transactions: list[dict],
    liabilities: float = 2450000,
    base_net_worth: float = 4500000,
    emergency_fund: float = 300000,
    emergency_target: float = 500000
) -> dict:
    """
    Main entry point for financial health scoring.

    Returns:
    {
        "composite_score": float (0–100),
        "grade": { grade, label, emoji },
        "ratios": {
            "savings_rate": { value, score, benchmark, status },
            "expense_ratio": { ... },
            "dti": { ... },
            "emergency_coverage": { ... },
            "investment_rate": { ... },
            "cash_flow_positivity": { ... }
        },
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

    # Ratios
    savings_rate = ((total_income - total_expenses) / total_income * 100) if total_income > 0 else 0
    expense_ratio = (total_expenses / total_income * 100) if total_income > 0 else 100
    annual_income = total_income / max(n_months, 1) * 12
    dti = (liabilities / annual_income * 100) if annual_income > 0 else 100
    emergency_months = (emergency_fund / avg_monthly_expenses) if avg_monthly_expenses > 0 else 0
    investment_rate = (investment_credits / total_income * 100) if total_income > 0 else 0

    # Individual scores
    s_savings   = _score_higher_better(savings_rate, **_BENCHMARKS['savings_rate'])
    s_expense   = _score_lower_better(expense_ratio, **_BENCHMARKS['expense_ratio'])
    s_dti       = _score_lower_better(dti, **_BENCHMARKS['dti'])
    s_emergency = _score_higher_better(emergency_months, **_BENCHMARKS['emergency_months'])
    s_invest    = _score_higher_better(investment_rate, **_BENCHMARKS['investment_rate'])
    s_cf        = _score_higher_better(positive_cf_rate, **_BENCHMARKS['positive_cf_rate'])

    # Weighted composite
    weights = [0.25, 0.20, 0.20, 0.15, 0.10, 0.10]
    scores  = [s_savings, s_expense, s_dti, s_emergency, s_invest, s_cf]
    composite = float(np.dot(weights, scores))

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
        'dti': {
            'value': round(dti, 1),
            'score': round(s_dti, 1),
            'unit': '%',
            'benchmark': f"Ideal: ≤{_BENCHMARKS['dti']['ideal']}%",
            'status': _status(s_dti),
            'description': 'Debt-to-Income ratio (annual)'
        },
        'emergency_coverage': {
            'value': round(emergency_months, 1),
            'score': round(s_emergency, 1),
            'unit': 'months',
            'benchmark': f"Ideal: ≥{_BENCHMARKS['emergency_months']['ideal']} months",
            'status': _status(s_emergency),
            'description': 'Emergency fund runway'
        },
        'investment_rate': {
            'value': round(investment_rate, 1),
            'score': round(s_invest, 1),
            'unit': '%',
            'benchmark': f"Ideal: ≥{_BENCHMARKS['investment_rate']['ideal']}%",
            'status': _status(s_invest),
            'description': 'Investments as share of income'
        },
        'cash_flow_positivity': {
            'value': round(positive_cf_rate, 1),
            'score': round(s_cf, 1),
            'unit': '%',
            'benchmark': f"Ideal: ≥{_BENCHMARKS['positive_cf_rate']['ideal']}%",
            'status': _status(s_cf),
            'description': 'Months with positive net cash flow'
        }
    }

    # Strengths and weaknesses
    score_map = {
        'savings_rate': ('Savings Rate', s_savings),
        'expense_ratio': ('Expense Control', s_expense),
        'dti': ('Debt-to-Income', s_dti),
        'emergency_coverage': ('Emergency Coverage', s_emergency),
        'investment_rate': ('Investment Rate', s_invest),
        'cash_flow_positivity': ('Cash Flow', s_cf)
    }
    sorted_scores = sorted(score_map.items(), key=lambda x: x[1][1], reverse=True)
    strengths = [f"{name} ({round(sc, 0):.0f}/100)" for _, (name, sc) in sorted_scores if sc >= 70]
    weaknesses = [f"{name} ({round(sc, 0):.0f}/100)" for _, (name, sc) in sorted_scores if sc < 55]

    # Recommendations
    recommendations = []
    if s_savings < 60:
        shortfall = max(0, 20 - savings_rate)
        recommendations.append(f"Increase savings rate by {shortfall:.1f}% — target ₹{(total_income * shortfall / 100):.0f}/month more in savings")
    if s_expense > 0 and s_expense < 60:
        recommendations.append(f"Expense ratio is {expense_ratio:.1f}%. Trim discretionary spending to reach 70% ratio")
    if s_dti < 60:
        recommendations.append(f"DTI ratio is {dti:.1f}% — above safe threshold. Prioritise debt prepayment")
    if s_emergency < 60:
        months_needed = 6 - emergency_months
        recommendations.append(f"Emergency fund covers only {emergency_months:.1f} months. Build ₹{months_needed * avg_monthly_expenses:,.0f} more")
    if s_invest < 50:
        recommendations.append(f"Investment rate is {investment_rate:.1f}%. Allocate at least 15% of income to growth assets")
    if not recommendations:
        recommendations.append("Financial health is strong — consider tax-loss harvesting and international diversification")

    grade_info = _grade(composite)

    return {
        'composite_score': round(composite, 1),
        'grade': grade_info,
        'ratios': ratios,
        'strengths': strengths[:3],
        'weaknesses': weaknesses[:3],
        'recommendations': recommendations,
        'metadata': {
            'total_income_analyzed': round(total_income, 2),
            'total_expenses_analyzed': round(total_expenses, 2),
            'months_analyzed': n_months,
            'liabilities_used': liabilities,
            'emergency_fund_used': emergency_fund
        }
    }
