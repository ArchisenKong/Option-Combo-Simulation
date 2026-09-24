"""P3: the FOP economic core against the independent model and the real store.

CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §13.3 P3 and §14.2: hand-worked
vectors -> independent rational model -> JS core -> temporary SQLite -> read
back and replayed. Every vector in tests/fixtures/cost_basis_fop/core_vectors.json
is:

- reproduced by tests/helpers/cost_basis_fop_model.py (Fractions, no production code);
- ordered by the server timeline (cost_basis_fop_domain.build_timeline) the way
  the JS core orders it, and refused by the server when no evidence fixes an
  order that matters;
- written through the real store (a rebuild with the whole package, then the
  cycle boundaries), exported, and replayed by js/cost_basis_fop_core.js; the
  figures equal the model's and the ones the core computes from the builder's
  graph.

Random histories check the model and the core against each other, some of them
through the store. Temporary databases only; nothing reaches TWS.
"""
import copy
import json
import pathlib
import random
import subprocess
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta
from fractions import Fraction
from unittest import mock

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
for path in (REPO_ROOT, REPO_ROOT / 'tests'):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import cost_basis_fop_domain as domain  # noqa: E402
import cost_basis_fop_store  # noqa: E402
from cost_basis_fop_test_support import FOP_META, FopLedger, IDENTITY, token  # noqa: E402
from cost_basis_store import (  # noqa: E402
    FopCycleBoundaryViolatedError, FopOrderingAmbiguousError, InvalidRequestError)
from helpers import cost_basis_fop_model as model  # noqa: E402

VECTORS = json.loads((REPO_ROOT / 'tests/fixtures/cost_basis_fop/core_vectors.json').read_text(encoding='utf-8'))
CATALOGUE = VECTORS['catalogue']
PRICES = {'averagePrice', 'breakEven', 'breakEvenIfOpenShortsExpire'}
OBSERVED = '2026-10-01T00:00:00.000000Z'


def with_catalogue(vector):
    return {**vector, 'contracts': {**CATALOGUE, **vector.get('contracts', {})}}


def equal(expected, actual):
    if expected is None:
        return actual is None
    return actual is not None and Fraction(str(expected)) == actual


def close_to(expected, actual, field):
    """A model Fraction (or None) against a core float (or None), plan §14.2."""
    if expected is None:
        return actual is None
    tolerance = 1e-9 if field in PRICES else 1e-7
    return actual is not None and abs(float(expected) - actual) <= tolerance


class Bridge:
    """js/cost_basis_fop_core.js through tests/helpers/cost_basis_fop_vectors.js."""

    def __init__(self):
        self.process = subprocess.Popen(
            ['node', str(REPO_ROOT / 'tests/helpers/cost_basis_fop_vectors.js')], cwd=REPO_ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def compute(self, request):
        self.process.stdin.write(json.dumps(request) + '\n')
        self.process.stdin.flush()
        answer = json.loads(self.process.stdout.readline())
        if 'error' in answer:
            raise AssertionError(answer['error'])
        return answer['result']

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=10)


def _shifted(text, seconds):
    """A vector time `seconds` later, in vector form."""
    moment = datetime.strptime(model.instant(text), '%Y-%m-%dT%H:%M:%S.%fZ') + timedelta(seconds=seconds)
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def core_options(vector):
    options = {}
    if vector.get('asOf'):
        options['asOf'] = model.instant(vector['asOf'])
    return options


def marks_by_id(vector):
    specs = with_catalogue(vector)['contracts']
    return {specs[alias]['contractId']: price for alias, price in (vector.get('marks') or {}).items()}


# ----------------------------------------------------------------------
# Vectors as store requests and as server timeline rows
# ----------------------------------------------------------------------

def contract_record(spec):
    common = {'contractId': spec['contractId'], 'revision': 1, 'conId': spec.get('conId'), 'root': 'CL',
              'localSymbol': spec.get('localSymbol'), 'exchange': 'NYMEX', 'currency': 'USD',
              'ruleVersion': 'NYMEX-CL-v1', 'evidenceStatus': 'verified_broker', 'evidenceSummary': '',
              'observedAtUtc': OBSERVED}
    if spec['secType'] == 'FUT':
        return {**common, 'secType': 'FUT', 'tradingClass': 'CL', 'futureContractMonth': spec['month'],
                'futureLastTradeDate': spec.get('lastTrade'), 'futureLastTradeAsOf': None,
                'futurePointValue': spec.get('pointValue', 1000)}
    return {**common, 'secType': 'FOP', 'tradingClass': 'LO', 'optionRight': spec['right'],
            'optionStrike': spec['strike'], 'optionExpiry': spec['expiry'], 'optionExpiryAsOf': None,
            'premiumMultiplier': spec.get('multiplier', 1000),
            'deliverableFuturesPerOption': spec.get('deliverable', 1),
            'settlementType': 'physical_future', 'exerciseStyle': 'american'}


def event_time(event):
    time = {'exchangeTradeDate': None, 'executedAtUtc': None, 'timeRange': None, 'sourceTimeText': None,
            'sourceTimezone': None, 'orderEvidence': event.get('evidence')}
    if 'range' in event:
        time['timeRange'] = {'startUtc': model.instant(event['range'][0]),
                             'endUtc': model.instant(event['range'][1])}
    else:
        time['executedAtUtc'] = model.instant(event['at'])
    return time


