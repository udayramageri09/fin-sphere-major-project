"""Plan generator tests (Issue #80).

Rule thresholds are unchanged: every boundary below was the boundary before this issue. The additions (kind, method,
source_model, category_order, action, evidence) are checked for presence, honesty and for reproducing the shown values.
"""
import json
import math
import random
import unittest

import fixtures as F
from models.anomaly import run_anomaly_detection
from models.clustering import run_clustering
from models.forecaster import run_forecaster
from models.health_scorer import run_health_scorer
from models.plan_generator import generate_plan, forecast_caveats

ALLOWED_DESTINATIONS = {'budgets', 'liabilities', 'emergency-fund', 'transactions', None}


def pipeline(rows, debt, fund):
    return generate_plan(run_forecaster(rows, 3), run_anomaly_detection(rows), run_clustering(rows), run_health_scorer(rows, debt, fund))


def health(savings=None, dti=None, fund=None, total_income=100000.0, total_expenses=60000.0, months=3):
    """A hand-made health result: only the fields the rules read."""
    ratios = {}
    if savings is not None:
        ratios['savings_rate'] = {'value': savings}
    if dti is not None:
        ratios['dti'] = {'value': dti}
    meta = {'total_income_analyzed': total_income, 'total_expenses_analyzed': total_expenses, 'months_analyzed': months,
            'monthly_debt_payments_used': 1000.0, 'monthly_income_used': 5000.0}
    if fund is not None:
        ratios['emergency_coverage'] = {'value': round(fund * months / total_expenses, 1)}
        meta['emergency_fund_used'] = fund
    return {'composite_score': 60.0, 'grade': {'grade': 'C'}, 'ratios': ratios, 'metadata': meta,
            'breakdown': {'spending_by_category': [{'category': 'Rent', 'net_spending': 30000.0, 'share_pct': 50.0}]}}


def ids(plan):
    return [s['step_id'] for s in plan['steps']]


def fc(income='stable', expense='stable', projected=1000.0, months_analyzed=6, r2=0.9):
    return {'forecast': {'months': ['Sep 2026', 'Oct 2026', 'Nov 2026'],
                         'income': {'predictions': [100.0, 100.0, 100.0], 'slope': 600.0 if income == 'rising' else 0.0, 'r2': r2, 'model': 'linear_regression'},
                         'expenses': {'predictions': [60.0, 60.0, 60.0], 'slope': 600.0 if expense == 'rising' else 0.0, 'r2': r2, 'model': 'linear_regression'}},
            'insights': {'income_momentum': income, 'expense_momentum': expense, 'projected_savings_3m': projected, 'savings_rate_pct': 20.0, 'months_analyzed': months_analyzed}}


