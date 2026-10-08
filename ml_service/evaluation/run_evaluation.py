"""
run_evaluation.py - reproducible evaluation of the FinSphere ML service.

    python -m ml_service.evaluation.run_evaluation            (from the repository root)

Writes, next to this file:
    results/evaluation_results.json   machine-readable records + detailed sections
    results/EVALUATION_REPORT.md      human-readable report GENERATED from those results

No number in the report is typed in by hand: everything is computed here from the deterministic fixtures in
fixtures.py. The suite never changes production code, never touches the network and never reads user data.
"""

import argparse
import json
import platform
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import sklearn
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics import adjusted_rand_score, silhouette_score
from sklearn.preprocessing import StandardScaler

HERE = Path(__file__).resolve().parent
ML_DIR = HERE.parent
ROOT = ML_DIR.parent
for p in (str(ROOT), str(ML_DIR)):          # ML_DIR makes `models.*` importable exactly as main.py imports it
    if p not in sys.path:
        sys.path.insert(0, p)

from ml_service.evaluation import baselines as bl          # noqa: E402
from ml_service.evaluation import fixtures as fx            # noqa: E402
from ml_service.evaluation import metrics as mt             # noqa: E402
from models import health_scorer as hs                      # noqa: E402
from models.anomaly import run_anomaly_detection            # noqa: E402
from models.clustering import run_clustering                # noqa: E402
from models.forecaster import _build_monthly_series, run_forecaster  # noqa: E402
from models.plan_generator import generate_plan             # noqa: E402

TARGETS = ('income', 'expenses', 'net')
SHORT = {'last_value': 'last', 'historical_mean': 'mean', 'moving_average_3': 'ma3'}


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# Audit (static facts about the production code; verified by the checks below where they are testable)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

def audit() -> list:
    return [
        {'component': 'forecaster', 'file': 'models/forecaster.py', 'class': 'statistical model fitted per request (ordinary least squares, supervised regression)',
         'algorithm': 'sklearn LinearRegression of monthly income and of monthly net spending on a month index, fitted separately',
         'inputs': 'monthly aggregates of the user\'s own transactions (classification-aware: income, spending net of refunds, transfers excluded)',
         'outputs': 'next n months (default 3) of income and spending, net, slopes, in-sample R2, trend labels (+/-500 rupees per month slope threshold)',
         'training': 'none persisted: it is re-fitted on the user\'s history on every request; no model file, no dataset',
         'randomness': 'none (closed-form least squares)', 'min_history': '1 month (constant mean), 2+ months for a fitted line; predictions are clamped at 0',
         'notes': ['the month index is the position among months that HAVE transactions, so a missing calendar month is collapsed (see the missing_months benchmark)',
                   'R2 is in-sample, not a held-out accuracy', 'statsmodels is listed in requirements.txt but is not imported anywhere']},
        {'component': 'anomaly_detector', 'file': 'models/anomaly.py', 'class': 'trained unsupervised ML, fitted per request (transductive: it scores the same rows it is fitted on)',
         'algorithm': 'sklearn IsolationForest (100 trees) on StandardScaler-scaled [abs_amount, day_of_week, day_of_month]',
         'inputs': 'every transaction regardless of classification (intentional: unusual money movement, not only spending)',
         'outputs': 'the flagged rows, most anomalous first, score, severity (score < -0.2 is "high"), a reason string',
         'training': 'none persisted', 'randomness': 'random_state=42 (deterministic)', 'min_history': '5 transactions',
         'notes': ['contamination = min(0.15, max(1/n, 0.05)): it ALWAYS flags a fixed share (>= 5%, >= 1 row) of the rows, even in a clean dataset',
                   'no fraud labels exist, so detection quality can only be measured on synthetic injected anomalies']},
        {'component': 'clustering', 'file': 'models/clustering.py', 'class': 'unsupervised ML fitted per request',
         'algorithm': 'sklearn AgglomerativeClustering, Ward linkage, k fixed at 3, on StandardScaler-scaled [abs_amount, is_expense]',
         'inputs': 'analytical spending transactions only (explicit expenses + unclassified debits; income, refunds and transfers are excluded)',
         'outputs': 'three clusters sorted by mean amount (micro / mid-range / high-value), silhouette score, an inertia proxy',
         'training': 'none persisted', 'randomness': 'none (Ward linkage is deterministic)', 'min_history': '3 spending transactions',
         'notes': ['k is not selected from the data: it is always 3', 'is_expense is constant after filtering, so only the amount drives the clusters',
                   'the plan rules and ML metadata call this "KMeans" although the algorithm is Agglomerative (a naming inconsistency, not a numerical one)']},
        {'component': 'health_scorer', 'file': 'models/health_scorer.py', 'class': 'heuristic / deterministic rule system (no learning)',
         'algorithm': 'six ratios scored 0-100 by piecewise-linear benchmark curves and combined with fixed weights; weights renormalised over available ratios',
         'inputs': 'classification-aware income / spending, monthly debt payments, emergency fund', 'outputs': 'composite score, grade, per-ratio score and status, recommendations',
         'training': 'none', 'randomness': 'none', 'min_history': '1 transaction',
         'notes': ['the benchmarks (e.g. savings 20% / 30%, DTI 36%) are conventional rules of thumb, not fitted to data']},
        {'component': 'plan_generator', 'file': 'models/plan_generator.py', 'class': 'heuristic / deterministic rule engine (no learning)',
         'algorithm': 'if/else threshold rules over the outputs of the four components above', 'inputs': 'forecast, anomalies, clusters, health outputs',
         'outputs': 'prioritised action steps', 'training': 'none', 'randomness': 'none', 'min_history': 'n/a',
         'notes': ['it is not machine learning; its quality is rule correctness, which is evaluated by boundary and coverage checks']},
    ]


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# Forecaster
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

FORECAST_LIMITS = [
    'synthetic series: they show how the model behaves on known shapes, not how well it predicts a real person\'s finances',
    'rolling-origin evaluation: each origin trains only on months strictly before it and is scored on the next 3 months',
    'origins overlap, so the points are not independent; treat differences as indicative, not as significance tests',
]


def _metric_fn(kind):
    return {'mae': lambda a, f: mt.mae(a, f), 'rmse': lambda a, f: mt.rmse(a, f), 'smape_pct': lambda a, f: mt.smape(a, f)}[kind]


