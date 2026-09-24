"""P2: the server's FOP rules without a database (plan §6.1, §8.1, §9.2).

cost_basis_fop_domain.py is pure. These cases pin the rules the store relies
on: the frozen contract shapes (the server accepts every valid example and
refuses every invalid one), the delivery direction, the trade-date
projection, the P2 quantity replay and the repeated-source comparison that
imports use from P4.
"""
import copy
import json
import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
for path in (REPO_ROOT, REPO_ROOT / 'tests'):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import cost_basis_fop_domain as domain  # noqa: E402
import cost_basis_fop_schema as schema  # noqa: E402
from cost_basis_fop_test_support import PROTOCOL  # noqa: E402

CONTRACT = REPO_ROOT / 'tests' / 'fixtures' / 'cost_basis_fop' / 'contract'


def row(event_id, kind, seq, *, contracts=None, future_contracts=None, contract='c1',
        delivered=None, open_close=None, at='2026-10-01T14:00:00.000000Z', span=None,
        evidence=None, ref=None, price=None):
    start, end = span or (None, None)
    return {'event_id': event_id, 'kind': kind, 'seq': seq, 'contracts': contracts,
            'future_contracts': future_contracts, 'contract_id': contract,
            'delivered_contract_id': delivered, 'open_close': open_close,
            'executed_at_utc': None if span else at, 'time_range_start_utc': start,
            'time_range_end_utc': end, 'order_evidence': evidence, 'external_ref': ref,
            'price': price, 'cash_amount': 0.0, 'fees': 0.0}


class ContractShapeTests(unittest.TestCase):
    def test_the_runtime_protocol_is_the_frozen_contract(self):
        fixture = json.loads((CONTRACT / 'protocol.json').read_text(encoding='utf-8'))
        runtime = schema.protocol()
        self.assertEqual(runtime['types'], fixture['types'])
        self.assertEqual(runtime['formats'], fixture['formats'])

    def test_the_server_accepts_every_valid_example_and_refuses_every_invalid_one(self):
        for example in PROTOCOL['examples']['valid']:
            with self.subTest(valid=example['name']):
                domain.require_shape(example['type'], example['value'])
        for example in PROTOCOL['examples']['invalid']:
            with self.subTest(invalid=example['name']):
                with self.assertRaises(domain.FopDomainError) as caught:
                    domain.require_shape(example['type'], example['value'])
                self.assertEqual(caught.exception.code, 'invalid_request')
                self.assertIn(f"{example['expect']['path'] or '(root)'}: {example['expect']['code']}",
                              str(caught.exception))