def event_values(vector, event):
    """Every field a vector event can carry, before the kind's field list picks."""
    specs = vector['contracts']
    spec = specs.get(event.get('contract'))
    fees = event.get('fees', 0)
    quantity = event.get('q')
    values = {
        'kind': event['kind'], 'account': IDENTITY['account'],
        'source': 'execution_report' if event.get('src') else 'manual',
        'externalRef': event['src']['ref'] if event.get('src') else None,
        'packageKey': f'pk-{event["id"]}'.ljust(8, '0'), 'time': event_time(event),
        # An adjustment names its evidence (the contract requires a note).
        'note': 'synthetic adjustment evidence' if event['kind'] == 'manual_adjust' else '',
        'sources': ([{'namespace': event['src']['ns'], 'sourceRef': event['src']['ref'], 'role': 'trade',
                      'quantity': abs(quantity), 'fees': fees}] if event.get('src') else []),
        'contractRef': {'contractId': spec['contractId'], 'revision': 1} if spec else None,
        'contracts': quantity, 'futureContracts': None, 'price': event.get('price'),
        'cashAmount': float(model.event_cash(vector, event)), 'fees': fees,
        'includeInCost': event.get('includeInCost', True), 'openClose': event.get('openClose'),
        'feeCategory': event.get('category'), 'feeIsRefund': bool(event.get('refund')),
        'feeSource': ({'eventId': None, 'packageKey': f'pk-{event["feeSource"]}'.ljust(8, '0')}
                      if event.get('feeSource') else None),
        'adjustmentScope': event.get('scope'), 'baselineKind': event.get('baseline'),
        'baselineAsOfUtc': model.instant(event['baselineAsOf']) if event.get('baselineAsOf') else None,
    }
    kind = event['kind']
    if kind == 'futures_trade' or (kind == 'opening_balance' and spec['secType'] == 'FUT'):
        values['futureContracts'], values['contracts'] = quantity, None
    if kind in model.DELIVERIES:
        alias, delivered = model.delivered_futures(vector, event)
        values['futureContracts'] = delivered
        values['price'] = spec['strike']
        values['deliveredContractRef'] = {'contractId': specs[alias]['contractId'], 'revision': 1}
        values['bindingRef'] = {'bindingId': f'bind-{spec["contractId"]}', 'revision': 1}
    return values


def fop_event(vector, event):
    cases = domain.schema.protocol()['types']['FopEvent']['cases']
    values = event_values(vector, event)
    return {field: values.get(field) for field in cases[event['kind']]['fields']}


def store_package(vector, store, book_id):
    """The whole vector as one FopPackage (FopRebuildRequest.fopPackage)."""
    vector = with_catalogue(vector)
    specs = vector['contracts']
    used = set()
    for event in vector['events']:
        if event.get('contract'):
            used.add(event['contract'])
            if specs[event['contract']]['secType'] == 'FOP':
                used.add(specs[event['contract']]['future'])
    records = {alias: contract_record(specs[alias]) for alias in sorted(used)}
    bindings = []
    for alias in sorted(used):
        spec = specs[alias]
        if spec['secType'] != 'FOP':
            continue
        status = vector.get('bindings', {}).get(alias, 'manual_attested')
        binding = {'bindingId': f'bind-{spec["contractId"]}', 'revision': 1,
                   'optionContractId': spec['contractId'], 'futureContractId': specs[spec['future']]['contractId'],
                   'status': status, 'evidenceSummary': '', 'evidenceCredential': None,
                   'observedAtUtc': OBSERVED}
        if status.startswith('verified'):
            binding['evidenceCredential'] = store.issue_binding_credential(
                book_id, status=status, option=records[alias], future=records[spec['future']],
                evidence={'vector': vector['name']})
        bindings.append(binding)
    sources = {}
    for event in vector['events']:
        src = event.get('src')
        if src and (src['ns'], src['ref']) not in sources:
            stated = src.get('stated') or [abs(event['q']), event.get('fees', 0)]
            sources[(src['ns'], src['ref'])] = {
                'account': IDENTITY['account'], 'namespace': src['ns'], 'sourceRef': src['ref'],
                'capabilityKey': None, 'format': 'tws_execution', 'section': None,
                'rawFields': {'execId': src['ref']}, 'statedQuantity': stated[0], 'statedFees': stated[1]}
    return {'version': 1, 'engineVersion': 1, 'contracts': list(records.values()), 'bindings': bindings,
            'sourceRecords': list(sources.values()),
            'events': [fop_event(vector, event) for event in vector['events'] if not event.get('void')]}