def eval_forecaster() -> dict:
    H = fx.FORECAST_HORIZON
    cases_out, records = [], []
    wins = {name: {'wins': 0, 'losses': 0, 'ties': 0} for name in bl.BASELINES}
    for case in fx.build_forecast_cases():
        origins = [t for t in range(case.min_train, case.n_months - H + 1) if (t - 1) in case.present]
        per_origin = []
        for t in origins:
            train = case.transactions_before(t)
            out = run_forecaster(train, H)
            if 'error' in out:
                continue
            monthly = _build_monthly_series(train)
            hist = {'income': monthly['income'].astype(float).tolist(), 'expenses': monthly['expenses'].astype(float).tolist()}
            hist['net'] = [i - e for i, e in zip(hist['income'], hist['expenses'])]
            model = {'income': out['forecast']['income']['predictions'], 'expenses': out['forecast']['expenses']['predictions'], 'net': out['forecast']['net']}
            truth_i = [case.truth_income[t + h] for h in range(H)]
            truth_e = [case.truth_expense[t + h] for h in range(H)]
            truth = {'income': truth_i, 'expenses': truth_e, 'net': [i - e for i, e in zip(truth_i, truth_e)]}
            base = {tgt: {name: fn(hist[tgt], H) for name, fn in bl.BASELINES.items()} for tgt in TARGETS}
            per_origin.append({'origin': t, 'n_train_months': len(hist['income']), 'truth': truth, 'model': model, 'base': base})
        case_out = {'name': case.name, 'description': case.description, 'n_calendar_months': case.n_months,
                    'n_months_with_data': len(case.present), 'n_origins': len(per_origin), 'horizon': H, 'targets': {}}
        for tgt in TARGETS:
            tgt_out = {'model': None, 'baselines': {}}
            actual_all = [v for o in per_origin for v in o['truth'][tgt]]
            model_all = [v for o in per_origin for v in o['model'][tgt]]
            if not actual_all:
                case_out['targets'][tgt] = tgt_out
                continue
            tgt_out['model'] = mt.error_summary(actual_all, model_all)
            for name in bl.BASELINES:
                sub = [o for o in per_origin if o['base'][tgt][name] is not None]
                if not sub:
                    tgt_out['baselines'][name] = {'available': False, 'reason': 'not enough history for this baseline at any origin'}
                    continue
                a = [v for o in sub for v in o['truth'][tgt]]
                m = [v for o in sub for v in o['model'][tgt]]
                b = [v for o in sub for v in o['base'][tgt][name]]
                ms, bs = mt.error_summary(a, m), mt.error_summary(a, b)
                diff = bs['mae'] - ms['mae']
                rel = diff / bs['mae'] * 100 if bs['mae'] > 0 else None
                verdict = 'tie' if abs(diff) <= 1e-9 else ('model_better' if diff > 0 else 'baseline_better')
                wins[name]['wins' if verdict == 'model_better' else 'losses' if verdict == 'baseline_better' else 'ties'] += 1
                tgt_out['baselines'][name] = {'available': True, 'n_origins_compared': len(sub), 'model_on_same_points': ms, 'baseline': bs,
                                              'mae_baseline_minus_model': diff, 'mae_relative_improvement_pct': rel, 'verdict': verdict}
                for kind in ('mae', 'rmse', 'smape_pct'):
                    records.append({
                        'component': 'forecaster', 'scenario': case.name, 'target': tgt, 'metric': kind.upper().replace('_PCT', ''),
                        'value': ms[kind], 'baseline': name, 'baseline_value': bs[kind],
                        'beats_baseline': (ms[kind] < bs[kind] - 1e-9) if ms[kind] is not None and bs[kind] is not None else None,
                        'interpretation': _forecast_interpretation(case.name, tgt, name, kind, ms[kind], bs[kind]),
                        'limitations': FORECAST_LIMITS})
                if ms['mape_pct'] is not None and bs['mape_pct'] is not None:
                    records.append({'component': 'forecaster', 'scenario': case.name, 'target': tgt, 'metric': 'MAPE', 'value': ms['mape_pct'],
                                    'baseline': name, 'baseline_value': bs['mape_pct'], 'beats_baseline': ms['mape_pct'] < bs['mape_pct'] - 1e-9,
                                    'interpretation': _forecast_interpretation(case.name, tgt, name, 'mape_pct', ms['mape_pct'], bs['mape_pct']),
                                    'limitations': FORECAST_LIMITS + [f'MAPE excludes points with |actual| < 1 rupee ({ms["mape_points_excluded"]} excluded here)']})
            case_out['targets'][tgt] = tgt_out
        cases_out.append(case_out)

    by_name = {c['name']: c for c in cases_out}
    summary = {'comparisons_by_baseline': wins, 'n_series': len(cases_out)}
    best_baseline_wins = 0
    pairs = 0
    for c in cases_out:
        for tgt in TARGETS:
            t = c['targets'][tgt]
            if not t['model']:
                continue
            avail = [b for b in t['baselines'].values() if b.get('available')]
            if not avail:
                continue
            pairs += 1
            if all(b['verdict'] == 'model_better' for b in avail):
                best_baseline_wins += 1
    summary['series_targets_where_model_beats_every_available_baseline'] = best_baseline_wins
    summary['series_targets_compared'] = pairs

    # classification effect: the same rows with and without their classification
    def mae_of(name, tgt='expenses'):
        return by_name[name]['targets'][tgt]['model']['mae'] if by_name[name]['targets'][tgt]['model'] else None
    summary['classification_effect'] = {tgt: {'mae_with_classification': mae_of('classification_traps', tgt), 'mae_rows_without_classification': mae_of('classification_traps_unlabelled', tgt)} for tgt in ('income', 'expenses', 'net')}
    summary['unknown_equals_explicit'] = {
        'stable': {tgt: (mae_of('unknown_stable', tgt), mae_of('stable', tgt)) for tgt in TARGETS},
        'linear_up': {tgt: (mae_of('unknown_linear_up', tgt), mae_of('linear_up', tgt)) for tgt in TARGETS}}
    summary['unknown_equals_explicit_flag'] = all(abs((a or 0) - (b or 0)) < 1e-9 for series in summary['unknown_equals_explicit'].values() for a, b in series.values())
    # the missing-month finding, in one comparable number
    gm, lu = by_name['missing_months']['targets']['income']['model'], by_name['linear_up']['targets']['income']['model']
    summary['missing_months_effect'] = {'income_mae_with_missing_months': gm['mae'] if gm else None, 'income_mae_complete_history': lu['mae'] if lu else None}
    return {'cases': cases_out, 'summary': summary, 'records': records}


def _forecast_interpretation(case, tgt, base, kind, m, b):
    if m is None or b is None:
        return f'{kind} is not defined for this comparison'
    verdict = 'beats' if m < b - 1e-9 else ('loses to' if m > b + 1e-9 else 'ties with')
    return f'On "{case}" ({tgt}) the linear-regression model {verdict} the {base} baseline on {kind} ({m:.4g} vs {b:.4g}); lower is better.'


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# Anomaly detector (controlled SYNTHETIC evaluation)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

def _mad_flags(rows):
    """Statistical baseline: robust z-score of |amount| (median / MAD); flag > 3.5."""
    amounts = np.array([abs(r['amount']) for r in rows])
    med = np.median(amounts)
    mad = np.median(np.abs(amounts - med)) or 1e-9
    z = 0.6745 * (amounts - med) / mad
    return [r['id'] for r, v in zip(rows, z) if v > 3.5]


def _confusion(flagged, injected, n_normal):
    tp = len([x for x in flagged if x in injected])
    fp = len(flagged) - tp
    return {'n_flagged': len(flagged), 'tp': tp, 'fp': fp,
            'recall': (tp / len(injected)) if injected else None,
            'precision': (tp / len(flagged)) if flagged and injected else (None if not injected else 0.0),
            'false_positive_rate': fp / n_normal}