class RulesUnchanged(unittest.TestCase):
    def test_fixed_fixtures_fire_the_same_rules_in_the_same_order(self):
        cases = {
            'typical': (F.typical, 15000.0, 40000.0, [('HS-05', 'critical'), ('AN-01', 'medium')]),
            'healthy': (F.healthy, 0.0, 400000.0, [('AN-01', 'medium')]),
            'stressed': (F.stressed, 20000.0, 0.0, [('FC-03', 'critical'), ('HS-01', 'critical'), ('HS-03', 'critical'), ('HS-05', 'critical'), ('AN-01', 'medium')]),
            'no_income': (F.no_income, 5000.0, None, [('HS-01', 'critical')]),
            'typical_nodata': (F.typical, None, None, [('AN-01', 'medium')]),
        }
        for name, (build, debt, fund, expected) in cases.items():
            plan = pipeline(build(), debt, fund)
            self.assertEqual([(s['step_id'], s['priority']) for s in plan['steps']], expected, name)

    def test_savings_boundaries(self):
        self.assertEqual(ids(generate_plan({}, {}, {}, health(savings=9.9))), ['HS-01'])
        self.assertEqual(ids(generate_plan({}, {}, {}, health(savings=10.0))), ['HS-02'])
        self.assertEqual(ids(generate_plan({}, {}, {}, health(savings=19.9))), ['HS-02'])
        self.assertEqual(ids(generate_plan({}, {}, {}, health(savings=20.0))), [])

    def test_dti_boundaries(self):
        self.assertEqual(ids(generate_plan({}, {}, {}, health(dti=50.1))), ['HS-03'])
        self.assertEqual(ids(generate_plan({}, {}, {}, health(dti=50.0))), ['HS-04'])
        self.assertEqual(ids(generate_plan({}, {}, {}, health(dti=36.1))), ['HS-04'])
        self.assertEqual(ids(generate_plan({}, {}, {}, health(dti=36.0))), [])
        self.assertEqual(ids(generate_plan({}, {}, {}, health(dti=0.0))), [], 'a real 0 does not trigger anything')

    def test_emergency_boundaries_are_exact(self):
        # coverage = fund * months / total expenses; exactly 3.0 months is NOT below 3, exactly 6.0 is NOT below 6
        self.assertEqual(ids(generate_plan({}, {}, {}, health(fund=60000.0, total_expenses=60000.0, months=3))), ['HS-06'], '3.0 months -> only the 6-month rule')
        self.assertEqual(ids(generate_plan({}, {}, {}, health(fund=59999.0, total_expenses=60000.0, months=3))), ['HS-05'], '2.99 months')
        self.assertEqual(ids(generate_plan({}, {}, {}, health(fund=120000.0, total_expenses=60000.0, months=3))), [], '6.0 months')
        self.assertEqual(ids(generate_plan({}, {}, {}, health(fund=119999.0, total_expenses=60000.0, months=3))), ['HS-06'])
        self.assertEqual(ids(generate_plan({}, {}, {}, health(fund=0.0))), ['HS-05'], 'a stated 0 fund is a real 0 and triggers HS-05')

    def test_missing_ratios_trigger_nothing(self):
        self.assertEqual(ids(generate_plan({}, {}, {}, health())), [])
        self.assertEqual(ids(generate_plan({}, {}, {}, {})), [])
        plan = generate_plan({}, {}, {}, {})
        self.assertIsNone(plan['overall_score'])

    def test_forecast_rules(self):
        self.assertEqual(ids(generate_plan(fc(expense='rising'), {}, {}, {})), ['FC-01'])
        self.assertEqual(ids(generate_plan(fc(expense='rising', income='rising'), {}, {}, {})), ['FC-02'])
        self.assertEqual(ids(generate_plan(fc(projected=-1.0), {}, {}, {})), ['FC-03'])
        self.assertEqual(ids(generate_plan(fc(projected=0.0), {}, {}, {})), [])

    def test_anomaly_and_cluster_rules(self):
        an = lambda n: {'total_flagged': n, 'anomalies': [{'id': i, 'title': f't{i}', 'amount': -100.0 * (i + 1), 'date': '2026-07-01', 'severity': 'medium', 'reason': 'r'} for i in range(n)],
                        'insights': {'total_amount_in_anomalies': 600.0}, 'contamination_rate': 0.1}
        plan = generate_plan({}, an(2), {}, {})
        self.assertEqual([(s['step_id'], s['priority']) for s in plan['steps']], [('AN-01', 'medium')])
        self.assertEqual([(s['step_id'], s['priority']) for s in generate_plan({}, an(3), {}, {})['steps']], [('AN-01', 'high')])
        cl = lambda hv, micro: {'clusters': [{'id': 0, 'label': 'Small', 'transaction_count': micro, 'centroid_amount': 50.0, 'total_amount': 50.0 * micro, 'pct_of_total': 10.0},
                                              {'id': 2, 'label': 'Large', 'transaction_count': 3, 'centroid_amount': 5000.0, 'total_amount': 15000.0, 'pct_of_total': 90.0}],
                                'insights': {'high_value_exposure_pct': hv}, 'model_metrics': {'silhouette_score': 0.5}}
        self.assertEqual(ids(generate_plan({}, {}, cl(70.1, 20), {})), ['CL-01'])
        self.assertEqual(ids(generate_plan({}, {}, cl(70.0, 21), {})), ['CL-02'])
        self.assertEqual(ids(generate_plan({}, {}, cl(70.0, 20), {})), [])


