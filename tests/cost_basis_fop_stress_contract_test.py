"""The FOP stress contract's vectors hold (CODE PLAN/COST_BASIS_FOP_STRESS_CONTRACT.md, plan §13.3 P7).

Design acceptance of P7: every vector in
tests/fixtures/cost_basis_fop/stress_vectors.json is reproduced by the
independent reference model, every hand-worked figure agrees with it, and the
identities the plan asks the design to prove hold: t=0 equals the ledger, a
ledger without options moves linearly month by month, an expiry or early
delivery keeps the economic P&L (the rational ledger replay with the scenario's
settlements equals the position-based change), and a missing quote or an
unsupported model stops instead of guessing. Nothing here runs production code;
the implementation phase runs the same vectors through js/cost_basis_fop_stress.js.
"""
import copy
import json
import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / 'tests' / 'helpers'))

import cost_basis_fop_stress_model as model  # noqa: E402

VECTORS = json.loads((REPO_ROOT / 'tests/fixtures/cost_basis_fop/stress_vectors.json').read_text(encoding='utf-8'))
PRICE = 1e-9      # $/bbl, and for sigma
DOLLARS = 1e-6    # a change or a P&L
RUNS = {}


def full(vector):
    return dict(vector, contracts=VECTORS['contracts'])


def run_of(vector):
    if vector['name'] not in RUNS:
        RUNS[vector['name']] = model.Run(full(vector))
    return RUNS[vector['name']]


def args_of(point):
    return {'shift': point.get('shift', 0), 'slope': point.get('slope', 0),
            'horizon_days': point.get('horizonDays', 0), 'iv_scale': point.get('ivScale', 1.0),
            'early': tuple(point.get('early', ()))}


def by_name(name):
    return next(vector for vector in VECTORS['vectors'] if vector['name'] == name)


class PricerTests(unittest.TestCase):
    """Contract §3: the two pricers, their domain and their limits."""

    def test_every_pricer_case(self):
        for case in VECTORS['pricers']:
            with self.subTest(case['name']):
                tau = model.years(case['asOf'], case['expiryAt'])
                pricer = model.american_futures_crr if case['model'] == 'american' else model.black76
                value = pricer(case['right'], case['future'], case['strike'], tau, case['rate'], case['sigma'])
                expected = case['expect']['value']
                if expected is None:
                    self.assertIsNone(value, 'outside the model domain the pricer stops, with no epsilon')
                    continue
                self.assertAlmostEqual(value, expected, delta=PRICE)
                if 'europeanValue' in case['expect']:
                    european = case['expect']['europeanValue']
                    if 'treeErrorBound' in case['expect']:
                        self.assertLess(abs(value - european), case['expect']['treeErrorBound'])
                    else:
                        self.assertGreaterEqual(value, european)
                if 'parity' in case['expect']:
                    self.assertAlmostEqual(value, case['expect']['parity'], delta=PRICE)

    def test_the_black76_steps_are_the_formula(self):
        case = VECTORS['pricers'][0]
        steps = case['expect']
        tau = model.years(case['asOf'], case['expiryAt'])
        self.assertAlmostEqual(tau, 28.1875 / 365, delta=1e-15)
        for key, value in model.black76_steps('C', 72, 70, tau, 0.04, 0.35).items():
            self.assertAlmostEqual(value, steps[key], delta=PRICE, msg=key)
        self.assertAlmostEqual(steps['value'], steps['discount'] * (72 * steps['Nd1'] - 70 * steps['Nd2']),
                               delta=PRICE)


