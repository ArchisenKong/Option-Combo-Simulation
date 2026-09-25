"""P6: the seeded FOP ledger campaign in small, fixed form (plan §13.3 P6 step 2, §14.2).

scripts/verify_cost_basis_fop_randomized.py runs the release campaign (2000
seeds of 80 steps, 300 through a temporary store). These checks keep a fixed
slice of it in every test run, and check the campaign itself: its histories are
valid and keep their instants apart, it catches a wrong figure, and its reducer
keeps the failing stage while it shrinks the actions.
"""
import pathlib
import sys
import unittest
from collections import Counter
from unittest import mock

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
for path in (REPO_ROOT, REPO_ROOT / 'tests'):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from helpers import cost_basis_fop_random_campaign as campaign  # noqa: E402


class CampaignTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.campaign = campaign.Campaign()

    @classmethod
    def tearDownClass(cls):
        cls.campaign.close()

    def test_fixed_seeds_agree_with_the_model_through_every_stage(self):
        for seed in range(24):
            with self.subTest(seed=seed):
                self.campaign.verify_case(seed, 60, store=seed < 6)
        coverage = self.campaign.coverage
        for name in ('futures_trade', 'option_trade', 'option_assignment', 'option_exercise', 'option_expiry',
                     'orders', 'negative future prices', 'preview activity', 'preview flex', 'store cases',
                     'store restore', 'store late fee'):
            self.assertGreater(coverage.get(name, 0), 0, f'the fixed slice covers {name}')

    def test_generated_histories_are_valid_and_keep_their_instants_apart(self):
        for seed in range(300):
            case = campaign.generate(seed, 80)
            made = campaign.materialize(case['actions'])
            self.assertIsNotNone(made, f'seed {seed} does not fit its own positions')
            fills, events, _positions = made
            # Only a delivery's two rows share an instant; no row is in the autumn repeated hour.
            per_instant = Counter(fill['utc'] for fill in fills)
            for instant, count in per_instant.items():
                if count > 1:
                    codes = {fill['codes'] for fill in fills if fill['utc'] == instant}
                    self.assertEqual((count, len(codes & {'A', 'Ex'})), (2, 1), f'seed {seed} at {instant}')
            self.assertEqual(len({event['at'] for event in events}), len(events), f'seed {seed}')
            self.assertEqual(events, sorted(events, key=lambda event: event['at']), f'seed {seed}')

    def test_a_wrong_figure_is_caught_and_reduced_to_the_same_stage(self):
        # Inject a fault into the preview: every option trade's price read 0.01 higher.
        real = campaign.statement_options

        def shifted(kind, fills, positions, shape, **options):
            fills = [dict(fill, price=round(fill['price'] + 0.01, 2)) if fill['symbol'].startswith('LO')
                     and fill['codes'] not in ('A', 'Ex', 'Ep') else fill for fill in fills]
            return real(kind, fills, positions, shape, **options)

        seed = next(seed for seed in range(50) if any(action['kind'] == 'trade' and action['contract'] in
                                                      campaign.OPTIONS for action in campaign.generate(seed, 40)['actions']))
        case = campaign.generate(seed, 40)
        with mock.patch.object(campaign, 'statement_options', shifted):
            with self.assertRaises(campaign.CampaignFailure) as caught:
                self.campaign.run(case, store=False)
            self.assertEqual(caught.exception.stage, 'preview')
            reduced = campaign.reduce(self.campaign, case, store=False)
        self.assertEqual(reduced['stage'], 'preview')
        self.assertLess(len(reduced['actions']), len(case['actions']))
        self.assertTrue(any(action['kind'] in ('trade', 'order') and action['contract'] in campaign.OPTIONS
                            for action in reduced['actions']), 'the reduced case keeps an option trade')
        # Saved and loaded, the reduced case still fails the same way, and passes without the fault.
        replayed = dict(case, actions=campaign.load_actions(reduced['actions']))
        with mock.patch.object(campaign, 'statement_options', shifted):
            with self.assertRaises(campaign.CampaignFailure):
                self.campaign.run(replayed, store=False)
        self.campaign.run(replayed, store=False)
        # A passing case reduces to nothing.
        self.assertIsNone(campaign.reduce(self.campaign, case, store=False))


if __name__ == '__main__':
    unittest.main()
