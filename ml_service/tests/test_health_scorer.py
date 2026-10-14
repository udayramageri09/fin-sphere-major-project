"""Health scorer tests (Issue #80).

Run from the repository root:  python -m unittest discover ml_service/tests

The scores, ratios and statuses for the fixed fixtures below were captured BEFORE the Issue #80 changes: they prove the
score calculation did not move. The rest covers the additive metadata, the unavailable reasons and the spending breakdown.
"""
import unittest

import fixtures as F
from models.health_scorer import run_health_scorer

# (score, grade, {ratio: (value, score, status)}, unavailable_ratios)
GOLDEN = {
    'typical': (75.3, 'B', {'savings_rate': (51.4, 100.0, 'good'), 'expense_ratio': (48.6, 100.0, 'good'), 'dti': (29.8, 75.6, 'fair'),
                            'emergency_coverage': (1.6, 32.7, 'poor'), 'investment_rate': (0.7, 3.0, 'poor'), 'cash_flow_positivity': (100.0, 100.0, 'good')}, []),
    'healthy': (100.0, 'A', {'savings_rate': (75.0, 100.0, 'good'), 'expense_ratio': (25.0, 100.0, 'good'), 'dti': (0.0, 100.0, 'good'),
                             'emergency_coverage': (13.3, 100.0, 'good'), 'investment_rate': (16.7, 100.0, 'good'), 'cash_flow_positivity': (100.0, 100.0, 'good')}, []),
    'stressed': (3.6, 'D', {'savings_rate': (-50.0, 0, 'poor'), 'expense_ratio': (150.0, 4.7, 'poor'), 'dti': (66.7, 13.3, 'poor'),
                            'emergency_coverage': (0.0, 0, 'poor'), 'investment_rate': (0.0, 0, 'poor'), 'cash_flow_positivity': (0.0, 0, 'poor')}, []),
    'no_income': (5.1, 'D', {'savings_rate': (0, 0, 'poor'), 'expense_ratio': (100, 16.5, 'poor'), 'investment_rate': (0, 0, 'poor'),
                             'cash_flow_positivity': (0.0, 0, 'poor')}, ['dti', 'emergency_coverage']),
    'typical_nodata': (85.1, 'A', {'savings_rate': (51.4, 100.0, 'good'), 'expense_ratio': (48.6, 100.0, 'good'), 'investment_rate': (0.7, 3.0, 'poor'),
                                   'cash_flow_positivity': (100.0, 100.0, 'good')}, ['dti', 'emergency_coverage']),
}
INPUTS = {
    'typical': (F.typical, 15000.0, 40000.0), 'healthy': (F.healthy, 0.0, 400000.0), 'stressed': (F.stressed, 20000.0, 0.0),
    'no_income': (F.no_income, 5000.0, None), 'typical_nodata': (F.typical, None, None),
}


def run(name):
    build, debt, fund = INPUTS[name]
    return run_health_scorer(build(), monthly_debt_payments=debt, emergency_fund=fund)


class ScoreUnchanged(unittest.TestCase):
    def test_fixed_fixtures_keep_their_scores_ratios_and_statuses(self):
        for name, (score, grade, ratios, unavailable) in GOLDEN.items():
            h = run(name)
            self.assertEqual(h['composite_score'], score, name)
            self.assertEqual(h['grade']['grade'], grade, name)
            self.assertEqual(h['unavailable_ratios'], unavailable, name)
            self.assertEqual({k: (v['value'], v['score'], v['status']) for k, v in h['ratios'].items()}, ratios, name)

    def test_weights_and_benchmarks_are_the_documented_ones(self):
        from models import health_scorer as hs
        self.assertEqual(hs._WEIGHTS, {'savings_rate': 0.25, 'expense_ratio': 0.20, 'dti': 0.20, 'emergency_coverage': 0.15, 'investment_rate': 0.10, 'cash_flow_positivity': 0.10})
        self.assertEqual(hs._BENCHMARKS['savings_rate'], {'ideal': 30, 'acceptable': 20, 'poor': 10})
        self.assertEqual(hs._BENCHMARKS['dti'], {'ideal': 20, 'acceptable': 36, 'poor': 50})
        self.assertEqual(hs._BENCHMARKS['emergency_months'], {'ideal': 6, 'acceptable': 3, 'poor': 1})
        self.assertEqual([t[0] for t in hs._GRADE_THRESHOLDS], [85, 70, 55, 0])

    def test_effective_weights_sum_to_100_over_the_ratios_that_exist(self):
        for name in GOLDEN:
            h = run(name)
            self.assertAlmostEqual(sum(r['weight_pct'] for r in h['ratios'].values()), 100.0, delta=0.2, msg=name)


