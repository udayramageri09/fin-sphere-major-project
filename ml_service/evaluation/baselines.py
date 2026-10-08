"""
baselines.py - the naive forecasters the production forecaster must beat to justify itself.

Each baseline takes the history it is allowed to see (training months only, oldest first) and the horizon, and returns
`horizon` forecasts. None of them can see the future.
"""

from typing import Sequence


def last_value(history: Sequence[float], horizon: int) -> list:
    """Naive 'persistence': every future month equals the most recent month."""
    return [float(history[-1])] * horizon


def historical_mean(history: Sequence[float], horizon: int) -> list:
    """Every future month equals the mean of all training months."""
    m = sum(history) / len(history)
    return [float(m)] * horizon


def moving_average(history: Sequence[float], horizon: int, window: int = 3):
    """
    Mean of the last `window` months, repeated. Returns None when there is not enough history, so the caller can
    skip the baseline instead of silently shrinking the window.
    """
    if len(history) < window:
        return None
    m = sum(history[-window:]) / window
    return [float(m)] * horizon


BASELINES = {
    'last_value': last_value,
    'historical_mean': historical_mean,
    'moving_average_3': moving_average,
}
