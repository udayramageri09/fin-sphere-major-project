"""Amount clusters must never be described as a purpose (rent, EMIs, fixed costs, food ...).

Regression: the CL-01 plan step claimed a high share of large transactions "indicates high fixed-cost exposure (EMIs, rent)" although the
clustering only groups amounts, and its own evidence caveat says the groups "describe size, not purpose". The wording now states only
what was measured, and the cluster descriptions are built from the recorded amount range.
"""
import unittest

from models.clustering import run_clustering
from models.plan_generator import generate_plan

FORBIDDEN = ('fixed-cost', 'fixed cost', 'emi', 'rent', 'liabilit', 'subscription', 'utility', 'coffee', 'transit')   # "not merchant category" in the disclaimer is correct and allowed


class ClusterWording(unittest.TestCase):
    def test_cl01_describes_size_not_purpose(self):
        clusters = {'clusters': [{'id': 0, 'label': 'S', 'transaction_count': 3, 'centroid_amount': 10.0, 'total_amount': 30.0, 'pct_of_total': 10.0}],
                    'insights': {'high_value_exposure_pct': 80.0}, 'model_metrics': {'silhouette_score': 0.5}}
        plan = generate_plan({}, {}, clusters, {})
        step = next(s for s in plan['steps'] if s['step_id'] == 'CL-01')
        text = ' '.join(str(step.get(key, '')) for key in ('title', 'description', 'expected_outcome')).lower()
        for word in FORBIDDEN:
            self.assertNotIn(word, text, f'CL-01 text must not claim a purpose ({word!r}): {text}')
        self.assertIn('largest transactions', text)
        self.assertIn('does not show what the money was for', text)

    def test_cluster_descriptions_state_the_recorded_range(self):
        rows = [{'id': str(i), 'title': 't', 'amount': -(20 + i), 'date': '2026-09-%02d' % (1 + i % 27), 'type': 'expense', 'category': 'General', 'classification': 'expense'} for i in range(30)]
        rows += [{'id': 'big', 'title': 'b', 'amount': -50000, 'date': '2026-09-15', 'type': 'expense', 'category': 'Rent', 'classification': 'expense'}]
        result = run_clustering(rows)
        self.assertTrue(result['clusters'])
        for cluster in result['clusters']:
            self.assertRegex(cluster['description'], r'^Recorded spending amounts from ₹[\d,.]+ to ₹[\d,.]+\.')
            lowered = cluster['description'].lower()
            for word in FORBIDDEN:
                self.assertNotIn(word, lowered)


if __name__ == '__main__':
    unittest.main()