class UnavailableSemantics(unittest.TestCase):
    def test_zero_income_makes_dti_unavailable_with_a_reason(self):
        h = run('no_income')
        self.assertNotIn('dti', h['ratios'])
        self.assertEqual(h['unavailable_reasons']['dti'], 'no_income')
        self.assertEqual(h['unavailable_reasons']['emergency_coverage'], 'no_fund')

    def test_missing_debt_total_and_missing_fund_have_their_own_reasons(self):
        h = run('typical_nodata')
        self.assertEqual(h['unavailable_reasons'], {'dti': 'debt_total_unavailable', 'emergency_coverage': 'no_fund'})
        self.assertEqual(h['metadata']['ratios_used'], 4)
        self.assertEqual(h['metadata']['ratios_total'], 6)

    def test_a_fund_without_spending_is_no_spending(self):
        income_only = [F.tx(1, 'Salary', 50000, '2026-07-01', 'income', 'Salary', 'income')]
        h = run_health_scorer(income_only, monthly_debt_payments=0.0, emergency_fund=5000.0)
        self.assertNotIn('emergency_coverage', h['ratios'])
        self.assertEqual(h['unavailable_reasons'], {'emergency_coverage': 'no_spending'})
        self.assertEqual(h['ratios']['dti']['value'], 0.0, 'a stated 0 of debt payments is a real 0')

    def test_a_stated_zero_fund_is_supplied_not_missing(self):
        h = run('stressed')
        self.assertEqual(h['ratios']['emergency_coverage']['value'], 0.0)
        self.assertNotIn('emergency_coverage', h['unavailable_reasons'])
        self.assertEqual(h['unavailable_reasons'], {})

    def test_everything_available_means_no_reasons(self):
        self.assertEqual(run('typical')['unavailable_reasons'], {})
        self.assertEqual(run('typical')['metadata']['ratios_used'], 6)


class MetadataAndPeriod(unittest.TestCase):
    def test_monthly_figures_and_period(self):
        m = run('typical')['metadata']
        self.assertEqual(m['monthly_income'], 50375.0)
        self.assertEqual(m['avg_monthly_net_spending'], 24500.0)
        self.assertEqual(m['period'], {'months': 4, 'first_month': '2026-05', 'last_month': '2026-08'})
        # they reproduce the totals the existing fields report
        self.assertEqual(round(m['total_income_analyzed'] / m['period']['months'], 2), m['monthly_income'])
        self.assertEqual(round(m['total_expenses_analyzed'] / m['period']['months'], 2), m['avg_monthly_net_spending'])

    def test_no_income_still_reports_spending_and_period(self):
        m = run('no_income')['metadata']
        self.assertEqual(m['monthly_income'], 0.0)
        self.assertEqual(m['period']['months'], 2)
        self.assertIsNone(m['monthly_income_used'], 'the DTI input stays absent when DTI is unavailable')