def eval_anomaly() -> dict:
    scenarios_out, records = {}, []
    for scenario, desc in fx.ANOMALY_SCENARIOS.items():
        reps, mad_reps, contamination = [], [], None
        for k in range(fx.ANOMALY_REPLICATES):
            rows, injected, n_normal = fx.build_anomaly_dataset(scenario, fx.SEED_ANOMALY_BASE + k)
            out = run_anomaly_detection(rows)
            contamination = out['contamination_rate']
            flagged = [a['id'] for a in out['anomalies']]
            c = _confusion(flagged, injected, n_normal)
            ranks = [flagged.index(i) + 1 for i in injected if i in flagged]
            c['mean_rank_of_injected_among_flagged'] = (sum(ranks) / len(ranks)) if ranks else None
            c['top_k_hit_rate'] = (len([i for i in flagged[:len(injected)] if i in injected]) / len(injected)) if injected else None
            c['flag_rate'] = len(flagged) / len(rows)
            reps.append(c)
            mad_reps.append(_confusion(_mad_flags(rows), injected, n_normal))

        def agg(rs, key):
            vals = [r[key] for r in rs if r[key] is not None]
            return {'mean': mt.mean(vals), 'std': mt.std(vals), 'n_replicates_defined': len(vals)} if vals else {'mean': None, 'std': None, 'n_replicates_defined': 0}
        keys = ['n_flagged', 'recall', 'precision', 'false_positive_rate', 'flag_rate', 'mean_rank_of_injected_among_flagged', 'top_k_hit_rate']
        model_summary = {k: agg(reps, k) for k in keys if k in reps[0]}
        mad_summary = {k: agg(mad_reps, k) for k in ('n_flagged', 'recall', 'precision', 'false_positive_rate')}
        n_inj = len(fx.build_anomaly_dataset(scenario, fx.SEED_ANOMALY_BASE)[1])
        scenarios_out[scenario] = {'description': desc, 'n_injected_per_dataset': n_inj, 'replicates': fx.ANOMALY_REPLICATES,
                                   'contamination_rate_used': contamination, 'isolation_forest': model_summary, 'robust_mad_baseline': mad_summary}
        for metric in ('recall', 'precision', 'false_positive_rate', 'n_flagged'):
            v, b = model_summary[metric]['mean'], mad_summary[metric]['mean']
            if v is None:
                continue
            records.append({'component': 'anomaly_detector', 'scenario': scenario, 'metric': metric, 'value': v, 'baseline': 'robust_mad_z_gt_3.5',
                            'baseline_value': b, 'interpretation': f'controlled synthetic anomaly-detection evaluation, mean over {fx.ANOMALY_REPLICATES} seeded datasets: IsolationForest {metric} = {v:.4g} vs robust-MAD baseline {b:.4g}.',
                            'limitations': ANOMALY_LIMITS})

    # the fixed-flag-rate limitation, measured: clean data of growing size
    sizes = {}
    for n in (20, 50, 100, 200, 500, 1000):
        rng = np.random.RandomState(fx.SEED_ANOMALY_BASE)
        rows = [{'id': f'n{i}', 'title': 't', 'date': f'2026-03-{int(rng.randint(3, 27)):02d}', 'category': 'General', 'type': 'expense', 'classification': 'expense',
                 'amount': -round(float(np.exp(rng.normal(np.log(800), 0.5))), 2)} for i in range(n)]
        out = run_anomaly_detection(rows)
        sizes[str(n)] = {'n_rows': n, 'n_flagged': out['total_flagged'], 'flag_rate': out['total_flagged'] / n, 'contamination_rate': out['contamination_rate']}
    # classification independence + determinism
    ident = True
    for k in range(5):
        rows, _, _ = fx.build_anomaly_dataset('large_transfer', fx.SEED_ANOMALY_BASE + k)
        a = [x['id'] for x in run_anomaly_detection(rows)['anomalies']]
        stripped = [{kk: v for kk, v in r.items() if kk != 'classification'} for r in rows]
        b = [x['id'] for x in run_anomaly_detection(stripped)['anomalies']]
        again = [x['id'] for x in run_anomaly_detection(rows)['anomalies']]
        ident = ident and a == b == again
    return {'scenarios': scenarios_out, 'clean_data_flag_rate_by_size': sizes, 'classification_independent_and_deterministic': ident, 'records': records}


ANOMALY_LIMITS = [
    'controlled synthetic anomaly-detection evaluation: injected anomalies are simple large amounts / one odd date, NOT real fraud; this is not fraud-detection accuracy',
    'the algorithm flags a fixed share of rows (contamination >= 5%) whatever the data, so precision is capped and the false-positive rate on clean data is non-zero by construction',
    'the model is fitted and scored on the same rows (transductive)',
]


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# Clustering
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

def _labels_by_id(out):
    return {t['id']: t['cluster_id'] for t in out['labeled_transactions']}


def eval_clustering() -> dict:
    pops, records = {}, []
    for name, desc in fx.CLUSTER_POPULATIONS.items():
        reps = []
        for k in range(fx.CLUSTER_REPLICATES):
            rows, truth = fx.build_cluster_population(name, fx.SEED_CLUSTER_BASE + k)
            out = run_clustering(rows)
            labels = _labels_by_id(out)
            ids = [r['id'] for r in rows]
            again = _labels_by_id(run_clustering(rows))
            shuffled_rows = list(np.random.RandomState(fx.SEED_CLUSTER_BASE + k + 1).permutation(np.array(rows, dtype=object)))
            shuffled = _labels_by_id(run_clustering(shuffled_rows))
            sizes = [c['transaction_count'] for c in sorted(out['clusters'], key=lambda c: c['id'])]
            centroids = [c['centroid_amount'] for c in sorted(out['clusters'], key=lambda c: c['id'])]
            # k check: silhouette for k=2..5 on the standardised amounts, to see whether k=3 is what the data suggests
            amounts = np.array([[abs(r['amount'])] for r in rows])
            X = StandardScaler().fit_transform(amounts)
            sil_by_k = {}
            for kk in range(2, 6):
                try:
                    sil_by_k[kk] = float(silhouette_score(X, AgglomerativeClustering(n_clusters=kk, linkage='ward').fit_predict(X)))
                except Exception:
                    sil_by_k[kk] = None
            valid = {kk: v for kk, v in sil_by_k.items() if v is not None}
            reps.append({
                'silhouette': out['model_metrics']['silhouette_score'], 'inertia_proxy': out['model_metrics']['inertia_proxy'],
                'cluster_sizes': sizes, 'centroids': centroids, 'centroids_sorted_ascending': centroids == sorted(centroids),
                'ari_vs_generating_groups': adjusted_rand_score([truth[i] for i in ids], [labels[i] for i in ids]),
                'rerun_identical': labels == again,
                'ari_after_row_shuffle': adjusted_rand_score([labels[i] for i in ids], [shuffled[i] for i in ids]),
                'best_silhouette_k': max(valid, key=valid.get) if valid else None, 'silhouette_by_k': sil_by_k})
        def col(key):
            return [r[key] for r in reps]
        pops[name] = {
            'description': desc, 'replicates': fx.CLUSTER_REPLICATES, 'k_used': 3,
            'silhouette': {'mean': mt.mean(col('silhouette')), 'std': mt.std(col('silhouette'))},
            'inertia_proxy': {'mean': mt.mean(col('inertia_proxy')), 'std': mt.std(col('inertia_proxy'))},
            'adjusted_rand_vs_generating_groups_SYNTHETIC': {'mean': mt.mean(col('ari_vs_generating_groups')), 'std': mt.std(col('ari_vs_generating_groups'))},
            'rerun_identical_all': all(col('rerun_identical')), 'min_ari_after_row_shuffle': min(col('ari_after_row_shuffle')),
            'centroids_always_sorted_ascending': all(col('centroids_sorted_ascending')),
            'first_replicate_cluster_sizes': reps[0]['cluster_sizes'], 'first_replicate_centroids': reps[0]['centroids'],
            'best_silhouette_k_counts': {str(kk): col('best_silhouette_k').count(kk) for kk in range(2, 6)},
            'silhouette_by_k_mean': {str(kk): mt.mean([r['silhouette_by_k'][kk] for r in reps if r['silhouette_by_k'][kk] is not None]) for kk in range(2, 6)}}
        records.append({'component': 'clustering', 'scenario': name, 'metric': 'silhouette', 'value': pops[name]['silhouette']['mean'], 'baseline': None, 'baseline_value': None,
                        'interpretation': f'Mean silhouette {pops[name]["silhouette"]["mean"]:.3f} over {fx.CLUSTER_REPLICATES} seeded populations ("{name}"); k is fixed at 3 regardless of the data.',
                        'limitations': CLUSTER_LIMITS})
        records.append({'component': 'clustering', 'scenario': name, 'metric': 'adjusted_rand_vs_generating_groups', 'value': pops[name]['adjusted_rand_vs_generating_groups_SYNTHETIC']['mean'],
                        'baseline': None, 'baseline_value': None,
                        'interpretation': 'Agreement with the synthetic generator\'s groups (1.0 = identical partition). This is recovery of known synthetic structure, NOT classification accuracy on real data.',
                        'limitations': CLUSTER_LIMITS})

    edge = _clustering_edge_cases()
    return {'populations': pops, 'edge_cases': edge, 'records': records}