class DeterministicOrder(unittest.TestCase):
    def test_priority_then_fixed_category_order_then_id(self):
        h = health(savings=15.0, dti=40.0)
        an = {'total_flagged': 3, 'anomalies': [{'id': 1, 'title': 'x', 'amount': -1.0}], 'insights': {'total_amount_in_anomalies': 1.0}}
        cl = {'clusters': [{'id': 0, 'label': 'S', 'transaction_count': 1, 'centroid_amount': 1.0, 'total_amount': 1.0, 'pct_of_total': 1.0}], 'insights': {'high_value_exposure_pct': 80.0}}
        plan = generate_plan(fc(expense='rising'), an, cl, h)
        # all "high": debt (2), then savings-and-spending FC-01 before HS-02 by id (both 4), transaction review (5), concentration (6)
        self.assertEqual(ids(plan), ['HS-04', 'FC-01', 'HS-02', 'AN-01', 'CL-01'])
        self.assertEqual([s['category_order'] for s in plan['steps']], [2, 4, 4, 5, 6])

    def test_critical_order_is_cash_flow_then_debt_then_emergency(self):
        plan = pipeline(F.stressed(), 20000.0, 0.0)
        self.assertEqual(ids(plan)[:4], ['FC-03', 'HS-01', 'HS-03', 'HS-05'])

    def test_same_inputs_same_order_every_time(self):
        first = ids(pipeline(F.stressed(), 20000.0, 0.0))
        for _ in range(5):
            rows = F.stressed()
            random.shuffle(rows)
            self.assertEqual(ids(pipeline(rows, 20000.0, 0.0)), first)


