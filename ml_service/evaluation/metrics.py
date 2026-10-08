"""
metrics.py - forecast-error metrics and small statistics helpers for the evaluation suite.

Every metric states how it treats zeros, because monthly money series can legitimately contain 0:
  * MAE / RMSE are scale-dependent and always defined.
  * MAPE is only computed over points whose actual value is at least `eps` in magnitude; the number of points that
    were excluded is returned so the report can say how much of the series the metric really covers.
  * sMAPE uses |a| + |f| in the denominator; a point where both are 0 is a perfect forecast (error 0), not a division.
"""

import math
from typing import Sequence


def mae(actual: Sequence[float], forecast: Sequence[float]) -> float:
    return sum(abs(a - f) for a, f in zip(actual, forecast)) / len(actual)


def rmse(actual: Sequence[float], forecast: Sequence[float]) -> float:
    return math.sqrt(sum((a - f) ** 2 for a, f in zip(actual, forecast)) / len(actual))


def mape(actual: Sequence[float], forecast: Sequence[float], eps: float = 1.0):
    """
    Mean absolute percentage error in percent over points with |actual| >= eps (default: one rupee).
    Returns (value_or_None, n_used, n_excluded); value is None when no point qualifies.
    """
    pairs = [(a, f) for a, f in zip(actual, forecast) if abs(a) >= eps]
    excluded = len(actual) - len(pairs)
    if not pairs:
        return None, 0, excluded
    return sum(abs((a - f) / a) for a, f in pairs) / len(pairs) * 100, len(pairs), excluded


def smape(actual: Sequence[float], forecast: Sequence[float]):
    """Symmetric MAPE in percent (0-200). A point with actual == forecast == 0 contributes 0."""
    terms = []
    for a, f in zip(actual, forecast):
        denom = abs(a) + abs(f)
        terms.append(0.0 if denom == 0 else 2 * abs(a - f) / denom)
    return sum(terms) / len(terms) * 100 if terms else None


def error_summary(actual: Sequence[float], forecast: Sequence[float]) -> dict:
    """All four metrics for one set of (actual, forecast) pairs."""
    m, n_used, n_excluded = mape(actual, forecast)
    return {
        'n_points': len(actual),
        'mae': mae(actual, forecast),
        'rmse': rmse(actual, forecast),
        'mape_pct': m,
        'mape_points_used': n_used,
        'mape_points_excluded': n_excluded,
        'smape_pct': smape(actual, forecast),
    }


def mean(values: Sequence[float]) -> float:
    return sum(values) / len(values)


def std(values: Sequence[float]) -> float:
    """Population standard deviation (the replicates ARE the population being summarised)."""
    if not values:
        return 0.0
    m = mean(values)
    return math.sqrt(sum((v - m) ** 2 for v in values) / len(values))


def rnd(value, digits: int = 6):
    """Rounds floats for stable, diff-friendly JSON; leaves None / ints / strings alone."""
    if isinstance(value, float):
        return round(value, digits)
    return value


def round_tree(obj, digits: int = 6):
    """Rounds every float inside a nested dict/list structure."""
    if isinstance(obj, dict):
        return {k: round_tree(v, digits) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [round_tree(v, digits) for v in obj]
    return rnd(obj, digits)