class CalibrationTests(unittest.TestCase):
    """Contract §4.1: an implied volatility from a live mid, or a named stop."""

    def test_round_trips_and_bounds(self):
        for case in VECTORS['calibration']:
            with self.subTest(case['name']):
                option = VECTORS['contracts'][case['option']]
                tau = model.years(case['asOf'], option['expiryAt'])
                if 'stop' in case['expect']:
                    with self.assertRaises(model.Stop) as stopped:
                        model.implied_sigma(option, case['future'], tau, case['rate'], case['mark'])
                    self.assertEqual(stopped.exception.reason, case['expect']['stop'])
                    continue
                sigma = model.implied_sigma(option, case['future'], tau, case['rate'], case['mark'])
                self.assertAlmostEqual(sigma, case['expect']['sigma'], delta=PRICE)
                self.assertAlmostEqual(case['expect']['repriced'], case['mark'], delta=model.PRICE_TOLERANCE)


class ScenarioTests(unittest.TestCase):
    """Contract §5-§7: every vector, its stops, its points and its identities."""

    def test_every_vector_reproduces(self):
        for vector in VECTORS['vectors']:
            with self.subTest(vector['name']):
                expect = vector['expect']
                if 'stop' in expect:
                    with self.assertRaises(model.Stop) as stopped:
                        run_of(vector)
                    self.assertEqual(stopped.exception.reason, expect['stop'])
                    continue
                run = run_of(vector)
                self.assertEqual(run.empty, expect.get('empty', False))
                if run.empty:
                    for point in expect['points']:
                        self.check_point(vector, run, point)
                    continue
                anchor = expect['anchor']
                self.assertEqual(run.reference, anchor['reference'])
                for alias, sigma in anchor['sigma'].items():
                    self.assertAlmostEqual(run.sigma[alias], sigma, delta=PRICE, msg=alias)
                    self.assertAlmostEqual(run.anchor_value[alias], anchor['value'][alias], delta=PRICE)
                for point in expect['points']:
                    self.check_point(vector, run, point)

    def check_point(self, vector, run, point):
        label = json.dumps({key: point[key] for key in ('shift', 'slope', 'horizonDays', 'ivScale', 'early')
                            if key in point})
        if not point['available']:
            with self.assertRaises(model.Stop, msg=label) as stopped:
                run.point(**args_of(point))
            self.assertEqual(stopped.exception.reason, point['reason'], label)
            return
        got = run.point(**args_of(point))
        self.assertAlmostEqual(got['change'], point['change'], delta=DOLLARS, msg=label)
        self.assertEqual(got['positions'], point['positions'], label)
        self.assertEqual(got['notDelivered'], point['notDelivered'], label)
        self.assertEqual(json.loads(json.dumps(got['settlements'])), point['settlements'], label)
        for alias, value in point['values'].items():
            self.assertAlmostEqual(got['values'][alias], value, delta=PRICE, msg=label)
        # Conservation: the ledger replayed with the scenario's settlements, at the scenario
        # marks, moves from the anchor by exactly the position-based change.
        marks = dict(got['futures'], **got['values'])
        absolute = model.economic_pnl(full(vector), marks, model.settlement_events(got))
        anchor = model.economic_pnl(full(vector), dict(run.anchor, **run.anchor_value))
        self.assertAlmostEqual(float(absolute - anchor), got['change'], delta=DOLLARS, msg=label)
        self.assertAlmostEqual(float(absolute), point['economicPnlModelAnchored'], delta=DOLLARS, msg=label)
        for key in ('handChange', 'handEconomicPnl'):
            if key in point:
                value = got['change'] if key == 'handChange' else float(absolute)
                self.assertAlmostEqual(value, point[key], delta=DOLLARS, msg=f'{label} {key}')

    def test_t0_is_the_ledger_valuation(self):
        vector = by_name('t=0: the anchor is the ledger valuation')
        run = run_of(vector)
        at_anchor = run.point()
        self.assertEqual(at_anchor['change'], 0.0, 'the anchor point is the same evaluation on both sides')
        self.assertEqual(at_anchor['settlements'], [])
        quotes = {alias: model.quote_mark(quote) for alias, quote in vector['quotes'].items()}
        ledger = model.economic_pnl(full(vector), quotes)
        self.assertEqual(float(ledger), vector['expect']['anchor']['handLedgerEconomicPnl'])
        # The model's anchor values reprice the quote mids within the calibration tolerance.
        for alias, value in run.anchor_value.items():
            self.assertAlmostEqual(value, quotes[alias], delta=model.PRICE_TOLERANCE)
        anchored = model.economic_pnl(full(vector), dict(run.anchor, **run.anchor_value))
        residual = sum(abs(n) * 1000 * model.PRICE_TOLERANCE for n in run.options.values())
        self.assertLessEqual(abs(float(anchored - ledger)), residual)

    def test_futures_without_options_are_linear_month_by_month(self):
        vector = by_name('no options: every futures month moves linearly, negative prices included')
        run = run_of(vector)
        for shift in (-150, -100, -72, -10, 0, 0.25, 5, 40):
            for slope in (-1, 0, 0.5):
                for days in (0, 1, 20):
                    got = run.point(shift=shift, slope=slope, horizon_days=days)
                    self.assertAlmostEqual(got['change'], 2000 * shift - 1000 * (shift + slope), delta=DOLLARS)

    def test_an_early_assignment_of_a_short_gains_exactly_the_time_value(self):
        vector = by_name("an early delivery differs from holding by the option's time value")
        hold, early = vector['expect']['points'][:2]
        value = hold['values']['C80']
        intrinsic = hold['futures']['F7'] - 80
        self.assertGreater(intrinsic, 0)
        self.assertGreaterEqual(value, intrinsic, 'an American value is at least its intrinsic value')
        # early - hold = n x mult x (intrinsic - V), n = -1
        self.assertAlmostEqual(early['change'] - hold['change'], -1 * 1000 * (intrinsic - value), delta=DOLLARS)
        self.assertEqual(early['positions'], {}, 'the assigned call closed the long CLF7')
        self.assertNotIn('C80', early['values'])

    def test_an_option_is_priced_off_its_own_future(self):
        vector = by_name('each option is priced off its own future: a curve slope moves CLG7 alone')
        slope_only = vector['expect']['points'][0]
        self.assertEqual(slope_only['futures'], {'F7': 72.0, 'G7': 74.5})
        run = run_of(vector)
        self.assertAlmostEqual(slope_only['change'], -1000 * (slope_only['values']['G85'] - run.anchor_value['G85']),
                               delta=DOLLARS, msg='CLF7 did not move, so only the option changed')

    def test_the_band_holds_the_center(self):
        vector = by_name('t=0: the anchor is the ledger valuation')
        run = run_of(vector)
        band = vector['expect']['band']
        for point in band['points']:
            center = run.point(shift=point.get('shift', 0), horizon_days=point.get('horizonDays', 0))['change']
            low, high = model.band(run, {'shift': point.get('shift', 0), 'horizon_days': point.get('horizonDays', 0)},
                                   band['fraction'])
            self.assertAlmostEqual(low, point['lower'], delta=DOLLARS)
            self.assertAlmostEqual(high, point['upper'], delta=DOLLARS)
            self.assertLessEqual(low, center)
            self.assertGreaterEqual(high, center)

    def test_a_scenario_changes_none_of_its_inputs(self):
        vector = by_name('expiry inside the horizon: a delivery keeps the economic P&L')
        before = copy.deepcopy(vector)
        catalogue = copy.deepcopy(VECTORS['contracts'])
        run = model.Run(full(vector))
        for point in vector['expect']['points']:
            run.point(**args_of(point))
        self.assertEqual(vector, before)
        self.assertEqual(VECTORS['contracts'], catalogue)