class StepContract(unittest.TestCase):
    def all_steps(self):
        steps = []
        for build, debt, fund in ((F.stressed, 20000.0, 0.0), (F.typical, 15000.0, 40000.0)):
            steps += pipeline(build(), debt, fund)['steps']
        h = health(savings=15.0, dti=40.0, fund=30000.0)
        cl = {'clusters': [{'id': 0, 'label': 'S', 'transaction_count': 25, 'centroid_amount': 10.0, 'total_amount': 250.0, 'pct_of_total': 5.0}], 'insights': {'high_value_exposure_pct': 80.0}, 'model_metrics': {'silhouette_score': 0.4}}
        steps += generate_plan(fc(expense='rising'), {}, {}, {})['steps']
        steps += generate_plan(fc(expense='rising', income='rising', projected=-5.0), {'total_flagged': 1, 'anomalies': [{'id': 1, 'title': 'x', 'amount': -1.0}], 'insights': {'total_amount_in_anomalies': 1.0}}, cl, h)['steps']
        return steps

    def test_every_step_has_the_full_contract(self):
        seen = set()
        for s in self.all_steps():
            seen.add(s['step_id'])
            self.assertIn(s['kind'], {'risk', 'opportunity', 'maintenance'}, s['step_id'])
            self.assertIn(s['method'], {'rule', 'ml_signal'})
            self.assertIn(s['source_model'], {'Health score rules', 'LinearRegression forecast', 'IsolationForest', 'Agglomerative clustering (Ward)'})
            self.assertIn(s['category_order'], range(1, 7))
            self.assertTrue(s['action'] is None or s['action']['destination'] in ALLOWED_DESTINATIONS - {None})
            ev = s['evidence']
            for key in ('metric', 'label', 'value', 'unit', 'formula', 'inputs', 'contributors', 'caveats', 'threshold'):
                self.assertIn(key, ev, f"{s['step_id']} evidence.{key}")
            self.assertTrue(ev['formula'] and ev['inputs'] is not None)
        self.assertTrue({'HS-03', 'HS-05', 'FC-01', 'FC-02', 'FC-03', 'AN-01', 'CL-01', 'CL-02'} <= seen, seen)

    def test_health_steps_are_rules_and_the_others_are_ml_signals(self):
        for s in self.all_steps():
            if s['step_id'].startswith('HS-'):
                self.assertEqual((s['method'], s['source_model']), ('rule', 'Health score rules'), s['step_id'])
            else:
                self.assertEqual(s['method'], 'ml_signal', s['step_id'])

    def test_destinations_are_the_approved_ones(self):
        expected = {'HS-01': 'budgets', 'HS-02': 'budgets', 'HS-03': 'liabilities', 'HS-04': 'liabilities', 'HS-05': 'emergency-fund', 'HS-06': 'emergency-fund',
                    'FC-01': 'budgets', 'FC-02': None, 'FC-03': 'budgets', 'AN-01': 'transactions', 'CL-01': None, 'CL-02': 'budgets'}
        from models.plan_generator import _STEP_META
        self.assertEqual({k: v['destination'] for k, v in _STEP_META.items()}, expected)
        self.assertEqual({k: v['order'] for k, v in _STEP_META.items()},
                         {'FC-03': 1, 'HS-01': 1, 'HS-03': 2, 'HS-04': 2, 'HS-05': 3, 'HS-06': 3, 'HS-02': 4, 'FC-01': 4, 'AN-01': 5, 'CL-01': 6, 'CL-02': 6, 'FC-02': 6})
        self.assertEqual(_STEP_META['FC-02']['kind'], 'opportunity')

    def test_evidence_inputs_reproduce_the_shown_values(self):
        by_id = {s['step_id']: s for s in pipeline(F.typical(), 15000.0, 40000.0)['steps']}
        s = by_id['HS-05']['evidence']
        fund = next(i['value'] for i in s['inputs'] if i['label'] == 'Emergency fund')
        avg = next(i['value'] for i in s['inputs'] if i['label'].startswith('Average monthly net spending'))
        self.assertEqual(s['value'], math.floor(fund / avg * 100) / 100)
        self.assertEqual(s['threshold'], {'comparator': '<', 'value': 3, 'meaning': 'minimum safe buffer'})
        self.assertEqual(s['unit'], 'months')
        # savings (HS-01 on the no-income fixture) and DTI (HS-03 on the stressed fixture)
        stressed = {x['step_id']: x for x in pipeline(F.stressed(), 20000.0, 0.0)['steps']}
        sv = stressed['HS-01']['evidence']
        income = next(i['value'] for i in sv['inputs'] if i['label'] == 'Income')
        spend = next(i['value'] for i in sv['inputs'] if i['label'] == 'Net spending')
        self.assertEqual(round((income - spend) / income * 100, 1), sv['value'])
        self.assertEqual([c['category'] for c in sv['contributors']], ['Rent', 'Food', 'Fun'])
        dt = stressed['HS-03']['evidence']
        debt = next(i['value'] for i in dt['inputs'] if i['label'].startswith('Monthly debt payments'))
        inc = next(i['value'] for i in dt['inputs'] if i['label'] == 'Monthly income')
        self.assertEqual(round(debt / inc * 100, 1), dt['value'])
        fc3 = stressed['FC-03']['evidence']
        self.assertAlmostEqual(sum(i['value'] for i in fc3['inputs'] if i['label'].startswith('Forecast income')) - sum(i['value'] for i in fc3['inputs'] if i['label'].startswith('Forecast net spending')), fc3['value'], delta=0.05)

    def test_anomaly_evidence_names_the_flagged_transactions(self):
        s = next(x for x in pipeline(F.typical(), 15000.0, 40000.0)['steps'] if x['step_id'] == 'AN-01')
        self.assertEqual(s['evidence']['value'], len(s['evidence']['contributors']))
        for c in s['evidence']['contributors']:
            self.assertTrue({'id', 'title', 'amount', 'date', 'reason'} <= set(c))


