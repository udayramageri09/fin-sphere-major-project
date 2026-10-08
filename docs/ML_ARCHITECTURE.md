# FinSphere ML architecture

This document describes what the ML service actually does, as implemented. It is written from the code (`ml_service/`, `server/`) and the checked-in evaluation (`ml_service/evaluation/`). Where a statement rests on a measurement it links to [ML_EVALUATION.md](ML_EVALUATION.md); the exact money rules are in [FINANCIAL_LOGIC.md](FINANCIAL_LOGIC.md).

## 1. System overview

FinSphere has four runtime parts.

| Part | Technology | Responsibility |
|---|---|---|
| Web app | React + Vite (`src/`) | UI; holds no financial truth of its own beyond display helpers |
| API | Express (`server/server.js`, `server/db/`) | authentication, ownership, validation, every database read/write, the proxy to the ML service, the assistant |
| Database | PostgreSQL | the single source of persisted financial state |
| ML service | FastAPI (`ml_service/`) | stateless analysis of the transactions it is sent |

An optional LLM (Groq) is called by the API for the chat assistants and for statement parsing. It is not part of the financial calculations.

## 2. Data flow (`GET /api/ml/analyze`)

```
Browser ──(httpOnly JWT cookie)──▶ Express
                                    │ 1. authenticate; owner = req.user.id (never from the request)
                                    │ 2. PostgreSQL: that user's transactions
                                    │                (incl. type + classification),
                                    │                SUM of monthly payments of unpaid liabilities,
                                    │                the saved emergency fund (or null)
                                    ▼
                         POST {ML_SERVICE_URL}/ml/full-analysis      (60 s timeout)
                         { transactions, monthly_debt_payments, emergency_fund, n_forecast_months: 3 }
                                    │
                                    ▼
   FastAPI:  forecaster · anomaly detector · clustering · health scorer ──▶ plan generator
                                    │
                                    ▼
                         { forecast, anomalies, clusters, health, plan, metadata }
                                    │
Express relays it unchanged ◀───────┘   (ML error → 502, ML service unreachable → 503)
```

The plan generator runs last and consumes the other four outputs. If one model throws, its error is recorded in `metadata.errors` and its section is `{}`; the rest still run.

## 3. The Express / FastAPI trust boundary

* **Express is the security boundary.** It authenticates the caller, derives the owner from the verified JWT, validates and normalises every write, and decides which rows are sent to the ML service.
* **FastAPI has no authentication.** `ml_service/main.py` says so in a comment; it restricts browser origins with CORS (`localhost:5173` and `localhost:5000`) but does not check who is calling. It trusts whatever transactions it receives. In any deployment it must be reachable only from the API, not from the internet.
* The ML service never reads the database and never stores anything.
* `POST /api/plan-chat` receives the ML results (`mlContext`) **from the client** and narrates them. The server does not re-validate that context (a code comment records this as a known follow-up). `/api/ml/analyze` itself is fully server-derived.

## 4. PostgreSQL-owned financial state

Users, transactions, goals (and their contributions), liabilities (and their repayments), the emergency fund and monthly budgets live in PostgreSQL. Money is `NUMERIC`, never floating point. The ML service receives a snapshot per request and returns derived numbers; those numbers are not written back.

## 5. Transaction `type` versus `classification`

Each transaction has two independent fields:

* `type` is its direction and sign: `income` (stored positive) or `expense` (stored negative). The database enforces that the sign follows the type.
* `classification` is its analytical meaning: `income`, `expense`, `refund`, `transfer` or `unknown`. Only some pairings are valid (an expense-direction row can be `expense`, `transfer` or `unknown`; an income-direction row can be `income`, `refund`, `transfer` or `unknown`); the database enforces this too.

Every historical and every imported row is `unknown`, because those rows only ever proved their direction. `unknown` rows fall back to their direction, so old data keeps contributing. The full rules, with the refund and transfer handling, are in [FINANCIAL_LOGIC.md](FINANCIAL_LOGIC.md). The Python side implements them once, in `ml_service/models/analytics.py`.