def inline(events, quotes, as_of, rate=0.04):
    return {'name': 'inline', 'contracts': VECTORS['contracts'], 'events': events, 'quotes': quotes,
            'asOf': as_of, 'rate': rate}


def trade(event_id, at, kind, contract, q, price):
    return {'id': event_id, 'at': at, 'kind': kind, 'contract': contract, 'q': q, 'price': price}


class BoundaryTests(unittest.TestCase):
    """Contract §3.1, §3.4, §6.2, §6.3, §7.5: the design review's boundaries."""

    def test_a_date_only_last_trade_is_read_on_the_exchange_date(self):
        # CLF7 known only by its last trade date, 2026-12-17. asOf is 03:00Z, 21:00 the evening
        # before in Chicago, so 31 days on is 2026-12-18 by UTC but still 12-17 at the exchange.
        vector = inline([trade('e1', '2026-11-16T02:00:00Z', 'futures_trade', 'D7', 1, 70),
                         trade('e2', '2026-11-16T02:10:00Z', 'option_trade', 'DP65', -1, 0.8)],
                        {'D7': {'bid': 71.99, 'ask': 72.01}, 'DP65': {'bid': 0.49, 'ask': 0.51}},
                        '2026-11-17T03:00:00Z')
        run = model.Run(vector)
        # The put, assigned at its expiry (13:30 Chicago = 19:30Z in December), delivers onto CLF7.
        assigned = run.point(shift=-12, horizon_days=29)
        self.assertEqual([(s['action'], s['at']) for s in assigned['settlements']],
                         [('assign', '2026-12-14T19:30:00Z')])
        self.assertEqual(assigned['positions'], {'D7': 2})
        total = model.economic_pnl(vector, dict(assigned['futures'], **assigned['values']),
                                   model.settlement_events(assigned))
        self.assertEqual(float(total), -14200)  # 2 x 1000 x (60 - 67.5) + 800
        held = run.point(shift=5, horizon_days=31)
        total = model.economic_pnl(vector, dict(held['futures'], **held['values']), model.settlement_events(held))
        self.assertEqual(float(total), 7800)  # 1000 x (77 - 70) + 800; the put expired
        with self.assertRaises(model.Stop) as stopped:
            run.point(shift=5, horizon_days=32)
        self.assertEqual(stopped.exception.reason, 'future_past_last_trade:D7')

    def test_a_date_only_expiry_is_1330_chicago_through_daylight_saving(self):
        # October (CDT): 13:30 Chicago is 18:30Z, so at 19:00Z the call has expired and delivered.
        october = inline([trade('e1', '2026-10-28T15:00:00Z', 'option_trade', 'ZC70', 1, 2.0)],
                         {'Z6': {'bid': 71.99, 'ask': 72.01}, 'ZC70': {'bid': 2.04, 'ask': 2.06}},
                         '2026-10-29T19:00:00Z')
        point = model.Run(october).point(horizon_days=1)
        self.assertEqual([(s['action'], s['at']) for s in point['settlements']],
                         [('exercise', '2026-10-30T18:30:00Z')])
        self.assertEqual(point['positions'], {'Z6': 1})
        total = model.economic_pnl(october, dict(point['futures'], **point['values']),
                                   model.settlement_events(point))
        self.assertEqual(float(total), 0)  # 1000 x (72 - 70) - 2000
        # December (CST): 13:30 Chicago is 19:30Z, so at 19:00Z the call is still open.
        december = inline([trade('e1', '2026-12-12T15:00:00Z', 'option_trade', 'W80', -1, 0.5)],
                          {'F7': {'bid': 71.99, 'ask': 72.01}, 'W80': {'bid': 0.01, 'ask': 0.03}},
                          '2026-12-13T19:00:00Z')
        point = model.Run(december).point(horizon_days=1)
        self.assertEqual(point['settlements'], [])
        self.assertIn('W80', point['values'])

    def test_an_early_delivery_moves_the_pnl_by_n_mult_intrinsic_minus_value(self):
        # early - hold = n x mult x (intrinsic - V): a short gains the time value, a long gives it up.
        run = run_of(by_name("an early delivery differs from holding by the option's time value"))
        for alias, shift, sign in (('C80', 10, 1), ('P65', -12, -1)):
            with self.subTest(alias):
                hold = run.point(shift=shift, horizon_days=10)
                early = run.point(shift=shift, horizon_days=10, early=(alias,))
                n = run.options[alias]
                spec = VECTORS['contracts'][alias]
                future = hold['futures'][spec['future']]
                inner = model.intrinsic(spec['right'], future, spec['strike'])
                self.assertGreater(inner, 0)
                difference = early['change'] - hold['change']
                self.assertAlmostEqual(difference, n * 1000 * (inner - hold['values'][alias]), delta=DOLLARS)
                self.assertGreaterEqual(sign * difference, 0)

    def test_only_an_american_option_in_the_money_is_delivered_early(self):
        run = run_of(by_name("an early delivery differs from holding by the option's time value"))
        # Out of the money at CLF7 72: the short C80 is not assigned; it stays open, and the point says so.
        hold = run.point(horizon_days=10)
        chosen = run.point(horizon_days=10, early=('C80',))
        self.assertEqual(chosen['change'], hold['change'])
        self.assertIn('C80', chosen['values'])
        self.assertEqual(chosen['notDelivered'], [{'option': 'C80', 'why': 'out_of_the_money'}])
        # Settled at its expiry inside the horizon: the choice changes nothing.
        settled = run.point(shift=10, horizon_days=30, early=('C80',))
        self.assertEqual(settled['change'], run.point(shift=10, horizon_days=30)['change'])
        self.assertEqual(settled['notDelivered'], [{'option': 'C80', 'why': 'settled_at_expiry'}])
        # Not an open option of this ledger.
        with self.assertRaises(model.Stop) as stopped:
            run.point(early=('A70',))
        self.assertEqual(stopped.exception.reason, 'early_delivery_unknown:A70')
        # A European option is exercised only at its expiry.
        european = model.Run(inline([trade('e1', '2026-11-02T15:00:00Z', 'option_trade', 'E70', 1, 3.0)],
                                    {'F7': {'bid': 71.99, 'ask': 72.01}, 'E70': {'bid': 3.8, 'ask': 3.9}},
                                    '2026-11-16T15:00:00Z'))
        with self.assertRaises(model.Stop) as stopped:
            european.point(shift=10, horizon_days=10, early=('E70',))
        self.assertEqual(stopped.exception.reason, 'early_delivery_european:E70')

    def test_at_expiry_a_non_positive_future_still_has_its_intrinsic_value(self):
        for pricer in (model.american_futures_crr, model.black76):
            for right, future, value in (('P', -3, 68), ('P', 0, 65), ('C', -3, 0), ('C', 0, 0)):
                with self.subTest(pricer=pricer.__name__, right=right, future=future):
                    self.assertEqual(pricer(right, future, 65, 0.0, 0.04, 0.35), value)
            self.assertIsNone(pricer('P', -3, 65, 0.01, 0.04, 0.35), 'before expiry the model still stops')

    def test_a_flat_ledger_has_nothing_to_move(self):
        flat = inline([trade('e1', '2026-11-02T15:00:00Z', 'futures_trade', 'F7', 1, 70),
                       trade('e2', '2026-11-03T15:00:00Z', 'futures_trade', 'F7', -1, 72)], {},
                      '2026-11-16T15:00:00Z', rate=None)
        run = model.Run(flat)
        self.assertTrue(run.empty)
        for point in ({}, {'shift': -80, 'horizon_days': 60}, {'shift': 5, 'iv_scale': 2.0}):
            got = run.point(**point)
            self.assertEqual((got['change'], got['positions'], got['settlements'], got['futures']), (0.0, {}, [], {}))


class IndependenceTests(unittest.TestCase):
    def test_the_reference_model_uses_no_production_code(self):
        text = (REPO_ROOT / 'tests/helpers/cost_basis_fop_stress_model.py').read_text(encoding='utf-8')
        imports = [line.strip() for line in text.splitlines() if line.startswith(('import ', 'from '))]
        self.assertEqual(sorted(imports), sorted([
            'import math', 'from datetime import datetime, timedelta, timezone', 'from fractions import Fraction',
            'from zoneinfo import ZoneInfo', 'import cost_basis_fop_model as ledger_model']))


if __name__ == '__main__':
    unittest.main()
