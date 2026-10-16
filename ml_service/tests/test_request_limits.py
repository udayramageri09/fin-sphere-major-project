import unittest
from pydantic import ValidationError
from main import AnalysisRequest, Transaction

class RequestLimits(unittest.TestCase):
    def test_transaction_count_boundary(self):
        row = dict(title='Synthetic', amount=-10, date='2026-10-01')
        self.assertEqual(len(AnalysisRequest(transactions=[row]*3000).transactions), 3000)
        with self.assertRaises(ValidationError):
            AnalysisRequest(transactions=[row]*3001)

    def test_nonfinite_money_and_forecast_horizon(self):
        for amount in [float('nan'), float('inf'), -float('inf')]:
            with self.assertRaises(ValidationError):
                Transaction(title='Synthetic', amount=amount, date='2026-10-01')
        for months in [0, 13, None]:
            with self.assertRaises(ValidationError):
                AnalysisRequest(transactions=[], n_forecast_months=months)
