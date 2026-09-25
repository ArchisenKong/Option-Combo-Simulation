"""P4: synthetic CSV -> the page's own preview and request -> real store -> read back.

CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §9, §13.3 P4 and §14.1 (F17, F19-F22,
F24, F29-F32, F36, F39, F41, F42, F44). Statements are written by
tests/helpers/cost_basis_fop_statements.js; js/cost_basis_fop_import.js reads and
plans them and builds the request exactly as the page does (through
tests/cost_basis_fop_import_pipeline.test.js --serve); this file sends that
request to a real temporary store and replays the exported ledger with
js/cost_basis_fop_core.js. No request is written by hand here.

Every economic row type is synthetic_only (plan §9.7), so the stores that write
statement rows stand in for a real acceptance with
cost_basis_fop_test_support.verified_capabilities(); the capability tests use
the shipped list. Temporary databases only; nothing reaches TWS.
"""
import copy
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
for path in (REPO_ROOT, REPO_ROOT / 'tests'):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import cost_basis_fop_domain as domain  # noqa: E402
import cost_basis_fop_store  # noqa: E402
import cost_basis_store  # noqa: E402
from cost_basis_fop_test_support import (  # noqa: E402
    FopLedger, IDENTITY, token, verified_capabilities)
from cost_basis_store import (  # noqa: E402
    CostBasisStoreError, FopCapabilityNotVerifiedError, FopCycleBoundaryViolatedError,
    FopOrderingAmbiguousError, FopUnsupportedRowError, ImportRevisionConflictError, InvalidRequestError)

OBSERVED = '2027-03-01T14:15:00.000000Z'