## 6. Components and what they really are

| Component | Class | Algorithm | Learns from data? |
|---|---|---|---|
| Forecaster | statistical model (supervised regression), fitted per request | scikit-learn `LinearRegression` (ordinary least squares) on a month index, income and spending separately | refits on the user's own history every request |
| Anomaly detector | unsupervised ML, fitted per request | scikit-learn `IsolationForest`, 100 trees, `random_state=42`, on standardised `[abs_amount, day_of_week, day_of_month]` | refits every request; scores the same rows it is fitted on |
| Clustering | unsupervised ML, fitted per request | scikit-learn `AgglomerativeClustering`, Ward linkage, fixed `k = 3`, on standardised amount features | refits every request; deterministic |
| Health scorer | **deterministic weighted rules, not trained ML** | piecewise-linear benchmark curves combined with fixed weights | no |
| Plan generator | **deterministic rule engine, not trained ML** | if/else threshold rules over the four outputs above | no |

## 7. The learned / statistical components

**Forecaster** (`models/forecaster.py`). Builds a monthly series from the user's transactions using the classification-aware income and spending rules, then fits a straight line to each series and predicts the next 3 months (predictions are clamped at 0). With one month of data it returns the mean; with two or more it fits a line. It reports slopes, an in-sample R² (not a held-out accuracy), and a trend label (`rising` / `falling` when the slope exceeds ±500 rupees per month, else `stable`). The month index is the position among months that have transactions, so a calendar month with no transactions is skipped rather than counted (see the missing-month finding in [ML_EVALUATION.md](ML_EVALUATION.md)).

**Anomaly detector** (`models/anomaly.py`). Needs at least 5 transactions. Uses every transaction regardless of classification, deliberately: it looks for unusual **money movements** (a large transfer or refund is as worth reviewing as a large purchase). It is not a fraud detector: there are no fraud labels anywhere in the system. The contamination is `min(0.15, max(1/n, 0.05))`, so it always flags at least 5% of rows (at least one), even when nothing is unusual. Flagged rows are returned most anomalous first, with a severity (`high` when the score is below -0.2) and a reason string.

**Clustering** (`models/clustering.py`). Clusters only analytical spending transactions (explicit expenses plus unclassified debits; income, refunds and transfers are excluded). Needs at least 3 such rows. `k` is fixed at 3 and is not selected from the data. Clusters are numbered by mean amount (0 micro, 1 mid-range, 2 high-value) and reported with a silhouette score and an inertia proxy. The model is deterministic (no random seed).

## 8. The deterministic components

**Health scorer** (`models/health_scorer.py`). Computes six ratios (savings rate, expense ratio, debt-to-income, emergency coverage, investment rate, cash-flow positivity), scores each 0-100 from fixed benchmark curves, and combines them with fixed weights (0.25, 0.20, 0.20, 0.15, 0.10, 0.10). A ratio whose input is missing (no debt payments supplied, no emergency fund, no usable income or spending) is **omitted, never defaulted**, and the weights are renormalised over the ratios that exist. The grade is A at 85 or more, B at 70, C at 55, otherwise D. The benchmarks are conventional rules of thumb, not values fitted to data.

**Plan generator** (`models/plan_generator.py`). Twelve rules: `HS-01..06` (savings, debt-to-income, emergency coverage), `FC-01..03` (forecast), `AN-01` (anomalies), `CL-01..02` (clusters). Rules only fire when their input exists; missing data never creates an alert. The emergency rules use the exact, unrounded coverage reconstructed from the health metadata, not the one-decimal value shown to users.

## 9. How the outputs relate

```
transactions (type + classification) ─┬─▶ forecaster ───────────────▶ FC-01, FC-02, FC-03
                                       ├─▶ anomaly detector ─────────▶ AN-01
                                       ├─▶ clustering (spending) ────▶ CL-01, CL-02
                                       └─▶ health scorer ────────────▶ HS-01 .. HS-06
monthly debt payments (PostgreSQL) ───────▶ health scorer (DTI)
emergency fund (PostgreSQL) ──────────────▶ health scorer (coverage)
```

