"""
fixtures.py - deterministic synthetic data for the evaluation suite.

Everything here is generated from fixed seeds and closed-form formulas: no network, no files, no real user data, no
wall-clock time. Calling a builder twice returns identical objects.

Transactions use the same shape the backend sends to the ML service:
  {id, title, amount (signed: expenses negative), date 'YYYY-MM-DD', type, category, classification}
"""

import math

import numpy as np

# ── seeds (documented in README.md) ───────────────────────────────────────────────────────────────────────────────
SEED_NOISY_SERIES = 7
SEED_ANOMALY_BASE = 1000      # replicate k of an anomaly scenario uses SEED_ANOMALY_BASE + k
SEED_CLUSTER_BASE = 2000      # replicate k of a clustering population uses SEED_CLUSTER_BASE + k
ANOMALY_REPLICATES = 25
CLUSTER_REPLICATES = 10
FORECAST_HORIZON = 3
FIRST_YEAR = 2022


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# Forecasting
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

def month_key(t: int) -> str:
    """Calendar month t months after January FIRST_YEAR, as 'YYYY-MM'."""
    return f'{FIRST_YEAR + t // 12}-{t % 12 + 1:02d}'


def _tx(i, date, type_, amount, category, classification):
    row = {
        'id': f'f{i}', 'title': f'row {i}', 'date': date, 'type': type_, 'category': category,
        'amount': round(abs(amount), 2) if type_ == 'income' else -round(abs(amount), 2),
    }
    if classification is not None:
        row['classification'] = classification
    return row


class ForecastCase:
    """
    One benchmark series. `truth_income[t]` / `truth_expense[t]` are the ANALYTICAL monthly values (what a correct
    classification-aware reading of the data should be) for EVERY calendar month t, including months that have no
    transactions (the generating function is the ground truth, because the data is synthetic).
    """

    def __init__(self, name, description, n_months, truth_income, truth_expense, present=None, min_train=6,
                 traps=False, label_mode='explicit'):
        self.name = name
        self.description = description
        self.n_months = n_months
        self.truth_income = truth_income
        self.truth_expense = truth_expense
        self.present = present if present is not None else list(range(n_months))   # calendar months with transactions
        self.min_train = min_train
        self.traps = traps                 # add refund / transfer rows around the real ones
        self.label_mode = label_mode       # 'explicit' | 'unknown' | 'legacy_unlabelled'

    def transactions_before(self, t: int) -> list:
        """Every transaction dated in a calendar month < t (the training data for an origin at t)."""
        rows, i = [], 0
        for m in self.present:
            if m >= t:
                continue
            date5, date10 = f'{month_key(m)}-05', f'{month_key(m)}-10'
            inc_cls = {'explicit': 'income', 'unknown': 'unknown', 'legacy_unlabelled': None}[self.label_mode]
            exp_cls = {'explicit': 'expense', 'unknown': 'unknown', 'legacy_unlabelled': None}[self.label_mode]
            if self.traps:
                # the real income / expense plus what a bank statement also contains: the analytical truth is
                # income = truth_income, spending = truth_expense (gross spending minus the refund)
                refund = 4000
                rows.append(_tx(i := i + 1, date5, 'income', self.truth_income[m], 'Salary', inc_cls))
                rows.append(_tx(i := i + 1, date5, 'income', 25000, 'General', 'transfer' if inc_cls else None))
                rows.append(_tx(i := i + 1, date10, 'income', refund, 'Shopping', 'refund' if inc_cls else None))
                rows.append(_tx(i := i + 1, date10, 'expense', self.truth_expense[m] + refund, 'Bills', exp_cls))
                rows.append(_tx(i := i + 1, date10, 'expense', 20000, 'General', 'transfer' if exp_cls else None))
            else:
                rows.append(_tx(i := i + 1, date5, 'income', self.truth_income[m], 'Salary', inc_cls))
                rows.append(_tx(i := i + 1, date10, 'expense', self.truth_expense[m], 'Bills', exp_cls))
        return rows


