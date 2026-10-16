# FinSphere API notes

This file is not a full API reference yet. It documents the two endpoints behind the Plans / Financial Intelligence page, as
implemented (Issue #80). Both require the signed-in session cookie; the owner is always the verified user, never anything in the
request.

## `GET /api/ml/analyze`

Runs the analysis for the **caller's own** data (transactions, the monthly payments of unpaid liabilities, the saved emergency
fund) through the private FastAPI service and returns:

```jsonc
{
  "health":    { "composite_score", "grade", "ratios": { "<key>": { "value", "unit", "score", "status", "benchmark", "weight_pct" } },
                 "unavailable_ratios": ["dti"], "unavailable_reasons": { "dti": "no_income | debt_total_unavailable",
                                                                         "emergency_coverage": "no_fund | no_spending" },
                 "metadata": { "monthly_income", "avg_monthly_net_spending", "period": { "months", "first_month", "last_month" },
                               "ratios_used", "ratios_total", "total_income_analyzed", "total_expenses_analyzed", ... },
                 "breakdown": { "basis", "spending_by_category": [{ "category", "net_spending", "share_pct" }],
                                "other_net_spending", "categories_total" }, ... },   // rule-based, not ML
  "forecast":  { "historical", "forecast", "insights" },                              // ML: LinearRegression
  "anomalies": { "anomalies", "total_flagged", ... },                                 // ML: IsolationForest
  "clusters":  { "clusters", "model_metrics", "insights" },                           // ML: Agglomerative (Ward)
  "plan": {                                                                            // rule-based, not ML
    "plan_title", "plan_summary", "step_count", "forecast_caveats": [string],
    "steps": [{ "step_id", "title", "description", "priority", "kind": "risk|opportunity|maintenance",
                "method": "rule|ml_signal", "source_model", "category_order", "action": { "destination" } | null,
                "evidence": { "metric", "label", "value", "unit", "threshold", "formula", "inputs", "contributors", "caveats" },
                "timeline", "expected_outcome", ... }]       // already in final order
  },
  "metadata": { "transaction_count", "models_run": [ML models], "rule_engines_run": [rule engines], "elapsed_ms",
                "errors": null | { "<section>": true } }
}
```

* **Sanitised:** `clusters.labeled_transactions` is removed, and `metadata.errors` only says which sections failed
  (`{ "forecast": true }`); Python exception text is never returned.
* **Order:** steps are sorted by priority, then a fixed category order, then step id. There is no score.
* **Errors:** `502 { "error": "ML service returned an error" }` (the upstream body is neither returned nor logged),
  `503` when the service is unreachable, `401` when not signed in. A rate limit of 10 requests per minute per user applies.
* **Snapshot:** a successful result is kept in memory for that user for 30 minutes (up to about 1000 users) so `plan-chat` can
  narrate it. Nothing is persisted.

## `POST /api/plan-chat`

Body: `{ "messages": [{ "role": "user" | "assistant", "content": string }] }` (1 to 20 turns, at most 2000 characters each, the
last from the user).

* Narrates the **server-side snapshot** of the caller's last analysis. A `mlContext` field is still accepted (it must be an
  object) but is ignored.
* With no snapshot (none run yet, or it expired) the response is `200 { "reply": "Run the analysis first." }`.
* The prompt separates the rule-based health score and plan from the ML forecast, anomalies and spending clusters
  ("SPENDING CLUSTERS (Agglomerative, Ward)") and includes each step's evidence so "why" answers quote the same numbers as the page.
* Without a language-model key the reply is the plan summary text. Chat limit: 30 requests per minute per user.

## PATCH /api/transactions/:id

Changes only the category of one of the caller's own transactions. Body: exactly `{ "category": "<1-60 characters, no control characters>" }`;
any other field (amount, date, title, type, classification, id, owner) is refused with 400. Returns the updated transaction (same shape as the
list). 404 for a missing id and for another user's id alike. Same targeting as DELETE (the owner's first match, so a repeated legacy id changes
exactly one row). Limited to 120 requests per minute per user.


## Investment holdings (authenticated, INR only)

GET /api/holdings lists only the session owner's records. POST /api/holdings creates a record with a server-generated UUID (201).
PUT /api/holdings/:id replaces the owner's holding (200); DELETE removes it (204). Missing, malformed and foreign IDs return 404.
Every route requires a current session and is limited to 120 requests/minute/user. No owner or user ID is accepted in input.

POST/PUT accept exactly name (1–100 characters, trimmed, no control characters), assetClass (Stocks, Mutual funds, Bonds,
Deposits, Gold, Other), investedPaise and currentPaise (integer, 0–1,000,000,000,000), and valuedOn (valid YYYY-MM-DD,
1900 onward, no later than one day after the server's current UTC date, so users east of UTC can use their local today). Unknown fields and invalid bodies return 400. Reads return the
same fields plus id. Amounts are total position values, not unit prices. There is no market feed or historical valuation endpoint.

## PATCH /api/auth/profile (setup guide state)

Changes the signed-in user's own profile; the owner always comes from the session. Body: one or more of `displayName` (string, at most 80
characters, no control characters), `reduceMotion` (boolean) and `onboardingState` (`"pending"`, `"skipped"` or `"completed"`); anything else
is refused with 400 and nothing changes. Returns `{ user }`. `GET /api/auth/verify` and login return the same public profile, which includes
`onboardingState`.

`onboardingState` drives the first-login setup guide. Only registration sets `pending`; accounts that existed before the feature, and any
account created without registering (for example a legacy import), are `completed`, so a returning user with an empty account is never treated
as new. `skipped` dismisses the guide and Settings can set `pending` again to reopen it. The guide never creates a financial record.
