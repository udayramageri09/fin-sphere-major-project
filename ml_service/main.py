"""
main.py — FinFlow ML Microservice (FastAPI)

Endpoints:
  GET  /health             — service health check
  POST /ml/full-analysis   — runs the 3 ML models, then the rule-based health scorer and plan generator
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
from pydantic import BaseModel, Field
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
    description="FinSphere analytics: ML (Linear Regression forecast, Isolation Forest anomalies, Agglomerative/Ward clustering) plus deterministic rules (health score, plan generator)",
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
    title: str = Field(max_length=120)
    amount: float = Field(allow_inf_nan=False)
    date: str = Field(max_length=32)
    type: Optional[str] = 'expense'
    category: Optional[str] = 'General'
    # Analytical label from FinSphere (income | expense | refund | transfer | unknown). The health scorer uses it
    # (Issue #61); a caller that omits it gets 'unknown', which falls back to the direction of the amount.
    classification: Optional[str] = 'unknown'


class AnalysisRequest(BaseModel):
    transactions: list[Transaction] = Field(max_length=3000)
    # Optional user-supplied amounts, None = "not available": the ratio that needs it is then omitted,
    # never defaulted. monthly_debt_payments is the sum of the user's monthly debt payments per month
    # (0 = a real "no payments"); it drives DTI. emergency_fund is the user's saved emergency fund in rupees
    # (0 = a real "nothing saved yet"); it drives emergency coverage (months).
    # (A client still sending the old "liabilities" field is accepted and the field is ignored.)
    monthly_debt_payments: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    emergency_fund: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    n_forecast_months: int = Field(default=3, ge=1, le=12)


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
        "models": ["LinearRegression", "IsolationForest", "AgglomerativeClustering (Ward)"],
        "rule_engines": ["HealthScorer (rules)", "PlanGenerator (rules)"],
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
            monthly_debt_payments=req.monthly_debt_payments,
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
            'models_run': ['LinearRegression', 'IsolationForest', 'AgglomerativeClustering (Ward)'],
            'rule_engines_run': ['HealthScorer (rules)', 'PlanGenerator (rules)'],
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
            monthly_debt_payments=req.monthly_debt_payments,
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
    # This service has no authentication: Express is the trust boundary. It binds to the loopback interface by
    # default so a developer machine does not expose it to the network. To reach it from another host or container
    # set ML_SERVICE_HOST (e.g. 0.0.0.0) AND restrict access with a private network or firewall. Auto-reload is a
    # development convenience and is off unless ML_SERVICE_RELOAD=true.
    host = os.environ.get("ML_SERVICE_HOST", "127.0.0.1")
    port = int(os.environ.get("ML_SERVICE_PORT", "8000"))
    reload = os.environ.get("ML_SERVICE_RELOAD", "false").lower() == "true"
    uvicorn.run("main:app", host=host, port=port, reload=reload, log_level="info")