def timeline_rows(vector):
    """The rows cost_basis_store._validate_fop_ledger hands the domain, per vector event."""
    vector = with_catalogue(vector)
    rows = []
    for event in vector['events']:
        if event.get('void'):
            continue
        values = event_values(vector, event)
        time = values['time']
        rows.append({
            'event_id': event['id'], 'kind': event['kind'], 'contracts': values['contracts'],
            'future_contracts': values['futureContracts'], 'price': values['price'],
            'cash_amount': values['cashAmount'], 'fees': values['fees'],
            'external_ref': (f'{event["src"]["ns"]}:{event["src"]["ref"]}' if event.get('src') else None),
            'contract_id': values['contractRef']['contractId'] if values['contractRef'] else None,
            'delivered_contract_id': (values['deliveredContractRef']['contractId']
                                      if values.get('deliveredContractRef') else None),
            'open_close': values['openClose'], 'order_evidence': time['orderEvidence'],
            'executed_at_utc': time['executedAtUtc'],
            'time_range_start_utc': time['timeRange']['startUtc'] if time['timeRange'] else None,
            'time_range_end_utc': time['timeRange']['endUtc'] if time['timeRange'] else None,
            'baseline_as_of_utc': values['baselineAsOfUtc'],
        })
    return rows


def write_through_store(vector, db_path):
    """Rebuild a temporary ledger from the vector, add its boundaries, export its graph.

    Returns (ledger, graph, ids): ids maps vector event ids to stored ids.
    """
    ledger = FopLedger(db_path, history_scope=vector.get('historyScope', 'full_history'))
    store = ledger.store
    plan = store.reset_confirmation(ledger.book_id)
    store.rebuild_fop_book(
        ledger.book_id, store_package(vector, store, ledger.book_id), confirmation=plan['phrase'],
        client_token=token(), import_batch_id=token('batch'), expected_ledger_version=plan['ledgerVersion'],
        book_identity=dict(IDENTITY))
    ids = map_ids(vector, store.export_backup(ledger.book_id)['payload'])
    for boundary in vector.get('boundaries', []):
        store.commit_fop_metadata(
            ledger.book_id, {'kind': 'close_cycle', 'boundaryId': boundary['id'],
                             'anchorEventId': ids[boundary['anchor']], 'label': ''},
            client_token=token(), expected_ledger_version=ledger.version(), book_identity=dict(IDENTITY),
            engine_version=1)
    return ledger, store.export_backup(ledger.book_id)['payload'], ids


def map_ids(vector, payload):
    vector = with_catalogue(vector)

    def fingerprint(kind, contract, contracts, future_contracts, price, cash, time):
        return (kind, contract, contracts, future_contracts, None if price is None else float(price),
                round(float(cash), 9), time['executedAtUtc'],
                json.dumps(time['timeRange'], sort_keys=True))

    stored = {}
    for item in payload['events']:
        row = item['row']
        key = fingerprint(row['kind'], (row['fop']['contractRef'] or {}).get('contractId'), row['contracts'],
                          row['futureContracts'], row['price'], row['cashAmount'], row['fop']['time'])
        stored.setdefault(key, []).append(row['eventId'])
    ids = {}
    for event in vector['events']:
        values = event_values(vector, event)
        key = fingerprint(event['kind'], (values['contractRef'] or {}).get('contractId'), values['contracts'],
                          values['futureContracts'], values['price'], values['cashAmount'], values['time'])
        ids[event['id']] = stored[key].pop(0)
    return ids


def comparable(output):
    """The figures of a core output without event ids."""
    output = copy.deepcopy(output)
    output.pop('roll')

    def strip(value):
        if isinstance(value, dict):
            return {k: (v.split(':')[0] if k == 'reason' and isinstance(v, str) else strip(v))
                    for k, v in value.items()}
        if isinstance(value, list):
            return [strip(v) for v in value]
        return value

    return strip(output)


class _BridgeCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bridge = Bridge()

    @classmethod
    def tearDownClass(cls):
        cls.bridge.close()

    def assert_matches_model(self, vector, output, label):
        expected = model.ledger(with_catalogue(vector), marks=vector.get('marks'), as_of=vector.get('asOf'))
        for field, value in expected['totals'].items():
            self.assertTrue(close_to(value, output['totals'][field]['value'], field),
                            f'{label}: totals.{field} {output["totals"][field]} != {value}')
        for field in ('Rs', 'Es', 'Js', 'breakEven', 'breakEvenIfOpenShortsExpire'):
            self.assertTrue(close_to(expected['sellerLens'][field], output['sellerLens'][field]['value'], field),
                            f'{label}: sellerLens.{field} {output["sellerLens"][field]} != '
                            f'{expected["sellerLens"][field]}')
        self.assertEqual(output['sellerLens']['longExerciseAffectsBreakEven'],
                         expected['sellerLens']['longExerciseAffectsBreakEven'], label)
        specs = with_catalogue(vector)['contracts']
        listed = {row['contractId']: row for row in output['futures'] + output['options']}
        self.assertEqual(sorted(listed), sorted(specs[alias]['contractId'] for alias in expected['positions']),
                         label)
        for alias, fields in expected['positions'].items():
            row = listed[specs[alias]['contractId']]
            for field, value in fields.items():
                self.assertTrue(close_to(value, row[field]['value'], field), f'{label}: {alias}.{field}')
        realized = {row['contractId']: row['realized']['value'] for row in output['realizedByContract']}
        self.assertEqual(sorted(realized), sorted(specs[alias]['contractId'] for alias in expected['realized']),
                         label)
        for alias, value in expected['realized'].items():
            self.assertTrue(close_to(value, realized[specs[alias]['contractId']], 'realized'), label)
        self.assertEqual(len(output['cycles']), len(expected['cycles']), label)
        for index, cycle in enumerate(expected['cycles']):
            for field, value in cycle.items():
                self.assertTrue(close_to(value, output['cycles'][index]['totals'][field]['value'], field),
                                f'{label}: cycle {index} {field}')
        if vector.get('historyScope') == 'since_baseline':
            self.assertTrue(close_to(expected['openingValue'], output['scope']['openingValue']['value'],
                                     'openingValue'), label)
        for field, value in expected['unattributed'].items():
            self.assertTrue(close_to(value, output['unattributed'][field]['value'], field),
                            f'{label}: unattributed.{field}')


