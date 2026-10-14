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
Express sanitises it ◀──────────────┘   (ML error → 502, ML service unreachable → 503)
   · removes clusters.labeled_transactions
   · metadata.errors → { section: true }   (no exception text)
   · stores it as that user's snapshot (in memory, 30 minutes, ≤ 1000 users)
```

The plan generator runs last and consumes the other four outputs. If one model throws, the failure is recorded as `metadata.errors.<section> = true` (the Python message is never sent to the browser) and its section is `{}`; the rest still run. Only the three models (forecaster, anomaly detector, clustering) are machine learning; the health scorer and the plan generator are deterministic rule engines, and `metadata` lists them separately (`models_run` and `rule_engines_run`).

## 3. The Express / FastAPI trust boundary

* **Express is the security boundary.** It authenticates the caller, derives the owner from the verified JWT, validates and normalises every write, and decides which rows are sent to the ML service.
* **FastAPI has no authentication.** `ml_service/main.py` says so in a comment; it restricts browser origins with CORS (`localhost:5173` and `localhost:5000`) but does not check who is calling. It trusts whatever transactions it receives. In any deployment it must be reachable only from the API, not from the internet (see [SECURITY_DEPLOYMENT.md](SECURITY_DEPLOYMENT.md)); `python main.py` now binds to `127.0.0.1` unless `ML_SERVICE_HOST` is set.
* The ML service never reads the database and never stores anything.
* `POST /api/plan-chat` narrates the analysis the **server** produced for the caller. After a successful `/api/ml/analyze`, Express keeps that (sanitised) result in a per-user, in-memory snapshot (`server/planSnapshot.js`: keyed by the authenticated user id, 30 minute TTL, at most about 1000 users, least recently used evicted first; nothing is persisted). The prompt is built from that snapshot. A `mlContext` sent by the browser is still accepted so old clients keep working, but it is only shape-checked and then ignored, so a forged context cannot change what the advisor says. With no snapshot the reply is "Run the analysis first." One user's snapshot is never returned for another user.
* Express never returns FastAPI's error body: a 502 carries a generic message, the server log records the status only, and `metadata.errors` is reduced to section-presence booleans.

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

**Plan generator** (`models/plan_generator.py`). Twelve rules: `HS-01..06` (savings, debt-to-income, emergency coverage), `FC-01..03` (forecast), `AN-01` (anomalies), `CL-01..02` (clusters). Rules only fire when their input exists; missing data never creates an alert. The emergency rules use the exact, unrounded coverage reconstructed from the health metadata, not the one-decimal value shown to users. Thresholds are unchanged by Issue #80.

Each step also carries, since Issue #80: `kind` (`risk`, `opportunity` or `maintenance`), `method` (`rule` for the health-score rules `HS-*`, `ml_signal` for a rule applied to a forecast, anomaly or cluster output), a truthful `source_model` ("Health score rules", "LinearRegression forecast", "IsolationForest", "Agglomerative clustering (Ward)"), `category_order`, `action` (`{ destination }` naming an existing page or section, or `null`) and structured `evidence` (`metric`, `label`, `value`, `unit`, `threshold`, `formula`, `inputs`, `contributors`, `caveats`). **Order:** priority first (critical, high, medium, low); within a priority a fixed category order breaks ties (1 cash-flow survival: FC-03, HS-01; 2 debt: HS-03, HS-04; 3 emergency fund: HS-05, HS-06; 4 savings and spending: HS-02, FC-01; 5 transaction review: AN-01; 6 behaviour and opportunity: CL-01, CL-02, FC-02), then the step id. There is no score and no model: the order is a pure function of which rules fired. The plan also carries `forecast_caveats` (short history, low R²) computed on the server.

**Health scorer additions (Issue #80).** The score, ratios, weights and grades are unchanged. `metadata` now also reports `monthly_income`, `avg_monthly_net_spending`, `period` (`months`, `first_month`, `last_month`), `ratios_used` and `ratios_total`; each ratio has its `weight_pct` (the weight actually used after renormalising); `unavailable_reasons` says why DTI (`no_income` or `debt_total_unavailable`) or emergency coverage (`no_fund` or `no_spending`) is missing; and `breakdown` lists the top five spending categories (see [FINANCIAL_LOGIC.md](FINANCIAL_LOGIC.md)). The generic "tax-loss harvesting" advice was replaced by "No issues found in the computed ratios.".

**What the Plans page shows.** `src/pages/Plans.jsx` and `src/components/plans/*` present the server's output as Current State, Top risks and opportunities (at most 3 and 2, in the server's order), Next actions (the server's order, with a button to an existing page through the shared navigation destinations) and a collapsed Analysis details section. "Why?", "How calculated?", "What caused this?" and "Show breakdown" render the returned `evidence` and health breakdown; the browser computes no ratio, score, threshold test or ranking (`src/utils/planIntelligence.js` only groups, slices and formats).

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

* `POST /api/chat`: the API builds a system prompt from the signed-in user's **server-side** data (analytical totals computed in SQL, all-time and for the current UTC month, goals, liabilities, emergency fund, the current UTC month's budgets with their real spending, recent transactions) and states what is not available (credit score, portfolio, net worth). Requests are validated (1-20 `user`/`assistant` turns, at most 2000 characters each; only the last 12 reach the model), and earlier turns are treated as conversation, never as financial facts. If no Groq key is configured, or the call fails, a deterministic fallback answers from the same data, continuing the previous topic for follow-ups such as "why?".
* Navigation is decided in the browser, not by the model: `src/utils/assistantIntent.js` only navigates on explicit action language ("open budgets", "take me there"); a question is always answered, and a question with a command is answered first.
* `POST /api/plan-chat`: a narrate-only prompt built from the ML results (see the trust note in section 3). Without a key it returns the plan summary text.
* Statement parsing (`POST /api/transactions/parse-statement`): if a Groq key is configured, a language model proposes rows; otherwise (or if it produces nothing valid) a rule-based parser is used. Either way every row goes through the same server validator, receives a server-generated UUID and the owner from the session, and is stored with classification `unknown`.

### Confirmed assistant actions (Issues #73, #75, #77 and #79)

The assistant can propose, but never silently perform, a financial write:

```
user text -> safe deterministic normalization -> deterministic action parser
  -> (if not understood) action-likelihood gate -> structured LLM extraction (fallback only)
  -> schema validation -> provenance validation -> server entity resolution -> clarification if needed
  -> server proposal -> preview -> explicit confirmation -> single-use execution -> verified result
```

* **Supported now:** `create_transaction`, `contribute_to_goal`, `record_liability_repayment`, `set_budget` and `create_liability`. Each kind is one entry in a per-kind handler table (detect, clarify, preview, edit) in `server/assistantActions.js`; loans, EMIs and budgets are claimed before goals so "add to my car loan" is never a goal.
* **Not supported yet:** changing or deleting a liability, other delete actions, refunds and transfers.
* **Repayments and transactions are separate.** Recording a repayment changes the liability's balance only; no expense transaction is added.
* **Budgets.** The assistant discloses the current limit before changing it and writes with compare-and-set; month names without a year are asked about, never guessed.
* **No language model is trusted for action execution.** The deterministic parser is preferred and runs first (amounts, dates, months, direction and the user's own goal, loan and budget names are parsed by rules); a missing or ambiguous field produces a clarifying question, never a guess.
* **Normalization layer (Issue #77).** `server/actionNormalization.js` fixes typos and speech-recognition slips in action keywords before parsing (curated aliases such as `payed`→`paid`, `lon`→`loan`, `budgt`→`budget`, `mnth`→`month`, plus a keyword-only Damerau-Levenshtein backstop with distance 1 for 4-6 letter words, 2 for longer ones, never for words of 3 letters or fewer, and a protected-word list such as `send`, `sent`, `spent`, `set`, `lend`, `earn`, `learn`). It keeps a correction log and an offset map back to the original text, leaves digits, amounts, number words and the user's own entity names alone, and never produces income, expense, refund, transfer or confirmation words.
* **Spoken money.** `server/numberParser.js` reads digit forms (`₹500`, `4.5k`, `1.5 lakh`, `1,25,000`) and number words (`five thousand`, `one lakh twenty thousand`, `two and a half thousand`, `six five zero zero`, `four fifty`) with BigInt arithmetic; Indian scale (hundred, thousand, k, lakh, lac, crore) only. "2 and a half thousand" is ₹2,500; a dangling "2 and a half" is a question, never ₹2. Number words only count in a money slot, so "Five Guys" is not an amount.
* **Entity matching.** `server/entityMatcher.js` ranks the user's own goals, liabilities and budget labels (exact, whole-word overlap, edit distance and trigram similarity). A fuzzy candidate is never chosen automatically: the assistant asks "Did you mean …?" even for a single candidate.
* **Structured LLM extraction is a fallback only.** `server/structuredActionExtractor.js` uses the existing Groq integration (`GROQ_API_KEY`; optional `GROQ_ACTION_MODEL`; kill switch `ASSISTANT_ACTION_LLM=off`) with temperature 0, about 250 output tokens and a 4 second timeout (for GPT-OSS models also `reasoning_effort: low`, so the reasoning does not use up the token cap), and is called only for a new message that is not a question, contains a money expression and an action word, and was not understood by the rules. It receives only that message: no chat history, account data or entity names, and it has no tools. Its output must match a closed schema (unknown keys, ids, confirmation or execution fields and confidence scores reject the whole output); `server/provenanceValidator.js` then requires every span to appear in the user's words, re-parses the amount itself, derives direction from the user's cue words and resolves dates and months on the server. The result is converted back into the same fields the deterministic handlers use, so entity resolution, previews and confirmation are unchanged. If the model is unavailable, slow, malformed or contradicts the user's words, the assistant falls back to deterministic behaviour and never executes anything.
* **Adding a liability (Issue #79).** `server/liabilityLanguage.js` holds the liability-specific language: a strict creation-versus-repayment grammar (creation is checked first, but a sentence that joins an amount to an existing liability with to/toward/on/against/into, or uses a payment verb, is a repayment), the type aliases (car/bike/vehicle/auto/scooter/motorcycle/two-wheeler loan, home/house/housing loan and mortgage, education/student/study loan, personal loan, credit card/card debt/card balance/card dues, and business/gold/loan-against-property as `other`; "card" alone and "loan" alone ask; "EMI" is a payment, not a type), deterministic name generation, role-labelled numbers in one pass (balance, interest rate, monthly payment, term; `11.5%` and `3 years` are never money, and `numberParser` no longer treats a percentage as an amount) and the edit grammar ("make the amount 4 lakh", "change interest to 10.8%", "EMI is 9500", "call it HDFC Car Loan", "make it a personal loan"; a term edit is acknowledged but not stored, and removing the rate or payment is refused with "say 0"). All five liability fields are required and none is guessed; a stated 0 is a value. The structured extractor adds the `create_liability` intent and verbatim `rate`, `payment` and `term` spans, validated against the sentence and against the rules' own role assignment.
* **Edits stay deterministic.** While a proposal is pending, "yeah make it 600 instead", "actually make that six hundred" or "sure, use the HDFC loan instead" are parsed by rules as edits: the old proposal is replaced by a new one that must be confirmed again. The model is never used for confirmation, cancellation or edits.
* **Confirmation is explicit.** The server stores the proposal and shows an exact preview; only a confirmation by proposal id executes it, through the same validators and database helpers as the manual forms. The client then updates its shared state from the stored result.
* **Voice and typed chat use the same flow** (`runTurn`): a spoken "yes" and a typed "yes" confirm through the same endpoint.

See [SECURITY_DEPLOYMENT.md](SECURITY_DEPLOYMENT.md) for the security properties of proposals.

Model selection lives in one module, `server/groqModels.js`. The **default configured models** are `openai/gpt-oss-120b` for chat and plan-chat (`GROQ_CHAT_MODEL`), `openai/gpt-oss-20b` for statement parsing (`GROQ_PARSE_MODEL`) and `openai/gpt-oss-120b` for the action extractor (`GROQ_ACTION_MODEL`). Each can be overridden by an environment variable, so a model the provider retires is a configuration change, not a code change; the defaults are not a promise about the provider's catalogue. Models whose name starts with `openai/gpt-oss-` are sent `reasoning_effort: low` (their reasoning counts against `max_tokens`); any other model gets no extra fields, and only GPT-OSS models are supported by that mapping. Request parameters that differ per call (`temperature`, `max_tokens`, `response_format`) stay with the call site: chat 0.4 / 500, plan-chat 0.4 / 600, statement parsing 0.1 with neither `max_tokens` nor `response_format` (it expects a top-level JSON array, which JSON mode cannot return), the extractor 0 / 250 with `response_format: json_object`. Only `message.content` is ever read; the separate reasoning text is never returned to the user. An optional `GROQ_API_BASE` overrides the API base URL (used by the tests to point at a local stub). No LLM output feeds a financial metric.

## 11. No persisted model artifacts

The repository contains no model file (`.pkl`, `.joblib` and the like) and no training dataset. Every model is constructed and fitted inside the request, on that request's data only, and discarded. Consequences: there is no model versioning, no drift to monitor and no cross-user learning; results depend only on the input and the library versions, and the same input returns the same output. The cost is that each model sees only one user's, possibly short, history.

## 12. What this project is, and is not

FinSphere is not an LLM wrapper. Its financial figures come from persisted PostgreSQL data, server-side validation and ownership, explicit documented formulas, a small set of statistical and machine-learning models, and deterministic scoring rules. The language model is used for grounded explanation and conversation over those figures. That grounding is only as good as the data and rules beneath it; see the limitations in [ML_EVALUATION.md](ML_EVALUATION.md).

## 13. Runtime wording that does not match the implementation

Documentation here uses the correct names. Issue #80 corrected the runtime strings that said "KMeans" (the algorithm is Agglomerative clustering with Ward linkage) and that presented the rule engines as ML: the FastAPI description, the `/health` model list, `metadata.models_run` (now only the three ML models, with `rule_engines_run` beside it), the CL-01 step text and `source_model`, the plan summary ("ML models analysed ..."), the plan-chat prompt headings, the Plans page title and its chat greeting. If a string still says "KMeans" or calls the health score or plan "ML", that is a defect.

Also, `Transactions.jsx` labels the statement buttons "AI-Powered". That is accurate only when a Groq key is configured; without one the rule-based parser runs.

## Evidence map

| Statement | Source |
|---|---|
| Algorithms, seeds, minimum rows, contamination, `k = 3` | `ml_service/models/forecaster.py`, `anomaly.py`, `clustering.py` |
| Weights, benchmarks, grades, omission of missing ratios | `ml_service/models/health_scorer.py` |
| The 12 rules and their thresholds | `ml_service/models/plan_generator.py` |
| Classification rules (Python / SQL / JS) | `ml_service/models/analytics.py`, `server/db/index.js`, `src/utils/finance.js` |
| Endpoint list, CORS, no authentication on FastAPI | `ml_service/main.py` |
| Payload, timeouts, 502 / 503, owner scoping, sanitising | `server/server.js` (`/api/ml/analyze`), `server/planSnapshot.js` |
| plan-chat narrates the server snapshot, client `mlContext` ignored | `server/server.js` (`/api/plan-chat`), `server/tests/plans.test.mjs` |
| Step evidence, order, destinations, wording | `ml_service/models/plan_generator.py`, `ml_service/tests/` |
| Type/classification constraints, `NUMERIC` money | `server/db/schema.sql` |
| No model artifacts | repository search for model/data files (none) |
| Measured behaviour | `ml_service/evaluation/results/` |