The same financial rules also exist in SQL (budget actuals and assistant totals, `server/db/index.js`) and JavaScript (dashboard figures, `src/utils/finance.js`). The test suites run all three implementations on shared fixtures to check that they agree.

## 10. The LLM assistant's role

The assistant explains and interacts; it does not compute.

* `POST /api/chat`: the API builds a system prompt from the signed-in user's **server-side** data (analytical totals computed in SQL, goals, liabilities, emergency fund, the current UTC month's budgets with their real spending, recent transactions) and states what is not available (credit score, portfolio, net worth). If no Groq key is configured, or the call fails, a keyword-based fallback answers from the same data.
* `POST /api/plan-chat`: a narrate-only prompt built from the ML results (see the trust note in section 3). Without a key it returns the plan summary text.
* Statement parsing (`POST /api/transactions/parse-statement`): if a Groq key is configured, a language model proposes rows; otherwise (or if it produces nothing valid) a rule-based parser is used. Either way every row goes through the same server validator, receives a server-generated UUID and the owner from the session, and is stored with classification `unknown`.

The model names in the code are `llama-3.3-70b-versatile` (chat and plan-chat) and `llama3-8b-8192` (parsing). No LLM output feeds a financial metric.

## 11. No persisted model artifacts

The repository contains no model file (`.pkl`, `.joblib` and the like) and no training dataset. Every model is constructed and fitted inside the request, on that request's data only, and discarded. Consequences: there is no model versioning, no drift to monitor and no cross-user learning; results depend only on the input and the library versions, and the same input returns the same output. The cost is that each model sees only one user's, possibly short, history.

## 12. What this project is, and is not

FinSphere is not an LLM wrapper. Its financial figures come from persisted PostgreSQL data, server-side validation and ownership, explicit documented formulas, a small set of statistical and machine-learning models, and deterministic scoring rules. The language model is used for grounded explanation and conversation over those figures. That grounding is only as good as the data and rules beneath it; see the limitations in [ML_EVALUATION.md](ML_EVALUATION.md).

## 13. Runtime wording that does not match the implementation

Documentation here uses the correct names. The following user-visible or API-visible strings still say "KMeans" although the algorithm is Agglomerative clustering. They are reported, not changed, by the documentation issue:

* `ml_service/main.py`: the API description, the `/health` model list and `metadata.models_run` in `/ml/full-analysis`.
* `ml_service/models/plan_generator.py`: the CL-01 step text ("K-Means clustering shows ...") and the `source_model` value `KMeans Clustering` on CL-01 and CL-02.
* `server/server.js`: a `=== K-MEANS SPENDING CLUSTER ===` heading in the plan-chat prompt.

Also, `Transactions.jsx` labels the statement buttons "AI-Powered". That is accurate only when a Groq key is configured; without one the rule-based parser runs.

## Evidence map

| Statement | Source |
|---|---|
| Algorithms, seeds, minimum rows, contamination, `k = 3` | `ml_service/models/forecaster.py`, `anomaly.py`, `clustering.py` |
| Weights, benchmarks, grades, omission of missing ratios | `ml_service/models/health_scorer.py` |
| The 12 rules and their thresholds | `ml_service/models/plan_generator.py` |
| Classification rules (Python / SQL / JS) | `ml_service/models/analytics.py`, `server/db/index.js`, `src/utils/finance.js` |
| Endpoint list, CORS, no authentication on FastAPI | `ml_service/main.py` |
| Payload, timeouts, 502 / 503, owner scoping | `server/server.js` (`/api/ml/analyze`) |
| `mlContext` is client-supplied | comment above `/api/plan-chat` in `server/server.js` |
| Type/classification constraints, `NUMERIC` money | `server/db/schema.sql` |
| No model artifacts | repository search for model/data files (none) |
| Measured behaviour | `ml_service/evaluation/results/` |