class ModelTests(unittest.TestCase):
    """The rational model reproduces every hand-worked number."""

    def test_the_model_reproduces_every_hand_worked_vector(self):
        replayed = 0
        for vector in VECTORS['vectors']:
            if vector.get('model') is False:
                continue
            replayed += 1
            with self.subTest(vector['name']):
                out = model.ledger(with_catalogue(vector), marks=vector.get('marks'), as_of=vector.get('asOf'))
                expect = vector['expect']
                for field, value in expect.get('totals', {}).items():
                    self.assertTrue(equal(value, out['totals'][field]), f'totals.{field}')
                for field, value in expect.get('sellerLens', {}).items():
                    actual = out['sellerLens'][field]
                    if isinstance(value, bool):
                        self.assertEqual(actual, value, field)
                    else:
                        self.assertTrue(equal(value, actual), f'sellerLens.{field}: {actual}')
                if 'positions' in expect:
                    self.assertEqual(set(expect['positions']), set(out['positions']))
                    for alias, fields in expect['positions'].items():
                        for field, value in fields.items():
                            self.assertTrue(equal(value, out['positions'][alias][field]), f'{alias}.{field}')
                if 'realized' in expect:
                    self.assertEqual(set(expect['realized']), set(out['realized']))
                    for alias, value in expect['realized'].items():
                        self.assertTrue(equal(value, out['realized'][alias]), alias)
                for index, cycle in enumerate(expect.get('cycles', [])):
                    for field, value in cycle.items():
                        self.assertTrue(equal(value, out['cycles'][index][field]), f'cycle {index} {field}')
                if 'openingValue' in expect:
                    self.assertTrue(equal(expect['openingValue'], out['openingValue']))
                for field, value in expect.get('unattributed', {}).items():
                    self.assertTrue(equal(value, out['unattributed'][field]), f'unattributed.{field}')
                steps = {step['after']: step for step in out['steps']}
                for step in expect.get('steps', []):
                    actual = steps[step['after']]
                    for field, value in step.items():
                        if field == 'after':
                            continue
                        if field == 'positions':
                            self.assertEqual(set(value), set(actual['positions']), step['after'])
                            for alias, (contracts, second) in value.items():
                                self.assertEqual(actual['positions'][alias][0], contracts)
                                self.assertTrue(equal(second, actual['positions'][alias][1]), alias)
                        else:
                            self.assertTrue(equal(value, actual[field]), f'{step["after"]} {field}')
        self.assertGreaterEqual(replayed, 45)


