"""P1 contract: the frozen structure and protocol of the standalone FOP ledger.

CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §8.1, §8.2 item 7, §13.3 P1. These
tests prove the P1 contract files are consistent with each other and with the
code that exists today; they do not implement the P2 migration or the FOP
domain.

- contract/ddl_draft.sql applies to a real v10 ledger on a connection with
  foreign keys on, following its own run order, and leaves every stock row as
  it was; its constraints refuse what the plan refuses.
- contract/event_columns.json and event_kinds.json decide every column and
  every kind of cost_basis_events; write_coverage.json classifies every
  protocol action and every guarded store write.
- contract/protocol.json and core_output.json examples pass or fail exactly as
  stated, in this Python reader and in the independent JS reader
  (tests/helpers/fop-contract-schema.js), and both readers agree error for error.
- A ledger's type is stated, never defaulted (plan §1.1).
"""
import configparser
import inspect
import json
import math
import pathlib
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import cost_basis_store  # noqa: E402
from cost_basis_store import CostBasisStore, EVENT_KINDS, SCHEMA_USER_VERSION  # noqa: E402
from cost_basis_ws import SERVER_ACTIONS, create_store_env, handle_cost_basis_action  # noqa: E402

CONTRACT = REPO_ROOT / 'tests' / 'fixtures' / 'cost_basis_fop' / 'contract'
JS_READER = REPO_ROOT / 'tests' / 'helpers' / 'fop-contract-schema.js'
ACCOUNT = 'U1111111'


def _load(name):
    return json.loads((CONTRACT / name).read_text(encoding='utf-8'))


# ----------------------------------------------------------------------
# The Python reader of the contract schema language (protocol.json,
# "schemaLanguage"). Written independently of the JS reader on purpose.
# ----------------------------------------------------------------------

def _same(left, right):
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if left is None or right is None:
        return left is right
    return left == right


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _present(value, field):
    return field in value and value[field] is not None


class ContractReader:
    def __init__(self, types):
        self.types = types
        self._patterns = {}

    def _resolve(self, spec):
        seen = set()
        while 'ref' in spec:
            name = spec['ref']
            if name in seen or name not in self.types:
                raise KeyError(f'unknown or circular type {name}')
            seen.add(name)
            spec = self.types[name]
        return spec

    def _nullable(self, spec):
        while True:
            if spec.get('nullable') is True:
                return True
            if 'ref' not in spec:
                return False
            spec = self.types[spec['ref']]

    def _pattern(self, pattern):
        if pattern not in self._patterns:
            # JS '$' only matches at the very end; Python's also before a
            # final newline. '\Z' gives the JS meaning.
            text = pattern[:-1] + r'\Z' if pattern.endswith('$') else pattern
            self._patterns[pattern] = re.compile(text, re.ASCII)
        return self._patterns[pattern]

    def check(self, type_name, value):
        if type_name not in self.types:
            raise KeyError(type_name)
        errors = []
        self._check({'ref': type_name}, value, '', errors)
        return errors

    def _check(self, spec, value, path, errors):
        resolved = self._resolve(spec)
        kind = resolved['type']
        if kind == 'json':
            return
        if kind == 'const':
            if not _same(value, resolved['value']):
                errors.append((path, 'const'))
            return
        if value is None:
            if not self._nullable(spec):
                errors.append((path, 'null'))
            return
        if kind == 'string':
            if not isinstance(value, str):
                errors.append((path, 'type'))
                return
            if 'enum' in resolved and value not in resolved['enum']:
                errors.append((path, 'enum'))
            if 'pattern' in resolved and not self._pattern(resolved['pattern']).search(value):
                errors.append((path, 'pattern'))
            if 'minLength' in resolved and len(value) < resolved['minLength']:
                errors.append((path, 'minLength'))
            return
        if kind in ('integer', 'number'):
            integral = _is_number(value) and float(value).is_integer()
            if not _is_number(value) or (kind == 'integer' and not integral):
                errors.append((path, 'type'))
                return
            if 'min' in resolved and value < resolved['min']:
                errors.append((path, 'min'))
            if 'exclusiveMin' in resolved and value <= resolved['exclusiveMin']:
                errors.append((path, 'min'))
            if 'max' in resolved and value > resolved['max']:
                errors.append((path, 'max'))
            if resolved.get('nonzero') and value == 0:
                errors.append((path, 'nonzero'))
            return
        if kind == 'boolean':
            if not isinstance(value, bool):
                errors.append((path, 'type'))
            return
        if kind == 'array':
            if not isinstance(value, list):
                errors.append((path, 'type'))
                return
            if 'minItems' in resolved and len(value) < resolved['minItems']:
                errors.append((path, 'minItems'))
            if 'maxItems' in resolved and len(value) > resolved['maxItems']:
                errors.append((path, 'maxItems'))
            for index, item in enumerate(value):
                self._check(resolved['items'], item, f'{path}[{index}]', errors)
            return
        if kind == 'map':
            if not isinstance(value, dict):
                errors.append((path, 'type'))
                return
            if 'minEntries' in resolved and len(value) < resolved['minEntries']:
                errors.append((path, 'minEntries'))
            for key, item in value.items():
                self._check(resolved['values'], item, self._join(path, key), errors)
            return
        if kind == 'variant':
            if not isinstance(value, dict):
                errors.append((path, 'type'))
                return
            key = value.get(resolved['on'])
            case = resolved['cases'].get(key) if isinstance(key, str) else None
            if case is None:
                errors.append((self._join(path, resolved['on']), 'variant'))
                return
            self._check(case, value, path, errors)
            return
        if kind == 'object':
            self._check_object(resolved, value, path, errors)
            return
        raise ValueError(f'unknown spec type {kind}')

    @staticmethod
    def _join(path, key):
        return f'{path}.{key}' if path else key

    def _check_object(self, spec, value, path, errors):
        if not isinstance(value, dict):
            errors.append((path, 'type'))
            return
        fields = spec['fields']
        for key in value:
            if key not in fields:
                errors.append((self._join(path, key), 'additional'))
        for key in spec.get('required', []):
            if key not in value:
                errors.append((self._join(path, key), 'missing'))
        for key, field_spec in fields.items():
            if key in value:
                self._check(field_spec, value[key], self._join(path, key), errors)
        for rule in spec.get('rules', []):
            if not self._rule_holds(rule, value, spec):
                errors.append((path, f"rule:{rule['id']}"))

    def _well_formed(self, spec, value):
        errors = []
        self._check(spec, value, '', errors)
        return not errors

    def _rule_holds(self, rule, value, spec):
        when = rule.get('when')
        if when is not None:
            if when['field'] not in value:
                return True
            if not any(_same(value[when['field']], option) for option in when['in']):
                return True
        if 'require' in rule and not all(_present(value, field) for field in rule['require']):
            return False
        if 'forbid' in rule and any(_present(value, field) for field in rule['forbid']):
            return False
        for field, sign in rule.get('sign', {}).items():
            number = value.get(field)
            if _is_number(number) and not (number > 0 if sign == 'positive' else number < 0):
                return False
        if 'exactlyOne' in rule:
            if sum(1 for field in rule['exactlyOne'] if _present(value, field)) != 1:
                return False
        if 'equals' in rule:
            left = value.get(rule['equals']['field'])
            right = value.get(rule['equals']['negate'])
            if _is_number(left) and _is_number(right) and abs(left + right) > 1e-9:
                return False
        if 'lessOrEqual' in rule:
            first, second = rule['lessOrEqual']
            if (_present(value, first) and _present(value, second)
                    and self._well_formed(spec['fields'][first], value[first])
                    and self._well_formed(spec['fields'][second], value[second])
                    and value[first] > value[second]):
                return False
        return True


