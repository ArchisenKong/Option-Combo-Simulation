"""P2: read-only FOP contract resolution (plan §4.1-§4.3, §10.2).

A fake contract-details service stands in for IB; nothing here talks to TWS.
The delivery month comes from the underlying FUT's contractMonth reached
through the option's underConId, never from a last-trade date or an option
expiry (F03, F04); conflicts and ambiguity are reported, not guessed (F05).
"""
import asyncio
import copy
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
for path in (REPO_ROOT, REPO_ROOT / 'tests'):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import cost_basis_fop_broker as broker  # noqa: E402
from cost_basis_fop_test_support import (  # noqa: E402
    CLZ6, LOZ6, MANUAL_BINDING, FopLedger, at, example_event, in_range,
)

OBSERVED = '2026-10-01T15:00:00.000000Z'
LOZ6_DETAILS = {'conId': 9001, 'secType': 'FOP', 'symbol': 'CL', 'tradingClass': 'LO',
                'localSymbol': 'LOZ6 C7500', 'exchange': 'NYMEX', 'currency': 'USD', 'right': 'C',
                'strike': 75.0, 'lastTradeDateOrContractMonth': '20261117', 'multiplier': '1000',
                'underConId': 555}
# CL December: last trade in November, delivery month December.
CLZ6_DETAILS = {'conId': 555, 'secType': 'FUT', 'symbol': 'CL', 'tradingClass': 'CL',
                'localSymbol': 'CLZ6', 'exchange': 'NYMEX', 'currency': 'USD',
                'lastTradeDateOrContractMonth': '20261119', 'contractMonth': '202612',
                'multiplier': '1000'}
CLF7_DETAILS = dict(CLZ6_DETAILS, conId=556, localSymbol='CLF7',
                    lastTradeDateOrContractMonth='20261217', contractMonth='202701')
# A weekly option expiring after CLZ6 stopped trading: it delivers CLF7, which
# neither its expiry month (November) nor a front-month rule would give.
WEEKLY_DETAILS = dict(LOZ6_DETAILS, conId=9101, tradingClass='LO4', localSymbol='LO4X6 C7500',
                      lastTradeDateOrContractMonth='20261125', underConId=556)
WEEKLY = dict(LOZ6, contractId='fop-lo4x6-c75-1', conId=9101, tradingClass='LO4',
              localSymbol='LO4X6 C7500', optionExpiry='2026-11-25')


class FakeIB:
    def __init__(self, details, delay=0.0):
        self.details = details
        self.delay = delay
        self.queries = []
        self.active = 0
        self.max_active = 0

    async def __call__(self, query):
        self.queries.append(query)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(self.delay)
            if 'conId' in query:
                return [copy.deepcopy(d) for d in self.details if d['conId'] == query['conId']]
            return [copy.deepcopy(d) for d in self.details if d['secType'] == 'FOP'
                    and d['symbol'] == query['symbol'] and d['right'] == query['right']
                    and d['strike'] == query['strike']
                    and d['lastTradeDateOrContractMonth'] == query['lastTradeDateOrContractMonth']]
        finally:
            self.active -= 1


class BrokerResolutionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.ledger = FopLedger(pathlib.Path(self._tmp.name) / 'cost_basis.db')
        self.book = self.ledger.store.get_book(self.ledger.book_id)

    def resolve(self, queries, ib):
        return asyncio.run(broker.resolve_fop_contracts(
            self.ledger.store, self.book, queries, contract_details=ib, observed_at=OBSERVED))

    def test_the_delivery_month_is_the_underlyings_contract_month(self):
        [result] = self.resolve([LOZ6], FakeIB([LOZ6_DETAILS, CLZ6_DETAILS]))
        self.assertEqual(result['status'], 'verified_broker', result['problems'])
        self.assertEqual(result['future']['futureContractMonth'], '202612')
        self.assertEqual(result['future']['futureLastTradeDate'], '2026-11-19',
                         'kept apart from the month (F03)')
        self.assertIn('underConId 555', result['evidenceSummary'])
        # The credential lets the ledger store a verified_broker binding.
        future = dict(result['future'], contractId=CLZ6['contractId'], revision=1)
        self.ledger.append(at(example_event('FUT trade: cash is minus fees, notional stays out'),
                              '2026-10-01T14:30:05.000000Z'), contracts=[future])
        self.ledger.append(at(example_event('short call with its contract record'),
                              '2026-10-02T14:00:00.000000Z'), contracts=[LOZ6])
        binding = dict(MANUAL_BINDING, status='verified_broker',
                       evidenceCredential=result['evidenceCredential'],
                       evidenceSummary=result['evidenceSummary'])
        assigned = self.ledger.append(
            in_range(example_event('short call assigned: one FUT short at the strike, cash is the fee'),
                     '2026-11-16T05:00:00.000000Z', '2026-11-18T05:00:00.000000Z', '2026-11-17'),
            bindings=[binding])['event']
        self.assertEqual(assigned['display']['deliveredContractMonth'], '202612')

    def test_a_weekly_option_follows_its_underconid_not_its_expiry_month(self):
        [result] = self.resolve([WEEKLY], FakeIB([WEEKLY_DETAILS, CLZ6_DETAILS, CLF7_DETAILS]))
        self.assertEqual(result['status'], 'verified_broker', result['problems'])
        self.assertEqual(result['option']['optionExpiry'], '2026-11-25')
        self.assertEqual(result['future']['localSymbol'], 'CLF7')
        self.assertEqual(result['future']['futureContractMonth'], '202701')

    def test_without_a_contract_month_the_pair_stays_unresolved(self):
        no_month = dict(CLZ6_DETAILS, contractMonth='')
        [result] = self.resolve([LOZ6], FakeIB([LOZ6_DETAILS, no_month]))
        self.assertEqual(result['status'], 'unresolved')
        self.assertIsNone(result['evidenceCredential'])
        self.assertIsNone(result['future'])
        self.assertIn('contract_month_missing', result['problems'][0])
        no_under = dict(LOZ6_DETAILS, underConId=None)
        [result] = self.resolve([LOZ6], FakeIB([no_under, CLZ6_DETAILS]))
        self.assertEqual(result['status'], 'unresolved')
        self.assertIsNone(result['evidenceCredential'])

    def test_conflicts_and_ambiguity_are_reported_not_guessed(self):
        [result] = self.resolve([LOZ6], FakeIB([dict(LOZ6_DETAILS, strike=80.0), CLZ6_DETAILS]))
        self.assertEqual(result['status'], 'conflict')
        self.assertIsNone(result['evidenceCredential'])
        self.assertIn('optionStrike', result['problems'][0])
        other_class = dict(LOZ6_DETAILS, conId=9002, tradingClass='LO1', localSymbol='LO1Z6 C7500')
        [result] = self.resolve([dict(LOZ6, conId=None)], FakeIB([LOZ6_DETAILS, other_class, CLZ6_DETAILS]))
        self.assertEqual(result['status'], 'unresolved')
        self.assertIn('ambiguous', result['problems'][0])
        self.assertIsNone(result['evidenceCredential'])
        [result] = self.resolve([LOZ6], FakeIB([LOZ6_DETAILS, dict(CLZ6_DETAILS, exchange='CME')]))
        self.assertEqual(result['status'], 'conflict')

    def test_resolution_is_bounded_and_writes_nothing(self):
        version = self.ledger.version()
        with self.assertRaises(broker.BrokerResolutionError):
            self.resolve([LOZ6] * (broker.MAX_QUERIES + 1), FakeIB([]))
        ib = FakeIB([LOZ6_DETAILS, CLZ6_DETAILS], delay=0.01)
        results = self.resolve([LOZ6] * broker.MAX_QUERIES, ib)
        self.assertTrue(all(result['status'] == 'verified_broker' for result in results))
        self.assertLessEqual(ib.max_active, broker.MAX_CONCURRENCY)
        with mock.patch.object(broker, 'TIMEOUT_SECONDS', 0.01):
            [slow] = self.resolve([LOZ6], FakeIB([LOZ6_DETAILS, CLZ6_DETAILS], delay=0.2))
        self.assertEqual((slow['status'], slow['problems']), ('unresolved', ['timeout']))
        self.assertEqual(self.ledger.version(), version)
        [stock_query] = self.resolve([CLZ6], FakeIB([CLZ6_DETAILS]))
        self.assertEqual(stock_query['status'], 'unresolved', 'only options are resolved')


if __name__ == '__main__':
    unittest.main()