class TimelineTests(unittest.TestCase):
    """The server orders every vector as the JS core does, and refuses the same ones."""

    def test_the_server_timeline_agrees_with_every_vector(self):
        for vector in VECTORS['vectors']:
            expect = vector['expect']
            with self.subTest(vector['name']):
                rows = timeline_rows(vector)
                if expect.get('ambiguous'):
                    with self.assertRaises(domain.FopDomainError) as caught:
                        domain.build_timeline(rows)
                    self.assertEqual(caught.exception.code, 'fop_ordering_ambiguous')
                    continue
                timeline = domain.build_timeline(rows)
                if 'order' in expect:
                    self.assertEqual(timeline.order, expect['order'])
                if 'groups' in expect:
                    groups = [list(group) for group in dict.fromkeys(timeline.group_of.values())
                              if len(group) > 1]
                    self.assertEqual(groups, expect['groups'])
                final = timeline.after[timeline.order[-1]]
                if vector.get('model') is not False and not vector.get('asOf'):
                    positions = model.ledger(with_catalogue(vector), marks=vector.get('marks'))['positions']
                    specs = with_catalogue(vector)['contracts']
                    expected = {(specs[alias]['secType'], specs[alias]['contractId']): fields['contracts']
                                for alias, fields in positions.items()}
                    self.assertEqual({key: int(value) for key, value in final.items()}, expected)
                anchors = expect.get('boundaryAnchors', {})
                for anchor in anchors.get('valid', []):
                    domain.check_cycle_anchors([{'boundary_id': 'b', 'anchor_event_id': anchor}], timeline)
                for together in anchors.get('refusedTogether', []):
                    with self.assertRaises(domain.FopDomainError) as caught:
                        domain.check_cycle_anchors([{'boundary_id': f'b{index}', 'anchor_event_id': anchor}
                                                    for index, anchor in enumerate(together)], timeline)
                    self.assertEqual(caught.exception.code, 'fop_cycle_boundary_violated')

    def test_evidence_decides_only_where_order_matters_and_seq_never_does(self):
        vector = next(v for v in VECTORS['vectors'] if v['name'].endswith('bought first by evidence'))
        rows = timeline_rows(vector)
        for index, row in enumerate(reversed(rows)):
            row['seq'] = index + 1  # entry order is not evidence
        self.assertEqual(domain.build_timeline(rows).order, ['e1', 'e2', 'e3'])
        mixed = timeline_rows(vector)
        mixed[2]['order_evidence'] = 'another-scope#2'
        with self.assertRaises(domain.FopDomainError, msg='two scopes order nothing'):
            domain.build_timeline(mixed)
        duplicate = timeline_rows(vector)
        duplicate[2]['order_evidence'] = duplicate[1]['order_evidence']
        with self.assertRaises(domain.FopDomainError, msg='one sequence twice orders nothing'):
            domain.build_timeline(duplicate)

    def test_a_baseline_belongs_to_one_instant_before_everything_else(self):
        vector = next(v for v in VECTORS['vectors'] if v['name'] == 'F42 the change since B')
        rows = timeline_rows(vector)
        self.assertEqual(domain.check_baseline(rows, 'since_baseline'), '2026-10-01T21:00:00.000000Z')
        with self.assertRaises(domain.FopDomainError, msg='a full-history ledger has no baseline'):
            domain.check_baseline(rows, 'full_history')
        other = copy.deepcopy(rows)
        other[1]['baseline_as_of_utc'] = '2026-10-02T21:00:00.000000Z'
        with self.assertRaises(domain.FopDomainError, msg='one baseline instant'):
            domain.check_baseline(other, 'since_baseline')
        early = copy.deepcopy(rows) + [dict(rows[0], event_id='early', kind='futures_trade',
                                            executed_at_utc='2026-10-01T20:00:00.000000Z')]
        with self.assertRaises(domain.FopDomainError, msg='nothing before the baseline'):
            domain.check_baseline(early, 'since_baseline')
        # An opening balance happens at the B it states: an as-of view at B holds it.
        later = copy.deepcopy(rows)
        later[1]['executed_at_utc'] = '2026-10-02T21:00:00.000000Z'
        with self.assertRaises(domain.FopDomainError, msg='an opening balance is timed at B'):
            domain.check_baseline(later, 'since_baseline')
        ranged = copy.deepcopy(rows)
        ranged[0].update(executed_at_utc=None, time_range_start_utc='2026-10-01T00:00:00.000000Z',
                         time_range_end_utc='2026-10-01T21:00:00.000000Z')
        with self.assertRaises(domain.FopDomainError, msg='an opening balance is an instant'):
            domain.check_baseline(ranged, 'since_baseline')

    def test_order_evidence_cannot_contradict_the_times(self):
        vector = next(v for v in VECTORS['vectors'] if v['name'].startswith('§9.2 evidence that contradicts'))
        with self.assertRaises(domain.FopDomainError) as caught:
            domain.build_timeline(timeline_rows(vector))
        self.assertEqual(caught.exception.code, 'fop_ordering_ambiguous')
        self.assertIn('e4 before e3', str(caught.exception))
        # The same sequence in an order the times allow is evidence.
        rows = timeline_rows(vector)
        for row, sequence in zip(rows[1:], (1, 2, 3)):
            row['order_evidence'] = f'tws-20261002#{sequence}'
        self.assertEqual(domain.build_timeline(rows).order, ['e1', 'e2', 'e3', 'e4'])