CLUSTER_LIMITS = [
    'unsupervised: there are no true labels for real spending; silhouette / ARI are computed on SYNTHETIC populations with known structure',
    'k is hard-coded to 3 (no model selection), so data with 1 or 2 natural groups is still split into 3',
    'clusters are driven by the amount alone (the is_expense feature is constant after filtering)',
]


def _clustering_edge_cases() -> list:
    checks = []

    def add(name, ok, detail=''):
        checks.append({'name': name, 'passed': bool(ok), 'detail': detail})
    base = lambda i, amt, **kw: {'id': f'e{i}', 'title': 't', 'date': '2026-03-10', 'category': 'General', 'type': 'expense', 'classification': 'expense', 'amount': -amt, **kw}
    out = run_clustering([base(0, 10), base(1, 20)])
    add('fewer than 3 spending rows -> empty result with an explanatory message', out['clusters'] == [] and 'at least 3' in out['insights'].get('message', ''), str(out['insights']))
    out = run_clustering([{'id': 'i1', 'title': 'pay', 'date': '2026-03-01', 'category': 'Salary', 'type': 'income', 'classification': 'income', 'amount': 50000}] + [base(i, 10) for i in range(2)])
    add('income rows never count toward the minimum', out['clusters'] == [])
    same = run_clustering([base(i, 100.0) for i in range(30)])
    add('nearly identical rows: runs, labels every row, no crash', len(same['labeled_transactions']) == 30 and len(same['clusters']) >= 1, f'{len(same["clusters"])} cluster(s) reported')
    near = run_clustering([base(i, 100.0 + (i % 3) * 0.01) for i in range(30)])
    add('rows differing by a paisa: still partitions deterministically (rerun identical)', _labels_by_id(near) == _labels_by_id(run_clustering([base(i, 100.0 + (i % 3) * 0.01) for i in range(30)])))
    rows, _ = fx.build_cluster_population('with_extreme_outlier', fx.SEED_CLUSTER_BASE)
    out = run_clustering(rows)
    top = max(out['clusters'], key=lambda c: c['id'])
    add('one extreme outlier forms (or dominates) the high-value cluster: its share of the total is ~ the outlier\'s', top['transaction_count'] <= 3 and top['pct_of_total'] > 80, f'cluster 2 holds {top["transaction_count"]} row(s) = {top["pct_of_total"]}% of the amount')
    mix = [base(i, 50 * (i + 1)) for i in range(6)]
    extras = [{'id': 'inc', 'title': 'pay', 'date': '2026-03-01', 'category': 'Salary', 'type': 'income', 'classification': 'income', 'amount': 90000},
              {'id': 'ref', 'title': 'ref', 'date': '2026-03-02', 'category': 'Shopping', 'type': 'income', 'classification': 'refund', 'amount': 500},
              {'id': 'tin', 'title': 'tin', 'date': '2026-03-03', 'category': 'General', 'type': 'income', 'classification': 'transfer', 'amount': 20000},
              {'id': 'tout', 'title': 'tout', 'date': '2026-03-04', 'category': 'General', 'type': 'expense', 'classification': 'transfer', 'amount': -20000},
              {'id': 'unk_debit', 'title': 'u', 'date': '2026-03-05', 'category': 'General', 'type': 'expense', 'classification': 'unknown', 'amount': -75},
              {'id': 'unk_credit', 'title': 'u', 'date': '2026-03-06', 'category': 'General', 'type': 'income', 'classification': 'unknown', 'amount': 75}]
    ids = set(_labels_by_id(run_clustering(mix + extras)))
    add('transfers, refunds and income are excluded from clustering', not ({'inc', 'ref', 'tin', 'tout'} & ids), str(sorted(ids)))
    add('unknown debit-direction rows are clustered (fallback); unknown credits are not', 'unk_debit' in ids and 'unk_credit' not in ids)
    add('rows without a classification field follow the unknown fallback', 'nc' in _labels_by_id(run_clustering(mix + [{'id': 'nc', 'title': 'x', 'date': '2026-03-07', 'category': 'General', 'type': 'expense', 'amount': -60}])))
    return checks


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# Health scorer (deterministic rule system: boundary / reweighting / missing-data correctness, not "accuracy")
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

class Checks:
    def __init__(self):
        self.items = []

    def add(self, name, ok, detail=''):
        self.items.append({'name': name, 'passed': bool(ok), 'detail': detail})

    def summary(self):
        return {'total': len(self.items), 'passed': sum(1 for c in self.items if c['passed']), 'failed': [c['name'] for c in self.items if not c['passed']], 'checks': self.items}


def _txn(i, date, type_, classification, amount, category='General'):
    row = {'id': f'h{i}', 'title': 't', 'date': date, 'type': type_, 'category': category, 'amount': abs(amount) if type_ == 'income' else -abs(amount)}
    if classification is not None:
        row['classification'] = classification
    return row


