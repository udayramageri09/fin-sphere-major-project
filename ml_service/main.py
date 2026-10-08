"""
main.py — FinFlow ML Microservice (FastAPI)

Endpoints:
  GET  /health             — service health check
  POST /ml/full-analysis   — runs all 4 models + plan generator
  POST /ml/forecast        — forecaster only
  POST /ml/anomalies       — anomaly detection only
  POST /ml/clusters        — clustering only
  POST /ml/health-score    — financial health scoring only
  POST /ml/generate-plan   — plan from pre-computed ML results
"""
import os
os.environ['OMP_NUM_THREADS'] = '1'   # Prevent MKL threadpool crash on Anaconda/Windows

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Union
import time
import traceback

from models.forecaster import run_forecaster
from models.anomaly import run_anomaly_detection
from models.clustering import run_clustering
from models.health_scorer import run_health_scorer
from models.plan_generator import generate_plan

app = FastAPI(
    title="FinFlow ML Intelligence Service",
    description="Real ML models powering FinFlow financial analysis — Linear Regression, Isolation Forest, K-Means, Health Scoring",
    version="1.0.0"
)

# Allow CORS from the React frontend and Node backend only.
# The wildcard "*" is intentionally omitted — it would allow any browser origin
# to call the unauthenticated ML endpoints.  In production, replace these values
# with the real deployed frontend and API origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Pydantic Models ────────────────────────────────────────────────────────────

class Transaction(BaseModel):
    # New transactions have UUID string ids; historical ones have numeric ids. The ML
    # models never use the id, so either form must be accepted (it was int-only, which
    # made every request containing a UUID id fail with a 422).
    id: Optional[Union[int, str]] = None
    title: str
    amount: float
    date: str
    type: Optional[str] = 'expense'
    category: Optional[str] = 'General'


class AnalysisRequest(BaseModel):
    transactions: list[Transaction]
    # Optional user-supplied amounts. FinSphere does not store these yet, so they default
    # to None ("not available"); the ratios that need them are then omitted, never defaulted.
    liabilities: Optional[float] = None
    emergency_fund: Optional[float] = None
    n_forecast_months: Optional[int] = 3


class PlanRequest(BaseModel):
    forecast: Optional[dict] = None
    anomalies: Optional[dict] = None
    clusters: Optional[dict] = None
    health: Optional[dict] = None


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "FinFlow ML Intelligence Service",
        "models": ["LinearRegression", "IsolationForest", "KMeans", "HealthScorer", "RulePlanGenerator"],
        "version": "1.0.0"
    }


@app.post("/ml/full-analysis")
def full_analysis(req: AnalysisRequest):
    """
    Runs ALL ML models on the provided transactions and returns a complete analysis.
    This is the primary endpoint used by the Plans & Discussion page.
    """
    txns = [t.model_dump() for t in req.transactions]
    t0 = time.time()

    results = {}
    errors = {}

    # 1. Forecaster
    try:
        results['forecast'] = run_forecaster(txns, req.n_forecast_months)
    except Exception as e:
        errors['forecast'] = str(e)
        results['forecast'] = {}

    # 2. Anomaly Detection
    try:
        results['anomalies'] = run_anomaly_detection(txns)
    except Exception as e:
        errors['anomalies'] = str(e)
        results['anomalies'] = {}

    # 3. Clustering
    try:
        results['clusters'] = run_clustering(txns)
    except Exception as e:
        errors['clusters'] = str(e)
        results['clusters'] = {}

    # 4. Health Scorer
    try:
        results['health'] = run_health_scorer(
            txns,
            liabilities=req.liabilities,
            emergency_fund=req.emergency_fund
        )
    except Exception as e:
        errors['health'] = str(e)
        results['health'] = {}

    # 5. Plan Generator (consumes all model outputs)
    try:
        results['plan'] = generate_plan(
            forecast=results.get('forecast', {}),
            anomalies=results.get('anomalies', {}),
            clusters=results.get('clusters', {}),
            health=results.get('health', {})
        )
    except Exception as e:
        errors['plan'] = str(e)
        results['plan'] = {}

    elapsed_ms = round((time.time() - t0) * 1000, 1)

    return {
        **results,
        'metadata': {
            'transaction_count': len(txns),
            'models_run': ['LinearRegression', 'IsolationForest', 'KMeans', 'HealthScorer', 'RulePlanGenerator'],
            'elapsed_ms': elapsed_ms,
            'errors': errors if errors else None
        }
    }


@app.post("/ml/forecast")
def forecast_only(req: AnalysisRequest):
    txns = [t.model_dump() for t in req.transactions]
    try:
        return run_forecaster(txns, req.n_forecast_months)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ml/anomalies")
def anomalies_only(req: AnalysisRequest):
    txns = [t.model_dump() for t in req.transactions]
    try:
        return run_anomaly_detection(txns)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ml/clusters")
def clusters_only(req: AnalysisRequest):
    txns = [t.model_dump() for t in req.transactions]
    try:
        return run_clustering(txns)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ml/health-score")
def health_score_only(req: AnalysisRequest):
    txns = [t.model_dump() for t in req.transactions]
    try:
        return run_health_scorer(
            txns,
            liabilities=req.liabilities,
            emergency_fund=req.emergency_fund
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ml/generate-plan")
def generate_plan_endpoint(req: PlanRequest):
    try:
        return generate_plan(
            forecast=req.forecast or {},
            anomalies=req.anomalies or {},
            clusters=req.clusters or {},
            health=req.health or {}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True, log_level="info")