class StoreChainTests(_BridgeCase):
    """Vector -> real store -> exported graph -> JS core equals the model (§14.2 chain)."""

    def test_every_vector_through_the_store_replays_to_the_model(self):
        with tempfile.TemporaryDirectory() as directory:
            for index, vector in enumerate(VECTORS['vectors']):
                if vector['expect'].get('ambiguous'):
                    continue
                with self.subTest(vector['name']):
                    ledger, graph, _ids = write_through_store(vector, pathlib.Path(directory) / f'{index}.db')
                    options = {**core_options(vector), 'marks': marks_by_id(vector)}
                    stored = self.bridge.compute({'graph': graph, 'options': options})
                    built = self.bridge.compute({'vector': vector, 'catalogue': CATALOGUE,
                                                 'options': core_options(vector)})
                    self.assertEqual(comparable(stored), comparable(built),
                                     'the builder graph and the stored graph replay alike')
                    if vector.get('model') is not False:
                        self.assert_matches_model(vector, stored, vector['name'])

    def test_the_server_refuses_what_no_evidence_orders(self):
        with tempfile.TemporaryDirectory() as directory:
            for index, vector in enumerate(v for v in VECTORS['vectors'] if v['expect'].get('ambiguous')):
                with self.subTest(vector['name']):
                    ledger = FopLedger(pathlib.Path(directory) / f'{index}.db')
                    plan = ledger.store.reset_confirmation(ledger.book_id)
                    with self.assertRaises(FopOrderingAmbiguousError):
                        ledger.store.rebuild_fop_book(
                            ledger.book_id, store_package(vector, ledger.store, ledger.book_id),
                            confirmation=plan['phrase'], client_token=token(), import_batch_id=token('batch'),
                            expected_ledger_version=plan['ledgerVersion'], book_identity=dict(IDENTITY))
                    self.assertEqual(ledger.events(), [])

    def test_a_boundary_inside_a_group_goes_after_the_whole_group(self):
        vector = next(v for v in VECTORS['vectors'] if v['name'].startswith('F41 a boundary after a group'))
        with tempfile.TemporaryDirectory() as directory:
            outputs = []
            for anchor in ('e1', 'e2'):
                ledger, graph, ids = write_through_store(
                    dict(vector, boundaries=[{'id': 'cycle-000000001', 'anchor': anchor}]),
                    pathlib.Path(directory) / f'{anchor}.db')
                outputs.append(comparable(self.bridge.compute({'graph': graph, 'options': {
                    'marks': marks_by_id(vector)}})))
                other = ids['e2' if anchor == 'e1' else 'e1']
                with self.assertRaises(FopCycleBoundaryViolatedError, msg='one group closes one cycle'):
                    ledger.store.commit_fop_metadata(
                        ledger.book_id, {'kind': 'close_cycle', 'boundaryId': 'cycle-000000002',
                                         'anchorEventId': other, 'label': ''},
                        client_token=token(), expected_ledger_version=ledger.version(),
                        book_identity=dict(IDENTITY), engine_version=1)
            self.assertEqual(outputs[0], outputs[1], 'either member anchors "after the whole group"')

    def test_a_backup_restores_into_another_ledger_whatever_ids_it_gets(self):
        # Review P1: the two closes' stable keys differ only in the event id.
        # Restored with new ids in both relative orders, the boundary on e3
        # stays after both closes and the figures stay as they were.
        vector = next(v for v in VECTORS['vectors'] if v['name'].startswith('F41 two months closed together'))
        specs = with_catalogue(vector)['contracts']
        by_symbol = {specs[alias]['localSymbol']: price for alias, price in vector['marks'].items()}

        def figures(payload):
            # Contract and boundary ids are new after the restore; marks go by symbol.
            marks = {c['record']['contractId']: by_symbol[c['record']['localSymbol']]
                     for c in payload['contracts'] if c['record']['localSymbol'] in by_symbol}
            output = self.bridge.compute({'graph': payload, 'options': {'marks': marks}})
            return ([cycle['totals'] for cycle in output['cycles']], output['totals'], output['sellerLens'],
                    output['unattributed'])

        with tempfile.TemporaryDirectory() as directory:
            ledger, graph, ids = write_through_store(vector, pathlib.Path(directory) / 'tie.db')
            store = ledger.store
            before = figures(graph)
            self.assertEqual(before[0][0]['economicPnl']['value'], 4000)
            backup = store.export_backup(ledger.book_id)
            store.archive_book(ledger.book_id)
            anchor_is_largest = set()
            for step in (1, -1):
                counter = iter(range(10 ** 6, 2 * 10 ** 6) if step > 0 else range(2 * 10 ** 6, 10 ** 6, -1))
                other = store.create_fop_book(account=IDENTITY['account'], symbol='CL', start_date='2026-01-01',
                                              fop=dict(FOP_META))
                plan = store.reset_confirmation(other['bookId'])
                with mock.patch.object(cost_basis_fop_store.uuid, 'uuid4',
                                       side_effect=lambda: uuid.UUID(int=next(counter))):
                    result = store.restore_backup(
                        other['bookId'], backup, confirmation=plan['phrase'], client_token=token(),
                        expected_ledger_version=plan['ledgerVersion'], book_identity=dict(IDENTITY),
                        engine_version=1)
                self.assertTrue(result['remapped'])
                restored = store.export_backup(other['bookId'])['payload']
                [cycle] = restored['cycles']
                closes = sorted(e['row']['eventId'] for e in restored['events']
                                if e['row']['kind'] == 'futures_trade' and e['row']['futureContracts'] == -1)
                anchor_is_largest.add(cycle['anchorEventId'] == closes[-1])
                self.assertEqual(figures(restored), before)
                store.archive_book(other['bookId'])
            self.assertEqual(anchor_is_largest, {True, False}, 'both id orders were restored')

    def test_the_event_listing_pages_the_economic_order(self):
        # Review P2: entry order (seq) is not the order; the whole order is cut into pages.
        vector = {
            'name': 'listing', 'expect': {}, 'events': [
                {'id': 'e3', 'at': '2026-10-02T14:00:00Z', 'kind': 'futures_trade', 'contract': 'Z6', 'q': 1,
                 'price': 80, 'evidence': 'tws-20261002#2'},
                {'id': 'e2', 'at': '2026-10-02T14:00:00Z', 'kind': 'futures_trade', 'contract': 'Z6', 'q': -1,
                 'price': 75, 'evidence': 'tws-20261002#1'},
                {'id': 'e1', 'at': '2026-10-01T15:00:00Z', 'kind': 'futures_trade', 'contract': 'Z6', 'q': 1,
                 'price': 71},
                {'id': 'e0', 'at': '2026-10-01T14:00:00Z', 'kind': 'futures_trade', 'contract': 'Z6', 'q': 1,
                 'price': 70},
            ]}
        with tempfile.TemporaryDirectory() as directory:
            ledger, _graph, ids = write_through_store(vector, pathlib.Path(directory) / 'listing.db')
            name = {stored: alias for alias, stored in ids.items()}
            store = ledger.store

            def listed(**query):
                page = store.list_events(ledger.book_id, **query)
                return page['total'], [name[event['eventId']] for event in page['events']]

            self.assertEqual(listed(), (4, ['e0', 'e1', 'e2', 'e3']))
            self.assertEqual([alias for offset in range(4) for alias in listed(limit=1, offset=offset)[1]],
                             ['e0', 'e1', 'e2', 'e3'])
            ledger.void(ids['e1'])
            self.assertEqual(listed(), (3, ['e0', 'e2', 'e3']))
            self.assertEqual(listed(include_voided=True), (4, ['e0', 'e1', 'e2', 'e3']),
                             'a voided event keeps its place in time')
            self.assertEqual(listed(include_voided=True, limit=2, offset=1), (4, ['e1', 'e2']))

    def test_an_opening_balance_is_timed_at_its_baseline_instant(self):
        # Review P2: B = 10-01 with the balance on 10-02 left an as-of view at B empty.
        vector = next(v for v in VECTORS['vectors'] if v['name'] == 'F42 the change since B')
        late = copy.deepcopy(vector)
        late['events'][1]['at'] = '2026-10-02T21:00:00Z'
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(InvalidRequestError) as caught:
                write_through_store(late, pathlib.Path(directory) / 'late.db')
            self.assertIn('executed at its baseline instant', str(caught.exception))

    def test_metadata_revisions_leave_every_figure_as_it_was(self):
        vector = next(v for v in VECTORS['vectors'] if v['name'] == '§5.4 old-month call assigned after the roll')
        with tempfile.TemporaryDirectory() as directory:
            ledger, graph, ids = write_through_store(vector, pathlib.Path(directory) / 'revised.db')
            options = {'marks': marks_by_id(vector)}
            before = self.bridge.compute({'graph': graph, 'options': options})
            store = ledger.store
            [record] = [c['record'] for c in graph['contracts'] if c['record']['contractId'] == 'fut-clz6-0001']
            affected = [{'eventId': ids[event_id], 'reference': reference,
                         'before': {'id': 'fut-clz6-0001', 'revision': 1},
                         'after': {'id': 'fut-clz6-0001', 'revision': 2}}
                        for event_id, reference in (('e1', 'contract'), ('e3', 'contract'),
                                                    ('e5', 'delivered_contract'))]
            store.commit_fop_metadata(
                ledger.book_id, {'kind': 'correct_contract', 'contract': dict(record, revision=2,
                                                                             futureLastTradeAsOf=OBSERVED),
                                 'affected': affected},
                client_token=token(), expected_ledger_version=ledger.version(), book_identity=dict(IDENTITY),
                engine_version=1)
            after = self.bridge.compute({'graph': store.export_backup(ledger.book_id)['payload'],
                                         'options': options})
            self.assertEqual(comparable(after), comparable(before))