def build_forecast_cases() -> list:
    n = 24
    t = np.arange(n)
    rng = np.random.RandomState(SEED_NOISY_SERIES)
    noisy_inc = 60000 * (1 + 0.06 * rng.randn(n))
    noisy_exp = 35000 * (1 + 0.06 * rng.randn(n))

    def arr(a):
        return [round(float(x), 2) for x in a]

    stable_i, stable_e = arr(np.full(n, 60000.0)), arr(np.full(n, 35000.0))
    up_i, up_e = arr(40000 + 1200 * t), arr(25000 + 700 * t)
    down_i, down_e = arr(80000 - 1200 * t), arr(50000 - 800 * t)
    seas_i = arr(60000 + 9000 * np.sin(2 * math.pi * t / 12))
    seas_e = arr(35000 + 7000 * np.sin(2 * math.pi * (t + 3) / 12))
    gap_present = [m for m in range(n) if m % 3 != 2]       # every third calendar month has no transactions

    return [
        ForecastCase('stable', 'constant income 60,000 and spending 35,000', n, stable_i, stable_e),
        ForecastCase('linear_up', 'income +1,200 / month, spending +700 / month', n, up_i, up_e),
        ForecastCase('linear_down', 'income -1,200 / month, spending -800 / month', n, down_i, down_e),
        ForecastCase('noisy_stable', f'stable level with 6% seeded Gaussian noise (seed {SEED_NOISY_SERIES})', n, arr(noisy_inc), arr(noisy_exp)),
        ForecastCase('seasonal', '12-month sine pattern around a stable level (a straight line cannot represent it)', n, seas_i, seas_e),
        ForecastCase('sparse_history', 'only 5 months of history (linear up); training windows of 2-4 months', 5, arr(40000 + 1200 * np.arange(5)), arr(25000 + 700 * np.arange(5)), min_train=2),
        ForecastCase('missing_months', 'linear up, but every third calendar month has NO transactions (the model sees only the present months)', n, up_i, up_e, present=gap_present, min_train=7),
        ForecastCase('classification_traps', 'stable truth, but each month also has a 25,000 transfer-in, a 4,000 refund and a 20,000 transfer-out (classified)', n, stable_i, [35000.0 - 4000.0] * n, traps=True),
        ForecastCase('classification_traps_unlabelled', 'the SAME rows as classification_traps with no classification (what the model saw before classification existed)', n, stable_i, [35000.0 - 4000.0] * n, traps=True, label_mode='legacy_unlabelled'),
        ForecastCase('unknown_stable', 'stable series stored as classification "unknown" (historical / imported rows)', n, stable_i, stable_e, label_mode='unknown'),
        ForecastCase('unknown_linear_up', 'linear-up series stored as classification "unknown"', n, up_i, up_e, label_mode='unknown'),
    ]


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# Anomaly detection (controlled SYNTHETIC injection - there are no fraud labels)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

ANOMALY_SCENARIOS = {
    'isolated_large_outlier': 'one expense 60x the median amount',
    'date_pattern_outlier': 'one typical-sized expense on day 31 when every other transaction is on days 3-26',
    'large_transfer': 'one transfer-out 60x the median amount (classification transfer)',
    'large_refund': 'one refund 50x the median amount (classification refund)',
    'multiple_anomalies': 'five large movements (30x-90x the median, mixed expense / income / transfer / refund) among 200 rows',
    'clean_no_anomaly': 'no injected anomaly (every flagged row is, by construction, a false positive)',
}


