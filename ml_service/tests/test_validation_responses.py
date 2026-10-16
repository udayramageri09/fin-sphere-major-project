"""A refused request must be a clean 422 that never reflects the submitted financial rows.

Regression for two verified defects of the default FastAPI handler: (1) a non-finite amount (NaN) made the error response itself
un-serialisable, so the service answered HTTP 500; (2) an oversized history was echoed back in full (about 177 kB for 3,001 rows).
No HTTP client library is required: the handler is exercised directly, and the full ASGI path is covered by the API's own tests.
"""
import asyncio
import json
import unittest

from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError

from main import AnalysisRequest, refuse_invalid_request


def refusal_for(**kwargs):
    try:
        AnalysisRequest(**kwargs)
    except ValidationError as err:
        return asyncio.run(refuse_invalid_request(None, RequestValidationError(err.errors())))
    raise AssertionError('the request should have been refused')


class ValidationResponses(unittest.TestCase):
    def test_non_finite_amount_is_a_clean_422(self):
        row = dict(title='SENTINEL-TITLE', amount=float('nan'), date='2026-10-01')
        response = refuse_for_rows([row])
        self.assertEqual(response.status_code, 422)
        body = json.loads(response.body)          # strict JSON: no NaN anywhere
        self.assertTrue(body['detail'])
        self.assertNotIn(b'SENTINEL', response.body)

    def test_oversized_history_is_not_echoed_back(self):
        rows = [dict(title='SENTINEL-TITLE', amount=-5, date='2026-10-01')] * 3001
        response = refuse_for_rows(rows)
        self.assertEqual(response.status_code, 422)
        self.assertNotIn(b'SENTINEL', response.body)
        self.assertLess(len(response.body), 2000)

    def test_financial_context_and_horizon_refusals_name_the_field_only(self):
        for kwargs, field in [({'emergency_fund': -1}, 'emergency_fund'), ({'monthly_debt_payments': -5}, 'monthly_debt_payments'), ({'n_forecast_months': 13}, 'n_forecast_months')]:
            response = refusal_for(transactions=[], **kwargs)
            self.assertEqual(response.status_code, 422)
            detail = json.loads(response.body)['detail']
            self.assertIn(field, [part for item in detail for part in item['loc']])
            self.assertTrue(all(set(item) == {'loc', 'msg', 'type'} for item in detail))


def refuse_for_rows(rows):
    return refusal_for(transactions=rows)


if __name__ == '__main__':
    unittest.main()