def eval_health_scorer() -> dict:
    c = Checks()
    approx = lambda a, b, tol=1e-9: a is not None and abs(a - b) <= tol
    # 1. every benchmark curve at its anchor points, and shape properties on a fine grid
    for key, b in hs._BENCHMARKS.items():
        lower = key in ('expense_ratio', 'dti')
        fn = hs._score_lower_better if lower else hs._score_higher_better
        ideal, acc, poor = b['ideal'], b['acceptable'], b['poor']
        c.add(f'{key}: score(ideal) = 100, score(acceptable) = 60, score(poor) = 20', approx(fn(ideal, **b), 100) and approx(fn(acc, **b), 60) and approx(fn(poor, **b), 20),
              f'{fn(ideal, **b):.4g}/{fn(acc, **b):.4g}/{fn(poor, **b):.4g}')
        lo, hi = (0, max(ideal, acc, poor) * 3)
        grid = [lo + (hi - lo) * i / 3000 for i in range(3001)]
        scores = [fn(v, **b) for v in grid]
        mono = all((s2 <= s1 + 1e-9) if lower else (s2 >= s1 - 1e-9) for s1, s2 in zip(scores, scores[1:]))
        c.add(f'{key}: monotone in the right direction, always within [0, 100]', mono and all(-1e-9 <= s <= 100 + 1e-9 for s in scores))
        c.add(f'{key}: continuous (largest step between neighbouring grid points is small)', max(abs(s2 - s1) for s1, s2 in zip(scores, scores[1:])) < 1.5, f'max step {max(abs(s2 - s1) for s1, s2 in zip(scores, scores[1:])):.3f}')
    # 2. grade boundaries
    for score, want in ((100, 'A'), (85, 'A'), (84.9, 'B'), (70, 'B'), (69.9, 'C'), (55, 'C'), (54.9, 'D'), (0, 'D')):
        c.add(f'grade({score}) = {want}', hs._grade(score)['grade'] == want)
    c.add('weights sum to 1.0 when every ratio is present', approx(sum(hs._WEIGHTS.values()), 1.0))
    # 3. exact threshold cases through the public entry point
    r = hs.run_health_scorer([_txn(1, '2026-03-01', 'income', 'income', 1000), _txn(2, '2026-03-02', 'expense', 'expense', 800)])
    c.add('savings rate exactly 20% scores exactly 60', r['ratios']['savings_rate']['value'] == 20 and r['ratios']['savings_rate']['score'] == 60, str(r['ratios']['savings_rate']))
    r = hs.run_health_scorer([_txn(1, '2026-03-01', 'income', 'income', 1000), _txn(2, '2026-03-02', 'expense', 'expense', 700)])
    c.add('savings rate exactly 30% scores 100', r['ratios']['savings_rate']['score'] == 100)
    r = hs.run_health_scorer([_txn(1, '2026-03-01', 'income', 'income', 100000)], monthly_debt_payments=36000)
    c.add('DTI exactly 36% (36000 / 100000) scores exactly 60', r['ratios']['dti']['value'] == 36 and r['ratios']['dti']['score'] == 60)
    r = hs.run_health_scorer([_txn(1, '2026-03-01', 'income', 'income', 100000)], monthly_debt_payments=20000)
    c.add('DTI 20% = 20000 / 100000 and scores 100', r['ratios']['dti']['value'] == 20 and r['ratios']['dti']['score'] == 100)
    r = hs.run_health_scorer([_txn(1, '2026-03-01', 'expense', 'expense', 20000)], emergency_fund=60000)
    c.add('emergency coverage exactly 3 months (60000 / 20000) scores exactly 60', r['ratios']['emergency_coverage']['value'] == 3 and r['ratios']['emergency_coverage']['score'] == 60)
    # 4. component reweighting
    def renorm(res):
        w = sum(hs._WEIGHTS[k] for k in res['ratios'])
        return sum(hs._WEIGHTS[k] * v['score'] for k, v in res['ratios'].items()) / w
    base_t = [_txn(1, '2026-03-01', 'income', 'income', 100000), _txn(2, '2026-03-02', 'expense', 'expense', 60000)]
    for label, kw in (('4 ratios (no debt, no fund)', {}), ('5 ratios (+DTI)', {'monthly_debt_payments': 30000}), ('5 ratios (+emergency)', {'emergency_fund': 90000}), ('6 ratios', {'monthly_debt_payments': 30000, 'emergency_fund': 90000})):
        res = hs.run_health_scorer(base_t, **kw)
        c.add(f'composite is the weight-renormalised average of the available scores: {label}', abs(renorm(res) - res['composite_score']) < 0.06, f'{renorm(res):.3f} vs {res["composite_score"]}')
    # 5. missing-data semantics
    res = hs.run_health_scorer(base_t)
    c.add('no debt payments / no fund -> DTI and emergency coverage are unavailable, not defaulted', 'dti' not in res['ratios'] and 'emergency_coverage' not in res['ratios'] and res['unavailable_ratios'] == ['dti', 'emergency_coverage'])
    res0 = hs.run_health_scorer(base_t, monthly_debt_payments=0, emergency_fund=0)
    c.add('a real 0 is supplied: DTI 0.0 and 0.0 months of coverage', res0['ratios']['dti']['value'] == 0 and res0['ratios']['emergency_coverage']['value'] == 0)
    c.add('negative debt payments / negative fund are treated as missing', 'dti' not in hs.run_health_scorer(base_t, monthly_debt_payments=-1)['ratios'] and 'emergency_coverage' not in hs.run_health_scorer(base_t, emergency_fund=-5)['ratios'])
    res = hs.run_health_scorer([_txn(1, '2026-03-01', 'expense', 'expense', 100)], monthly_debt_payments=500)
    c.add('zero income -> DTI unavailable (no 100% fallback)', 'dti' not in res['ratios'])
    res = hs.run_health_scorer([_txn(1, '2026-03-01', 'income', 'income', 100)], emergency_fund=500)
    c.add('no spending -> emergency coverage unavailable (no division by zero)', 'emergency_coverage' not in res['ratios'])
    c.add('no transactions -> an error payload, no score', 'error' in hs.run_health_scorer([]))
    c.add('deterministic: identical input gives identical output', hs.run_health_scorer(base_t, monthly_debt_payments=30000) == hs.run_health_scorer(base_t, monthly_debt_payments=30000))
    # 6. classification-aware inputs
    mixed = [_txn(1, '2026-03-01', 'income', 'income', 1000), _txn(2, '2026-03-02', 'income', 'refund', 300), _txn(3, '2026-03-03', 'income', 'transfer', 500), _txn(4, '2026-03-04', 'income', 'unknown', 250),
             _txn(5, '2026-03-05', 'expense', 'expense', 400), _txn(6, '2026-03-06', 'expense', 'transfer', 900), _txn(7, '2026-03-07', 'expense', 'unknown', 100), _txn(8, '2026-03-08', 'income', None, 50)]
    res = hs.run_health_scorer(mixed)
    c.add('income = explicit income + unknown credits (+ rows with no classification); refunds and transfer-ins excluded (1000 + 250 + 50)', res['metadata']['total_income_analyzed'] == 1300, str(res['metadata']))
    c.add('spending = expenses + unknown debits - refunds, transfer-out excluded: 400 + 100 - 300 = 200', res['metadata']['total_expenses_analyzed'] == 200)
    mm = hs.run_health_scorer([_txn(1, '2026-01-01', 'expense', 'expense', 20000), _txn(2, '2026-02-01', 'expense', 'expense', 20000), _txn(3, '2026-03-01', 'expense', 'expense', 20000), _txn(4, '2026-03-02', 'income', 'refund', 90000)], emergency_fund=40000)
    c.add('a refund exceeding one month\'s spending floors THAT month at 0 only: total (20000 + 20000 + 0) / 3 months', mm['metadata']['total_expenses_analyzed'] == 40000 and mm['metadata']['months_analyzed'] == 3)
    return c.summary()


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# Plan generator (rule engine: coverage, thresholds, conflicts, missing inputs, dependencies)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

def _health(savings=None, dti=None, emergency_exact=None, score=60.0):
    ratios = {}
    if savings is not None:
        ratios['savings_rate'] = {'value': savings}
    if dti is not None:
        ratios['dti'] = {'value': dti}
    meta = {}
    if emergency_exact is not None:
        fund, total, months = emergency_exact
        ratios['emergency_coverage'] = {'value': round(fund * months / total, 1)}
        meta = {'emergency_fund_used': fund, 'total_expenses_analyzed': total, 'months_analyzed': months}
    return {'composite_score': score, 'grade': {'grade': 'C'}, 'ratios': ratios, 'metadata': meta}


def _forecast(income='stable', expense='stable', projected=0.0):
    return {'forecast': {}, 'insights': {'income_momentum': income, 'expense_momentum': expense, 'savings_rate_pct': 0, 'projected_savings_3m': projected}}


def _clusters(high_pct=0.0, micro_count=0):
    return {'clusters': [{'id': 0, 'transaction_count': micro_count, 'centroid_amount': 50, 'total_amount': 50 * micro_count}], 'insights': {'high_value_exposure_pct': high_pct, 'spending_fragmentation': 'balanced'}}


def _anoms(n=0):
    return {'total_flagged': n, 'anomalies': [{'title': 'x', 'amount': -100}] * n if n else [], 'insights': {'total_amount_in_anomalies': 100 * n}}


