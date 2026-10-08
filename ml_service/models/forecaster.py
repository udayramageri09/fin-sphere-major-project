"""
forecaster.py — Linear Regression Forecaster

Uses sklearn LinearRegression to:
1. Fit monthly income and expense time-series
2. Predict the next N months
3. Compute trend slope (momentum indicator)
4. Compute MoM (month-over-month) growth rates
"""

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score
from datetime import datetime
import calendar

from models.analytics import add_analytical_columns


def _build_monthly_series(transactions: list[dict]) -> pd.DataFrame:
    """
    Aggregates transactions into a monthly income / spending DataFrame, using the analytical semantics of
    models/analytics.py (Issue #61): income = explicit income plus unclassified credits (refunds and transfers
    are NOT income); expenses = explicit expenses plus unclassified debits MINUS that month's refunds, floored at 0
    per month (transfers are NOT spending). A refund in one month never changes another month. Sums are exact
    integer paise, converted to rupees only here.
    Returns DataFrame with columns: month_label, month_idx, income, expenses, net
    """
    if not transactions:
        return pd.DataFrame()

    df = pd.DataFrame(transactions)
    df['date'] = pd.to_datetime(df['date'], errors='coerce')
    df = df.dropna(subset=['date'])
    df['amount'] = pd.to_numeric(df['amount'], errors='coerce').fillna(0)
    df['year_month'] = df['date'].dt.to_period('M')

    add_analytical_columns(df)
    paise = df.groupby('year_month')[['income_p', 'spending_p', 'refund_p']].sum()
    monthly = pd.DataFrame({
        'income': paise['income_p'] / 100,
        'expenses': (paise['spending_p'] - paise['refund_p']).clip(lower=0) / 100,
    }).reset_index()

    monthly = monthly.sort_values('year_month')
    monthly['month_idx'] = range(len(monthly))
    monthly['net'] = monthly['income'] - monthly['expenses']
    monthly['month_label'] = monthly['year_month'].dt.strftime('%b %Y')

    return monthly


def _fit_and_predict(X: np.ndarray, y: np.ndarray, n_future: int) -> dict:
    """
    Fits a LinearRegression and returns predictions + model stats.
    """
    if len(X) < 2:
        # Not enough data — return flat line at mean
        mean_val = float(np.mean(y)) if len(y) > 0 else 0
        return {
            'predictions': [mean_val] * n_future,
            'slope': 0.0,
            'intercept': mean_val,
            'r2': 0.0,
            'model': 'constant_mean'
        }

    model = LinearRegression()
    model.fit(X, y)

    # Future indices
    last_idx = X[-1][0]
    future_X = np.array([[last_idx + i + 1] for i in range(n_future)])
    preds = model.predict(future_X).tolist()

    r2 = float(r2_score(y, model.predict(X))) if len(X) >= 2 else 0.0

    return {
        'predictions': [max(0, p) for p in preds],  # clamp to non-negative
        'slope': float(model.coef_[0]),
        'intercept': float(model.intercept_),
        'r2': round(r2, 3),
        'model': 'linear_regression'
    }


def _month_label(base_period, offset: int) -> str:
    """Returns a month label N months after a pandas Period."""
    target = base_period + offset
    return target.strftime('%b %Y')


def run_forecaster(transactions: list[dict], n_future: int = 3) -> dict:
    """
    Main entry point.

    Returns:
    {
        "historical": [ { month_label, income, expenses, net } ... ],
        "forecast": {
            "months": ["Sep 2026", "Oct 2026", "Nov 2026"],
            "income":  { predictions, slope, intercept, r2, trend_direction },
            "expenses": { predictions, slope, intercept, r2, trend_direction },
            "net": [...]
        },
        "insights": {
            "income_momentum": "rising|falling|stable",
            "expense_momentum": "rising|falling|stable",
            "avg_monthly_savings": float,
            "projected_savings_3m": float,
            "savings_rate_pct": float
        }
    }
    """
    monthly = _build_monthly_series(transactions)

    if monthly.empty or len(monthly) < 1:
        return {'error': 'Insufficient transaction data for forecasting (need at least 1 month)'}

    X = monthly['month_idx'].values.reshape(-1, 1)
    y_income = monthly['income'].values.astype(float)
    y_expenses = monthly['expenses'].values.astype(float)

    income_result = _fit_and_predict(X, y_income, n_future)
    expense_result = _fit_and_predict(X, y_expenses, n_future)

    # Generate future month labels
    last_period = monthly['year_month'].iloc[-1]
    future_months = [_month_label(last_period, i + 1) for i in range(n_future)]

    # Net forecast
    net_forecast = [
        round(income_result['predictions'][i] - expense_result['predictions'][i], 2)
        for i in range(n_future)
    ]

    # Trend direction
    def _trend(slope: float) -> str:
        if slope > 500:
            return 'rising'
        elif slope < -500:
            return 'falling'
        return 'stable'

    income_trend = _trend(income_result['slope'])
    expense_trend = _trend(expense_result['slope'])

    avg_savings = float(monthly['net'].mean())
    projected_savings_3m = sum(net_forecast)
    avg_income = float(monthly['income'].mean())
    savings_rate = (avg_savings / avg_income * 100) if avg_income > 0 else 0.0

    historical = monthly[['month_label', 'income', 'expenses', 'net']].copy()
    historical['income'] = historical['income'].round(2)
    historical['expenses'] = historical['expenses'].round(2)
    historical['net'] = historical['net'].round(2)

    return {
        'historical': historical.to_dict(orient='records'),
        'forecast': {
            'months': future_months,
            'income': {
                **income_result,
                'predictions': [round(p, 2) for p in income_result['predictions']],
                'trend_direction': income_trend
            },
            'expenses': {
                **expense_result,
                'predictions': [round(p, 2) for p in expense_result['predictions']],
                'trend_direction': expense_trend
            },
            'net': net_forecast
        },
        'insights': {
            'income_momentum': income_trend,
            'expense_momentum': expense_trend,
            'avg_monthly_savings': round(avg_savings, 2),
            'projected_savings_3m': round(projected_savings_3m, 2),
            'savings_rate_pct': round(savings_rate, 1),
            'months_analyzed': len(monthly)
        }
    }
