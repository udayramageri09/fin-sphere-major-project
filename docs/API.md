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