def eval_plan_generator() -> dict:
    c = Checks()
    ids = lambda plan: sorted(s['step_id'] for s in plan['steps'])
    run = lambda **kw: generate_plan(kw.get('forecast', {}), kw.get('anomalies', {}), kw.get('clusters', {}), kw.get('health', {}))
    fired = set()

    def expect(name, plan, want, absent=()):
        got = set(ids(plan))
        fired.update(got)
        c.add(name, set(want) <= got and not (set(absent) & got), f'fired {sorted(got)}')
    # thresholds, both sides of every boundary
    expect('HS-01 fires for savings 9.99%', run(health=_health(savings=9.99)), ['HS-01'], ['HS-02'])
    expect('savings exactly 10% is HS-02, not HS-01', run(health=_health(savings=10)), ['HS-02'], ['HS-01'])
    expect('savings 19.99% -> HS-02', run(health=_health(savings=19.99)), ['HS-02'])
    expect('savings exactly 20% -> no savings rule', run(health=_health(savings=20)), [], ['HS-01', 'HS-02'])
    expect('HS-03 fires for DTI 50.01%', run(health=_health(dti=50.01)), ['HS-03'], ['HS-04'])
    expect('DTI exactly 50% is HS-04, not HS-03', run(health=_health(dti=50)), ['HS-04'], ['HS-03'])
    expect('DTI 36.01% -> HS-04', run(health=_health(dti=36.01)), ['HS-04'])
    expect('DTI exactly 36% -> no DTI rule', run(health=_health(dti=36)), [], ['HS-03', 'HS-04'])
    expect('HS-05 for coverage 2.999 months (exact inputs 59.98 / 20)', run(health=_health(emergency_exact=(59980, 60000, 3))), ['HS-05'], ['HS-06'])
    expect('coverage exactly 3.0 months -> HS-06', run(health=_health(emergency_exact=(60000, 60000, 3))), ['HS-06'], ['HS-05'])
    expect('coverage 5.999 -> HS-06', run(health=_health(emergency_exact=(119980, 60000, 3))), ['HS-06'])
    expect('coverage exactly 6.0 months -> no emergency rule', run(health=_health(emergency_exact=(120000, 60000, 3))), [], ['HS-05', 'HS-06'])
    expect('the displayed 1-decimal ratio never decides: 2.99995 months displays 3.0 but is HS-05', run(health=_health(emergency_exact=(59999, 60000, 3))), ['HS-05'])
    expect('FC-01: expenses rising while income is not', run(forecast=_forecast('stable', 'rising')), ['FC-01'], ['FC-02'])
    expect('FC-01 does not fire when income is rising too', run(forecast=_forecast('rising', 'rising')), ['FC-02'], ['FC-01'])
    expect('FC-02: income rising', run(forecast=_forecast('rising', 'stable')), ['FC-02'])
    expect('FC-03 fires for projected savings -0.01', run(forecast=_forecast(projected=-0.01)), ['FC-03'])
    expect('FC-03 does not fire at exactly 0', run(forecast=_forecast(projected=0.0)), [], ['FC-03'])
    expect('AN-01 fires for 1 flagged transaction', run(anomalies=_anoms(1)), ['AN-01'])
    c.add('AN-01 priority is "medium" for 2 flagged and "high" for 3', next(s for s in run(anomalies=_anoms(2))['steps'] if s['step_id'] == 'AN-01')['priority'] == 'medium' and next(s for s in run(anomalies=_anoms(3))['steps'] if s['step_id'] == 'AN-01')['priority'] == 'high')
    expect('no AN-01 when nothing is flagged', run(anomalies=_anoms(0)), [], ['AN-01'])
    expect('CL-01 fires for a 70.01% high-value share', run(clusters=_clusters(high_pct=70.01)), ['CL-01'])
    expect('CL-01 does not fire at exactly 70%', run(clusters=_clusters(high_pct=70)), [], ['CL-01'])
    expect('CL-02 fires for 21 micro transactions', run(clusters=_clusters(micro_count=21)), ['CL-02'])
    expect('CL-02 does not fire at exactly 20', run(clusters=_clusters(micro_count=20)), [], ['CL-02'])
    # missing inputs
    empty = run()
    c.add('all inputs empty -> no steps, no score (nothing is invented)', empty['steps'] == [] and empty['overall_score'] is None, str(empty['plan_title']))
    c.add('a health result without a composite score fires no health rule', run(health={'ratios': {'savings_rate': {'value': 1}}})['steps'] == [])
    c.add('absent DTI / emergency ratios fire no DTI / emergency rule', not ({'HS-03', 'HS-04', 'HS-05', 'HS-06'} & set(ids(run(health=_health(savings=50))))))
    c.add('emergency ratio without usable metadata fires no emergency rule (no fabricated coverage)', not ({'HS-05', 'HS-06'} & set(ids(run(health={'composite_score': 60, 'ratios': {'emergency_coverage': {'value': 1.0}}, 'metadata': {}})))))
    # conflicts: mutually exclusive families never co-fire anywhere on a grid
    conflicts = []
    for s in (0, 5, 9.99, 10, 15, 19.99, 20, 40):
        for d in (0, 20, 36, 36.01, 50, 50.01, 90):
            for fund in (0, 30000, 59999, 60000, 100000, 120000, 300000):
                got = set(ids(run(health=_health(savings=s, dti=d, emergency_exact=(fund, 60000, 3)))))
                for fam in ({'HS-01', 'HS-02'}, {'HS-03', 'HS-04'}, {'HS-05', 'HS-06'}):
                    if len(fam & got) > 1:
                        conflicts.append((s, d, fund, sorted(fam & got)))
    c.add('mutually exclusive rule families (HS-01/02, HS-03/04, HS-05/06) never fire together on a 392-point grid', not conflicts, str(conflicts[:2]))
    # priority ordering
    big = run(health=_health(savings=5, dti=60, emergency_exact=(0, 60000, 3)), forecast=_forecast('stable', 'rising', -5000), clusters=_clusters(80, 25), anomalies=_anoms(4))
    fired.update(ids(big))
    ranks = [s['priority_rank'] for s in big['steps']]
    c.add('steps are sorted by priority (critical first) when many rules fire', ranks == sorted(ranks), str(ranks))
    c.add('the plan title escalates with the number of critical steps', 'Urgent' in big['plan_title'] and 'Maintenance' in run(health=_health(savings=50), forecast=_forecast())['plan_title'])
    # dependency on component outputs: flipping one input toggles exactly the rules that read it
    a, b = set(ids(run(forecast=_forecast('stable', 'stable', 100)))), set(ids(run(forecast=_forecast('stable', 'stable', -100))))
    c.add('flipping only the projected cash flow toggles exactly FC-03', (b - a) == {'FC-03'} and not (a - b))
    a, b = set(ids(run(clusters=_clusters(60, 0)))), set(ids(run(clusters=_clusters(80, 0))))
    c.add('flipping only the cluster high-value share toggles exactly CL-01', (b - a) == {'CL-01'} and not (a - b))
    a, b = set(ids(run(anomalies=_anoms(0)))), set(ids(run(anomalies=_anoms(2))))
    c.add('flipping only the anomaly count toggles exactly AN-01', (b - a) == {'AN-01'} and not (a - b))
    # rule coverage: every step id that appears in the source was exercised
    src = (ML_DIR / 'models' / 'plan_generator.py').read_text(encoding='utf-8')
    declared = sorted(set(re.findall(r"'([A-Z]{2}-\d{2})'", src)))
    uncovered = [i for i in declared if i not in fired]
    c.add(f'rule coverage: all {len(declared)} step ids declared in plan_generator.py fire in at least one scenario', not uncovered, f'declared {declared}; uncovered {uncovered}')
    out = c.summary()
    out['rules_declared'] = declared
    out['rules_fired'] = sorted(fired)
    return out


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# Orchestration and report
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