class RandomHistoryTests(_BridgeCase):
    """Random histories: the model and the core agree, also after the store."""

    FUTURES = ('Z6', 'F7', 'G7')
    OPTIONS = ('C75', 'P65')

    def history(self, rng, steps):
        events = []
        futures = {alias: 0 for alias in self.FUTURES}
        options = {alias: 0 for alias in self.OPTIONS}
        clock = 0

        def at():
            nonlocal clock
            clock += rng.randint(1, 5000)
            return f'2026-10-{1 + clock // 86400:02d}T{(clock // 3600) % 24:02d}:{(clock // 60) % 60:02d}:{clock % 60:02d}Z'

        for index in range(steps):
            name = f'r{index:03d}'
            choice = rng.random()
            price = lambda low, high: round(rng.uniform(low, high), 2)  # noqa: E731
            if choice < 0.45:
                alias = rng.choice(self.FUTURES)
                quantity = rng.choice([-3, -2, -1, 1, 2, 3])
                events.append({'id': name, 'at': at(), 'kind': 'futures_trade', 'contract': alias,
                               'q': quantity, 'price': price(-5, 90), 'fees': rng.choice([0, 1.25, 2.02])})
                futures[alias] += quantity
            elif choice < 0.70:
                alias = rng.choice(self.OPTIONS)
                quantity = rng.choice([-2, -1, 1, 2])
                events.append({'id': name, 'at': at(), 'kind': 'option_trade', 'contract': alias,
                               'q': quantity, 'price': price(0, 4), 'fees': rng.choice([0, 2.5])})
                options[alias] += quantity
            elif choice < 0.82:
                open_options = [alias for alias, n in options.items() if n]
                if not open_options:
                    continue
                alias = rng.choice(open_options)
                n = options[alias]
                closing = -n if rng.random() < 0.6 else (1 if n < 0 else -1)
                kind = 'option_expiry'
                if rng.random() < 0.6:
                    kind = 'option_assignment' if n < 0 else 'option_exercise'
                events.append({'id': name, 'at': at(), 'kind': kind, 'contract': alias, 'q': closing,
                               'fees': rng.choice([0, 1.5])})
                options[alias] += closing
                if kind != 'option_expiry':
                    right = CATALOGUE[alias]['right']
                    sign = (-1 if right == 'C' else 1) if closing > 0 else (1 if right == 'C' else -1)
                    futures['Z6'] += sign * abs(closing)
            elif choice < 0.94:
                trades = [event['id'] for event in events if event['kind'] != 'fee']
                refund = rng.random() < 0.2
                fee = {'id': name, 'at': at(), 'kind': 'fee', 'cash': (1 if refund else -1) * rng.choice([1, 3.5, 10]),
                       'category': rng.choice(['futures', 'short_option', 'long_option', 'strategy']),
                       'refund': refund, 'includeInCost': rng.random() < 0.9}
                if trades and rng.random() < 0.5:
                    fee['feeSource'] = rng.choice(trades)
                events.append(fee)
            else:
                events.append({'id': name, 'at': at(), 'kind': 'manual_adjust', 'cash': rng.choice([-20, 15.5, 40]),
                               'scope': rng.choice(['strategy', 'seller_lens']),
                               'includeInCost': rng.random() < 0.9})
        marks = {alias: price for alias, price in (
            *((alias, round(rng.uniform(-5, 90), 2)) for alias in self.FUTURES),
            *((alias, round(rng.uniform(0, 5), 2)) for alias in self.OPTIONS)) if rng.random() < 0.9}
        return {'name': f'random {rng.random():.6f}', 'events': events, 'marks': marks, 'expect': {}}

    def test_random_histories_agree_with_the_model(self):
        rng = random.Random(20260924)
        for case in range(150):
            vector = self.history(rng, rng.randint(5, 30))
            with self.subTest(case=case):
                output = self.bridge.compute({'vector': vector, 'catalogue': CATALOGUE, 'options': {}})
                self.assert_matches_model(vector, output, f'random case {case}')

    def test_random_as_of_views_are_sound(self):
        # Review P1: at an as-of instant a known figure must hold whatever the
        # unresolved events turn out to be. Every event carries the broker
        # sequence it was made in (its list position), and a time range, when
        # it has one, starts at its real time: so what has happened by the
        # instant is a prefix of the sequence that holds everything that has
        # ended and nothing that has not started. The model replays each such
        # prefix on its own; a figure the core states must equal it in all.
        rng = random.Random(918)
        views = known = 0
        for case in range(150):
            vector = self.history(rng, rng.randint(5, 25))
            events = vector['events']
            for index, event in enumerate(events):
                event['evidence'] = f'rnd#{index + 1}'
                if rng.random() < 0.35:
                    start = event.pop('at')
                    event['range'] = [start, _shifted(start, rng.randint(1, 20000))]
            spans = [model.interval(event) for event in events]
            for _probe in range(3):
                start, end = rng.choice(spans)
                cut = model.instant(_shifted(start, rng.randint(0, 20000)))
                must = max((i + 1 for i, (_s, e) in enumerate(spans) if e <= cut), default=0)
                can = min((i for i, (s, _e) in enumerate(spans) if s > cut), default=len(events))
                output = self.bridge.compute({'vector': vector, 'catalogue': CATALOGUE,
                                              'options': {'asOf': cut}})
                with self.subTest(case=case, as_of=cut):
                    self.assertLessEqual(must, can)
                    for size in range(must, can + 1):
                        world = model.ledger(with_catalogue(dict(vector, events=events[:size])),
                                             marks=vector.get('marks'))
                        known += self.assert_sound(output, world, vector, f'case {case} {cut} world {size}')
                views += 1
        self.assertEqual(views, 450)
        self.assertGreater(known, 5000, 'the views state figures, not only unknowns')

    def assert_sound(self, output, world, vector, label):
        """Every figure the core states equals the model's in this world; returns how many."""
        count = 0

        def same(metric, value, field, name):
            nonlocal count
            if metric['reason'] is not None:
                return
            count += 1
            self.assertTrue(close_to(value, metric['value'], field), f'{label}: {name} {metric} vs {value}')

        for field, value in world['totals'].items():
            same(output['totals'][field], value, field, f'totals.{field}')
        for field in ('Rs', 'Es', 'Js', 'breakEven', 'breakEvenIfOpenShortsExpire'):
            same(output['sellerLens'][field], world['sellerLens'][field], field, f'sellerLens.{field}')
        alias_of = {spec['contractId']: alias for alias, spec in CATALOGUE.items()}
        rows = {alias_of[row['contractId']]: row for row in output['futures'] + output['options']}
        for alias in set(rows) | set(world['positions']):
            position = world['positions'].get(alias)
            row = rows.get(alias)
            if row is None:
                self.assertIsNone(position, f'{label}: the core has {alias} flat')
                continue
            same(row['contracts'], position['contracts'] if position else 0, 'contracts', f'{alias}.contracts')
            for field in ('averagePrice', 'remainingNetPremium'):
                if field in row and position is not None:
                    same(row[field], position[field], field, f'{alias}.{field}')
        for row in output['realizedByContract']:
            alias = alias_of[row['contractId']]
            same(row['realized'], world['realized'].get(alias, 0), 'realized', f'realized {alias}')
        return count

    def test_random_histories_through_the_store_agree_with_the_model(self):
        rng = random.Random(3)
        with tempfile.TemporaryDirectory() as directory:
            for case in range(20):
                vector = self.history(rng, rng.randint(5, 25))
                with self.subTest(case=case):
                    _ledger, graph, _ids = write_through_store(vector, pathlib.Path(directory) / f'{case}.db')
                    output = self.bridge.compute({'graph': graph, 'options': {'marks': marks_by_id(vector)}})
                    self.assert_matches_model(vector, output, f'random store case {case}')


if __name__ == '__main__':
    unittest.main()