class HonestWording(unittest.TestCase):
    def full_text(self):
        parts = []
        for build, debt, fund in ((F.stressed, 20000.0, 0.0), (F.typical, 15000.0, 40000.0), (F.no_income, 5000.0, None)):
            parts.append(json.dumps(pipeline(build(), debt, fund), ensure_ascii=False))
        cl = {'clusters': [{'id': 0, 'label': 'S', 'transaction_count': 25, 'centroid_amount': 10.0, 'total_amount': 250.0, 'pct_of_total': 5.0}], 'insights': {'high_value_exposure_pct': 80.0}}
        parts.append(json.dumps(generate_plan(fc(expense='rising', income='rising', projected=-5.0), {}, cl, health(savings=5.0, dti=60.0, fund=1000.0)), ensure_ascii=False))
        return '\n'.join(parts)

    def test_no_kmeans_and_no_ml_label_on_rule_output(self):
        text = self.full_text()
        for bad in ('KMeans', 'K-Means', 'K-MEANS', 'kmeans', 'ML models analysed', 'HealthScorer'):
            self.assertNotIn(bad, text, bad)

    def test_no_rupee_sign_before_a_percentage(self):
        text = self.full_text()
        import re
        self.assertIsNone(re.search(r'₹\d+(?:\.\d+)?%', text))
        s = next(x for x in pipeline(F.no_income(), 5000.0, None)['steps'] if x['step_id'] == 'HS-01')
        self.assertIn('percentage points to close', s['expected_outcome'])

    def test_summary_says_which_parts_are_rule_based(self):
        plan = pipeline(F.typical(), 15000.0, 40000.0)
        self.assertIn('rule-based', plan['plan_summary'])
        self.assertIn('ML signals', plan['plan_summary'])

    def test_service_labels_in_main(self):
        from main import full_analysis, AnalysisRequest, Transaction, health_check
        req = AnalysisRequest(transactions=[Transaction(**t) for t in F.typical()], monthly_debt_payments=15000.0, emergency_fund=40000.0)
        out = full_analysis(req)
        self.assertEqual(out['metadata']['models_run'], ['LinearRegression', 'IsolationForest', 'AgglomerativeClustering (Ward)'])
        self.assertEqual(out['metadata']['rule_engines_run'], ['HealthScorer (rules)', 'PlanGenerator (rules)'])
        self.assertNotIn('KMeans', json.dumps(health_check()))
        self.assertIn('breakdown', out['health'])
        self.assertIn('forecast_caveats', out['plan'])


class ForecastCaveats(unittest.TestCase):
    def test_short_history_and_low_fit_are_reported_by_the_backend(self):
        self.assertEqual(forecast_caveats(fc(months_analyzed=6, r2=0.9)), [])
        short = forecast_caveats(fc(months_analyzed=2, r2=0.9))
        self.assertEqual(len(short), 1)
        self.assertIn('2 month(s)', short[0])
        weak = forecast_caveats(fc(months_analyzed=6, r2=0.1))
        self.assertEqual(len(weak), 1)
        # Plain-language only: the caveat names the weak series but never a statistical metric.
        self.assertIn('Low fit', weak[0])
        self.assertNotIn('R²', weak[0])
        self.assertEqual(forecast_caveats({}), [])

    def test_a_constant_mean_model_is_not_called_low_fit(self):
        data = fc(months_analyzed=1, r2=0.0)
        data['forecast']['income']['model'] = 'constant_mean'
        data['forecast']['expenses']['model'] = 'constant_mean'
        self.assertEqual(len(forecast_caveats(data)), 1, 'only the short-history caveat')

    def test_the_plan_carries_the_caveats(self):
        plan = generate_plan(fc(expense='rising', months_analyzed=2), {}, {}, {})
        self.assertTrue(plan['forecast_caveats'])
        self.assertEqual(plan['steps'][0]['evidence']['caveats'], plan['forecast_caveats'])


if __name__ == '__main__':
    unittest.main()