def derive_findings(sections: dict) -> list:
    """Plain-language findings computed from the measured numbers (no value is typed in)."""
    out = []
    fc = sections['forecaster']
    losses = []
    for c in fc['cases']:
        for tgt in TARGETS:
            t = c['targets'][tgt]
            for name, b in t['baselines'].items():
                if b.get('available') and b['verdict'] == 'baseline_better':
                    losses.append((c['name'], tgt, name))
    if losses:
        series = sorted({x[0] for x in losses})
        out.append({'component': 'forecaster', 'severity': 'limitation',
                    'finding': f'The model LOSES to at least one naive baseline on: {", ".join(series)} ({len(losses)} series x target x baseline comparisons). '
                               'A straight line cannot represent seasonality and over-reacts to noise, where a historical mean does better. Reported as measured; the benchmark was not changed.'})
    wins = sum(w['wins'] for w in fc['summary']['comparisons_by_baseline'].values())
    out.append({'component': 'forecaster', 'severity': 'info',
                'finding': f'Across all baseline comparisons the model was strictly better {wins} times; many comparisons tie (MAE 0 for everyone) on perfectly stable series, where there is nothing to predict.'})
    mm = fc['summary']['missing_months_effect']
    if mm['income_mae_with_missing_months'] is not None and mm['income_mae_complete_history'] is not None and mm['income_mae_with_missing_months'] > mm['income_mae_complete_history'] + 1e-9:
        out.append({'component': 'forecaster', 'severity': 'potential_defect',
                    'finding': f'Months with no transactions are collapsed (the regression index counts only months that have data). On an exact linear trend with every third month missing, income MAE is '
                               f'{mm["income_mae_with_missing_months"]:.0f} vs {mm["income_mae_complete_history"]:.0f} with complete history. Reported only; production code was not changed.'})
    ce = fc['summary']['classification_effect']
    if ce['expenses']['mae_with_classification'] is not None and ce['expenses']['mae_rows_without_classification'] > ce['expenses']['mae_with_classification']:
        out.append({'component': 'forecaster', 'severity': 'info',
                    'finding': f'Classification matters: with refund / transfer rows in the data, spending MAE against the analytical truth is {ce["expenses"]["mae_with_classification"]:.0f} with classification '
                               f'and {ce["expenses"]["mae_rows_without_classification"]:.0f} when the same rows are unclassified.'})
    an = sections['anomaly_detector']
    clean = an['scenarios']['clean_no_anomaly']['isolation_forest']['false_positive_rate']['mean']
    out.append({'component': 'anomaly_detector', 'severity': 'limitation',
                'finding': f'Contamination is fixed, so on a CLEAN dataset the detector still flags {clean * 100:.1f}% of rows; precision with one injected anomaly is capped near 1 / (rows flagged).'})
    dp = an['scenarios']['date_pattern_outlier']['isolation_forest']['recall']['mean']
    if dp is not None and dp < 1:
        out.append({'component': 'anomaly_detector', 'severity': 'limitation',
                    'finding': f'A typical-sized transaction on an unusual day of the month is caught only {dp * 100:.0f}% of the time in the synthetic test (large amounts are caught reliably).'})
    cl = sections['clustering']['populations']
    three = cl['three_groups']
    ari = three['adjusted_rand_vs_generating_groups_SYNTHETIC']['mean']
    if ari < 0.8:
        out.append({'component': 'clustering', 'severity': 'limitation',
                    'finding': f'On a population with three clearly different spending levels the clusters recover the generating groups only partially (ARI {ari:.2f}; replicate-1 cluster sizes {three["first_replicate_cluster_sizes"]}). '
                               f'Amounts are standardised linearly, so a few very large expenses dominate the scale and the small and medium groups merge; the silhouette ({three["silhouette"]["mean"]:.2f}) is high '
                               'because of those extreme points, so it overstates quality here.'})
    one = cl['one_group']
    out.append({'component': 'clustering', 'severity': 'limitation',
                'finding': f'k is fixed at 3: on a homogeneous population with no structure the model still returns 3 clusters (silhouette {one["silhouette"]["mean"]:.2f}).'})
    return out


def run_all() -> dict:
    forecaster, anomaly, clustering = eval_forecaster(), eval_anomaly(), eval_clustering()
    health, plan = eval_health_scorer(), eval_plan_generator()
    records = forecaster.pop('records') + anomaly.pop('records') + clustering.pop('records')
    for name, summ in (('health_scorer', health), ('plan_generator', plan)):
        records.append({'component': name, 'scenario': 'deterministic correctness checks', 'metric': 'checks_passed', 'value': summ['passed'], 'baseline': 'checks_total',
                        'baseline_value': summ['total'], 'interpretation': f'{summ["passed"]} of {summ["total"]} boundary / reweighting / missing-data / coverage checks pass. This is a deterministic rule system: there is no "accuracy".',
                        'limitations': ['checks verify the implemented rules do what they say, not that the rules are the right financial advice']})
    result = {
        'meta': {'python': platform.python_version(), 'numpy': np.__version__, 'pandas': pd.__version__, 'scikit_learn': sklearn.__version__,
                 'seeds': {'noisy_series': fx.SEED_NOISY_SERIES, 'anomaly_base': fx.SEED_ANOMALY_BASE, 'cluster_base': fx.SEED_CLUSTER_BASE},
                 'forecast_horizon_months': fx.FORECAST_HORIZON, 'anomaly_replicates_per_scenario': fx.ANOMALY_REPLICATES, 'cluster_replicates_per_population': fx.CLUSTER_REPLICATES,
                 'data': 'fully synthetic; no user data, no network, no wall-clock time'},
        'audit': audit(), 'findings': None, 'records': records,
        'sections': {'forecaster': forecaster, 'anomaly_detector': anomaly, 'clustering': clustering, 'health_scorer': health, 'plan_generator': plan}}
    result['findings'] = derive_findings(result['sections'])
    return mt.round_tree(result)


def _fmt(v, d=2):
    return 'n/a' if v is None else (f'{v:,.{d}f}' if isinstance(v, float) else str(v))