def build_anomaly_dataset(scenario: str, seed: int):
    """Returns (transactions, set_of_injected_ids, n_normal)."""
    rng = np.random.RandomState(seed)
    n_normal = 200 if scenario == 'multiple_anomalies' else 100
    rows = []
    for i in range(n_normal):
        amount = round(float(math.exp(rng.normal(math.log(800), 0.5))), 2)
        month, day = int(rng.randint(3, 6)), int(rng.randint(3, 27))
        is_income = rng.rand() < 0.15
        rows.append({
            'id': f'n{i}', 'title': f'normal {i}', 'date': f'2026-{month:02d}-{day:02d}', 'category': 'General',
            'type': 'income' if is_income else 'expense', 'classification': 'income' if is_income else 'expense',
            'amount': amount if is_income else -amount,
        })
    median = float(np.median([abs(r['amount']) for r in rows]))
    injected = []

    def inject(k, multiple, type_, classification, date='2026-04-15'):
        amount = round(median * multiple, 2)
        injected.append({'id': f'x{k}', 'title': f'injected {k}', 'date': date, 'category': 'General', 'type': type_,
                         'classification': classification, 'amount': amount if type_ == 'income' else -amount})

    if scenario == 'isolated_large_outlier':
        inject(0, 60, 'expense', 'expense')
    elif scenario == 'date_pattern_outlier':
        inject(0, 1.0, 'expense', 'expense', date='2026-03-31')
    elif scenario == 'large_transfer':
        inject(0, 60, 'expense', 'transfer')
    elif scenario == 'large_refund':
        inject(0, 50, 'income', 'refund')
    elif scenario == 'multiple_anomalies':
        for k, (mult, type_, cls) in enumerate([(30, 'expense', 'expense'), (45, 'income', 'income'), (60, 'expense', 'transfer'),
                                                 (75, 'income', 'refund'), (90, 'expense', 'expense')]):
            inject(k, mult, type_, cls, date=f'2026-04-{10 + k:02d}')
    elif scenario != 'clean_no_anomaly':
        raise ValueError(scenario)
    return rows + injected, {r['id'] for r in injected}, n_normal


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# Clustering (synthetic spending populations)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

CLUSTER_POPULATIONS = {
    'three_groups': 'daily small (120 x ~60), medium recurring (30 x ~1,500) and high-value (6 x ~40,000) expenses',
    'two_groups': 'daily small (120 x ~60) and high-value (6 x ~40,000) only: the data has 2 natural groups',
    'one_group': 'one homogeneous group (150 x ~500): there is no cluster structure at all',
    'with_extreme_outlier': 'small + medium expenses plus ONE 1,000,000 expense',
}


def _expense(i, rng, amount, group, classification='expense', type_='expense'):
    month, day = int(rng.randint(3, 6)), int(rng.randint(3, 27))
    return {'id': f'c{i}', 'title': f'{group} {i}', 'date': f'2026-{month:02d}-{day:02d}', 'category': 'General',
            'type': type_, 'classification': classification, 'amount': -round(abs(amount), 2), '_group': group}


def build_cluster_population(name: str, seed: int):
    """Returns (transactions, {id: generating_group}). `_group` is stripped from the rows sent to the model."""
    rng = np.random.RandomState(seed)
    groups = []
    if name == 'three_groups':
        groups = [('small', 120, 60, 15), ('medium', 30, 1500, 300), ('high', 6, 40000, 5000)]
    elif name == 'two_groups':
        groups = [('small', 120, 60, 15), ('high', 6, 40000, 5000)]
    elif name == 'one_group':
        groups = [('only', 150, 500, 50)]
    elif name == 'with_extreme_outlier':
        groups = [('small', 100, 60, 15), ('medium', 30, 1500, 300)]
    else:
        raise ValueError(name)
    rows, i = [], 0
    for group, count, mean_, sd in groups:
        for _ in range(count):
            rows.append(_expense(i, rng, max(5.0, rng.normal(mean_, sd)), group)); i += 1
    if name == 'with_extreme_outlier':
        rows.append(_expense(i, rng, 1_000_000, 'outlier'))
    truth = {r['id']: r.pop('_group') for r in rows}
    return rows, truth
