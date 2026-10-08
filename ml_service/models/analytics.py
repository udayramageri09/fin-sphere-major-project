"""
analytics.py - the one Python definition of a transaction's analytical role (Issue #61).

Every ML component that produces a financial figure (health scorer, forecaster, spending clusters) calls
add_analytical_columns() instead of reading the sign / type of an amount itself, so they cannot drift apart.
The same rule is implemented in SQL (server/db/index.js) and JavaScript (src/utils/finance.js); the test suites
prove the three agree.

  classification 'income'   -> analytical income
  classification 'expense'  -> analytical spending
  classification 'refund'   -> NOT income; it reduces spending
  classification 'transfer'  -> neither income nor spending
  'unknown' / missing / unrecognised -> legacy fallback by the direction of the signed amount
                                        (> 0 income, < 0 spending), so historical and imported rows keep counting

Net spending of a period = max(spending - refunds, 0), applied PER PERIOD (e.g. per month) so one period's
refunds can never make another period's spending negative. Money is held as integer paise (exact), and only
converted to rupees at the very end by the caller.
"""

import pandas as pd

_KNOWN_CLASSIFICATIONS = ['income', 'expense', 'refund', 'transfer']


def add_analytical_columns(df: pd.DataFrame) -> pd.DataFrame:
    """
    Adds three integer-paise columns to df (in place, and returns it):
      income_p    - the row's amount if it counts as analytical income, else 0
      spending_p  - the row's amount if it counts as analytical spending, else 0
      refund_p    - the row's amount if it is a refund, else 0
    df needs a numeric 'amount' column; an optional 'classification' column is used when present.
    """
    if 'classification' in df.columns:
        classification = df['classification'].fillna('unknown').astype(str).str.strip().str.lower()
    else:
        classification = pd.Series('unknown', index=df.index)
    unlabelled = ~classification.isin(_KNOWN_CLASSIFICATIONS)
    paise = (df['amount'].abs() * 100).round().astype('int64')
    is_income = (classification == 'income') | (unlabelled & (df['amount'] > 0))
    is_spending = (classification == 'expense') | (unlabelled & (df['amount'] < 0))
    is_refund = classification == 'refund'
    df['income_p'] = paise.where(is_income, 0)
    df['spending_p'] = paise.where(is_spending, 0)
    df['refund_p'] = paise.where(is_refund, 0)
    return df
