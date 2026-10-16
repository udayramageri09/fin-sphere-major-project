import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from models.forecaster import run_forecaster

class ForecastHorizonTest(unittest.TestCase):
    def test_each_period_uses_real_predictions_and_keeps_three_month_total(self):
        transactions = []
        for month in range(1,7):
            transactions += [dict(date=f'2026-{month:02}-01', amount=10000, type='income', classification='income'), dict(date=f'2026-{month:02}-02',amount=-4000,type='expense',classification='expense')]
        for period in [3,6,12]:
            with self.subTest(period=period):
                result = run_forecaster(transactions, period)
                net = result['forecast']['net']
                self.assertEqual(len(net),period)
                self.assertEqual(len(result['forecast']['months']),period)
                self.assertEqual(result['insights']['forecast_months'],period)
                self.assertAlmostEqual(result['insights']['projected_savings_3m'],sum(net[:3]),places=2)
                self.assertAlmostEqual(result['insights']['projected_savings_total'],sum(net),places=2)
                self.assertAlmostEqual(sum(net),period*6000,places=2)

if __name__ == '__main__': unittest.main()