class RuleTests(unittest.TestCase):
    def test_a_delivery_moves_the_future_the_way_plan_6_1_says(self):
        self.assertEqual(domain.delivery_direction('C', 1), -1, 'short call assigned: FUT short')
        self.assertEqual(domain.delivery_direction('P', 1), 1, 'short put assigned: FUT long')
        self.assertEqual(domain.delivery_direction('C', -1), 1, 'long call exercised: FUT long')
        self.assertEqual(domain.delivery_direction('P', -1), -1, 'long put exercised: FUT short')

    def test_trade_dates_are_projected_in_the_tws_timezone(self):
        summer = {'executedAtUtc': '2026-10-01T02:30:05.500000Z', 'timeRange': None,
                  'exchangeTradeDate': '2026-10-01'}
        # 22:30 the evening before in New York: the calendar day, not the
        # exchange trade date, and never the UTC day.
        self.assertEqual(domain.time_projection(summer, 'America/New_York'),
                         ('2026-09-30', '2026-09-30T22:30:05'))
        winter = dict(summer, executedAtUtc='2026-12-01T14:30:05.000000Z')
        self.assertEqual(domain.time_projection(winter, 'America/New_York'),
                         ('2026-12-01', '2026-12-01T09:30:05'))
        ranged = {'executedAtUtc': None, 'exchangeTradeDate': '2026-10-02',
                  'timeRange': {'startUtc': '2026-10-01T04:00:00.000000Z',
                                'endUtc': '2026-10-03T04:00:00.000000Z'}}
        self.assertEqual(domain.time_projection(ranged, 'America/New_York'), ('2026-10-02', None))
        with self.assertRaises(domain.FopDomainError):
            domain.time_projection(summer, 'Not/AZone')

    def test_the_replay_refuses_closes_that_overdraw(self):
        opened = row('e1', 'option_trade', 1, contracts=-1)
        assigned = row('e2', 'option_assignment', 2, contracts=1, future_contracts=-1,
                       delivered='f1', at='2026-11-17T20:00:00.000000Z')
        order, after = domain.replay_quantities([assigned, opened])
        self.assertEqual(order, ['e1', 'e2'], 'economic order, not entry order')
        self.assertEqual(after['e2'], {('FUT', 'f1'): -1})
        refused = {
            'assignment before the short': [dict(assigned, executed_at_utc='2026-09-01T00:00:00.000000Z'),
                                            opened],
            'assigning more than is short': [opened, dict(assigned, contracts=2, future_contracts=-2)],
            'an exercise of a short': [opened, row('e3', 'option_exercise', 3, contracts=-1,
                                                   future_contracts=1, delivered='f1',
                                                   at='2026-11-17T20:00:00.000000Z')],
            'an opening that reduces': [row('f', 'futures_trade', 1, future_contracts=2, contract='f1'),
                                        row('g', 'futures_trade', 2, future_contracts=-1,
                                            contract='f1', open_close='O',
                                            at='2026-10-02T00:00:00.000000Z')],
            'a close-and-open that does not cross': [
                row('f', 'futures_trade', 1, future_contracts=2, contract='f1'),
                row('g', 'futures_trade', 2, future_contracts=-1, contract='f1', open_close='CO',
                    at='2026-10-02T00:00:00.000000Z')],
        }
        for name, rows in refused.items():
            with self.subTest(name), self.assertRaises(domain.FopDomainError) as caught:
                domain.replay_quantities(rows)
            self.assertEqual(caught.exception.code, 'position_overdraw')
        crossing = [row('f', 'futures_trade', 1, future_contracts=1, contract='f1'),
                    row('g', 'futures_trade', 2, future_contracts=-2, contract='f1', open_close='CO',
                        at='2026-10-02T00:00:00.000000Z')]
        self.assertEqual(domain.replay_quantities(crossing)[1]['g'], {('FUT', 'f1'): -1})

    def test_a_source_split_across_events_gives_each_event_its_own_key(self):
        # P2 review R4: the source table de-duplicates the source; the events
        # table keeps one key per event, and each still shows its source.
        def normalized(primary):
            ref = None if primary is None else f'{primary[0]}:{primary[1]}'
            return {'event': {'external_ref': ref}, 'primary_source': primary}

        split = ('tws_exec', 'exec-summary-0001')
        alone = ('ib_exec', 'exec-alone-00001')
        events = [normalized(split), normalized(alone), normalized(split), normalized(None)]
        ids = ['evt-a-00000001', 'evt-b-00000002', 'evt-c-00000003', 'evt-d-00000004']
        refs = domain.event_external_refs(events, ids)
        self.assertEqual(refs, ['tws_exec:exec-summary-0001#evt-a-00000001', 'ib_exec:exec-alone-00001',
                                'tws_exec:exec-summary-0001#evt-c-00000003', None])
        self.assertEqual(len(set(refs[:3])), 3)
        self.assertEqual([domain.listed_external_ref(ref, event_id) for ref, event_id in zip(refs, ids)],
                         ['exec-summary-0001', 'exec-alone-00001', 'exec-summary-0001', None])
        self.assertEqual(domain.listed_external_ref('manual:ref#1', 'evt-a-00000001'), 'ref#1',
                         "only the event's own id is taken off")

    def test_a_boundary_sits_on_a_live_event_after_which_all_is_zero(self):
        rows = [row('a', 'futures_trade', 1, future_contracts=1, contract='f1'),
                row('b', 'futures_trade', 2, future_contracts=-1, contract='f1',
                    at='2026-10-02T00:00:00.000000Z'),
                row('c', 'fee', 3, at='2026-10-03T00:00:00.000000Z')]
        timeline = domain.build_timeline(rows)
        domain.check_cycle_anchors([{'boundary_id': 'x', 'anchor_event_id': 'b'}], timeline)
        domain.check_cycle_anchors([{'boundary_id': 'x', 'anchor_event_id': 'c'}], timeline)
        without_b = domain.build_timeline([rows[0], rows[2]])
        for anchor, built in (('a', timeline), ('b', without_b)):
            with self.subTest(anchor=anchor), self.assertRaises(domain.FopDomainError) as caught:
                domain.check_cycle_anchors([{'boundary_id': 'x', 'anchor_event_id': anchor}], built)
            self.assertEqual(caught.exception.code, 'fop_cycle_boundary_violated')


class RepeatedSourceTests(unittest.TestCase):
    def test_every_worked_case_gets_its_stated_outcome(self):
        for case in PROTOCOL['domainCases']:
            with self.subTest(case['name']):
                self.assertEqual(domain.repeat_outcome(case['stored'], case['incoming']),
                                 case['expect'])

    def test_every_event_field_and_time_fact_has_one_policy(self):
        types = schema.protocol()['types']
        groups = (set(domain.REPEAT_EVENT_VALUES), domain.REPEAT_EVENT_BY_MEANING,
                  domain.REPEAT_EVENT_PROVENANCE)
        self.assertEqual(sum(map(len, groups)), len(set().union(*groups)))
        declared = set().union(*(set(case['fields']) for case in types['FopEvent']['cases'].values()))
        self.assertEqual(set().union(*groups), declared)
        time = (set(domain.REPEAT_TIME_COMPARED), set(domain.REPEAT_TIME_REPORTED))
        self.assertFalse(time[0] & time[1])
        self.assertEqual(time[0] | time[1], set(types['TimeFacts']['fields']))

    def test_a_delivery_whose_binding_names_another_pair_is_refused(self):
        case = copy.deepcopy(next(c for c in PROTOCOL['domainCases'] if 'bindings' in c['stored']))
        case['incoming']['bindings'][0]['futureContractId'] = 'fut-other-0001'
        with self.assertRaises(domain.FopDomainError):
            domain.repeat_outcome(case['stored'], case['incoming'])


if __name__ == '__main__':
    unittest.main()