class Node:
    """One node process: the statement writer and the page's import pipeline."""

    def __init__(self):
        self.pipeline = subprocess.Popen(
            ['node', str(REPO_ROOT / 'tests/cost_basis_fop_import_pipeline.test.js'), '--serve'],
            cwd=REPO_ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def call(self, **message):
        self.pipeline.stdin.write(json.dumps(message) + '\n')
        self.pipeline.stdin.flush()
        answer = json.loads(self.pipeline.stdout.readline())
        if 'error' in answer:
            raise PipelineError(answer['error'])
        return answer

    def close(self):
        self.pipeline.stdin.close()
        self.pipeline.wait(timeout=10)
        self.pipeline.stdout.close()


class PipelineError(Exception):
    """The page's pipeline refused (a blocked preview, a missing credential)."""


def statement(kind, **options):
    """A synthetic statement written by tests/helpers/cost_basis_fop_statements.js."""
    script = ("const s = require('./tests/helpers/cost_basis_fop_statements.js');"
              f"process.stdout.write(s.{kind}(JSON.parse(process.argv[1])));")
    return subprocess.check_output(['node', '-e', script, json.dumps(options)], cwd=REPO_ROOT, text=True)


class Ledger:
    """A temporary FOP ledger that imports statements the way the page does."""

    def __init__(self, test, name, *, history_scope='full_history', capabilities='verified', **options):
        self.test = test
        self.node = test.node
        stand_in = verified_capabilities() if capabilities == 'verified' else capabilities
        self.ledger = FopLedger(pathlib.Path(test.directory.name) / f'{name}.db', history_scope=history_scope,
                                fop_capabilities=stand_in, **options)
        self.store = self.ledger.store
        self.book_id = self.ledger.book_id
        self.history_scope = history_scope

    def graph(self):
        return self.store.export_backup(self.book_id)['payload']

    def book(self):
        book = self.store.get_book(self.book_id)
        return {'bookId': self.book_id, 'account': book['account'], 'symbol': book['symbol'],
                'currency': book['currency'], 'fop': book['fop']}

    def coverage(self):
        """The statement periods the ledger has registered, as the page reads them."""
        return [{'periodFrom': batch['periodFrom'], 'periodThrough': batch['periodThrough']}
                for batch in self.store.list_import_batches(self.book_id, limit=500)]

    def plan(self, text, file_name='statement.csv', **context):
        context = {'book': self.book(), 'graph': self.graph(), 'coverage': self.coverage(),
                   'observedAtUtc': OBSERVED, **context}
        answer = self.node.call(op='plan', text=text, fileName=file_name, context=context)
        return answer['planId'], answer['summary']

    def credentials(self, summary):
        if not summary['bindingRequests']:
            return {}
        results = self.store.issue_statement_binding_credentials(self.book_id, [
            {'bindingId': item['bindingId'], 'option': item['option'], 'future': item['future'],
             'evidence': item['evidence']} for item in summary['bindingRequests']])
        for result in results:
            self.test.assertEqual(result['status'], 'verified_statement', result['problems'])
        return {result['bindingId']: result['evidenceCredential'] for result in results}

    def request(self, plan_id, summary, text, *, kind='import', claim=None, batch=None, **extra):
        request = {
            'requestId': token('req'), 'bookId': self.book_id,
            'expectedLedgerVersion': self.ledger.version(), 'bookIdentity': dict(self.ledger.identity),
            'importBatchId': batch or token('batch'), 'clientTokenPrefix': token('import'),
            'fileSha256': hashlib.sha256(text.encode('utf-8')).hexdigest(), 'engineVersion': 1, **extra}
        answer = self.node.call(op='request', planId=plan_id, kind=kind, request=request,
                                credentials=self.credentials(summary), claim=claim)
        message = answer['request']
        # The WebSocket layer checks the message against the contract first.
        domain.require_shape('ImportRequest' if kind == 'import' else 'FopRebuildRequest', message, 'request')
        return message

    def send(self, message):
        if message['action'] == 'import_cost_basis_events':
            return self.store.import_fop_events(
                message['bookId'], message['fopPackage'], statement=message['statement'],
                import_batch_id=message['importBatchId'], client_token_prefix=message['clientTokenPrefix'],
                supersede_tws_event_ids=message['supersedeTwsEventIds'],
                expected_ledger_version=message['expectedLedgerVersion'], book_identity=message['bookIdentity'],
                duplicate_decisions=message.get('duplicateDecisions') or [])
        return self.store.rebuild_fop_book(
            message['bookId'], message['fopPackage'], confirmation=message['confirmation'],
            client_token=message['clientToken'], import_batch_id=message['importBatchId'],
            statement=message['statement'], revoke_boundaries=message['revokeBoundaries'],
            reason=message['reason'], expected_ledger_version=message['expectedLedgerVersion'],
            book_identity=message['bookIdentity'])

    def import_text(self, text, file_name='statement.csv', **context):
        """(the store's answer, the preview). A statement without new events still registers its period."""
        plan_id, summary = self.plan(text, file_name, **context)
        self.test.assertFalse(summary['blocking'], summary['problems'])
        return self.send(self.request(plan_id, summary, text)), summary

    def rebuild_text(self, text, file_name='statement.csv', **context):
        plan_id, summary = self.plan(text, file_name, **context)
        self.test.assertFalse(summary['blocking'], summary['problems'])
        plan = self.store.reset_confirmation(self.book_id)
        message = self.request(plan_id, summary, text, kind='rebuild', confirmation=plan['phrase'],
                               clientToken=token('rebuild'))
        return self.send(message)

    def output(self, marks_by_symbol=None):
        graph = self.graph()
        marks = {}
        for stored in graph['contracts']:
            symbol = stored['record']['localSymbol']
            if marks_by_symbol and symbol in marks_by_symbol:
                marks[stored['record']['contractId']] = marks_by_symbol[symbol]
        return self.node.call(op='compute', graph=graph, options={'marks': marks})['output']


def figures(output):
    """What a reader compares: totals, the seller lens, positions and realized results by symbol."""
    value = lambda metric: None if metric['value'] is None else round(metric['value'], 7)  # noqa: E731
    return {
        'totals': {name: value(metric) for name, metric in output['totals'].items()},
        'lens': {name: value(output['sellerLens'][name]) for name in ('Rs', 'Es', 'Js', 'breakEven')},
        'futures': sorted((row['localSymbol'], row['contracts']['value'], value(row['averagePrice']))
                          for row in output['futures']),
        'options': sorted((row['contractId'], row['contracts']['value'], value(row['remainingNetPremium']))
                          for row in output['options']),
        'realized': sorted((row['localSymbol'], value(row['realized'])) for row in output['realizedByContract']),
    }


# ----------------------------------------------------------------------
# The plan §9.6 history as statement fills (account-local New York time)
# ----------------------------------------------------------------------

ROLLS = [
    {'symbol': 'CLZ6', 'local': '2026-10-01T10:00:00', 'qty': 1, 'price': 70, 'commission': 0, 'codes': 'O'},
    {'symbol': 'LOZ6 C7500', 'local': '2026-10-01T11:00:00', 'qty': -1, 'price': 1.2, 'commission': 0,
     'codes': 'O'},
    {'symbol': 'LOZ6 C7500', 'local': '2026-11-17T15:00:00', 'qty': 1, 'price': 0, 'commission': 0, 'codes': 'Ep'},
    {'symbol': 'CLZ6', 'local': '2026-11-18T10:00:00', 'qty': -1, 'price': 68, 'commission': -5, 'codes': 'C'},
    {'symbol': 'CLF7', 'local': '2026-11-18T10:00:01', 'qty': 1, 'price': 69, 'commission': -5, 'codes': 'O'},
    {'symbol': 'CLF7', 'local': '2026-12-15T10:00:00', 'qty': -1, 'price': 72, 'commission': -5, 'codes': 'C'},
    {'symbol': 'CLG7', 'local': '2026-12-15T10:00:01', 'qty': 1, 'price': 72.5, 'commission': -5, 'codes': 'O'},
    {'symbol': 'CLG7', 'local': '2027-01-14T10:00:00', 'qty': -1, 'price': 71, 'commission': -5, 'codes': 'C'},
    {'symbol': 'CLH7', 'local': '2027-01-14T10:00:01', 'qty': 1, 'price': 70.8, 'commission': -5, 'codes': 'O'},
]
# Open positions at each month end.
HOLDINGS = {
    '2026-10': [{'symbol': 'CLZ6', 'quantity': 1, 'costPrice': 70},
                {'symbol': 'LOZ6 C7500', 'quantity': -1, 'costPrice': 1.2}],
    '2026-11': [{'symbol': 'CLF7', 'quantity': 1, 'costPrice': 69}],
    '2026-12': [{'symbol': 'CLG7', 'quantity': 1, 'costPrice': 72.5}],
    '2027-01': [{'symbol': 'CLH7', 'quantity': 1, 'costPrice': 70.8}],
}
MONTH_ENDS = {'2026-10': '2026-10-31', '2026-11': '2026-11-30', '2026-12': '2026-12-31', '2027-01': '2027-01-31'}


def activity_for(months, **options):
    """One Activity Statement covering whole months of ROLLS."""
    first, last = months[0], months[-1]
    fills = [fill for fill in ROLLS if fill['local'][:7] in months]
    return statement('activity', period={'from': f'{first}-01', 'through': MONTH_ENDS[last]}, fills=fills,
                     openPositions=HOLDINGS[last], **options)


# The plan §9.6 result at a D (CLH7) mark of 71.8.
EXPECTED_96 = {'Rf': -500, 'Uf': 1000, 'Co': 1200, 'Vo': 0, 'E': 30, 'J': 0, 'economicPnl': 1670}


class _PipelineCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = Node()

    @classmethod
    def tearDownClass(cls):
        cls.node.close()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def assert_96(self, ledger, label):
        output = ledger.output({'CLH7': 71.8})
        for name, value in EXPECTED_96.items():
            self.assertAlmostEqual(output['totals'][name]['value'], value, places=7, msg=f'{label}: {name}')
        self.assertAlmostEqual(output['sellerLens']['breakEven']['value'], 70.13, places=9, msg=label)
        self.assertEqual([(row['localSymbol'], row['contracts']['value']) for row in output['futures']],
                         [('CLH7', 1)], label)
        self.assertEqual(sorted((row['localSymbol'], round(row['realized']['value'], 7))
                                for row in output['realizedByContract']),
                         [('CLF7', 3000), ('CLG7', -1500), ('CLZ6', -2000)], label)
        return output


class FullHistoryPathTests(_PipelineCase):
    """Plan §9.6 and F31: one statement, monthly statements, overlapping ones."""

    def test_the_three_rolls_from_one_statement(self):
        ledger = Ledger(self, 'one')
        result, summary = ledger.import_text(activity_for(['2026-10', '2026-11', '2026-12', '2027-01']))
        self.assertEqual(result['inserted'], 9)
        self.assertEqual(result['duplicates'], [])
        [binding] = summary['bindings']
        self.assertEqual(binding['status'], 'verified_statement')
        # Record ids are readable and scoped to their ledger (two accounts hold the same contract).
        self.assertRegex(binding['bindingId'], r'^bind-fop-cl-lo-20261117-c75-[0-9a-f]{6}$')
        self.assert_96(ledger, 'one statement')
        # The same file again adds nothing (F21).
        again, _summary = ledger.import_text(activity_for(['2026-10', '2026-11', '2026-12', '2027-01']))
        self.assertEqual(again['inserted'], 0)
        self.assertEqual(len(again['duplicates']), 9)
        self.assert_96(ledger, 'one statement twice')

    def test_monthly_statements_across_the_year_end(self):
        ledger = Ledger(self, 'monthly')
        for month in ('2026-10', '2026-11', '2026-12', '2027-01'):
            result, summary = ledger.import_text(activity_for([month]), f'{month}.csv')
            self.assertTrue(result['inserted'] > 0, month)
            self.assertTrue(all(item['ledger'] == item['opening'] for item in summary['quantityProof']), month)
        self.assert_96(ledger, 'monthly')

    def test_overlapping_statements_count_each_fill_once(self):
        ledger = Ledger(self, 'overlap')
        ledger.import_text(activity_for(['2026-10', '2026-11', '2026-12']), '2026.csv')
        ledger.import_text(activity_for(['2026-11', '2026-12', '2027-01']), 'nov-jan.csv')
        again, _summary = ledger.import_text(activity_for(['2026-10', '2026-11', '2026-12']), '2026.csv')
        self.assertEqual(again['inserted'], 0)
        self.assert_96(ledger, 'overlapping')

    def test_a_flex_export_of_the_same_history_gives_the_same_ledger(self):
        fills = [dict(fill, tradeId=str(1000 + index)) for index, fill in enumerate(ROLLS)]
        ledger = Ledger(self, 'flex')
        text = statement('flex', fills=fills)
        result, summary = ledger.import_text(text, 'flex.csv', timeZone='America/New_York')
        self.assertEqual(result['inserted'], 9)
        self.assertIn('period_from_rows', [item['code'] for item in summary['warnings']])
        self.assert_96(ledger, 'flex')



def tws_future(ledger, *, symbol='CLF7', month='202701', con_id=556, instant='2026-11-18T15:00:01.000000Z',
               quantity=1, price=69, fees=0.0, exec_id='0000e0d5.65a1b2c3.01.01'):
    """One TWS execution appended the way the page's execution sync would (plan §9.3)."""
    contract = {'secType': 'FUT', 'contractId': f'fut-{symbol.lower()}-tws0001', 'revision': 1, 'conId': con_id,
                'root': 'CL', 'tradingClass': 'CL', 'localSymbol': symbol, 'exchange': 'NYMEX', 'currency': 'USD',
                'futureContractMonth': month, 'futureLastTradeDate': None, 'futureLastTradeAsOf': None,
                'futurePointValue': 1000, 'ruleVersion': 'NYMEX-CL-v1', 'evidenceStatus': 'verified_broker',
                'evidenceSummary': 'TWS execution contract', 'observedAtUtc': OBSERVED}
    event = {'kind': 'futures_trade', 'account': IDENTITY['account'], 'source': 'execution_report',
             'externalRef': exec_id, 'packageKey': None, 'note': '',
             'time': {'exchangeTradeDate': None, 'executedAtUtc': instant, 'timeRange': None,
                      'sourceTimeText': None, 'sourceTimezone': None, 'orderEvidence': None},
             'sources': [{'namespace': 'tws_exec', 'sourceRef': exec_id, 'role': 'trade',
                          'quantity': abs(quantity), 'fees': fees}],
             'contractRef': {'contractId': contract['contractId'], 'revision': 1}, 'futureContracts': quantity,
             'price': price, 'cashAmount': -fees, 'fees': fees, 'openClose': None, 'includeInCost': True}
    record = {'account': IDENTITY['account'], 'namespace': 'tws_exec', 'sourceRef': exec_id,
              'capabilityKey': None, 'format': 'tws_execution', 'section': None,
              'rawFields': {'execId': exec_id}, 'statedQuantity': abs(quantity), 'statedFees': fees}
    # A contract the ledger already holds is referenced, never recorded twice.
    stored = [item['record'] for item in ledger.graph()['contracts']
              if item['supersededByRevision'] is None and item['record']['localSymbol'] == symbol]
    contracts = [contract]
    if stored:
        event['contractRef'] = {'contractId': stored[0]['contractId'], 'revision': stored[0]['revision']}
        contracts = []
    return ledger.ledger.append(event, contracts=contracts, sources=[record])['event']


class CrossFormatTests(_PipelineCase):
    """F21, F22, F20: the same fill from Activity, Flex and TWS counts once."""

    def flex_rolls(self):
        return statement('flex', fills=[dict(fill, tradeId=str(1000 + index),
                                             execId=f'0000e0d5.{index:08x}.01.01')
                                        for index, fill in enumerate(ROLLS)])

    def test_flex_then_activity_and_back_add_nothing_twice(self):
        for first, second in (('flex', 'activity'), ('activity', 'flex')):
            with self.subTest(first=first):
                ledger = Ledger(self, first)
                texts = {'flex': self.flex_rolls(),
                         'activity': activity_for(['2026-10', '2026-11', '2026-12', '2027-01'])}
                ledger.import_text(texts[first], timeZone='America/New_York')
                result, summary = ledger.import_text(texts[second], timeZone='America/New_York')
                # Nothing new, but the file still registers its period.
                self.assertEqual((result['inserted'], result['duplicates']), (0, []))
                self.assertEqual(summary['events'], 0)
                self.assertEqual(len([row for row in summary['rows'] if row['disposition'] == 'duplicate']), 9)
                self.assertEqual(len(ledger.coverage()), 2)
                self.assert_96(ledger, f'{first} then {second}')

    def test_chinese_headers_and_a_byte_order_mark_read_the_same(self):
        english = Ledger(self, 'english')
        english.import_text(activity_for(['2026-10', '2026-11', '2026-12', '2027-01']))
        chinese = Ledger(self, 'chinese')
        result, summary = chinese.import_text(activity_for(['2026-10', '2026-11', '2026-12', '2027-01'],
                                                           chinese=True, bom=True))
        self.assertEqual(result['inserted'], 9)
        self.assertEqual(figures(chinese.output({'CLH7': 71.8})), figures(english.output({'CLH7': 71.8})))
        # The duplicate 代码 columns keep the symbol and the codes apart.
        self.assertIn('option_expiry', summary['kinds'])

    GRANULAR = [
        {'symbol': 'CLZ6', 'local': '2026-10-01T10:00:00', 'qty': 1, 'price': 70, 'commission': -1, 'codes': 'O'},
        {'symbol': 'CLZ6', 'local': '2026-10-01T10:00:05', 'qty': 2, 'price': 71, 'commission': -2, 'codes': 'O'},
    ]
    ORDER = {'symbol': 'CLZ6', 'local': '2026-10-01T10:00:00', 'qty': 3, 'price': 212 / 3, 'commission': -3,
             'codes': 'O'}

    def test_an_order_and_its_executions_without_an_order_reference_are_not_taken_for_each_other(self):
        # Same contract, direction, day, size and average: still no proof
        # that the order row is those executions (review P4-1).
        period = {'from': '2026-10-01', 'through': '2026-10-31'}
        held = [{'symbol': 'CLZ6', 'quantity': 3, 'costPrice': 212 / 3}]
        with_fills = statement('activity', period=period, fills=self.GRANULAR, openPositions=held,
                               orders=[{'fills': [0, 1]}])
        orders_only = statement('activity', period=period, openPositions=held, fills=[self.ORDER])
        for first, second in ((with_fills, orders_only), (orders_only, with_fills)):
            with self.subTest(first='executions' if first is with_fills else 'order'):
                ledger = Ledger(self, token('granularity'))
                ledger.import_text(first)
                before = ledger_state(ledger)
                _plan, summary = ledger.plan(second)
                self.assertTrue(summary['blocking'])
                self.assertEqual({item['code'] for item in summary['problems']}, {'possible_duplicate'})
                self.assertEqual(ledger_state(ledger), before)

    def test_an_order_and_its_executions_count_once_through_their_order_reference(self):
        executions = statement('flex', fills=[dict(fill, tradeId=str(700 + index), orderId='5001')
                                              for index, fill in enumerate(self.GRANULAR)])
        order = statement('flex', fills=[dict(self.ORDER, tradeId='799', orderId='5001')])
        for first, second in ((executions, order), (order, executions)):
            with self.subTest(first='executions' if first is executions else 'order'):
                ledger = Ledger(self, token('ordered'))
                ledger.import_text(first, timeZone='America/New_York')
                again, summary = ledger.import_text(second, timeZone='America/New_York')
                self.assertEqual(again['inserted'], 0)
                self.assertEqual(summary['events'], 0)
                [row] = ledger.output({'CLZ6': 71})['futures']
                self.assertEqual(row['contracts']['value'], 3)
                self.assertAlmostEqual(row['averagePrice']['value'], 212 / 3, places=9)
                self.assertEqual(ledger.output({'CLZ6': 71})['totals']['E']['value'], 3)
        # The same order with other fees is a conflict, never a silent duplicate.
        ledger = Ledger(self, 'ordered-fees')
        ledger.import_text(executions, timeZone='America/New_York')
        _plan, summary = ledger.plan(statement('flex', fills=[dict(self.ORDER, tradeId='799', orderId='5001',
                                                                   commission=-5)]), timeZone='America/New_York')
        self.assertEqual({item['code'] for item in summary['problems']}, {'duplicate_conflict'})
        self.assertIn('fees (3 stored, 5 in this file)', summary['problems'][0]['message'])
        # So is the same order at another size.
        _plan, summary = ledger.plan(statement('flex', fills=[dict(self.ORDER, tradeId='799', orderId='5001', qty=4,
                                                                   commission=-4)]), timeZone='America/New_York')
        self.assertEqual({item['code'] for item in summary['problems']}, {'duplicate_conflict'})
        self.assertIn('order 5001 quantity (3 stored, 4 in this file)', summary['problems'][0]['message'])
        # Another order of the same size, price and day is another fill.
        other, _summary = ledger.import_text(statement('flex', fills=[dict(self.ORDER, tradeId='800',
                                                                            orderId='5002')]),
                                             timeZone='America/New_York')
        self.assertEqual(other['inserted'], 1)
        self.assertEqual(ledger.output({'CLZ6': 71})['futures'][0]['contracts']['value'], 6)

    def test_a_separate_fill_of_a_stored_day_is_never_dropped_as_a_duplicate(self):
        # Review P4-1: a stored 11:00 buy and a new 10:00 buy under another
        # trade id are not the same fill; without proof either way it blocks.
        ledger = Ledger(self, 'separate')
        eleven = {'symbol': 'CLZ6', 'local': '2026-10-01T11:00:00', 'qty': 1, 'price': 70, 'codes': 'O'}
        ten = dict(eleven, local='2026-10-01T10:00:00')
        ledger.import_text(statement('flex', fills=[dict(eleven, tradeId='1')]), timeZone='America/New_York')
        _plan, summary = ledger.plan(statement('flex', fills=[dict(ten, tradeId='2')]), timeZone='America/New_York')
        self.assertTrue(summary['blocking'])
        self.assertEqual({item['code'] for item in summary['problems']}, {'possible_duplicate'})
        self.assertEqual(summary['duplicates'], [])
        # Both naming their own broker order proves them apart.
        ledger = Ledger(self, 'separate-orders')
        ledger.import_text(statement('flex', fills=[dict(eleven, tradeId='1', orderId='6001')]),
                           timeZone='America/New_York')
        result, _summary = ledger.import_text(statement('flex', fills=[dict(ten, tradeId='2', orderId='6002')]),
                                              timeZone='America/New_York')
        self.assertEqual(result['inserted'], 1)
        self.assertEqual(ledger.output({'CLZ6': 70})['futures'][0]['contracts']['value'], 2)

    def test_the_same_fill_with_other_fees_or_another_underlying_future_is_a_conflict(self):
        # Review P4-3: every economic and identity field takes part (plan §9.1).
        ledger = Ledger(self, 'content')
        fills = [{'symbol': 'CLZ6', 'local': '2026-10-01T10:00:00', 'qty': 1, 'price': 70, 'commission': -1,
                  'codes': 'O'},
                 {'symbol': 'LOZ6 C7500', 'local': '2026-10-01T11:00:00', 'qty': -1, 'price': 1.2,
                  'commission': -1, 'codes': 'O'}]
        ledger.import_text(statement('activity', period=OCTOBER, fills=fills, openPositions=[
            {'symbol': 'CLZ6', 'quantity': 1}, {'symbol': 'LOZ6 C7500', 'quantity': -1}]))
        before = ledger_state(ledger)
        fees = statement('flex', fills=[dict(fills[0], commission=-5, tradeId='11'), dict(fills[1], tradeId='12')])
        _plan, summary = ledger.plan(fees, timeZone='America/New_York')
        self.assertEqual([(item['code'], item['line']) for item in summary['problems']], [('duplicate_conflict', 2)])
        self.assertIn('fees (1 stored, 5 in this file)', summary['problems'][0]['message'])
        # The option row alone, naming CLF7 (conId 556) as its underlying future.
        moved = statement('flex', fills=[dict(fills[1], tradeId='12')]).replace(',9001,555,', ',9001,556,')
        _plan, summary = ledger.plan(moved, timeZone='America/New_York')
        self.assertEqual([item['code'] for item in summary['problems']], ['duplicate_conflict'])
        self.assertIn('underlying future', summary['problems'][0]['message'])
        # A new fill of the option naming CLF7 is held to the binding too.
        later = statement('flex', fills=[dict(fills[1], tradeId='13', local='2026-10-05T11:00:00')]).replace(
            ',9001,555,', ',9001,556,')
        _plan, summary = ledger.plan(later, timeZone='America/New_York')
        self.assertIn('binding_conflict', [item['code'] for item in summary['problems']])
        self.assertEqual(ledger_state(ledger), before)

    def test_order_rows_must_add_up_to_their_executions(self):
        fills = [
            {'symbol': 'CLZ6', 'local': '2026-10-01T10:00:00', 'qty': 1, 'price': 70, 'commission': -1, 'codes': 'O'},
            {'symbol': 'CLZ6', 'local': '2026-10-01T10:00:05', 'qty': 2, 'price': 71, 'commission': -2, 'codes': 'O'},
        ]
        text = statement('activity', period={'from': '2026-10-01', 'through': '2026-10-31'}, fills=fills,
                         orders=[{'fills': [0, 1], 'price': 70.5}])
        _plan, summary = Ledger(self, 'orders').plan(text)
        self.assertIn('order_fills_differ', [item['code'] for item in summary['problems']])

    def test_a_statement_supersedes_the_tws_leg_it_repeats(self):
        ledger = Ledger(self, 'tws')
        ledger.import_text(activity_for(['2026-10']))
        leg = tws_future(ledger, exec_id='0000e0d5.65a1b2c3.01.01')
        result, summary = ledger.import_text(activity_for(['2026-11']))
        self.assertEqual(result['superseded'], [leg['eventId']])
        self.assertEqual(summary['supersede'], [leg['eventId']])
        voided = [event for event in ledger.store.list_events(ledger.book_id, include_voided=True)['events']
                  if event['eventId'] == leg['eventId']]
        self.assertIsNotNone(voided[0]['voidedAtUtc'])
        for month in ('2026-12', '2027-01'):
            ledger.import_text(activity_for([month]))
        self.assert_96(ledger, 'TWS leg superseded')
        # The statement's commission replaced the execution's missing one.
        self.assertEqual(ledger.output({'CLH7': 71.8})['totals']['E']['value'], 30)

    def test_a_flex_execution_id_supersedes_the_same_tws_execution(self):
        ledger = Ledger(self, 'execid')
        text = self.flex_rolls()
        ledger.import_text(statement('flex', fills=[dict(ROLLS[0], tradeId='1000')]),
                           timeZone='America/New_York')
        leg = tws_future(ledger, symbol='CLZ6', month='202612', con_id=555, instant='2026-11-18T15:00:00.000000Z',
                         quantity=-1, price=68, exec_id='0000e0d5.00000003.01.01')
        result, _summary = ledger.import_text(text, timeZone='America/New_York')
        self.assertEqual(result['superseded'], [leg['eventId']])
        self.assert_96(ledger, 'flex exec id')

    def test_a_statement_period_without_a_tws_fill_is_not_covered(self):
        # F20: a month with no statement trades still checks the TWS round trip.
        ledger = Ledger(self, 'roundtrip')
        tws_future(ledger, symbol='CLZ6', month='202612', con_id=555, instant='2026-10-05T15:00:00.000000Z',
                   exec_id='0000e0d5.00000101.01.01')
        tws_future(ledger, symbol='CLZ6', month='202612', con_id=555, instant='2026-10-06T15:00:00.000000Z',
                   quantity=-1, price=71, exec_id='0000e0d5.00000102.01.01')
        text = statement('activity', period={'from': '2026-10-01', 'through': '2026-10-31'}, fills=[],
                         openPositions=[])
        _plan, summary = ledger.plan(text)
        self.assertTrue(summary['blocking'])
        self.assertEqual([item['code'] for item in summary['problems']], ['tws_not_in_statement'] * 2)

    def test_times_are_read_in_the_statement_zone(self):
        fills = [
            # 01:30 happens twice on 2026-11-01 in New York: both readings stay possible.
            {'symbol': 'CLZ6', 'local': '2026-11-01T01:30:00', 'qty': 1, 'price': 70, 'codes': 'O'},
            {'symbol': 'CLZ6', 'local': '2026-11-02T00:00:00', 'qty': 1, 'price': 70, 'codes': 'O'},
        ]
        text = statement('activity', period={'from': '2026-11-01', 'through': '2026-11-30'}, fills=fills)
        _plan, summary = Ledger(self, 'dst').plan(text)
        self.assertFalse(summary['blocking'], summary['problems'])
        self.assertEqual(summary['eventTimes'][0]['timeRange'],
                         {'startUtc': '2026-11-01T05:30:00.000000Z', 'endUtc': '2026-11-01T06:30:00.000000Z'})
        self.assertEqual(summary['eventTimes'][1]['executedAtUtc'], '2026-11-02T05:00:00.000000Z')
        gap = statement('activity', period={'from': '2027-03-01', 'through': '2027-03-31'}, fills=[
            {'symbol': 'CLH7', 'local': '2027-03-14T02:30:00', 'qty': 1, 'price': 70, 'codes': 'O'}])
        _plan, summary = Ledger(self, 'gap').plan(gap)
        self.assertIn('time_invalid', [item['code'] for item in summary['problems']])
        unnamed = statement('activity', period={'from': '2026-11-01', 'through': '2026-11-30'}, fills=fills,
                            generated='2027-03-01, 09:15:00 CST')
        _plan, summary = Ledger(self, 'cst').plan(unnamed)
        self.assertIn('timezone_missing', [item['code'] for item in summary['problems']])

    def test_a_night_session_keeps_its_exchange_trade_date(self):
        text = statement('flex', fills=[
            {'symbol': 'CLZ6', 'local': '2026-10-01T19:00:00', 'tradeDate': '2026-10-02', 'qty': 1, 'price': 70,
             'tradeId': '2001'},
            {'symbol': 'CLZ6', 'local': '2026-10-05T10:00:00', 'tradeDate': '2026-10-05', 'qty': 1, 'price': 71,
             'tradeId': '2002', 'dateOnly': True}])
        _plan, summary = Ledger(self, 'night').plan(text, timeZone='America/New_York')
        self.assertFalse(summary['blocking'], summary['problems'])
        night, day_only = summary['eventTimes']
        self.assertEqual(night['exchangeTradeDate'], '2026-10-02')
        self.assertEqual(night['executedAtUtc'], '2026-10-01T23:00:00.000000Z')
        # Only a trade date: from the evening session before it (exchange zone).
        self.assertEqual(day_only['timeRange'], {'startUtc': '2026-10-04T05:00:00.000000Z',
                                                 'endUtc': '2026-10-06T05:00:00.000000Z'})



def event_lines(summary):
    return [row['line'] for row in summary['rows'] if row['disposition'] == 'event']


def ledger_state(ledger):
    """Everything an import may change: the ledger version and every FOP table, with coverage."""
    tables = {}
    conn = ledger.store._connect()
    try:
        for table in ('cost_basis_events', 'cost_basis_fop_event_details', 'cost_basis_fop_contracts',
                      'cost_basis_fop_bindings', 'cost_basis_fop_sources', 'cost_basis_fop_source_allocations',
                      'cost_basis_fop_cycles', 'cost_basis_fop_requests', 'cost_basis_import_batches'):
            tables[table] = sorted(tuple(row) for row in conn.execute(f'SELECT * FROM {table}'))
    finally:
        conn.close()
    return ledger.ledger.version(), tables


OCTOBER = {'from': '2026-10-01', 'through': '2026-10-31'}


class CapabilityTests(_PipelineCase):
    """F44 and F17: row types, manual claims, unsupported and out-of-scope rows (plan §9.7)."""

    def october(self, **options):
        return activity_for(['2026-10'], **options)

    def test_every_row_shows_its_key_and_status_and_a_synthetic_row_does_not_write(self):
        ledger = Ledger(self, 'shipped', capabilities=None)
        plan_id, summary = ledger.plan(self.october(cashReport=True, markToMarket=True))
        self.assertFalse(summary['blocking'], summary['problems'])
        keyed = {(row['key'], row['status']) for row in summary['rows']}
        self.assertEqual(keyed, {('activity/trades/FUT/trade', 'synthetic_only'),
                                 ('activity/trades/FOP/trade', 'synthetic_only'),
                                 ('activity/cash_report/ALL/cash', 'out_of_scope'),
                                 ('activity/mark_to_market/ALL/summary', 'out_of_scope')})
        before = ledger_state(ledger)
        with self.assertRaises(FopCapabilityNotVerifiedError):
            ledger.send(ledger.request(plan_id, summary, self.october()))
        self.assertEqual(ledger_state(ledger), before, 'a refused import changes nothing')

    def test_a_matching_manual_claim_covers_a_synthetic_row(self):
        ledger = Ledger(self, 'claim', capabilities=None)
        text = self.october()
        plan_id, summary = ledger.plan(text)
        message = ledger.request(plan_id, summary, text, claim={
            'lines': event_lines(summary), 'attestation': 'checked by hand against the October statement'})
        self.assertEqual({event['source'] for event in message['fopPackage']['events']}, {'manual'})
        result = ledger.send(message)
        self.assertEqual(result['inserted'], 2)
        listed = ledger.store.list_events(ledger.book_id)['events']
        self.assertEqual({event['source'] for event in listed}, {'manual'})
        # The claimed rows stay covered: the same file again adds nothing.
        again_id, again = ledger.plan(text)
        self.assertEqual(ledger.send(ledger.request(again_id, again, text, claim={
            'lines': event_lines(again), 'attestation': 'the same rows'}))['inserted'], 0)

    def test_a_claim_that_differs_from_its_row_is_refused(self):
        ledger = Ledger(self, 'mismatch', capabilities=None)
        text = self.october()
        plan_id, summary = ledger.plan(text)
        message = ledger.request(plan_id, summary, text, claim={'lines': event_lines(summary),
                                                                 'attestation': 'typed by hand'})
        tampered = copy.deepcopy(message)
        tampered['fopPackage']['events'][0]['price'] = 70.5
        before = ledger_state(ledger)
        with self.assertRaises(FopCapabilityNotVerifiedError) as caught:
            ledger.send(tampered)
        self.assertIn('price', str(caught.exception))
        self.assertEqual(ledger_state(ledger), before)

    def test_a_claim_is_held_to_the_row_type_its_own_fields_read_as(self):
        # Review P4-4: a FUT row whose code says it was delivered (A) cannot be
        # claimed as an ordinary futures trade under an ordinary trade key.
        ledger = Ledger(self, 'rowtype', capabilities=None)
        text = statement('activity', period=OCTOBER, fills=[
            {'symbol': 'CLZ6', 'local': '2026-10-01T10:00:00', 'qty': 1, 'price': 70, 'codes': 'O'}],
            openPositions=[{'symbol': 'CLZ6', 'quantity': 1}])
        plan_id, summary = ledger.plan(text)
        message = ledger.request(plan_id, summary, text, claim={'lines': event_lines(summary),
                                                                 'attestation': 'typed by hand'})
        tampered = copy.deepcopy(message)
        for record in tampered['fopPackage']['sourceRecords']:
            record['rawFields']['Code'] = 'A'
        before = ledger_state(ledger)
        with self.assertRaises(InvalidRequestError) as caught:
            ledger.send(tampered)
        self.assertIn('activity/trades/FUT/delivery_leg', str(caught.exception))
        # A cash-settled option sent under the ordinary option key is still unsupported.
        option = statement('activity', period=OCTOBER, fills=[
            {'symbol': 'LOZ6 C7500', 'local': '2026-10-01T11:00:00', 'qty': -1, 'price': 1.2, 'codes': 'O'}])
        plan_id, summary = ledger.plan(option)
        message = ledger.request(plan_id, summary, option, claim={'lines': event_lines(summary),
                                                                   'attestation': 'typed by hand'})
        for record in message['fopPackage']['sourceRecords']:
            record['rawFields']['Settlement Type'] = 'Cash'
        with self.assertRaises(FopUnsupportedRowError):
            ledger.send(message)
        self.assertEqual(ledger_state(ledger), before)
        # The untouched claim goes in.
        plan_id, summary = ledger.plan(text)
        self.assertEqual(ledger.send(ledger.request(plan_id, summary, text, claim={
            'lines': event_lines(summary), 'attestation': 'typed by hand'}))['inserted'], 1)

    def test_a_claim_of_a_dated_row_is_held_to_the_range_the_server_works_out(self):
        # Review P4-5: a row with only its trade date covers the evening
        # session before it; the claim may not move or narrow that range.
        ledger = Ledger(self, 'dated', capabilities=None)
        text = statement('flex', fills=[{'symbol': 'CLZ6', 'local': '2026-10-01T10:00:00', 'qty': 1, 'price': 70,
                                         'codes': 'O', 'tradeId': '21', 'dateOnly': True}])
        plan_id, summary = ledger.plan(text, timeZone='America/New_York')
        message = ledger.request(plan_id, summary, text, claim={'lines': event_lines(summary),
                                                                 'attestation': 'typed by hand'})
        self.assertEqual(message['fopPackage']['events'][0]['time']['timeRange'],
                         {'startUtc': '2026-09-30T05:00:00.000000Z', 'endUtc': '2026-10-02T05:00:00.000000Z'})
        before = ledger_state(ledger)
        for label, change in (
                ('moved', {'timeRange': {'startUtc': '2027-01-01T06:00:00.000000Z',
                                         'endUtc': '2027-01-02T06:00:00.000000Z'}}),
                ('narrowed', {'timeRange': {'startUtc': '2026-10-01T05:00:00.000000Z',
                                            'endUtc': '2026-10-02T05:00:00.000000Z'}}),
                ('another zone', {'sourceTimezone': 'America/New_York',
                                  'timeRange': {'startUtc': '2026-09-30T04:00:00.000000Z',
                                                'endUtc': '2026-10-02T04:00:00.000000Z'}})):
            with self.subTest(label):
                tampered = copy.deepcopy(message)
                tampered['fopPackage']['events'][0]['time'].update(change)
                with self.assertRaises(FopCapabilityNotVerifiedError):
                    ledger.send(tampered)
        self.assertEqual(ledger_state(ledger), before)
        self.assertEqual(ledger.send(message)['inserted'], 1)

    def test_an_unsupported_row_blocks_and_cannot_be_claimed(self):
        ledger = Ledger(self, 'unsupported', capabilities=None)
        for symbol in ('LCZ6 C7500', 'LOZ6 C0'):
            with self.subTest(symbol=symbol):
                text = statement('activity', period=OCTOBER, fills=[
                    {'symbol': symbol, 'local': '2026-10-01T11:00:00', 'qty': -1, 'price': 1.2, 'codes': 'O'}])
                _plan, summary = ledger.plan(text)
                self.assertTrue(summary['blocking'])
                self.assertEqual([row['disposition'] for row in summary['rows']], ['unsupported'])
                self.assertIn('row_unsupported', [item['code'] for item in summary['problems']])
        # Straight to the server, as a claim: still refused.
        text = self.october()
        plan_id, summary = ledger.plan(text)
        message = ledger.request(plan_id, summary, text, claim={'lines': event_lines(summary),
                                                                 'attestation': 'typed by hand'})
        for record in message['fopPackage']['sourceRecords']:
            if record['capabilityKey'] == 'activity/trades/FOP/trade':
                record['capabilityKey'] = 'activity/trades/FOP.cash_settled/any'
        with self.assertRaises(FopUnsupportedRowError):
            ledger.send(message)
        for record in message['fopPackage']['sourceRecords']:
            record['capabilityKey'] = 'activity/cash_report/ALL/cash'
        with self.assertRaises(InvalidRequestError):
            ledger.send(message)
        self.assertEqual(ledger.store.list_events(ledger.book_id)['events'], [])

    def test_cash_and_daily_settlement_sections_change_nothing(self):
        # F17: listed as out of scope, never written, never blocking.
        plain = Ledger(self, 'plain')
        plain.import_text(activity_for(['2026-10', '2026-11', '2026-12', '2027-01']))
        with_cash = Ledger(self, 'cash')
        result, summary = with_cash.import_text(activity_for(['2026-10', '2026-11', '2026-12', '2027-01'],
                                                             cashReport=True, markToMarket=True,
                                                             unknownSection=True))
        self.assertEqual(result['inserted'], 9)
        self.assertEqual([row['disposition'] for row in summary['rows']].count('out_of_scope'), 3)
        self.assertEqual(figures(with_cash.output({'CLH7': 71.8})), figures(plain.output({'CLH7': 71.8})))
        self.assertEqual(len(with_cash.graph()['sources']), 9)


class BaselineTests(_PipelineCase):
    """F19 and F42: a statement that starts with open positions (plan §9.2)."""

    QUIET = {'from': '2026-11-01', 'through': '2026-11-16'}

    def quiet(self, **options):
        # Nothing traded in the first half of November: the October positions stay open.
        return statement('activity', period=self.QUIET, fills=[], openPositions=HOLDINGS['2026-10'], **options)

    def late_november(self):
        fills = [fill for fill in ROLLS if '2026-11-17' <= fill['local'][:10] <= '2026-11-30']
        return statement('activity', period={'from': '2026-11-17', 'through': '2026-11-30'}, fills=fills,
                         openPositions=HOLDINGS['2026-11'])

    def test_a_full_history_ledger_needs_the_earlier_history(self):
        _plan, summary = Ledger(self, 'full').plan(self.quiet())
        self.assertTrue(summary['blocking'])
        self.assertEqual([item['code'] for item in summary['problems']], ['history_before_statement'])

    def test_a_baseline_ledger_starts_from_the_statement_and_the_history_replaces_it(self):
        ledger = Ledger(self, 'baseline', history_scope='since_baseline')
        result, summary = ledger.import_text(self.quiet())
        self.assertEqual(summary['kinds'], ['opening_balance', 'opening_balance'])
        self.assertEqual(result['inserted'], 2)
        for months in (None, ['2026-12'], ['2027-01']):
            ledger.import_text(self.late_november() if months is None else activity_for(months))
        baseline = ledger.output({'CLH7': 71.8})
        self.assertEqual(baseline['scope']['history'], 'since_baseline')
        self.assertEqual(baseline['scope']['baselineAsOfUtc'], '2026-11-01T04:00:00.000000Z')
        # A futures baseline at its trade cost cannot tell the change since B.
        self.assertIsNone(baseline['totals']['economicPnl']['value'])
        # The whole history replaces the baseline in one archived rebuild.
        rebuilt = ledger.rebuild_text(activity_for(['2026-10', '2026-11', '2026-12', '2027-01']), graph=None)
        self.assertEqual(rebuilt['inserted'], 9)
        self.assertEqual(ledger.store.get_book(ledger.book_id)['fop']['historyScope'], 'full_history')
        output = self.assert_96(ledger, 'history after a baseline')
        self.assertEqual([event['kind'] for event in ledger.store.list_events(ledger.book_id)['events']
                          if event['kind'] == 'opening_balance'], [])
        self.assertIsNone(output['scope']['baselineAsOfUtc'])

    def test_the_baseline_statement_imports_again_as_a_repeat(self):
        # Review P4-8: the baseline sits at the statement's start, so the same
        # file again opens with it and adds nothing.
        ledger = Ledger(self, 'again', history_scope='since_baseline')
        ledger.import_text(self.quiet())
        before = figures(ledger.output())
        result, summary = ledger.import_text(self.quiet())
        self.assertEqual((result['inserted'], summary['kinds']), (0, []))
        self.assertEqual({item['contract']: (item['opening'], item['ledger']) for item in summary['quantityProof']},
                         {'CLZ6': (1, 1), 'LOZ6 C7500': (-1, -1)})
        self.assertEqual(figures(ledger.output()), before)

    def test_an_option_without_its_cost_opens_as_a_quantity_stub(self):
        holdings = [{'symbol': 'CLZ6', 'quantity': 1, 'costPrice': 70}, {'symbol': 'LOZ6 C7500', 'quantity': -1}]
        text = statement('activity', period=self.QUIET, fills=[], openPositions=holdings)
        ledger = Ledger(self, 'stub', history_scope='since_baseline')
        ledger.import_text(text)
        kinds = {event['display']['localSymbol']: event['fop']['baselineKind']
                 for event in ledger.store.list_events(ledger.book_id)['events']}
        self.assertEqual(kinds, {'CLZ6': 'trade_cost', 'LOZ6 C7500': 'unknown_cost'})
        [option] = ledger.output()['options']
        self.assertIsNone(option['remainingNetPremium']['value'])

    def test_a_traded_future_needs_its_baseline_price(self):
        text = activity_for(['2026-11'])
        ledger = Ledger(self, 'traded', history_scope='since_baseline')
        _plan, summary = ledger.plan(text)
        self.assertIn('baseline_price_missing', [item['code'] for item in summary['problems']])
        result, summary = ledger.import_text(text, baselinePrices={
            'CLZ6': {'kind': 'reference_price', 'price': 70.5},
            'LOZ6 C7500': {'kind': 'reference_price', 'price': 0.9}})
        baselines = {event['display']['localSymbol']: (event['fop']['baselineKind'], event['price'])
                     for event in ledger.store.list_events(ledger.book_id)['events']
                     if event['kind'] == 'opening_balance'}
        self.assertEqual(baselines, {'CLZ6': ('reference_price', 70.5), 'LOZ6 C7500': ('reference_price', 0.9)})


class FailureTests(_PipelineCase):
    """F24: a failure anywhere rolls back everything; a retry writes once."""

    def test_a_failure_part_way_leaves_every_table_and_the_coverage_as_they_were(self):
        failures = {'armed': False}

        def hook(point):
            if point == 'fop_after_event' and failures['armed']:
                failures['armed'] = False
                raise RuntimeError('injected')

        ledger = Ledger(self, 'fault', fault_hook=hook)
        ledger.import_text(activity_for(['2026-10']))
        failures['armed'] = True
        text = activity_for(['2026-11'])
        plan_id, summary = ledger.plan(text)
        message = ledger.request(plan_id, summary, text)
        before = ledger_state(ledger)
        with self.assertRaises(RuntimeError):
            ledger.send(message)
        self.assertEqual(ledger_state(ledger), before)
        first = ledger.send(message)
        self.assertFalse(first['idempotentReplay'])
        self.assertEqual(first['inserted'], 3)
        replay = ledger.send(message)
        self.assertTrue(replay['idempotentReplay'])
        self.assertEqual(replay['eventIds'], first['eventIds'])
        self.assertEqual(len(ledger.store.list_events(ledger.book_id)['events']), 5)
        # The same batch with another package is another request.
        other = copy.deepcopy(message)
        other['fopPackage']['events'][0]['note'] = 'edited'
        with self.assertRaises(CostBasisStoreError):
            ledger.send(other)

    def test_a_revised_row_refuses_the_whole_import(self):
        ledger = Ledger(self, 'revision')
        flex = statement('flex', fills=[dict(ROLLS[0], tradeId='7001')])
        ledger.import_text(flex, 'flex.csv', timeZone='America/New_York')
        changed = statement('flex', fills=[dict(ROLLS[0], tradeId='7001', commission=-1)])
        _plan, summary = ledger.plan(changed, timeZone='America/New_York')
        self.assertIn('import_revision_conflict', [item['code'] for item in summary['problems']])
        # Straight to the server: the same reference with other content.
        plan_id, clean = ledger.plan(flex, timeZone='America/New_York')
        message = ledger.request(plan_id, clean, flex)
        message['fopPackage']['events'][0]['fees'] = 1
        message['fopPackage']['events'][0]['cashAmount'] = -1
        message['fopPackage']['events'][0]['sources'][0]['fees'] = 1
        message['fopPackage']['sourceRecords'][0]['statedFees'] = 1
        before = ledger_state(ledger)
        with self.assertRaises(ImportRevisionConflictError) as caught:
            ledger.send(message)
        self.assertIn('fees', str(caught.exception))
        self.assertEqual(ledger_state(ledger), before)

    def test_a_binding_without_a_valid_credential_refuses_the_import(self):
        ledger = Ledger(self, 'credential')
        text = activity_for(['2026-10'])
        plan_id, summary = ledger.plan(text)
        message = ledger.request(plan_id, summary, text)
        message['fopPackage']['bindings'][0]['evidenceCredential'] = 'eyJ2IjoxfQ.c2lnbmF0dXJl'
        with self.assertRaises(CostBasisStoreError) as caught:
            ledger.send(message)
        self.assertEqual(caught.exception.code, 'fop_binding_evidence_invalid')
        self.assertEqual(ledger.store.list_events(ledger.book_id)['events'], [])



class LimitTests(_PipelineCase):
    """F32 and plan §9.5 item 7: never truncated, never emptied first, split by period."""

    def full(self):
        return activity_for(['2026-10', '2026-11', '2026-12', '2027-01'])

    def test_an_import_over_the_limit_is_refused_and_splits_into_periods(self):
        ledger = Ledger(self, 'limit')
        text = self.full()
        plan_id, summary = ledger.plan(text)
        before = ledger_state(ledger)
        with mock.patch.object(cost_basis_store, 'MAX_IMPORT_EVENTS', 4):
            with self.assertRaises(InvalidRequestError) as caught:
                ledger.send(ledger.request(plan_id, summary, text))
            self.assertIn('consecutive periods', str(caught.exception))
            self.assertEqual(ledger_state(ledger), before, 'nothing of the refused import is kept')
            batches = self.node.call(op='split', planId=plan_id, maxEvents=4)['batches']
            self.assertEqual([(batch['from'], batch['through'], batch['events']) for batch in batches], [
                ('2026-10-01', '2026-10-31', 2), ('2026-11-01', '2026-11-30', 3), ('2026-12-01', '2027-01-31', 4)])
            messages = []
            for batch in batches:
                message = ledger.request(batch['planId'], summary, text)
                self.assertEqual(ledger.send(message)['inserted'], batch['events'])
                messages.append(message)
            # A batch sent again is the same request: its first answer, nothing new.
            self.assertTrue(ledger.send(messages[1])['idempotentReplay'])
        self.assert_96(ledger, 'split by period')
        periods = [(batch['periodFrom'], batch['periodThrough'])
                   for batch in ledger.store.list_import_batches(ledger.book_id)]
        self.assertEqual(sorted(periods), [('2026-10-01', '2026-10-31'), ('2026-11-01', '2026-11-30'),
                                           ('2026-12-01', '2027-01-31')])

    def test_a_rebuild_over_the_limit_is_refused_before_the_ledger_is_emptied(self):
        ledger = Ledger(self, 'rebuild')
        ledger.import_text(self.full())
        before = ledger_state(ledger)
        with mock.patch.object(cost_basis_store, 'MAX_IMPORT_EVENTS', 4):
            with self.assertRaises(InvalidRequestError):
                ledger.rebuild_text(self.full(), graph=None)
        self.assertEqual(ledger_state(ledger), before)
        with mock.patch.object(cost_basis_fop_store, 'MAX_FOP_PACKAGE_BYTES', 2000):
            with self.assertRaises(InvalidRequestError) as caught:
                ledger.rebuild_text(self.full(), graph=None)
            self.assertIn('bytes', str(caught.exception))
        self.assertEqual(ledger_state(ledger), before)
        self.assert_96(ledger, 'refused rebuilds')

    def test_a_missing_month_is_a_history_gap(self):
        ledger = Ledger(self, 'gap')
        ledger.import_text(activity_for(['2026-10']))
        _plan, summary = ledger.plan(activity_for(['2026-12']))
        self.assertTrue(summary['blocking'])
        self.assertEqual({item['code'] for item in summary['problems']}, {'quantity_proof_failed'})
        proof = {item['contract']: (item['opening'], item['ledger']) for item in summary['quantityProof']}
        self.assertEqual(proof['CLF7'], (1, 0))
        self.assertEqual(proof['CLZ6'], (0, 1))


class CoverageTests(_PipelineCase):
    """Review P4-7 and plan §9.5 item 5: periods are covered by statements, not by flat positions."""

    DECEMBER = {'from': '2026-12-01', 'through': '2026-12-31'}
    NOVEMBER = {'from': '2026-11-01', 'through': '2026-11-30'}

    def test_a_month_missing_between_flat_statements_is_a_gap_until_its_statement_registers(self):
        ledger = Ledger(self, 'gap')
        ledger.import_text(statement('activity', period=OCTOBER, fills=ROUND_TRIP, openPositions=[]))
        december = statement('activity', period=self.DECEMBER, openPositions=[], fills=[
            {'symbol': 'CLF7', 'local': '2026-12-01T10:00:00', 'qty': 1, 'price': 69, 'codes': 'O'},
            {'symbol': 'CLF7', 'local': '2026-12-02T10:00:00', 'qty': -1, 'price': 70, 'codes': 'C'}])
        result, summary = ledger.import_text(december)
        self.assertEqual(result['inserted'], 2)
        self.assertEqual([(item['code'], item['blocking']) for item in summary['warnings']],
                         [('coverage_gap', False)])
        self.assertIn('2026-11-01 to 2026-11-30', summary['warnings'][0]['message'])
        self.assertEqual(summary['coverage']['gaps'], [{'from': '2026-11-01', 'through': '2026-11-30'}])
        self.assertFalse(summary['checks']['coverageContinuous'])
        registered = {batch['periodFrom']: batch['checks'] for batch in ledger.store.list_import_batches(ledger.book_id)}
        self.assertFalse(registered['2026-12-01']['coverageContinuous'])
        # November had no trades; its statement still registers, and adds nothing.
        version = ledger.ledger.version()
        november = statement('activity', period=self.NOVEMBER, fills=[], openPositions=[])
        result, summary = ledger.import_text(november)
        self.assertEqual((result['inserted'], summary['events'], summary['warnings']), (0, 0, []))
        self.assertTrue(summary['checks']['coverageContinuous'])
        self.assertEqual(ledger.ledger.version(), version)
        self.assertEqual(sorted(batch['periodFrom'] for batch in ledger.coverage()),
                         ['2026-10-01', '2026-11-01', '2026-12-01'])
        _plan, summary = ledger.plan(december)
        self.assertEqual(summary['coverage']['gaps'], [])
        self.assertEqual(summary['warnings'], [])

    def test_another_accounts_empty_statement_cannot_fill_a_coverage_gap(self):
        ledger = Ledger(self, 'foreign-coverage')
        ledger.import_text(statement('activity', period=OCTOBER, fills=ROUND_TRIP, openPositions=[]))
        december = statement('activity', period=self.DECEMBER, openPositions=[], fills=[
            {'symbol': 'CLF7', 'local': '2026-12-01T10:00:00', 'qty': 1, 'price': 69, 'codes': 'O'},
            {'symbol': 'CLF7', 'local': '2026-12-02T10:00:00', 'qty': -1, 'price': 70, 'codes': 'C'}])
        ledger.import_text(december)
        november = statement('activity', period=self.NOVEMBER, fills=[], openPositions=[])
        plan_id, summary = ledger.plan(november)
        message = ledger.request(plan_id, summary, november)
        self.assertIsNone(message['fopPackage'])
        before = ledger_state(ledger)
        # Another account, exact or masked: a mask must show this ledger's
        # prefix and last digits (the page's own confirmation rule).
        for account in ('U2222222', 'U****2222', 'X****'):
            with self.subTest(account=account):
                wrong = copy.deepcopy(message)
                wrong['statement']['account'] = account
                domain.require_shape('ImportRequest', wrong, 'request')
                with self.assertRaisesRegex(InvalidRequestError,
                                            f'statement is for {re.escape(account)}, not U1111111'):
                    ledger.send(wrong)
        self.assertEqual(ledger_state(ledger), before, 'including coverage and the request log')
        _plan, summary = ledger.plan(december)
        self.assertEqual(summary['coverage']['gaps'], [self.NOVEMBER])
        self.assertFalse(summary['checks']['coverageContinuous'])
        # The refused request reserves no token: the correct file can use the same batch.
        result = ledger.send(message)
        self.assertEqual(result['inserted'], 0)
        self.assertEqual(ledger.ledger.version(), before[0])
        self.assertTrue(ledger.send(message)['idempotentReplay'])
        self.assertEqual(len(ledger.coverage()), 3)
        self.assertEqual({batch['account'] for batch in ledger.store.list_import_batches(ledger.book_id)},
                         {'U1111111'})
        _plan, summary = ledger.plan(december)
        self.assertEqual(summary['coverage']['gaps'], [])
        self.assertTrue(summary['checks']['coverageContinuous'])
        # A mask that shows this ledger's account registers.
        masked = copy.deepcopy(message)
        masked['statement']['account'] = 'U****1111'
        masked['importBatchId'] = token('batch')
        self.assertEqual(ledger.send(masked)['inserted'], 0)

    def test_events_before_the_first_statement_are_uncovered_history(self):
        ledger = Ledger(self, 'lead')
        tws_future(ledger, symbol='CLZ6', month='202612', con_id=555, instant='2026-09-15T15:00:00.000000Z',
                   exec_id='0000e0d5.00000201.01.01')
        _plan, summary = ledger.plan(statement('activity', period=OCTOBER, fills=[],
                                               openPositions=[{'symbol': 'CLZ6', 'quantity': 1}]))
        self.assertFalse(summary['blocking'], summary['problems'])
        self.assertEqual(summary['coverage']['gaps'], [{'from': '2026-09-15', 'through': '2026-09-30'}])

    def test_an_import_without_events_names_its_statement_and_supersedes_nothing(self):
        ledger = Ledger(self, 'bare')
        november = statement('activity', period=self.NOVEMBER, fills=[], openPositions=[])
        plan_id, summary = ledger.plan(november)
        message = ledger.request(plan_id, summary, november)
        self.assertIsNone(message['fopPackage'])
        before = ledger_state(ledger)
        with self.assertRaises(domain.FopDomainError):
            domain.require_shape('ImportRequest', dict(message, statement=None), 'request')
        with self.assertRaises(InvalidRequestError):
            ledger.send(dict(message, statement=None))
        with self.assertRaises(InvalidRequestError):
            ledger.send(dict(message, supersedeTwsEventIds=['tws-0000000001']))
        self.assertEqual(ledger_state(ledger), before)
        result = ledger.send(message)
        self.assertEqual(result['inserted'], 0)
        # The same request again is answered from the request log.
        self.assertTrue(ledger.send(message)['idempotentReplay'])
        self.assertEqual(len(ledger.coverage()), 1)


ROUND_TRIP = [
    {'symbol': 'CLZ6', 'local': '2026-10-01T10:00:00', 'qty': 1, 'price': 70, 'codes': 'O'},
    {'symbol': 'CLZ6', 'local': '2026-10-02T10:00:00', 'qty': -1, 'price': 71, 'codes': 'C'},
]
NEW_CYCLE = [{'symbol': 'CLF7', 'local': '2026-11-03T10:00:00', 'qty': 1, 'price': 69, 'codes': 'O'}]


class CycleTests(_PipelineCase):
    """F36 and F39: cycle boundaries and late fees around imported history."""

    def build(self, name):
        ledger = Ledger(self, name)
        ledger.import_text(statement('activity', period=OCTOBER, fills=ROUND_TRIP, openPositions=[]))
        events = ledger.store.list_events(ledger.book_id)['events']
        opened, closed = events
        ledger.store.commit_fop_metadata(
            ledger.book_id, {'kind': 'close_cycle', 'boundaryId': 'cycle-000000001',
                             'anchorEventId': closed['eventId'], 'label': ''},
            client_token=token(), expected_ledger_version=ledger.ledger.version(),
            book_identity=dict(IDENTITY), engine_version=1)
        ledger.import_text(statement('activity', period={'from': '2026-11-01', 'through': '2026-11-30'},
                                     fills=NEW_CYCLE, openPositions=[{'symbol': 'CLF7', 'quantity': 1}]))
        return ledger, opened, closed

    def test_a_late_fee_stays_with_its_trade_and_a_repeat_changes_nothing(self):
        ledger, opened, _closed = self.build('late')
        fee = {'kind': 'fee', 'account': IDENTITY['account'], 'source': 'manual', 'externalRef': None,
               'packageKey': None, 'note': 'commission corrected after the cycle closed',
               'time': {'exchangeTradeDate': None, 'executedAtUtc': '2026-11-20T15:00:00.000000Z',
                        'timeRange': None, 'sourceTimeText': None, 'sourceTimezone': None, 'orderEvidence': None},
               'sources': [], 'feeSource': {'eventId': opened['eventId'], 'packageKey': None},
               'feeCategory': 'futures', 'feeIsRefund': False, 'cashAmount': -10, 'fees': 0, 'includeInCost': True}
        ledger.ledger.append(fee)
        cycles = [(cycle['totals']['Rf']['value'], cycle['totals']['E']['value'])
                  for cycle in ledger.output({'CLF7': 69})['cycles']]
        self.assertEqual(cycles, [(1000, 10), (0, 0)])
        again, _summary = ledger.import_text(statement('activity', period=OCTOBER, fills=ROUND_TRIP,
                                                       openPositions=[]))
        self.assertEqual(again['inserted'], 0)
        self.assertEqual([(cycle['totals']['Rf']['value'], cycle['totals']['E']['value'])
                          for cycle in ledger.output({'CLF7': 69})['cycles']], cycles)

    def test_a_backfilled_fill_that_reopens_a_closed_cycle_is_refused(self):
        ledger, _opened, _closed = self.build('backfill')
        revised = ROUND_TRIP + [{'symbol': 'CLZ6', 'local': '2026-10-01T12:00:00', 'qty': 1, 'price': 70.5,
                                 'codes': 'O'}]
        text = statement('activity', period=OCTOBER, fills=revised,
                         openPositions=[{'symbol': 'CLZ6', 'quantity': 1}])
        plan_id, summary = ledger.plan(text)
        self.assertIn('cycle_boundary_violated', [item['code'] for item in summary['problems']])
        # The server refuses the same batch on its own: planned as if the
        # ledger were empty (so the preview does not stop it), with the
        # records the ledger already holds referenced rather than re-sent.
        before = ledger_state(ledger)
        plan_id, blind = ledger.plan(text, graph=None)
        message = ledger.request(plan_id, blind, text)
        graph = ledger.graph()
        stored = {item['record']['contractId'] for item in graph['contracts']}
        message['fopPackage']['contracts'] = [record for record in message['fopPackage']['contracts']
                                              if record['contractId'] not in stored]
        with self.assertRaises(FopCycleBoundaryViolatedError):
            ledger.send(message)
        self.assertEqual(ledger_state(ledger), before)

    def test_a_rebuild_from_statements_keeps_the_boundary_on_the_same_fill(self):
        ledger, _opened, closed = self.build('rebuild')
        both = statement('activity', period={'from': '2026-10-01', 'through': '2026-11-30'},
                         fills=ROUND_TRIP + NEW_CYCLE, openPositions=[{'symbol': 'CLF7', 'quantity': 1}])
        before = figures(ledger.output({'CLF7': 69}))
        result = ledger.rebuild_text(both, graph=None)
        [mapping] = [item for item in result['eventIdMappings'] if item['oldEventId'] == closed['eventId']]
        [cycle] = [item for item in ledger.graph()['cycles'] if item['supersededByRevision'] is None]
        self.assertEqual(cycle['anchorEventId'], mapping['newEventId'])
        self.assertEqual(figures(ledger.output({'CLF7': 69})), before)
        self.assertEqual(len(ledger.output({'CLF7': 69})['cycles']), 2)


class OrderTests(_PipelineCase):
    """F41: fills that share a time, in one file and across files (plan §9.2)."""

    SAME = '2026-10-02T10:00:00'

    def fills(self, sell_first):
        buy = {'symbol': 'CLZ6', 'local': self.SAME, 'qty': 1, 'price': 72, 'codes': 'O'}
        sell = {'symbol': 'CLZ6', 'local': self.SAME, 'qty': -1, 'price': 75, 'codes': 'C'}
        first = {'symbol': 'CLZ6', 'local': '2026-10-01T10:00:00', 'qty': 1, 'price': 70, 'codes': 'O'}
        return [first] + ([sell, buy] if sell_first else [buy, sell])

    def test_the_row_order_of_one_second_is_no_evidence_and_an_order_that_matters_blocks(self):
        # Review P4-2: listing the buy or the sell first used to give Rf 4000
        # or 5000. Neither listing proves the order, so both are refused.
        answers = []
        for sell_first in (False, True):
            ledger = Ledger(self, f'order-{sell_first}')
            _plan, summary = ledger.plan(statement('activity', period=OCTOBER, fills=self.fills(sell_first),
                                                   openPositions=[{'symbol': 'CLZ6', 'quantity': 1}]))
            self.assertTrue(summary['blocking'])
            answers.append(sorted(item['code'] for item in summary['problems']))
            self.assertEqual([time['orderEvidence'] for time in summary['eventTimes']], [None, None, None])
        self.assertEqual(answers, [['order_ambiguous'], ['order_ambiguous']])

    def test_another_contract_in_the_same_second_changes_no_stored_row(self):
        adds = [{'symbol': 'CLZ6', 'local': self.SAME, 'qty': 2, 'price': 71, 'codes': 'O'},
                {'symbol': 'CLZ6', 'local': self.SAME, 'qty': 1, 'price': 70, 'codes': 'O'}]
        ledger = Ledger(self, 'second')
        ledger.import_text(statement('activity', period=OCTOBER, fills=adds,
                                     openPositions=[{'symbol': 'CLZ6', 'quantity': 3}]))
        extra = adds[:1] + [{'symbol': 'CLF7', 'local': self.SAME, 'qty': 1, 'price': 69, 'codes': 'O'}] + adds[1:]
        result, summary = ledger.import_text(statement('activity', period=OCTOBER, fills=extra, openPositions=[
            {'symbol': 'CLZ6', 'quantity': 3}, {'symbol': 'CLF7', 'quantity': 1}]))
        self.assertEqual(result['inserted'], 1)
        self.assertEqual(len(result['duplicates']), 2)

    def test_fills_with_only_a_trade_date_and_opposite_sides_are_refused_everywhere(self):
        dated = [dict(fill, tradeId=str(3000 + index), tradeDate=fill['local'][:10],
                      dateOnly=index > 0) for index, fill in enumerate(self.fills(False))]
        ledger = Ledger(self, 'dated')
        _plan, summary = ledger.plan(statement('flex', fills=dated), timeZone='America/New_York')
        self.assertIn('order_ambiguous', [item['code'] for item in summary['problems']])
        # Straight to the server: the same rows timed only by their trade date
        # (planned a second apart, so the preview lets them through).
        timed = [dict(fill, dateOnly=False) for fill in dated]
        timed[2]['local'] = self.SAME[:-1] + '1'
        text = statement('flex', fills=timed)
        plan_id, clean = ledger.plan(text, timeZone='America/New_York')
        message = ledger.request(plan_id, clean, text)
        for event, time in zip(message['fopPackage']['events'][1:], summary['eventTimes'][1:]):
            event['time'] = time
        with self.assertRaises(FopOrderingAmbiguousError):
            ledger.send(message)
        self.assertEqual(ledger.store.list_events(ledger.book_id)['events'], [])

    def test_simultaneous_adds_need_no_order(self):
        fills = [{'symbol': 'CLZ6', 'local': self.SAME, 'qty': 2, 'price': 71, 'codes': 'O'},
                 {'symbol': 'CLZ6', 'local': self.SAME, 'qty': 1, 'price': 70, 'codes': 'O'}]
        ledger = Ledger(self, 'adds')
        ledger.import_text(statement('activity', period=OCTOBER, fills=fills,
                                     openPositions=[{'symbol': 'CLZ6', 'quantity': 3}]))
        [row] = ledger.output({'CLZ6': 71})['futures']
        self.assertAlmostEqual(row['averagePrice']['value'], 212 / 3, places=9)


class DeliveryTests(_PipelineCase):
    """Deliveries by statement (plan §6.1): the option row and the future it delivered."""

    def test_an_assignment_and_an_exercise_arrive_as_one_event_each(self):
        fills = [
            {'symbol': 'CLZ6', 'local': '2026-10-01T10:00:00', 'qty': 1, 'price': 70, 'codes': 'O'},
            {'symbol': 'LOZ6 C7500', 'local': '2026-10-01T11:00:00', 'qty': -1, 'price': 1.2, 'codes': 'O'},
            {'symbol': 'LOZ6 P6500', 'local': '2026-10-01T11:30:00', 'qty': 1, 'price': 0.8, 'codes': 'O'},
            {'symbol': 'LOZ6 C7500', 'local': '2026-11-17T16:20:00', 'qty': 1, 'price': 0, 'codes': 'A'},
            {'symbol': 'CLZ6', 'local': '2026-11-17T16:20:00', 'qty': -1, 'price': 75, 'commission': -1.5,
             'codes': 'A'},
            {'symbol': 'LOZ6 P6500', 'local': '2026-11-17T16:30:00', 'qty': -1, 'price': 0, 'codes': 'Ex'},
            {'symbol': 'CLZ6', 'local': '2026-11-17T16:30:00', 'qty': -1, 'price': 65, 'codes': 'Ex'},
        ]
        ledger = Ledger(self, 'deliveries')
        result, summary = ledger.import_text(statement(
            'activity', period={'from': '2026-10-01', 'through': '2026-11-30'}, fills=fills,
            openPositions=[{'symbol': 'CLZ6', 'quantity': -1}]))
        self.assertEqual(summary['kinds'], ['futures_trade', 'option_trade', 'option_trade', 'option_assignment',
                                            'option_exercise'])
        self.assertEqual(result['inserted'], 5)
        output = ledger.output({'CLZ6': 66})
        self.assertEqual(output['totals']['Rf']['value'], 5000)
        self.assertEqual([(row['localSymbol'], row['contracts']['value'], row['averagePrice']['value'])
                          for row in output['futures']], [('CLZ6', -1, 65)])
        self.assertEqual({row['bindingStatus'] for row in ledger.graph()['bindings']} if False else
                         {binding['status'] for binding in ledger.graph()['bindings']}, {'verified_statement'})

    def test_a_delivery_without_its_other_row_blocks(self):
        fills = [{'symbol': 'LOZ6 C7500', 'local': '2026-10-01T11:00:00', 'qty': -1, 'price': 1.2, 'codes': 'O'},
                 {'symbol': 'LOZ6 C7500', 'local': '2026-11-17T16:20:00', 'qty': 1, 'price': 0, 'codes': 'A'}]
        _plan, summary = Ledger(self, 'leg').plan(statement(
            'activity', period={'from': '2026-10-01', 'through': '2026-11-30'}, fills=fills))
        self.assertIn('delivery_leg_missing', [item['code'] for item in summary['problems']])


class SharedDatabaseTests(_PipelineCase):
    """Two accounts' ledgers in one database hold the same real contracts (plan §4.2)."""

    def test_two_accounts_import_the_same_contracts_into_one_database(self):
        first = Ledger(self, 'shared')
        second = Ledger(self, 'shared', account='U2222222')
        months = ['2026-10', '2026-11', '2026-12', '2027-01']
        self.assertEqual(first.import_text(activity_for(months))[0]['inserted'], 9)
        self.assertEqual(second.import_text(activity_for(months, account='U2222222'))[0]['inserted'], 9)
        self.assert_96(first, 'first account')
        self.assert_96(second, 'second account')
        ids = [{stored['record']['contractId'] for stored in ledger.graph()['contracts']} for ledger in (first, second)]
        self.assertEqual(len(ids[0]), 5)
        self.assertEqual(ids[0] & ids[1], set(), 'record ids are scoped to their ledger')


class ReadOnlyPreviewTests(_PipelineCase):
    """Plan §9.7: a statement previewed without a ledger, or over one, writes nothing."""

    def test_a_statement_previews_without_a_ledger(self):
        book = {'bookId': 'preview-ledger', 'account': IDENTITY['account'], 'symbol': 'CL', 'currency': 'USD',
                'fop': {'productRules': 'NYMEX-CL-v1', 'historyScope': 'full_history', 'engineVersion': 1}}
        answer = self.node.call(op='plan', text=activity_for(['2026-10', '2026-11', '2026-12', '2027-01']),
                                fileName='preview.csv', context={'book': book, 'graph': None,
                                                                 'observedAtUtc': OBSERVED})
        self.assertFalse(answer['summary']['blocking'], answer['summary']['problems'])
        contract = next(item['future'] for item in answer['summary']['bindingRequests'])
        self.assertEqual(contract['localSymbol'], 'CLZ6')
        self.assertRegex(contract['contractId'], r'^fut-cl-202612-[0-9a-f]{6}$')
        output = self.node.call(op='preview', planId=answer['planId'], graph=None, book=book,
                                options={'marks': {contract['contractId'].replace('202612', '202703'): 71.8}})['output']
        for name, value in EXPECTED_96.items():
            self.assertAlmostEqual(output['totals'][name]['value'], value, places=7, msg=name)

    def test_a_preview_over_a_ledger_writes_nothing(self):
        ledger = Ledger(self, 'readonly')
        ledger.import_text(activity_for(['2026-10']))
        before = ledger_state(ledger)
        plan_id, _summary = ledger.plan(activity_for(['2026-11', '2026-12', '2027-01']))
        clh7 = f'fut-cl-202703-{contract_scope(ledger.book_id)}'
        output = self.node.call(op='preview', planId=plan_id, graph=ledger.graph(), book=ledger.book(),
                                options={'marks': {clh7: 71.8}})['output']
        self.assertAlmostEqual(output['totals']['economicPnl']['value'], 1670, places=7)
        self.assertEqual(ledger_state(ledger), before)



def contract_scope(book_id):
    """The ledger scope js/cost_basis_fop_import.js puts on a new contract's record id."""
    script = ("const c = require('./tests/helpers/load-browser-scripts').loadBrowserScripts("
              "['js/cost_basis_import_common.js']).OptionComboCostBasisImportCommon;"
              "process.stdout.write(c.hash16('ledger|' + process.argv[1]).slice(0, 6));")
    return subprocess.check_output(['node', '-e', script, book_id], cwd=REPO_ROOT, text=True)


def decisions_for(summary, decision, attestation='checked against the broker\'s trade confirmations', *,
                  event_ids=None):
    """The decisions a person makes on every possible duplicate of a preview (plan §19 P5-C1)."""
    return [{'namespace': review['namespace'], 'sourceRef': review['sourceRef'], 'decision': decision,
             'eventIds': event_ids if event_ids is not None
             else [candidate['eventId'] for candidate in review['candidates']][:1 if decision == 'same_fill' else None],
             'attestation': attestation} for review in summary['duplicateReviews']]


class DuplicateDecisionTests(_PipelineCase):
    """Plan §19 P5-C1: a possible duplicate stays blocked until a person decides, and the server checks it."""

    # One order of 3 CLZ6 in October, stored first from an Activity order row
    # without an order reference; the same order's two executions arrive
    # later in a Flex export that names no order either.
    EXECUTIONS = [dict(fill, tradeId=str(900 + index)) for index, fill in enumerate(CrossFormatTests.GRANULAR)]

    def stored_order(self, name, **options):
        ledger = Ledger(self, token(name), **options)
        period = {'from': '2026-10-01', 'through': '2026-10-31'}
        ledger.import_text(statement('activity', period=period, fills=[CrossFormatTests.ORDER],
                                     openPositions=[{'symbol': 'CLZ6', 'quantity': 3, 'costPrice': 212 / 3}]))
        [event] = [stored['row'] for stored in ledger.graph()['events']]
        return ledger, event['eventId']

    def plan(self, ledger, text, decisions=None):
        return ledger.plan(text, timeZone='America/New_York', duplicateDecisions=decisions or [])

    def test_an_undecided_possible_duplicate_writes_nothing(self):
        ledger, stored = self.stored_order('undecided')
        before = ledger_state(ledger)
        text = statement('flex', fills=self.EXECUTIONS)
        plan_id, summary = self.plan(ledger, text)
        self.assertTrue(summary['blocking'])
        self.assertEqual([item['code'] for item in summary['problems']], ['possible_duplicate'] * 2)
        self.assertEqual([(review['status'], [c['eventId'] for c in review['candidates']])
                          for review in summary['duplicateReviews']], [('undecided', [stored])] * 2)
        review = summary['duplicateReviews'][0]
        self.assertEqual((review['localSymbol'], review['quantity'], review['price'], review['fees']),
                         ('CLZ6', 1, 70, 1))
        self.assertEqual(review['candidates'][0]['quantity'], 3)
        with self.assertRaises(PipelineError):
            ledger.request(plan_id, summary, text)
        self.assertEqual(ledger_state(ledger), before)

    def test_rows_named_the_same_fill_count_once_and_the_decision_is_kept(self):
        ledger, stored = self.stored_order('same')
        text = statement('flex', fills=self.EXECUTIONS)
        _plan_id, first = self.plan(ledger, text)
        plan_id, summary = self.plan(ledger, text, decisions_for(first, 'same_fill'))
        self.assertFalse(summary['blocking'], summary['problems'])
        self.assertEqual(summary['events'], 0)
        self.assertEqual([review['status'] for review in summary['duplicateReviews']], ['same', 'same'])
        self.assertEqual([row['disposition'] for row in summary['rows'] if row.get('storedEventId')],
                         ['duplicate', 'duplicate'])
        message = ledger.request(plan_id, summary, text)
        self.assertEqual(message['fopPackage'], None)
        self.assertEqual(message['statement']['confirmedDuplicates'], 2)
        self.assertEqual([(item['decision'], item['eventIds'], item['source']['sourceRef'])
                          for item in message['duplicateDecisions']],
                         [('same_fill', [stored], '900'), ('same_fill', [stored], '901')])
        result = ledger.send(message)
        self.assertEqual(result['inserted'], 0)
        self.assertEqual([item['sourceRef'] for item in result['duplicateDecisions']], ['900', '901'])
        [row] = ledger.output({'CLZ6': 71})['futures']
        self.assertEqual(row['contracts']['value'], 3)
        # The same request again is its first answer; nothing moves.
        before = ledger_state(ledger)
        again = ledger.send(message)
        self.assertTrue(again['idempotentReplay'])
        self.assertEqual(ledger_state(ledger), before)
        # Read back: the request log keeps the decision with its row, and the
        # same file previewed again needs no new decision.
        [kept] = [json.loads(item['resultJson']) for item in ledger.graph()['requests']
                  if json.loads(item['resultJson']).get('duplicateDecisions')]
        self.assertEqual(kept['duplicateDecisions'][0]['attestation'],
                         "checked against the broker's trade confirmations")
        self.assertEqual(kept['duplicateDecisions'][0]['source']['rawFields']['TradeID'], '900')
        _plan_id, later = self.plan(ledger, text)
        self.assertFalse(later['blocking'], later['problems'])
        self.assertEqual(later['decisions'], [])
        self.assertTrue(all(item['reason'].endswith('by an earlier import') for item in later['duplicates']))

    def test_rows_that_do_not_add_up_to_the_fill_stay_blocked(self):
        ledger, stored = self.stored_order('partial')
        # Only one of the two executions: 1 of the 3 contracts.
        text = statement('flex', fills=self.EXECUTIONS[:1])
        _plan_id, first = self.plan(ledger, text)
        _plan_id, summary = self.plan(ledger, text, decisions_for(first, 'same_fill'))
        self.assertEqual([item['code'] for item in summary['problems']], ['duplicate_decision_conflict'])
        self.assertIn('quantity (3 stored, 1 in the rows named the same fill)', summary['problems'][0]['message'])
        # Other fees are another fill's content, never absorbed.
        dearer = [dict(self.EXECUTIONS[0], commission=-4), self.EXECUTIONS[1]]
        text = statement('flex', fills=dearer)
        _plan_id, first = self.plan(ledger, text)
        _plan_id, summary = self.plan(ledger, text, decisions_for(first, 'same_fill'))
        self.assertEqual({item['code'] for item in summary['problems']}, {'duplicate_decision_conflict'})
        self.assertIn('fees (3 stored, 6 in this file)', summary['problems'][0]['message'])
        # The server adds the rows up itself: a request that leaves one out is refused.
        full = statement('flex', fills=self.EXECUTIONS)
        _plan_id, first = self.plan(ledger, full)
        plan_id, summary = self.plan(ledger, full, decisions_for(first, 'same_fill'))
        message = ledger.request(plan_id, summary, full)
        message['duplicateDecisions'] = message['duplicateDecisions'][:1]
        before = ledger_state(ledger)
        with self.assertRaisesRegex(InvalidRequestError, 'add up to 1 contracts; it is 3'):
            ledger.send(message)
        self.assertEqual(ledger_state(ledger), before)

    def test_a_row_decided_to_be_another_fill_is_written_once_with_its_check(self):
        ledger = Ledger(self, 'distinct')
        eleven = {'symbol': 'CLZ6', 'local': '2026-10-01T11:00:00', 'qty': 1, 'price': 70, 'codes': 'O'}
        ledger.import_text(statement('flex', fills=[dict(eleven, tradeId='1')]), timeZone='America/New_York')
        [stored] = [item['row']['eventId'] for item in ledger.graph()['events']]
        text = statement('flex', fills=[dict(eleven, local='2026-10-01T10:00:00', tradeId='2')])
        _plan_id, first = self.plan(ledger, text)
        # A decision without its check, or one that leaves a candidate out, is not a decision.
        _plan_id, silent = self.plan(ledger, text, decisions_for(first, 'distinct_fill', attestation='  '))
        self.assertEqual([item['code'] for item in silent['problems']], ['duplicate_decision_incomplete'])
        _plan_id, partial = self.plan(ledger, text, decisions_for(first, 'distinct_fill', event_ids=['evt-other']))
        self.assertEqual([item['code'] for item in partial['problems']], ['duplicate_decision_incomplete'])
        plan_id, summary = self.plan(ledger, text, decisions_for(first, 'distinct_fill',
                                                                 attestation='two confirmations, 10:00 and 11:00'))
        self.assertFalse(summary['blocking'], summary['problems'])
        self.assertEqual(summary['events'], 1)
        self.assertIn('two confirmations, 10:00 and 11:00', summary['notes'][0])
        result = ledger.send(ledger.request(plan_id, summary, text))
        self.assertEqual(result['inserted'], 1)
        self.assertEqual(result['duplicateDecisions'][0]['eventIds'], [stored])
        self.assertEqual(ledger.output({'CLZ6': 70})['futures'][0]['contracts']['value'], 2)
        written = next(item['row'] for item in ledger.graph()['events'] if item['row']['eventId'] == result['eventIds'][0])
        self.assertIn(stored, written['note'])
        self.assertIn('two confirmations, 10:00 and 11:00', written['note'])
        # The same file again: its row is stored now, so nothing is added twice.
        again, summary = ledger.import_text(text, timeZone='America/New_York')
        self.assertEqual((again['inserted'], summary['duplicateReviews']), (0, []))
        self.assertEqual(ledger.output({'CLZ6': 70})['futures'][0]['contracts']['value'], 2)

    def test_a_decision_made_before_the_ledger_moved_is_not_sent(self):
        ledger, _stored = self.stored_order('moved')
        text = statement('flex', fills=self.EXECUTIONS)
        _plan_id, first = self.plan(ledger, text)
        plan_id, summary = self.plan(ledger, text, decisions_for(first, 'same_fill'))
        message = ledger.request(plan_id, summary, text)
        # Something else is written before the confirmation.
        ledger.import_text(statement('flex', fills=[{'symbol': 'CLF7', 'local': '2026-10-05T10:00:00', 'qty': 1,
                                                    'price': 69, 'codes': 'O', 'tradeId': '950'}]),
                           timeZone='America/New_York')
        before = ledger_state(ledger)
        with self.assertRaises(cost_basis_store.LedgerChangedError):
            ledger.send(message)
        self.assertEqual(ledger_state(ledger), before)

    def test_the_server_reads_a_same_fill_row_itself(self):
        ledger, stored = self.stored_order('server')
        text = statement('flex', fills=self.EXECUTIONS)
        _plan_id, first = self.plan(ledger, text)
        plan_id, summary = self.plan(ledger, text, decisions_for(first, 'same_fill'))
        good = ledger.request(plan_id, summary, text)
        before = ledger_state(ledger)

        def refused(change, error, pattern):
            message = copy.deepcopy(good)
            change(message['duplicateDecisions'])
            with self.assertRaisesRegex(error, pattern):
                ledger.send(message)
            self.assertEqual(ledger_state(ledger), before)

        def other_contract(decisions):
            for decision in decisions:
                decision['source']['rawFields']['Symbol'] = 'CLF7'
                decision['source']['rawFields']['Conid'] = '556'
        refused(other_contract, InvalidRequestError, 'differ in contract')

        def other_day(decisions):
            for decision in decisions:
                decision['source']['rawFields']['DateTime'] = '20261020;100000'
                decision['source']['rawFields']['TradeDate'] = '20261020'
        refused(other_day, InvalidRequestError, r'differ in day \(2026-10-20')

        def missing_fill(decisions):
            for decision in decisions:
                decision['eventIds'] = ['evt-nosuchfill']
        refused(missing_fill, InvalidRequestError, 'not a live trade of this ledger')

        def other_account(decisions):
            decisions[0]['source']['account'] = 'U2222222'
        refused(other_account, InvalidRequestError, 'belongs to account U2222222')

        def as_cash_settled(decisions):
            for decision in decisions:
                decision['source']['rawFields']['AssetClass'] = 'FOP'
                decision['source']['rawFields']['SettlementType'] = 'Cash'
                decision['source']['capabilityKey'] = 'flex/trades/FOP.cash_settled/any'
        refused(as_cash_settled, cost_basis_store.FopUnsupportedRowError, 'does not support')

        def twice(decisions):
            decisions.append(copy.deepcopy(decisions[0]))
        refused(twice, InvalidRequestError, 'decided twice')
        # Unchanged, it goes through.
        self.assertEqual(ledger.send(good)['inserted'], 0)
        self.assertEqual(stored, good['duplicateDecisions'][0]['eventIds'][0])

    def decided(self, ledger, text):
        """The request that sends every possible duplicate of text as the same fill."""
        _plan_id, first = self.plan(ledger, text)
        plan_id, summary = self.plan(ledger, text, decisions_for(first, 'same_fill'))
        self.assertFalse(summary['blocking'], summary['problems'])
        return ledger.request(plan_id, summary, text)

    def refuses_each(self, ledger, good, changes):
        """Each change to the rows a request names the same fill is refused, and nothing moves."""
        before = ledger_state(ledger)
        for name, (change, pattern) in changes.items():
            with self.subTest(change=name):
                message = copy.deepcopy(good)
                change([decision['source']['rawFields'] for decision in message['duplicateDecisions']])
                with self.assertRaisesRegex(InvalidRequestError, pattern):
                    ledger.send(message)
                self.assertEqual(ledger_state(ledger), before)

    def test_the_server_checks_what_a_same_fill_row_is_worth(self):
        # Review P5-C1: the rows named the same fill carry its price, fees and intent, not only its size.
        ledger, stored = self.stored_order('worth')
        good = self.decided(ledger, statement('flex', fills=self.EXECUTIONS))

        def edit(field, value, rows=(0,)):
            def change(raws):
                for index in rows:
                    raws[index][field] = value
            return change

        self.refuses_each(ledger, good, {
            'commission': (edit('IBCommission', '-400'), r'differ in fees \(3 stored, 402 in the rows'),
            'price': (edit('TradePrice', '75'), r'differ in average price \(70\.666667 stored, 72\.333333 in'),
            'intent': (edit('Notes/Codes', 'C', rows=(0, 1)), r'differ in open/close \(O stored, C in the rows'),
            'part closes': (edit('Notes/Codes', 'C'), r'differ in open/close \(O stored, CO in the rows'),
        })
        self.assertEqual(ledger.send(good)['inserted'], 0)
        self.assertEqual(good['duplicateDecisions'][0]['eventIds'], [stored])

    def test_the_preview_adds_up_intents_and_dates_as_the_server_does(self):
        # One execution closes: together the rows open and close, which the stored opening fill does not.
        ledger, _stored = self.stored_order('intents')
        mixed = [self.EXECUTIONS[0], dict(self.EXECUTIONS[1], codes='C')]
        text = statement('flex', fills=mixed)
        _plan_id, first = self.plan(ledger, text)
        _plan_id, summary = self.plan(ledger, text, decisions_for(first, 'same_fill'))
        self.assertEqual({item['code'] for item in summary['problems']}, {'duplicate_decision_conflict'})
        self.assertIn('open/close (O stored, CO in this file)', summary['problems'][0]['message'])
        # A Flex fill of 2026-10-01: rows stating another exchange trade date are another fill's.
        option = Ledger(self, token('dates'))
        short = {'symbol': 'LOZ6 C7500', 'local': '2026-10-01T11:00:00', 'qty': -2, 'price': 1.2, 'codes': 'O'}
        option.import_text(statement('flex', fills=[dict(short, tradeId='1')]), timeZone='America/New_York')
        halves = [dict(short, qty=-1, tradeId='2'),
                  dict(short, local='2026-10-01T11:00:05', qty=-1, tradeId='3', tradeDate='2026-10-02')]
        text = statement('flex', fills=halves)
        _plan_id, first = self.plan(option, text)
        _plan_id, summary = self.plan(option, text, decisions_for(first, 'same_fill'))
        self.assertEqual({item['code'] for item in summary['problems']}, {'duplicate_decision_conflict'})
        self.assertIn('exchange trade date (2026-10-01 stored, 2026-10-02 in this file)',
                      summary['problems'][0]['message'])

    def test_the_server_checks_a_same_fill_option_row_for_cash_date_and_future(self):
        ledger = Ledger(self, token('option'))
        short = {'symbol': 'LOZ6 C7500', 'local': '2026-10-01T11:00:00', 'qty': -2, 'price': 1.2,
                 'commission': -5, 'codes': 'O'}
        # With its future in the same file, the statement binds the option to CLZ6 (conId 555).
        future = {'symbol': 'CLZ6', 'local': '2026-10-01T10:00:00', 'qty': 1, 'price': 70, 'codes': 'O'}
        ledger.import_text(statement('flex', fills=[dict(future, tradeId='0'), dict(short, tradeId='1')]),
                           timeZone='America/New_York')
        self.assertEqual([item['status'] for item in ledger.graph()['bindings']], ['verified_statement'])
        [stored] = [item['row']['eventId'] for item in ledger.graph()['events'] if item['row']['kind'] == 'option_trade']
        halves = [dict(short, qty=-1, commission=-2.5, tradeId='2'),
                  dict(short, local='2026-10-01T11:00:05', qty=-1, commission=-2.5, tradeId='3')]
        good = self.decided(ledger, statement('flex', fills=halves))
        self.refuses_each(ledger, good, {
            'cash': (lambda raws: raws[0].update(Proceeds='1300'), r'differ in cash \(2395 stored, 2495 in the rows'),
            'trade date': (lambda raws: raws[0].update(TradeDate='20261002'),
                           r'differ in exchange trade date \(2026-10-01 stored, 2026-10-02 in the rows'),
            'future': (lambda raws: raws[1].update(UnderlyingConid='556'),
                       r'differ in underlying future \(LOZ6 C7500 is bound to conId 555, the row names 556'),
            'future symbol': (lambda raws: raws[1].update(UnderlyingSymbol='CLF7'),
                              r'differ in underlying future \(LOZ6 C7500 is bound to CLZ6, the row names CLF7'),
            'no price': (lambda raws: raws[0].update(TradePrice=''), r"differ in price \(the row states ''\)"),
            'unreadable fees': (lambda raws: raws[0].update(IBCommission='n/a'),
                                r"differ in fees \(the row states 'n/a'\)"),
        })
        self.assertEqual(ledger.send(good)['inserted'], 0)
        self.assertEqual(good['duplicateDecisions'][0]['eventIds'], [stored])

    def test_a_decision_does_not_verify_a_row_type(self):
        # With the shipped row-type list every economic row is synthetic_only:
        # a row decided to be another fill still needs a claim (plan §9.7).
        ledger = Ledger(self, 'unverified', capabilities=None)
        eleven = {'symbol': 'CLZ6', 'local': '2026-10-01T11:00:00', 'qty': 1, 'price': 70, 'codes': 'O'}
        first_text = statement('flex', fills=[dict(eleven, tradeId='1')])
        plan_id, summary = ledger.plan(first_text, timeZone='America/New_York')
        ledger.send(ledger.request(plan_id, summary, first_text, claim={'lines': event_lines(summary),
                                                                        'attestation': 'checked by hand'}))
        text = statement('flex', fills=[dict(eleven, local='2026-10-01T10:00:00', tradeId='2')])
        _plan_id, first = self.plan(ledger, text)
        plan_id, summary = self.plan(ledger, text, decisions_for(first, 'distinct_fill'))
        self.assertFalse(summary['blocking'], summary['problems'])
        with self.assertRaises(FopCapabilityNotVerifiedError):
            ledger.send(ledger.request(plan_id, summary, text))
        result = ledger.send(ledger.request(plan_id, summary, text, claim={
            'lines': event_lines(summary), 'attestation': 'the 10:00 confirmation'}))
        written = next(item['row'] for item in ledger.graph()['events'] if item['row']['eventId'] == result['eventIds'][0])
        self.assertEqual(written['source'], 'manual')
        self.assertIn("checked against the broker's trade confirmations", written['note'])
        self.assertIn('the 10:00 confirmation', written['note'])


if __name__ == '__main__':
    unittest.main()
