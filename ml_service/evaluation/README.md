# FinSphere ML evaluation suite

A reproducible, offline evaluation of the ML service. One command runs everything:

```bash
# from the repository root
python -m ml_service.evaluation.run_evaluation
```

It writes two generated files into `ml_service/evaluation/results/` (use `--out DIR` to write elsewhere):

| File | Purpose |
|---|---|
| `evaluation_results.json` | machine-readable: `meta`, `audit`, `findings`, `records` (one per metric, with `component`, `scenario`, `metric`, `value`, `baseline`, `baseline_value`, `interpretation`, `limitations`) and the detailed `sections` |
| `EVALUATION_REPORT.md` | human-readable report **generated from** the JSON values; nothing is typed in by hand |

Runtime is about 40 seconds. It needs only the packages in `ml_service/requirements.txt` (`numpy`, `pandas`, `scikit-learn`).

## What is, and is not, machine learning here

| Component | What it really is | What is evaluated |
|---|---|---|
| Forecaster | ordinary least squares (`LinearRegression`) re-fitted per request on the user's monthly income and net spending | rolling-origin forecast error vs naive baselines |
| Anomaly detector | `IsolationForest`, fitted per request on the same rows it scores | controlled **synthetic** anomaly injection |
| Clustering | Ward agglomerative clustering with `k = 3`, fitted per request | silhouette, stability, recovery of synthetic groups, edge cases |
| Health scorer | deterministic weighted rule system (no learning) | boundary, reweighting, missing-data and classification checks (no "accuracy") |
| Plan generator | deterministic if/else rule engine (no learning) | rule coverage, threshold boundaries, conflicts, missing inputs, dependencies |

No model file or training dataset exists: every model is fitted on the user's own data at request time.

## Files

```
ml_service/evaluation/
  fixtures.py        deterministic synthetic data (seeded; no files, network or wall-clock time)
  baselines.py       last value, historical mean, 3-month moving average
  metrics.py         MAE, RMSE, MAPE (zero-safe, reports excluded points), sMAPE (zero-safe)
  run_evaluation.py  the audit, the five evaluations, the JSON + Markdown writers
  results/           generated output
```

## Methodology

* **Forecasting.** For each synthetic series (stable, linear up / down, noisy, seasonal-ish, sparse history, months with no transactions, refund / transfer traps, unknown-classification rows) the suite walks a *rolling origin*: train on the rows dated **before** the origin, forecast the next 3 months, score against the generating function. Nothing from the future reaches training, and the baselines see exactly the monthly series the model sees. Targets: income, spending and net. A model "beats" a baseline only with a strictly lower MAE on the same points.
* **Anomalies.** There are no fraud labels, so this is a *controlled synthetic anomaly-detection evaluation*, never fraud-detection accuracy. Large amounts, a date-pattern outlier, a large transfer, a large refund, five mixed anomalies and a clean dataset are generated over 25 seeds each. Reported: recall, precision, false-positive rate, number flagged, rank of the injected rows, and a robust-MAD statistical baseline. The fixed flag rate (contamination) is measured separately on clean data.
* **Clustering.** Unsupervised measures (silhouette, inertia proxy, cluster sizes, centroids), stability (rerun and shuffled row order), whether `k = 3` agrees with the best silhouette over `k = 2..5`, and agreement with the synthetic generator's groups (ARI), which measures recovery of *known synthetic structure*, not labelled accuracy. Edge cases: too few rows, identical rows, an extreme outlier, and exclusion of refunds / transfers / income.
* **Health scorer and plan generator.** Pass / fail checks (listed in the JSON) with explicit boundary values on both sides of every threshold.

## Reproducibility

* Seeds: `SEED_NOISY_SERIES = 7`, `SEED_ANOMALY_BASE = 1000`, `SEED_CLUSTER_BASE = 2000`; replicate `k` uses `base + k`. All are in `fixtures.py`.
* No network, no downloads, no database, no `.env`, no user data, no timestamps in the output. Two runs produce byte-identical files.
* Versions are recorded in `meta` (Python, numpy, pandas, scikit-learn). Different library versions can change the last digits or, for clustering / isolation forests, borderline decisions; re-run to regenerate.

## Reading the results honestly

* The suite never changes production code and does not tune models. Where a model loses to a naive baseline the report says so.
* Synthetic data shows how a model behaves on known shapes, not how well it predicts a real person's finances.
* Rolling origins overlap, so forecast comparisons are indicative, not significance tests.
* `findings` in the JSON/report are generated from the measured numbers; the audit notes are static observations about the code.
