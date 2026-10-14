# FinSphere financial logic

The exact rules behind the money figures. They are implemented three times and the test suites check that the three agree on shared fixtures:

| Layer | Where | Used for |
|---|---|---|
| SQL | `server/db/index.js` | budget actuals, the assistant's totals |
| JavaScript | `src/utils/finance.js` | dashboard figures |
| Python | `ml_service/models/analytics.py` (shared helper) | health scorer, forecaster, spending clusters |

See [ML_ARCHITECTURE.md](ML_ARCHITECTURE.md) for where each is used.

## 1. `type` and `classification`

* `type` is the **direction**: `income` (amount stored positive) or `expense` (stored negative). The database enforces the sign.
* `classification` is the **analytical meaning**: `income`, `expense`, `refund`, `transfer`, `unknown`. Allowed pairings (database constraint): an `income`-direction row may be `income`, `refund`, `transfer` or `unknown`; an `expense`-direction row may be `expense`, `transfer` or `unknown`.
* Direction is never inferred from the classification, and the classification is never inferred from the title or category.

## 2. How a row counts

| Classification | Analytical income | Analytical spending | Effect |
|---|---|---|---|
| `income` | yes | no | |
| `expense` | no | yes | |
| `refund` | no | no | **reduces spending**; never income |
| `transfer` | no | no | excluded from both |
| `unknown` (also a missing or unrecognised value) | credit: yes (provisional) | debit: yes (provisional) | falls back to direction, so historical and imported rows keep counting |

Every historical and every imported row is stored as `unknown`.

## 3. Net spending

For a period, net spending = `max(gross spending - refunds, 0)`. The floor is applied **once per period** in SQL and JavaScript. The Python scorer and forecaster apply it **per calendar month**, so one month's refunds can never make another month's spending negative. The amounts are summed exactly (NUMERIC in SQL, integer paise in Python).

Consequence: if refunds in a period exceed that period's spending, the excess is discarded, not carried over or shown as income. A dashboard can therefore show ₹0 spending for a period in which refunds exceeded purchases.

The Balance figure is different on purpose: it is the raw signed total of all rows and ignores classification.

## 4. Ratios that use these rules

* **Monthly income** = analytical income / number of calendar months that have any transaction (transfers count as "having a transaction"; months with none are not invented). Without a dated month there is no monthly income.
* **Debt-to-income (DTI)** = monthly debt payments / analytical monthly income x 100. Monthly debt payments are the sum of the monthly payments of the user's unpaid saved liabilities. Balances and interest rates are not part of it. If either input is missing, DTI is omitted, not set to a default; a real 0 is a supplied value and scores as 0.
* **Average monthly expenses** = analytical net spending (per month, floored) / the same month count.
* **Emergency coverage** (months) = emergency fund / analytical average monthly expenses. Omitted when the fund is not saved or the average is 0; a saved fund of 0 gives 0 months.
* **Savings rate** = (analytical income - net spending) / analytical income x 100 (0 when there is no income). **Expense ratio** = net spending / income x 100 (100 when there is no income).
* **Budget actuals**: for a month and a category, actual = `max(spending in that category - refunds in that category, 0)`, classification-aware, net of matching refunds. Categories match as `lower(btrim(category))` with no aliases.

## 5. Spending by category (Plans breakdown)

The Plans page's "Show breakdown" lists the top five spending categories from the health scorer (`health.breakdown`). It is descriptive only and is not part of any score. The rule is the budget-actuals rule applied per month and per category: the category identity is `lower(btrim(category))`, and for each month and category `net = max(spending - refunds, 0)`, summed exactly in integer paise; transfers are excluded, and an unclassified credit counts as income, never as a refund. The category amounts are summed over the months, so a refund never offsets another month's spending. Shares are relative to the sum of the category amounts (`categories_total`), which can differ from the overall net spending when a category's refunds exceed its spending in a month, because the overall figure nets refunds across categories within the month; the response carries `other_net_spending` and `categories_total` so the list adds up on its own.

## 6. Adding a liability (manual form and assistant)

A liability has five fields and **all five are required**: name, type (`home_loan`, `personal_loan`, `vehicle_loan`, `education_loan`, `credit_card` or `other`), outstanding balance (greater than 0), interest rate (0 to 100, percent per year) and monthly payment (0 or more). Nothing is defaulted or inferred: a missing rate or payment is asked for, and a stated **0** (an interest-free loan, no fixed payment) is a real value, not a default. A loan **term**, a **lender** and start or maturity dates have no columns; a lender can only be part of the name ("HDFC Personal Loan"), and a term the user mentions is recognised and disclosed on the preview but not stored.

The assistant (`create_liability`) and `POST /api/liabilities` share one validator and one insert (`createLiabilityFor`), so they cannot disagree. Adding a liability changes a balance sheet row only: **no transaction is created**, and repayments, DTI and every other metric keep their definitions (DTI still uses only the monthly payments of unpaid liabilities). Names need not be unique in the database; the assistant asks before creating a second liability with the same name. "I owe ₹X on my education loan" never edits an existing balance from chat.

## 7. Not modelled

* **No transfer pairing.** A transfer is excluded because it is marked as one; it is not matched with the opposite leg in another account.
* **No refund linking.** A refund reduces spending in the period it is dated (and, for budgets, in its category); it is not tied to the original purchase.
* **Unknown history.** A past transfer or refund stored as `unknown` is counted by direction.
* **Time zones.** Dates are plain calendar dates. The assistant reports the current budget month in UTC, not in the user's time zone.