# ----------------------------------------------------------------------
# DDL
# ----------------------------------------------------------------------

def _ddl_statements():
    text = (CONTRACT / 'ddl_draft.sql').read_text(encoding='utf-8')
    body = '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('--'))
    return [statement.strip() for statement in re.split(r';\s*\n', body + '\n') if statement.strip()]


def _apply_ddl(conn):
    """The run order written at the top of ddl_draft.sql."""
    conn.execute('PRAGMA foreign_keys = OFF')
    try:
        conn.execute('BEGIN IMMEDIATE')
        try:
            for statement in _ddl_statements():
                conn.execute(statement)
            violations = conn.execute('PRAGMA foreign_key_check').fetchall()
            if violations:
                raise AssertionError(f'foreign key violations: {violations}')
            conn.execute('COMMIT')
        except BaseException:
            conn.execute('ROLLBACK')
            raise
    finally:
        conn.execute('PRAGMA foreign_keys = ON')


def _rows(conn, table):
    conn.row_factory = sqlite3.Row
    try:
        return sorted(tuple(sorted(dict(row).items())) for row in conn.execute(f'SELECT * FROM "{table}"'))
    finally:
        conn.row_factory = None


class DdlDraftTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = pathlib.Path(self._tmp.name) / 'cost_basis.db'
        store = CostBasisStore(self.db_path).initialize()
        book = store.create_book(account=ACCOUNT, symbol='TQQQ', start_date='2026-01-01')
        self.stock_book_id = book['bookId']
        store.append_event(self.stock_book_id, {
            'kind': 'share_trade', 'tradeDate': '2026-06-01', 'account': ACCOUNT,
            'shares': 100, 'price': 50, 'fees': 1, 'cashAmount': -5001,
        }, client_token='tok-contract-0001')
        store.save_snapshot(self.stock_book_id, as_of_date='2026-06-02', summary={'shares': 100})
        self.conn = sqlite3.connect(self.db_path, isolation_level=None)
        self.addCleanup(self.conn.close)
        self.conn.execute('PRAGMA foreign_keys = ON')

    def test_draft_applies_to_a_v10_ledger_with_foreign_keys_on_and_keeps_stock_rows(self):
        before = {table: _rows(self.conn, table)
                  for table in ('cost_basis_books', 'cost_basis_events', 'cost_basis_snapshots')}
        _apply_ddl(self.conn)
        self.assertEqual(self.conn.execute('PRAGMA foreign_keys').fetchone()[0], 1)
        self.assertEqual(self.conn.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(self.conn.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        # P2 assigns the schema version; the structural draft does not.
        self.assertEqual(self.conn.execute('PRAGMA user_version').fetchone()[0], SCHEMA_USER_VERSION)
        for table, rows in before.items():
            self.assertEqual(_rows(self.conn, table), rows, table)
        for child in ('cost_basis_events', 'cost_basis_snapshots'):
            sql = self.conn.execute(
                'SELECT sql FROM sqlite_master WHERE name = ?', (child,)).fetchone()[0]
            self.assertIn('REFERENCES cost_basis_books(book_id)', sql)
        indexes = {row[0] for row in self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cost_basis_books'")}
        self.assertIn('idx_cost_basis_books_account_symbol', indexes)
        tables = {row[0] for row in self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertTrue({
            'cost_basis_fop_books', 'cost_basis_fop_contracts', 'cost_basis_fop_bindings',
            'cost_basis_fop_event_details', 'cost_basis_fop_cycles', 'cost_basis_fop_sources',
            'cost_basis_fop_source_allocations', 'cost_basis_fop_operations',
            'cost_basis_fop_reference_revisions', 'cost_basis_fop_event_id_mappings',
        } <= tables)
        self.assertFalse(any('roll' in name for name in tables if name.startswith('cost_basis_fop')))
        self.assertNotIn('cost_basis_fop_cash_reconciliation', tables)

    def test_the_existing_rebuild_order_fails_on_the_parent_table(self):
        # Why ddl_draft.sql uses SQLite's documented order (plan §8.2 item 7):
        # the order _migrate_v9_to_v10 uses for the events table breaks here.
        self.conn.execute('BEGIN IMMEDIATE')
        self.conn.execute('ALTER TABLE cost_basis_books RENAME TO cost_basis_books_old')
        self.conn.execute(_ddl_statements()[0].replace('cost_basis_books_new', 'cost_basis_books'))
        self.conn.execute('INSERT INTO cost_basis_books SELECT * FROM cost_basis_books_old')
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute('DROP TABLE cost_basis_books_old')
        self.conn.execute('ROLLBACK')
        self.assertEqual(self.conn.execute(
            "SELECT count(*) FROM sqlite_master WHERE name = 'cost_basis_books_old'").fetchone()[0], 0)

    def _insert(self, table, **values):
        columns = ', '.join(values)
        marks = ', '.join('?' for _ in values)
        self.conn.execute(f'INSERT INTO {table} ({columns}) VALUES ({marks})', tuple(values.values()))

    def test_constraints_refuse_what_the_plan_refuses(self):
        _apply_ddl(self.conn)
        stamp = '2026-10-01T00:00:00Z'  # a write stamp
        instant = '2026-10-01T00:00:00.000000Z'  # an economic or evidence time
        book = dict(account=ACCOUNT, symbol='CL', currency='USD', start_date='2026-01-01',
                    note='', created_at_utc=stamp, updated_at_utc=stamp)
        with self.assertRaises(sqlite3.IntegrityError, msg='a stock ledger keeps its multiplier'):
            self._insert('cost_basis_books', book_id='stknull001', sec_type='STK',
                         default_shares_per_contract=None, **dict(book, symbol='SPY'))
        self._insert('cost_basis_books', book_id='fopbook0001', sec_type='FUT',
                     default_shares_per_contract=None, **book)
        self._insert('cost_basis_fop_books', book_id='fopbook0001', engine_version=1,
                     product_rules='NYMEX-CL-v1', history_scope='full_history',
                     created_at_utc=stamp, updated_at_utc=stamp)
        common = dict(book_id='fopbook0001', root='CL', exchange='NYMEX', currency='USD',
                      rule_version='NYMEX-CL-v1', evidence_status='verified_statement',
                      observed_at_utc=instant, created_at_utc=stamp)
        fut = dict(common, contract_id='fut-clz6-0001', revision=1, sec_type='FUT',
                   future_contract_month='202612', future_point_value=1000)
        fop = dict(common, contract_id='fop-loz6-c75-01', revision=1, sec_type='FOP',
                   option_right='C', option_strike=75, option_expiry='2026-11-17',
                   premium_multiplier=1000, deliverable_futures_per_option=1,
                   settlement_type='physical_future', exercise_style='american')
        self._insert('cost_basis_fop_contracts', **fut)
        self._insert('cost_basis_fop_contracts', **fop)
        refused_contracts = {
            'zero strike': dict(fop, revision=2, option_strike=0),
            'negative strike': dict(fop, revision=2, option_strike=-5),
            'cash settlement': dict(fop, revision=2, settlement_type='cash'),
            'option terms on a FUT': dict(fut, revision=2, option_right='C'),
            'last-trade date as month': dict(fut, revision=2, future_contract_month='20261119'),
            'FUT without point value': dict(fut, revision=2, future_point_value=None),
            'FOP carrying a FUT month': dict(fop, revision=2, future_contract_month='202612'),
            'duplicate current conId': dict(fut, contract_id='fut-other-001', con_id=555),
        }
        self._insert('cost_basis_fop_contracts', **dict(fut, contract_id='fut-conid-001',
                                                           con_id=555))
        for name, row in refused_contracts.items():
            with self.subTest(contract=name), self.assertRaises(sqlite3.IntegrityError):
                self._insert('cost_basis_fop_contracts', **row)
        binding = dict(binding_id='bind-loz6-c75-1', revision=1, book_id='fopbook0001',
                       option_contract_id='fop-loz6-c75-01', future_contract_id='fut-clz6-0001',
                       status='verified_statement', evidence_digest='0' * 64,
                       observed_at_utc=instant, created_at_utc=stamp)
        self._insert('cost_basis_fop_bindings', **binding)
        refused_bindings = {
            'unresolved naming a FUT': dict(binding, revision=2, status='unresolved'),
            'verified without the server digest': dict(binding, revision=2, evidence_digest=None),
            'resolved without a FUT': dict(binding, revision=2, status='manual_attested',
                                           future_contract_id=None),
        }
        for name, row in refused_bindings.items():
            with self.subTest(binding=name), self.assertRaises(sqlite3.IntegrityError):
                self._insert('cost_basis_fop_bindings', **row)
        self._insert('cost_basis_events', event_id='evtfop000001', book_id='fopbook0001', seq=1,
                     client_token='tok-fop-evt-0001', kind='futures_trade', trade_date='2026-10-01',
                     account=ACCOUNT, future_contracts=1, price=70, cash_amount=-2, fees=2,
                     created_at_utc=stamp)
        detail = dict(event_id='evtfop000001', book_id='fopbook0001', contract_id='fut-clz6-0001',
                      contract_revision=1, executed_at_utc=instant)
        refused_details = {
            'instant and range': dict(detail, time_range_start_utc=instant,
                                      time_range_end_utc=instant),
            'neither instant nor range': dict(detail, executed_at_utc=None),
            'contract without revision': dict(detail, contract_revision=None),
            'half a range': dict(detail, executed_at_utc=None, time_range_start_utc=instant),
            'unknown fee category': dict(detail, fee_category='misc'),
        }
        for name, row in refused_details.items():
            with self.subTest(detail=name), self.assertRaises(sqlite3.IntegrityError):
                self._insert('cost_basis_fop_event_details', **row)
        self._insert('cost_basis_fop_event_details', **detail)
        with self.assertRaises(sqlite3.IntegrityError, msg='a closed cycle is anchored'):
            self._insert('cost_basis_fop_cycles', boundary_id='cycle-000000001', revision=1,
                         book_id='fopbook0001', state='closed', anchor_event_id=None,
                         created_at_utc=stamp)
        self._insert('cost_basis_fop_cycles', boundary_id='cycle-000000001', revision=1,
                     book_id='fopbook0001', state='closed', anchor_event_id='evtfop000001',
                     created_at_utc=stamp)
        with self.assertRaises(sqlite3.IntegrityError, msg='details must reference a real event'):
            self._insert('cost_basis_fop_event_details', **dict(detail, event_id='missing-event-1'))

    def test_time_text_has_one_fixed_width_form(self):
        # Text order is time order only when every value is spelled the same
        # way, and an instant must keep the digits its source gave. With a
        # free fraction, '14:30:05.1Z' sorted before '14:30:05Z'; with whole
        # seconds, a fill at 14:30:05.900 counted in an as-of of 14:30:05.
        _apply_ddl(self.conn)
        stamp = '2026-10-01T00:00:00Z'  # a write stamp
        self._insert('cost_basis_books', book_id='fopbook0001', sec_type='FUT',
                     default_shares_per_contract=None, account=ACCOUNT, symbol='CL',
                     currency='USD', start_date='2026-01-01', note='', created_at_utc=stamp,
                     updated_at_utc=stamp)
        events = ('evtfop000001', 'evtfop000002', 'evtfop000003')
        for seq, event_id in enumerate(events, start=1):
            self._insert('cost_basis_events', event_id=event_id, book_id='fopbook0001', seq=seq,
                         client_token=f'tok-fop-evt-000{seq}', kind='futures_trade',
                         trade_date='2026-10-01', account=ACCOUNT, future_contracts=1, price=70,
                         cash_amount=-2, fees=2, created_at_utc=stamp)
        detail = dict(event_id=events[0], book_id='fopbook0001', exchange_trade_date='2026-10-01')

        def ranged(start, end):
            return dict(detail, time_range_start_utc=start, time_range_end_utc=end)

        refused = {
            'short fraction': ranged('2026-10-01T14:30:05.000000Z', '2026-10-01T14:30:05.1Z'),
            'no fraction': dict(detail, executed_at_utc='2026-10-01T14:30:05Z'),
            'finer than a microsecond': dict(detail,
                                             executed_at_utc='2026-10-01T14:30:05.900000001Z'),
            'reversed range inside one second': ranged('2026-10-01T14:30:05.900000Z',
                                                       '2026-10-01T14:30:05.100000Z'),
            'offset instead of Z': dict(detail, executed_at_utc='2026-10-01T14:30:05.000000+00:00'),
            'space instead of T': dict(detail, executed_at_utc='2026-10-01 14:30:05.000000Z'),
            'compact trade date': dict(detail, exchange_trade_date='20261001',
                                       executed_at_utc='2026-10-01T14:30:05.000000Z'),
            'millisecond baseline': dict(detail, executed_at_utc='2026-10-01T14:30:05.000000Z',
                                         baseline_as_of_utc='2026-10-01T21:00:00.000Z'),
        }
        for name, row in refused.items():
            with self.subTest(detail=name), self.assertRaises(sqlite3.IntegrityError):
                self._insert('cost_basis_fop_event_details', **row)
        self._insert('cost_basis_fop_event_details',
                     **ranged('2026-10-01T14:30:05.000000Z', '2026-10-01T14:30:05.000000Z'))
        self._insert('cost_basis_fop_event_details',
                     **dict(ranged('2026-10-01T14:30:05.100000Z', '2026-10-01T14:30:05.900000Z'),
                            event_id=events[1]))
        self._insert('cost_basis_fop_event_details',
                     **dict(detail, event_id=events[2],
                            executed_at_utc='2026-10-01T14:30:05.900000Z'))
        counted = self.conn.execute(
            'SELECT event_id FROM cost_basis_fop_event_details WHERE executed_at_utc <= ?',
            ('2026-10-01T14:30:05.000000Z',)).fetchall()
        self.assertEqual(counted, [], 'a fill at 14:30:05.900 is after an as-of of 14:30:05')
        common = dict(book_id='fopbook0001', root='CL', exchange='NYMEX', currency='USD',
                      rule_version='NYMEX-CL-v1', evidence_status='verified_statement',
                      created_at_utc=stamp, sec_type='FUT', future_contract_month='202612',
                      future_point_value=1000, revision=1)
        for name, row in {
            'short fractional observation': dict(common, contract_id='fut-clz6-0001',
                                                 observed_at_utc='2026-10-01T15:00:00.5Z'),
            'observation without a fraction': dict(common, contract_id='fut-clz6-0002',
                                                   observed_at_utc='2026-10-01T15:00:00Z'),
            'last trade date with a time': dict(common, contract_id='fut-clz6-0003',
                                                observed_at_utc='2026-10-01T15:00:00.000000Z',
                                                future_last_trade_date='2026-11-19T00:00:00Z'),
        }.items():
            with self.subTest(contract=name), self.assertRaises(sqlite3.IntegrityError):
                self._insert('cost_basis_fop_contracts', **row)
        self._insert('cost_basis_fop_contracts', **dict(
            common, contract_id='fut-clz6-0004', observed_at_utc='2026-10-01T15:00:00.250000Z'))


# ----------------------------------------------------------------------
# Column, kind and write coverage
# ----------------------------------------------------------------------

class CoverageTests(unittest.TestCase):
    def test_every_event_column_is_decided(self):
        document = _load('event_columns.json')
        decided = document['columns']
        self.assertEqual(set(decided), set(cost_basis_store._EVENT_COLUMNS))
        with tempfile.TemporaryDirectory() as directory:
            db_path = pathlib.Path(directory) / 'cost_basis.db'
            CostBasisStore(db_path).initialize()
            conn = sqlite3.connect(db_path)
            try:
                actual = {row[1] for row in conn.execute('PRAGMA table_info(cost_basis_events)')}
            finally:
                conn.close()
        self.assertEqual(set(decided), actual)
        self.assertTrue(set(decided.values()) <= set(document['rules']))
        self.assertEqual(decided['future_contracts'], 'economic',
                         'future_contracts is a quantity: no future_* wildcard may clear it')
        self.assertEqual(decided['tag'], 'fixed_empty_string')

    def test_every_event_kind_is_decided(self):
        document = _load('event_kinds.json')
        allowed = set(document['allowed'])
        rejected = set(document['rejected'])
        self.assertFalse(allowed & rejected)
        self.assertEqual(allowed | rejected, set(EVENT_KINDS))
        self.assertIn('futures_roll', rejected)
        e_sum = document['eSum']
        buckets = [set(e_sum['feesOf']), set(e_sum['minusCashOf']), set(e_sum['never'])]
        self.assertEqual(set().union(*buckets), allowed)
        self.assertEqual(sum(len(bucket) for bucket in buckets), len(allowed))
        # Option commissions are already inside Co (plan §8.1, review C9).
        self.assertIn('option_trade', e_sum['never'])

    def test_write_coverage_matches_the_protocol_and_the_store(self):
        document = _load('write_coverage.json')
        writes = {entry['wsAction']: entry['storeMethod'] for entry in document['writes']}
        reads = set(document['reads'])
        self.assertFalse(set(writes) & reads)
        self.assertEqual(set(writes) | reads, set(SERVER_ACTIONS))
        for method in writes.values():
            self.assertTrue(callable(getattr(CostBasisStore, method, None)), method)
        guarded = {
            name for name, member in inspect.getmembers(CostBasisStore, inspect.isfunction)
            if '_get_writable_book(' in inspect.getsource(member) and name != '_get_writable_book'
        }
        self.assertTrue(guarded <= set(writes.values()), guarded - set(writes.values()))
        self.assertTrue({'create_book', 'delete_book'} <= set(writes.values()))
        planned = {entry['wsAction'] for entry in document['planned']}
        self.assertFalse(planned & set(SERVER_ACTIONS), 'a planned action already exists')


# ----------------------------------------------------------------------
# Protocol and core output
# ----------------------------------------------------------------------

def _python_results(document):
    reader = ContractReader(document['types'])
    return {group: {example['name']: reader.check(example['type'], example['value'])
                    for example in document['examples'][group]}
            for group in ('valid', 'invalid')}


# The reference comparison behind protocol.json domainRules
# repeated_source_matches_or_conflicts. P2 implements the rule in the store;
# this only proves the worked cases in domainCases say what the rule says.
_NOT_CONTRACT_TERMS = {'contractId', 'revision', 'evidenceStatus', 'evidenceSummary',
                       'observedAtUtc'}

# Every FopEvent field and every time fact is classified below. The coverage
# test compares these groups with all event variants so a new economic field
# cannot silently fall out of repeat detection. Account is checked against the
# source/book; source, externalRef and packageKey are provenance, and note is
# prose. The special fields are compared by meaning: contracts by terms, a
# binding through the contractRef -> deliveredContractRef pair it must match
# (delivery_follows_binding), a fee source by the event it resolves to, time by
# its compared facts, sources by this record's allocation.
_REPEAT_EVENT_VALUES = (
    'kind', 'contracts', 'futureContracts', 'price', 'cashAmount', 'fees',
    'includeInCost', 'openClose', 'feeCategory', 'feeIsRefund',
    'adjustmentScope', 'baselineKind', 'baselineAsOfUtc',
)
_REPEAT_EVENT_SPECIAL = {'contractRef', 'deliveredContractRef', 'bindingRef', 'feeSource',
                         'time', 'sources'}
_REPEAT_EVENT_PROVENANCE = {'account', 'source', 'externalRef', 'packageKey', 'note'}
# The same instant written another way (a timezone name, a text format) is
# reported, never a revision.
_REPEAT_TIME_COMPARED = ('exchangeTradeDate', 'executedAtUtc', 'timeRange', 'orderEvidence')
_REPEAT_TIME_REPORTED = ('sourceTimeText', 'sourceTimezone')


def _repeat_projection(side):
    """(reference key, compared values, reported values) of one side of a case."""
    record = side['record']
    key = (record['account'], record['namespace'], record['sourceRef'])
    contracts = {(item['contractId'], item['revision']): item for item in side['contracts']}
    bindings = {(item['bindingId'], item['revision']): item for item in side.get('bindings', [])}
    matched = side.get('matchedPackageKeys', {})
    events = [event for event in side['events']
              if any((record['account'], source['namespace'], source['sourceRef']) == key
                     for source in event['sources'])]
    compared = {'record.statedQuantity': record['statedQuantity'],
                'record.statedFees': record['statedFees'], 'events': len(events)}
    reported = {f'rawFields.{name}': value for name, value in record['rawFields'].items()}
    for index, event in enumerate(events):
        prefix = f'events[{index}]'
        for field in _REPEAT_EVENT_VALUES:
            compared[f'{prefix}.{field}'] = event.get(field)
        for field in _REPEAT_TIME_COMPARED:
            compared[f'{prefix}.time.{field}'] = json.dumps(event['time'][field], sort_keys=True)
        for field in _REPEAT_TIME_REPORTED:
            reported[f'{prefix}.time.{field}'] = event['time'][field]
        for ref in ('contractRef', 'deliveredContractRef'):
            if event.get(ref):
                terms = contracts[(event[ref]['contractId'], event[ref]['revision'])]
                for field, value in terms.items():
                    if field not in _NOT_CONTRACT_TERMS:
                        compared[f'{prefix}.{ref}.{field}'] = value
        if event.get('bindingRef'):
            binding = bindings[(event['bindingRef']['bindingId'], event['bindingRef']['revision'])]
            if (binding['optionContractId'] != event['contractRef']['contractId']
                    or binding['futureContractId'] != event['deliveredContractRef']['contractId']):
                raise AssertionError('case breaks delivery_follows_binding')
            reported[f'{prefix}.bindingRef'] = json.dumps(event['bindingRef'], sort_keys=True)
        fee_source = event.get('feeSource')
        if fee_source is not None:
            compared[f'{prefix}.feeSource'] = fee_source['eventId'] or matched.get(
                fee_source['packageKey'], f"new:{fee_source['packageKey']}")
        allocation = next(source for source in event['sources']
                          if (source['namespace'], source['sourceRef']) == key[1:])
        for field in ('role', 'quantity', 'fees'):
            compared[f'{prefix}.allocation.{field}'] = allocation[field]
    return key, compared, reported


def _repeat_outcome(stored, incoming):
    stored_key, before, before_reported = _repeat_projection(stored)
    incoming_key, after, after_reported = _repeat_projection(incoming)
    if stored_key != incoming_key:
        return {'outcome': 'new'}
    differing = sorted(field for field in set(before) | set(after)
                       if before.get(field) != after.get(field))
    if differing:
        return {'outcome': 'conflict', 'code': 'import_revision_conflict', 'fields': differing}
    return {'outcome': 'duplicate', 'reported': sorted(
        field for field in set(before_reported) | set(after_reported)
        if before_reported.get(field) != after_reported.get(field))}


class ProtocolContractTests(unittest.TestCase):
    DOCUMENTS = ('protocol.json', 'core_output.json')

    def test_examples_pass_and_fail_as_stated(self):
        for name in self.DOCUMENTS:
            document = _load(name)
            reader = ContractReader(document['types'])
            names = [example['name'] for group in ('valid', 'invalid')
                     for example in document['examples'][group]]
            self.assertEqual(len(names), len(set(names)), f'{name}: duplicate example name')
            for example in document['examples']['valid']:
                with self.subTest(document=name, valid=example['name']):
                    self.assertEqual(reader.check(example['type'], example['value']), [])
            for example in document['examples']['invalid']:
                with self.subTest(document=name, invalid=example['name']):
                    # Exactly the one stated error: a second one would mean
                    # the example tests more than its name says.
                    expected = (example['expect']['path'], example['expect']['code'])
                    self.assertEqual(reader.check(example['type'], example['value']), [expected])

    def test_every_protocol_type_is_used_by_an_example(self):
        document = _load('protocol.json')
        used = set()

        def walk(spec):
            if 'ref' in spec and spec['ref'] not in used:
                used.add(spec['ref'])
                walk(document['types'][spec['ref']])
            for child in (spec.get('items'), spec.get('values')):
                if child:
                    walk(child)
            for child in spec.get('fields', {}).values():
                walk(child)
            for child in spec.get('cases', {}).values():
                walk(child)

        for group in ('valid', 'invalid'):
            for example in document['examples'][group]:
                walk({'ref': example['type']})
        self.assertEqual(set(document['types']) - used, set())

    def test_every_write_request_carries_the_write_guard(self):
        # Plan §8.3: identity, the reviewed ledger version and an idempotency
        # key on every write, so a write prepared against an older ledger is
        # refused instead of applied.
        document = _load('protocol.json')
        coverage = _load('write_coverage.json')
        writes = {entry['wsAction'] for entry in coverage['writes']}
        writes |= {entry['wsAction'] for entry in coverage['planned'] if entry['writes']}
        requests = {}
        for name, spec in document['types'].items():
            action = spec.get('fields', {}).get('action', {})
            if action.get('type') == 'const' and action['value'] in writes:
                requests[action['value']] = spec
        self.assertEqual(set(requests), {
            'create_cost_basis_book', 'append_cost_basis_event', 'import_cost_basis_events',
            'void_cost_basis_event', 'commit_cost_basis_fop_metadata', 'save_cost_basis_snapshot'})
        idempotency = {
            'append_cost_basis_event': {'clientToken'},
            'void_cost_basis_event': {'clientToken'},
            'commit_cost_basis_fop_metadata': {'clientToken'},
            'import_cost_basis_events': {'importBatchId', 'clientTokenPrefix'},
            'save_cost_basis_snapshot': set(),
        }
        for action, spec in requests.items():
            if action == 'create_cost_basis_book':
                continue
            with self.subTest(action=action):
                required = set(spec['required'])
                self.assertTrue({'requestId', 'bookId', 'bookIdentity',
                                 'expectedLedgerVersion'} | idempotency[action] <= required)
                self.assertEqual(spec['fields']['bookIdentity'], {'ref': 'BookIdentity'})
                self.assertEqual(spec['fields']['expectedLedgerVersion'], {'ref': 'LedgerVersion'})
        self.assertIn('write_guard', {rule['id'] for rule in document['domainRules']})

    def test_order_rules_compare_only_fixed_width_text(self):
        instant = r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$'
        recorded = r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$'
        date = r'^\d{4}-\d{2}-\d{2}$'
        for name in self.DOCUMENTS:
            document = _load(name)
            types = document['types']
            with self.subTest(document=name):
                self.assertEqual(types['UtcInstant']['pattern'], instant)
                self.assertEqual(types['IsoDate']['pattern'], date)

            def objects(spec):
                if spec.get('type') == 'object':
                    yield spec
                    for child in spec['fields'].values():
                        yield from objects(child)
                for child in (spec.get('items'), spec.get('values')):
                    if child:
                        yield from objects(child)
                for child in spec.get('cases', {}).values():
                    yield from objects(child)

            for type_name, spec in types.items():
                for node in objects(spec):
                    for rule in node.get('rules', []):
                        if 'lessOrEqual' not in rule:
                            continue
                        with self.subTest(document=name, rule=rule['id']):
                            refs = {node['fields'][field].get('ref')
                                    for field in rule['lessOrEqual']}
                            self.assertEqual(len(refs), 1, 'both sides share one type')
                            self.assertIn(refs.pop(), ('UtcInstant', 'IsoDate'))
        protocol = _load('protocol.json')
        self.assertEqual(set(protocol['formats']), {'UtcInstant', 'IsoDate', 'RecordedAtUtc'})
        self.assertEqual(protocol['types']['RecordedAtUtc']['pattern'], recorded)
        # A write stamp is the store's own form (cost_basis_store._utc_now_iso);
        # every other time field is a UtcInstant.
        self.assertIn('%Y-%m-%dT%H:%M:%SZ', inspect.getsource(CostBasisStore._utc_now_iso))
        specs = []
        for type_name, spec in protocol['types'].items():
            specs.append((type_name, spec))
            specs.extend((f'{type_name}.{case}', case_spec)
                         for case, case_spec in spec.get('cases', {}).items())
        checked = 0
        for type_name, spec in specs:
            for field, field_spec in spec.get('fields', {}).items():
                checked += field.endswith(('Utc', 'AsOf'))
                if field_spec.get('ref') == 'RecordedAtUtc':
                    self.assertIn(field, ('createdAtUtc', 'updatedAtUtc', 'archivedAtUtc',
                                          'voidedAtUtc'), type_name)
                elif field.endswith(('Utc', 'AsOf')):
                    self.assertEqual(field_spec.get('ref'), 'UtcInstant', f'{type_name}.{field}')
        self.assertGreaterEqual(checked, 25)

    def test_example_packages_keep_the_source_rules(self):
        # The schema checks shapes; these are the protocol's domainRules that
        # a single package can show. The examples must not contradict them.
        document = _load('protocol.json')
        capabilities = {entry['key'] for entry in json.loads(
            (REPO_ROOT / 'cost_basis_fop_capabilities.json').read_text(encoding='utf-8'))['keys']}
        rule_ids = [rule['id'] for rule in document['domainRules']]
        self.assertEqual(len(rule_ids), len(set(rule_ids)))
        statement_namespaces = {'flex_trade', 'ib_exec', 'activity_row'}
        checked = 0
        for example in document['examples']['valid']:
            request = example['value']
            package = request.get('fopPackage') if isinstance(request, dict) else None
            if package is None:
                continue
            checked += 1
            with self.subTest(example=example['name']):
                records = {(record['namespace'], record['sourceRef']): record
                           for record in package['sourceRecords']}
                self.assertEqual(len(records), len(package['sourceRecords']), 'duplicate record')
                used = {key: {'quantity': 0, 'fees': 0} for key in records}
                for event in package['events']:
                    self.assertEqual(event['account'], request['bookIdentity']['account'])
                    for source in event['sources']:
                        key = (source['namespace'], source['sourceRef'])
                        self.assertIn(key, records, 'source_refs_resolve')
                        used[key]['quantity'] += abs(source['quantity'] or 0)
                        used[key]['fees'] += source['fees'] or 0
                for key, record in records.items():
                    self.assertGreater(len([event for event in package['events']
                                            if any((source['namespace'], source['sourceRef']) == key
                                                   for source in event['sources'])]), 0,
                                       'source_records_used')
                    self.assertEqual(record['account'], request['bookIdentity']['account'])
                    if record['statedQuantity'] is not None:
                        self.assertLessEqual(used[key]['quantity'], abs(record['statedQuantity']))
                    if record['statedFees'] is not None:
                        self.assertLessEqual(used[key]['fees'], abs(record['statedFees']) + 1e-9)
                    if record['capabilityKey'] is not None:
                        self.assertIn(record['capabilityKey'], capabilities)
                keyed = {event['packageKey']: event for event in package['events']
                         if event['packageKey'] is not None}
                self.assertEqual(len(keyed), len([event for event in package['events']
                                                  if event['packageKey'] is not None]),
                                 'package_keys_resolve: keys are unique')
                for event in package['events']:
                    source = event.get('feeSource')
                    if source and source['packageKey'] is not None:
                        target = keyed.get(source['packageKey'])
                        self.assertIsNotNone(target, 'package_keys_resolve')
                        self.assertNotEqual(target['kind'], 'fee', 'package_keys_resolve')
                statement_rows = any(key[0] in statement_namespaces for key in records)
                if request['action'] == 'append_cost_basis_event':
                    self.assertFalse(statement_rows, 'statement_rows_need_a_statement')
                elif statement_rows:
                    self.assertIsNotNone(request['statement'], 'statement_rows_need_a_statement')
                    self.assertEqual({record['format'] for key, record in records.items()
                                      if key[0] in statement_namespaces},
                                     {request['statement']['format']}, 'one file per import')
        self.assertGreaterEqual(checked, 10)

    def test_repeated_source_cases_agree_with_the_rule(self):
        # The same reference is skipped only when its economic content is
        # unchanged; a revised price, quantity, fee, contract or time must
        # stop the import instead of being dropped as a duplicate.
        document = _load('protocol.json')
        reader = ContractReader(document['types'])
        rules = {rule['id'] for rule in document['domainRules']}
        codes = set(document['types']['ErrorResponse']['fields']['code']['enum'])
        cases = [case for case in document['domainCases']
                 if case['rule'] == 'repeated_source_matches_or_conflicts']
        self.assertTrue({case['rule'] for case in document['domainCases']} <= rules)
        for case in cases:
            with self.subTest(case=case['name']):
                for side in ('stored', 'incoming'):
                    self.assertTrue(set(case[side]) <= {'record', 'events', 'contracts', 'bindings',
                                                        'matchedPackageKeys'})
                    self.assertEqual(reader.check('SourceSubmission', case[side]['record']), [])
                    for event in case[side]['events']:
                        self.assertEqual(reader.check('FopEvent', event), [])
                    for contract in case[side]['contracts']:
                        self.assertEqual(reader.check('ContractRecord', contract), [])
                    for binding in case[side].get('bindings', []):
                        self.assertEqual(reader.check('BindingRecord', binding), [])
                self.assertEqual(_repeat_outcome(case['stored'], case['incoming']), case['expect'])
                if case['expect']['outcome'] == 'conflict':
                    self.assertIn(case['expect']['code'], codes)
        outcomes = [case['expect']['outcome'] for case in cases]
        self.assertEqual(set(outcomes), {'duplicate', 'conflict', 'new'})
        conflicts = {field.split('.')[-1] for case in cases if case['expect']['outcome'] == 'conflict'
                     for field in case['expect']['fields']}
        self.assertTrue({'price', 'futureContracts', 'fees', 'futureContractMonth',
                         'executedAtUtc', 'orderEvidence', 'feeSource'} <= conflicts)
        # Differences that do not decide a repeat are reported, not dropped.
        reported = {field.split('.')[-1] for case in cases
                    if case['expect']['outcome'] == 'duplicate'
                    for field in case['expect']['reported']}
        self.assertTrue({'Description', 'sourceTimeText', 'sourceTimezone', 'bindingRef'}
                        <= reported)

    def test_repeat_comparison_classifies_every_event_field(self):
        kinds = _load('protocol.json')['types']['FopEvent']['cases']
        groups = (set(_REPEAT_EVENT_VALUES), _REPEAT_EVENT_SPECIAL,
                  _REPEAT_EVENT_PROVENANCE)
        self.assertEqual(sum(map(len, groups)), len(set().union(*groups)),
                         'a field must have exactly one comparison policy')
        declared = set().union(*(set(spec['fields']) for spec in kinds.values()))
        self.assertEqual(set().union(*groups), declared,
                         'classify every new event field before freezing its contract')
        time_facts = set(_load('protocol.json')['types']['TimeFacts']['fields'])
        self.assertFalse(set(_REPEAT_TIME_COMPARED) & set(_REPEAT_TIME_REPORTED))
        self.assertEqual(set(_REPEAT_TIME_COMPARED) | set(_REPEAT_TIME_REPORTED), time_facts,
                         'classify every new time fact before freezing its contract')

    def test_repeat_cases_isolate_each_event_semantic_change(self):
        # These are valid before/after events with exactly one changed field.
        # They protect the omission found in review without relying on a
        # simultaneous cash/quantity change to make the comparison fail.
        # A binding revision that keeps the same delivery is the one isolated
        # change that must NOT conflict: the binding is compared by what it
        # binds, and adopting a new revision is a metadata commit.
        required = {
            ('fee', 'feeCategory'), ('fee', 'feeSource'),
            ('fee', 'includeInCost'), ('manual_adjust', 'adjustmentScope'),
            ('manual_adjust', 'includeInCost'), ('futures_trade', 'openClose'),
            ('option_trade', 'openClose'), ('opening_balance', 'baselineKind'),
            ('opening_balance', 'baselineAsOfUtc'),
            ('option_assignment', 'bindingRef'), ('option_exercise', 'bindingRef'),
        }
        reported_only = {'bindingRef'}
        document = _load('protocol.json')
        reader = ContractReader(document['types'])
        isolated = set()
        for case in document['domainCases']:
            if not case.get('isolatedEventField'):
                continue
            field = case['isolatedEventField']
            before = case['stored']['events'][0]
            after = case['incoming']['events'][0]
            with self.subTest(case=case['name']):
                self.assertEqual(reader.check('FopEvent', before), [])
                self.assertEqual(reader.check('FopEvent', after), [])
                changed = {key for key in set(before) | set(after)
                           if before.get(key) != after.get(key)}
                self.assertEqual(changed, {field})
                self.assertEqual(case['stored']['record'], case['incoming']['record'])
                self.assertEqual(case['stored']['contracts'], case['incoming']['contracts'])
                if field in reported_only:
                    expected = {'outcome': 'duplicate', 'reported': [f'events[0].{field}']}
                else:
                    expected = {'outcome': 'conflict', 'code': 'import_revision_conflict',
                                'fields': [f'events[0].{field}']}
                self.assertEqual(case['expect'], expected)
                self.assertEqual(_repeat_outcome(case['stored'], case['incoming']), expected)
            isolated.add((before['kind'], field))
        self.assertEqual(isolated, required)

    def test_the_js_reader_reports_exactly_the_same_errors(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('node is not installed; tests/cost_basis_fop_identity.test.js covers the JS side')
        for name in self.DOCUMENTS:
            with self.subTest(document=name):
                completed = subprocess.run(
                    [node, str(JS_READER), str(CONTRACT / name)],
                    capture_output=True, text=True, check=True, timeout=60)
                js_results = json.loads(completed.stdout)
                python_results = _python_results(_load(name))
                for group in ('valid', 'invalid'):
                    self.assertEqual(set(js_results[group]), set(python_results[group]))
                    for example, errors in python_results[group].items():
                        js_errors = sorted((item['path'], item['code'])
                                           for item in js_results[group][example])
                        self.assertEqual(js_errors, sorted(errors), f'{group}: {example}')


# ----------------------------------------------------------------------
# A ledger's type is stated, never defaulted (plan §1.1)
# ----------------------------------------------------------------------

class FakeWebSocket:
    remote_address = ('127.0.0.1', 51000)

    def __init__(self):
        self.sent = []

    async def send(self, message):
        self.sent.append(message)


class ExplicitBookTypeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        config = configparser.ConfigParser()
        config.read_string(f"[cost_basis]\ndb_path = {pathlib.Path(self._tmp.name) / 'c.db'}\n")
        self.env = create_store_env(config, environ={})

    async def call(self, action, **fields):
        socket = FakeWebSocket()
        handled = await handle_cost_basis_action(
            self.env, socket, {'action': action, 'requestId': 'req-1', **fields})
        self.assertTrue(handled)
        return json.loads(socket.sent[0])

    async def test_creating_a_ledger_without_a_type_is_refused(self):
        response = await self.call('create_cost_basis_book', account=ACCOUNT, symbol='CL',
                                   startDate='2026-01-01')
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'invalid_request')
        self.assertIn('secType', response['message'])
        listed = await self.call('list_cost_basis_books')
        self.assertEqual(listed['books'], [])

    async def test_only_a_stock_ledger_keeps_the_default_multiplier(self):
        stock = await self.call('create_cost_basis_book', account=ACCOUNT, symbol='TQQQ',
                                startDate='2026-01-01', secType='STK')
        self.assertTrue(stock['success'], stock)
        self.assertEqual(stock['book']['defaultSharesPerContract'], 100)
        futures = await self.call('create_cost_basis_book', account=ACCOUNT, symbol='CL',
                                  startDate='2026-01-01', secType='FUT')
        self.assertFalse(futures['success'])
        self.assertEqual(futures['code'], 'invalid_request')
        self.assertIn('defaultSharesPerContract', futures['message'])


if __name__ == '__main__':
    unittest.main()