def render_markdown(res: dict) -> str:
    L = []
    s = res['sections']
    meta = res['meta']
    L += ['# FinSphere ML evaluation report', '',
          f'Generated by `python -m ml_service.evaluation.run_evaluation` (Python {meta["python"]}, numpy {meta["numpy"]}, pandas {meta["pandas"]}, scikit-learn {meta["scikit_learn"]}).',
          'Every number below is computed by that run from deterministic synthetic fixtures; nothing is typed in by hand. No real user data is used.', '',
          '## 1. What is actually machine learning here', '', '| Component | Type | Algorithm | Persisted model / dataset |', '|---|---|---|---|']
    for a in res['audit']:
        L.append(f'| {a["component"]} | {a["class"]} | {a["algorithm"]} | {a["training"]} |')
    L += ['', 'Notes found during the audit:', '']
    for a in res['audit']:
        for n in a['notes']:
            L.append(f'- **{a["component"]}**: {n}')

    L += ['', '## Key findings (derived from the measured numbers)', '']
    for f in res['findings']:
        L.append(f'- **{f["component"]}** ({f["severity"]}): {f["finding"]}')
    fc = s['forecaster']
    L += ['', '## 2. Forecaster: linear regression vs naive baselines', '',
          f'Rolling-origin evaluation (train only on months before the origin, score the next {meta["forecast_horizon_months"]} months). MAE in rupees; lower is better. '
          '"Model better" means a lower MAE than that baseline on exactly the same forecast points.', '',
          '| Series | Target | Origins | Model MAE | Last value | Hist. mean | Moving avg (3) | Model vs each baseline (✔ model better, ✘ baseline better, = tie) |', '|---|---|---|---|---|---|---|---|']
    for c in fc['cases']:
        for tgt in ('income', 'expenses', 'net'):
            t = c['targets'][tgt]
            if not t['model']:
                continue
            cells, beats = [], []
            for name in ('last_value', 'historical_mean', 'moving_average_3'):
                b = t['baselines'].get(name, {})
                if b.get('available'):
                    cells.append(_fmt(b['baseline']['mae'], 0))
                    beats.append(SHORT[name] + ('✔' if b['verdict'] == 'model_better' else '✘' if b['verdict'] == 'baseline_better' else '='))
                else:
                    cells.append('n/a'); beats.append('-')
            L.append(f'| {c["name"]} | {tgt} | {c["n_origins"]} | {_fmt(t["model"]["mae"], 0)} | {" | ".join(cells)} | {" ".join(beats)} |')
    sm = fc['summary']
    L += ['', f'Across {sm["series_targets_compared"]} series x target comparisons the model had a strictly lower MAE than **every** available baseline in {sm["series_targets_where_model_beats_every_available_baseline"]}.', '',
          '| Baseline | Model better | Baseline better | Ties |', '|---|---|---|---|']
    for name, w in sm['comparisons_by_baseline'].items():
        L.append(f'| {name} | {w["wins"]} | {w["losses"]} | {w["ties"]} |')
    ce = sm['classification_effect']
    L += ['', '**Effect of classification** (same rows, with and without their classification; MAE against the analytical truth):', '', '| Target | With classification | Rows unclassified |', '|---|---|---|']
    for tgt, v in ce.items():
        L.append(f'| {tgt} | {_fmt(v["mae_with_classification"], 0)} | {_fmt(v["mae_rows_without_classification"], 0)} |')
    mm = sm['missing_months_effect']
    L += ['', f'**Unknown rows** behave exactly like explicit ones: {"yes" if sm["unknown_equals_explicit_flag"] else "NO"}.',
          f'**Missing calendar months** (index collapsed): income MAE {_fmt(mm["income_mae_with_missing_months"], 0)} with gaps vs {_fmt(mm["income_mae_complete_history"], 0)} on the same trend with complete history.',
          '', 'Limitations: ' + '; '.join(fc['cases'][0] and FORECAST_LIMITS) + '. Sparse history yields very few origins; see `n_origins`.']

    an = s['anomaly_detector']
    L += ['', '## 3. Anomaly detector: controlled synthetic anomaly-detection evaluation', '',
          '**This is not fraud-detection accuracy.** There are no real fraud labels. Anomalies are injected into synthetic data and the metrics are means over '
          f'{meta["anomaly_replicates_per_scenario"]} seeded datasets per scenario.', '',
          '| Scenario | Injected | Flagged (mean) | Recall | Precision | False-positive rate | Top-k hit | Mean rank of a caught injection | MAD baseline recall | MAD baseline FPR |', '|---|---|---|---|---|---|---|---|---|---|']
    for name, sc in an['scenarios'].items():
        m, b = sc['isolation_forest'], sc['robust_mad_baseline']
        L.append(f'| {name} | {sc["n_injected_per_dataset"]} | {_fmt(m["n_flagged"]["mean"], 1)} | {_fmt(m["recall"]["mean"], 2)} | {_fmt(m["precision"]["mean"], 2)} | {_fmt(m["false_positive_rate"]["mean"], 3)} | {_fmt(m["top_k_hit_rate"]["mean"], 2)} | {_fmt(m["mean_rank_of_injected_among_flagged"]["mean"], 1)} | {_fmt(b["recall"]["mean"], 2)} | {_fmt(b["false_positive_rate"]["mean"], 3)} |')
    L += ['', '**Fixed flag rate (contamination) limitation, measured on clean data:**', '', '| Rows | Flagged | Flag rate | Contamination used |', '|---|---|---|---|']
    for n, v in an['clean_data_flag_rate_by_size'].items():
        L.append(f'| {n} | {v["n_flagged"]} | {_fmt(v["flag_rate"], 3)} | {_fmt(v["contamination_rate"], 3)} |')
    L += ['', 'The detector flags a fixed share of rows even when nothing is wrong, so on clean data every flag is a false positive, and precision is capped when only a few real anomalies exist.',
          f'Classification does not change the anomalies and results are deterministic: {"yes" if an["classification_independent_and_deterministic"] else "NO"}.']

    cl = s['clustering']
    L += ['', '## 4. Clustering: unsupervised, synthetic populations', '',
          'Silhouette and inertia are the production model\'s own unsupervised measures. "ARI vs generating groups" measures recovery of the **synthetic** generator\'s groups only; it is not accuracy on real data.', '',
          '| Population | Silhouette (mean ± sd) | ARI vs generating groups | Best-silhouette k (counts) | Cluster sizes (replicate 1) | Centroids (replicate 1) | Rerun identical | Min ARI after row shuffle |', '|---|---|---|---|---|---|---|---|']
    for name, p in cl['populations'].items():
        L.append(f'| {name} | {_fmt(p["silhouette"]["mean"], 3)} ± {_fmt(p["silhouette"]["std"], 3)} | {_fmt(p["adjusted_rand_vs_generating_groups_SYNTHETIC"]["mean"], 3)} | {p["best_silhouette_k_counts"]} | {p["first_replicate_cluster_sizes"]} | {p["first_replicate_centroids"]} | {p["rerun_identical_all"]} | {_fmt(p["min_ari_after_row_shuffle"], 3)} |')
    L += ['', 'Edge cases:', '']
    for e in cl['edge_cases']:
        L.append(f'- {"PASS" if e["passed"] else "FAIL"}: {e["name"]}' + (f' ({e["detail"]})' if e['detail'] and not e['passed'] else ''))
    L += ['', 'Limitations: ' + '; '.join(CLUSTER_LIMITS) + '.']

    for key, title, blurb in (('health_scorer', '5. Health scorer: deterministic rule system', 'It has no learned parameters, so there is no accuracy to report; the checks verify boundary values, curve shape, reweighting, missing-data handling and classification-aware inputs.'),
                              ('plan_generator', '6. Plan generator: deterministic rule engine', 'Rule coverage, threshold boundaries on both sides, mutually exclusive families, missing inputs, ordering and dependency on the other components\' outputs.')):
        sec = s[key]
        L += ['', f'## {title}', '', blurb, '', f'**{sec["passed"]} of {sec["total"]} checks pass.**']
        if sec['failed']:
            L += ['', 'Failed checks:'] + [f'- {n}' for n in sec['failed']]
        if key == 'plan_generator':
            L += ['', f'Rules declared in the source: {", ".join(sec["rules_declared"])}. Rules exercised: {", ".join(sec["rules_fired"])}.']
    L += ['', '## 7. Reproducibility', '',
          f'- Seeds: {json.dumps(meta["seeds"])}; all fixtures are generated in `fixtures.py`, no network, no files read, no wall-clock time.',
          '- Re-running the command produces byte-identical `evaluation_results.json` and this report.', '- Run from the repository root: `python -m ml_service.evaluation.run_evaluation`.', '']
    return '\n'.join(L)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Run the FinSphere ML evaluation suite.')
    parser.add_argument('--out', default=str(HERE / 'results'), help='directory for evaluation_results.json and EVALUATION_REPORT.md')
    args = parser.parse_args(argv)
    res = run_all()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / 'evaluation_results.json').write_text(json.dumps(res, indent=2, ensure_ascii=True) + '\n', encoding='utf-8')
    (out / 'EVALUATION_REPORT.md').write_text(render_markdown(res), encoding='utf-8', newline='\n')
    h, p = res['sections']['health_scorer'], res['sections']['plan_generator']
    print(f'wrote {out / "evaluation_results.json"} and {out / "EVALUATION_REPORT.md"}')
    print(f'records: {len(res["records"])} | health scorer checks {h["passed"]}/{h["total"]} | plan generator checks {p["passed"]}/{p["total"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