class SpendingBreakdown(unittest.TestCase):
    def breakdown(self, rows):
        return run_health_scorer(rows, monthly_debt_payments=0.0, emergency_fund=0.0)['breakdown']

    def test_refunds_reduce_their_own_category_and_transfers_are_excluded(self):
        b = self.breakdown(F.typical())
        cats = {c['category']: c['net_spending'] for c in b['spending_by_category']}
        self.assertEqual(cats, {'Rent': 60000.0, 'Food': 32000.0, 'Transport': 6000.0}, 'Food = 34,000 - the 2,000 refund; the 10,000 transfer is not spending')
        self.assertEqual(b['categories_total'], 98000.0)
        self.assertEqual(sum(c['share_pct'] for c in b['spending_by_category']), 100.0)

    def test_category_identity_is_normalised(self):
        rows = [F.tx(1, 'a', -100, '2026-07-01', 'expense', ' Food ', 'expense'), F.tx(2, 'b', -50, '2026-07-02', 'expense', 'food', 'expense'),
                F.tx(3, 'c', -25, '2026-07-03', 'expense', 'FOOD', 'expense')]
        cats = self.breakdown(rows)['spending_by_category']
        self.assertEqual(len(cats), 1)
        self.assertEqual(cats[0]['net_spending'], 175.0)

    def test_a_refund_never_offsets_another_months_spending(self):
        rows = [F.tx(1, 'a', -100, '2026-06-01', 'expense', 'Food', 'expense'), F.tx(2, 'r', 500, '2026-07-01', 'income', 'Food', 'refund'),
                F.tx(3, 'b', -300, '2026-08-01', 'expense', 'Food', 'expense')]
        cats = self.breakdown(rows)['spending_by_category']
        self.assertEqual(cats[0]['net_spending'], 400.0, 'July refund (500) floors at 0 in July; June and August spending stay whole')

    def test_unknown_classification_falls_back_to_the_amount_direction(self):
        rows = [F.tx(1, 'a', -80, '2026-07-01', 'expense', 'Misc'), F.tx(2, 'b', 40, '2026-07-02', 'income', 'Misc')]
        cats = self.breakdown(rows)['spending_by_category']
        self.assertEqual(cats[0]['net_spending'], 80.0, 'an unknown credit counts as income, never as a refund')

    def test_exact_paise(self):
        rows = [F.tx(1, 'a', -0.10, '2026-07-01', 'expense', 'X', 'expense'), F.tx(2, 'b', -0.20, '2026-07-02', 'expense', 'X', 'expense')]
        self.assertEqual(self.breakdown(rows)['spending_by_category'][0]['net_spending'], 0.3)

    def test_top_five_and_the_rest_add_up(self):
        rows = [F.tx(i, f'c{i}', -(100 + i), '2026-07-01', 'expense', f'Cat{i}', 'expense') for i in range(8)]
        b = self.breakdown(rows)
        self.assertEqual(len(b['spending_by_category']), 5)
        self.assertEqual(sum(c['net_spending'] for c in b['spending_by_category']) + b['other_net_spending'], b['categories_total'])
        self.assertEqual([c['category'] for c in b['spending_by_category']], ['Cat7', 'Cat6', 'Cat5', 'Cat4', 'Cat3'])

    def test_ties_are_ordered_deterministically_and_blank_categories_are_named(self):
        rows = [F.tx(1, 'a', -10, '2026-07-01', 'expense', 'Beta', 'expense'), F.tx(2, 'b', -10, '2026-07-01', 'expense', 'Alpha', 'expense'),
                F.tx(3, 'c', -5, '2026-07-01', 'expense', '', 'expense')]
        cats = [c['category'] for c in self.breakdown(rows)['spending_by_category']]
        self.assertEqual(cats, ['Alpha', 'Beta', 'Uncategorised'])


class GroundedAdvice(unittest.TestCase):
    def test_no_generic_investment_advice_when_nothing_is_wrong(self):
        recs = run('healthy')['recommendations']
        self.assertEqual(recs, ['No issues found in the computed ratios.'])
        for name in GOLDEN:
            self.assertNotIn('tax-loss', ' '.join(run(name)['recommendations']))


if __name__ == '__main__':
    unittest.main()
