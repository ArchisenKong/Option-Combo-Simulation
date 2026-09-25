"""P2: the FOP ledger's storage, versions and transactions.

CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §8 and §13.3 P2. Every test runs
on a temporary database; nothing here opens the real ledger or talks to TWS.

- The v10 -> v11 migration follows the frozen P1 draft, runs with foreign
  keys on, keeps every stock row, takes a verified backup first, and leaves
  the v10 file untouched when any step fails (F25, F37, F45).
- A FUT ledger from another build stays export and delete only (F11).
"""
import copy
import pathlib
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(REPO_ROOT / 'tests') not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / 'tests'))

import cost_basis_fop_domain as domain  # noqa: E402
import cost_basis_store  # noqa: E402
from cost_basis_fop_store import FOP_GRAPH_TABLES, FOP_TABLES  # noqa: E402
import cost_basis_fop_schema as schema  # noqa: E402
from cost_basis_fop_test_support import (  # noqa: E402
    CLZ6, FOP_META, IDENTITY, LOZ6, MANUAL_BINDING, FopLedger, at, example_event, in_range,
    package, previous_build, token, verified_capabilities,
)
from cost_basis_store import (  # noqa: E402
    SCHEMA_USER_VERSION, BookExistsError, CostBasisStore, EventAlreadyVoidedError,
    FopBindingEvidenceInvalidError, FopCycleBoundaryViolatedError, FopEngineVersionMismatchError,
    FopIdentityConflictError, FopReferenceRevisionConflictError, FuturesBookFrozenError,
    ImportRevisionConflictError, InvalidRequestError, LedgerChangedError, PositionOverdrawError,
    ResetConfirmationError, StoreUnavailableError,
)
import hashlib  # noqa: E402
import json  # noqa: E402

ACCOUNT = 'U1111111'
DRAFT = REPO_ROOT / 'tests' / 'fixtures' / 'cost_basis_fop' / 'contract' / 'ddl_draft.sql'
STOCK_TABLES = (
    'cost_basis_books', 'cost_basis_events', 'cost_basis_snapshots', 'cost_basis_book_resets',
    'cost_basis_import_batches', 'cost_basis_reset_coverage',
)
LEGACY_FUT_BOOK = 'legacyfut0001'


class InjectedFault(Exception):
    pass


def _fault_at(point):
    def hook(name):
        if name == point:
            raise InjectedFault(point)
    return hook


def _normalized(sql):
    return re.sub(r'\s+', ' ', sql).strip()


def _draft_statements():
    text = DRAFT.read_text(encoding='utf-8')
    body = '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('--'))
    return [statement.strip() for statement in re.split(r';\s*\n', body + '\n') if statement.strip()]


def _raw(path):
    conn = sqlite3.connect(path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn


def _rows(path, table):
    conn = _raw(path)
    try:
        return sorted((tuple(sorted(dict(row).items()))
                       for row in conn.execute(f'SELECT * FROM {table}')), key=repr)
    finally:
        conn.close()


def _schema(path):
    conn = _raw(path)
    try:
        return sorted((row['type'], row['name'], _normalized(row['sql'] or ''))
                      for row in conn.execute('SELECT type, name, sql FROM sqlite_master'))
    finally:
        conn.close()


def _pragma(path, statement):
    conn = _raw(path)
    try:
        return conn.execute(statement).fetchall()
    finally:
        conn.close()


def _write_v10_ledger(path):
    """A v10 ledger written by the previous build: one stock book with an
    event, a snapshot, a reset archive, and one legacy FUT book."""
    with previous_build():
        store = CostBasisStore(path).initialize()
        book = store.create_book(account=ACCOUNT, symbol='TQQQ', start_date='2026-01-01',
                                 default_shares_per_contract=100)
        store.append_event(book['bookId'], {
            'kind': 'share_trade', 'tradeDate': '2026-06-01', 'account': ACCOUNT,
            'shares': 100, 'price': 50, 'fees': 1, 'cashAmount': -5001,
        }, client_token='tok-store-000001')
        store.save_snapshot(book['bookId'], as_of_date='2026-06-02', summary={'shares': 100})
        plan = store.reset_confirmation(book['bookId'])
        store.reset_book(book['bookId'], confirmation=plan['phrase'], client_token='tok-reset-000001',
                         expected_ledger_version=plan['ledgerVersion'],
                         book_identity={'account': ACCOUNT, 'symbol': 'TQQQ', 'secType': 'STK',
                                        'currency': 'USD'})
        store.append_event(book['bookId'], {
            'kind': 'share_trade', 'tradeDate': '2026-06-03', 'account': ACCOUNT,
            'shares': 50, 'price': 51, 'fees': 1, 'cashAmount': -2551,
        }, client_token='tok-store-000002')
    stamp = '2026-08-01T00:00:00Z'
    conn = _raw(path)
    try:
        conn.execute(
            'INSERT INTO cost_basis_books (book_id, account, symbol, sec_type, currency, '
            'default_shares_per_contract, start_date, note, created_at_utc, updated_at_utc) '
            "VALUES (?, ?, 'ES', 'FUT', 'USD', 50, '2026-01-01', '', ?, ?)",
            (LEGACY_FUT_BOOK, ACCOUNT, stamp, stamp))
        conn.execute(
            'INSERT INTO cost_basis_events (event_id, book_id, seq, client_token, kind, '
            'trade_date, account, future_expiry, future_contracts, shares_per_contract, price, '
            'cash_amount, fees, source, created_at_utc) '
            "VALUES ('legacyfutevent01', ?, 1, 'legacyfuttoken01', 'futures_trade', "
            "'2026-08-01', ?, '202609', 1, 50, 5000, 0, 0, 'manual', ?)",
            (LEGACY_FUT_BOOK, ACCOUNT, stamp))
    finally:
        conn.close()
    return book['bookId']


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = pathlib.Path(self._tmp.name)
        self.db_path = self.dir / 'cost_basis.db'
        self.stock_book = _write_v10_ledger(self.db_path)
        self.before = {table: _rows(self.db_path, table) for table in STOCK_TABLES}
        self.schema_before = _schema(self.db_path)

    def backups(self):
        return sorted(self.dir.glob('cost_basis.pre-v12-*.db'))

    def assert_untouched_v10(self):
        self.assertEqual(_pragma(self.db_path, 'PRAGMA user_version')[0][0], 10)
        self.assertEqual(_schema(self.db_path), self.schema_before)
        for table, rows in self.before.items():
            self.assertEqual(_rows(self.db_path, table), rows, table)

    def test_a_v10_ledger_migrates_with_foreign_keys_on_and_keeps_every_stock_row(self):
        store = CostBasisStore(self.db_path).initialize()
        self.assertEqual(_pragma(self.db_path, 'PRAGMA user_version')[0][0], SCHEMA_USER_VERSION)
        self.assertEqual(_pragma(self.db_path, 'PRAGMA foreign_key_check'), [])
        self.assertEqual(_pragma(self.db_path, 'PRAGMA integrity_check')[0][0], 'ok')
        for table, rows in self.before.items():
            self.assertEqual(_rows(self.db_path, table), rows, table)
        conn = _raw(self.db_path)
        try:
            self.assertEqual(conn.execute('PRAGMA foreign_keys').fetchone()[0], 0,
                             'a fresh connection starts with foreign keys off; the store turns them on')
            for child in ('cost_basis_events', 'cost_basis_snapshots'):
                sql = conn.execute('SELECT sql FROM sqlite_master WHERE name = ?',
                                   (child,)).fetchone()[0]
                self.assertIn('REFERENCES cost_basis_books(book_id)', sql)
            tables = {row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'")}
            self.assertTrue(set(FOP_TABLES) <= tables)
            conn.execute('PRAGMA foreign_keys = ON')
            with self.assertRaises(sqlite3.IntegrityError, msg='a stock ledger keeps its multiplier'):
                conn.execute('UPDATE cost_basis_books SET default_shares_per_contract = NULL '
                             'WHERE book_id = ?', (self.stock_book,))
        finally:
            conn.close()
        stock = store.get_book(self.stock_book)
        self.assertEqual(stock['defaultSharesPerContract'], 100)
        self.assertIsNone(stock['fop'])
        self.assertFalse(stock['legacyFutures'])
        self.assertEqual(store.last_migration['fromVersion'], 10)
        self.assertEqual(store.last_migration['preservedOrphans'], {})

    def test_the_migration_takes_a_verified_backup_first(self):
        store = CostBasisStore(self.db_path).initialize()
        backups = self.backups()
        self.assertEqual(len(backups), 1)
        self.assertEqual(store.last_migration['backupPath'], str(backups[0]))
        self.assertEqual(_pragma(backups[0], 'PRAGMA user_version')[0][0], 10)
        self.assertEqual(_pragma(backups[0], 'PRAGMA integrity_check')[0][0], 'ok')
        for table, rows in self.before.items():
            self.assertEqual(_rows(backups[0], table), rows, table)
        # The copy is a working v10 ledger for the build that wrote it.
        with previous_build():
            restored = CostBasisStore(backups[0]).initialize()
            self.assertEqual(len(restored.list_events(self.stock_book)['events']), 1)

    def test_the_migrated_schema_is_the_frozen_draft(self):
        self.assertEqual([_normalized(s) for s in cost_basis_store._V11_STATEMENTS],
                         [_normalized(s) for s in _draft_statements()])
        draft_copy = self.dir / 'draft.db'
        source = _raw(self.db_path)
        target = sqlite3.connect(draft_copy)
        source.backup(target)
        source.close()
        target.close()
        conn = sqlite3.connect(draft_copy, isolation_level=None)
        try:
            conn.execute('PRAGMA foreign_keys = OFF')
            conn.execute('BEGIN IMMEDIATE')
            for statement in _draft_statements():
                conn.execute(statement)
            conn.execute(f'PRAGMA user_version = {SCHEMA_USER_VERSION}')
            conn.execute('COMMIT')
        finally:
            conn.close()
        CostBasisStore(self.db_path).initialize()
        self.assertEqual(_schema(self.db_path), _schema(draft_copy))

    def test_a_fresh_database_has_the_migrated_schema(self):
        CostBasisStore(self.db_path).initialize()
        fresh = self.dir / 'fresh.db'
        CostBasisStore(fresh).initialize()
        self.assertEqual(_schema(fresh), _schema(self.db_path))
        self.assertEqual(list(self.dir.glob('fresh.pre-*')), [], 'a new file needs no backup')

    def test_a_failure_anywhere_leaves_the_v10_file_untouched(self):
        for point in ('migrate_v11_after_copy', 'migrate_v11_before_commit'):
            with self.subTest(point=point):
                with self.assertRaises(InjectedFault):
                    CostBasisStore(self.db_path, fault_hook=_fault_at(point)).initialize()
                self.assert_untouched_v10()
        CostBasisStore(self.db_path).initialize()
        self.assertEqual(_pragma(self.db_path, 'PRAGMA user_version')[0][0], SCHEMA_USER_VERSION)

    def test_without_a_verified_backup_nothing_is_migrated(self):
        with self.assertRaises(StoreUnavailableError):
            CostBasisStore(self.db_path, fault_hook=_fault_at('migration_backup')).initialize()
        self.assert_untouched_v10()
        self.assertEqual(self.backups(), [], 'a failed backup leaves no partial file')

    def test_the_previous_build_refuses_a_v11_file(self):
        CostBasisStore(self.db_path).initialize()
        with previous_build():
            with self.assertRaises(StoreUnavailableError):
                CostBasisStore(self.db_path).initialize()
            with self.assertRaises(StoreUnavailableError):
                CostBasisStore(self.db_path).list_books()

    def test_rows_left_by_older_deletions_are_kept_and_reported(self):
        conn = _raw(self.db_path)
        try:
            conn.execute(
                "INSERT INTO cost_basis_import_batches (batch_id, book_id, mode, registered_at_utc) "
                "VALUES ('orphanbatch0001', 'deletedbook0001', 'append', '2026-01-01T00:00:00Z')")
        finally:
            conn.close()
        store = CostBasisStore(self.db_path).initialize()
        self.assertEqual(store.last_migration['preservedOrphans'], {'cost_basis_import_batches': 1})
        self.assertEqual(len(_pragma(
            self.db_path, "SELECT * FROM cost_basis_import_batches WHERE book_id = 'deletedbook0001'")), 1)

    def test_a_legacy_futures_book_stays_export_and_delete_only(self):
        store = CostBasisStore(self.db_path).initialize()
        book = store.get_book(LEGACY_FUT_BOOK)
        self.assertTrue(book['legacyFutures'])
        self.assertIsNone(book['fop'])
        self.assertEqual(book['defaultSharesPerContract'], 50, 'the original value is kept for export')
        with self.assertRaises(FuturesBookFrozenError):
            store.append_event(LEGACY_FUT_BOOK, {'kind': 'fee', 'tradeDate': '2026-08-02',
                                                 'cashAmount': -1}, client_token='tok-legacy-0001')
        self.assertEqual(len(store.export_backup(LEGACY_FUT_BOOK)['payload']['events']), 1)
        plan = store.delete_confirmation(LEGACY_FUT_BOOK)
        store.delete_book(LEGACY_FUT_BOOK, confirmation=plan['phrase'], client_token='tok-delete-0001')
        self.assertEqual([b['bookId'] for b in store.list_books()], [self.stock_book])

    def test_a_whole_book_deletion_removes_its_import_registrations(self):
        store = CostBasisStore(self.db_path).initialize()
        conn = _raw(self.db_path)
        try:
            conn.execute(
                "INSERT INTO cost_basis_import_batches (batch_id, book_id, mode, registered_at_utc) "
                "VALUES ('stockbatch00001', ?, 'append', '2026-06-01T00:00:00Z')", (self.stock_book,))
        finally:
            conn.close()
        plan = store.delete_confirmation(self.stock_book)
        store.delete_book(self.stock_book, confirmation=plan['phrase'], client_token='tok-delete-0002')
        for table in ('cost_basis_import_batches', 'cost_basis_book_resets', 'cost_basis_reset_coverage'):
            self.assertEqual(_pragma(self.db_path, f"SELECT * FROM {table} WHERE book_id = '{self.stock_book}'"),
                             [], table)

    def _as_v11(self):
        """The file as the P2 and P3 builds left it: v12 without imports in the request log."""
        old = cost_basis_store._FOP_REQUESTS_STATEMENT.replace("'rebuild', 'import'", "'rebuild'")
        self.assertNotEqual(old, cost_basis_store._FOP_REQUESTS_STATEMENT)
        conn = _raw(self.db_path)
        try:
            conn.execute('BEGIN IMMEDIATE')
            conn.execute('ALTER TABLE cost_basis_fop_requests RENAME TO requests_v12')
            conn.execute(old)
            conn.execute('INSERT INTO cost_basis_fop_requests SELECT * FROM requests_v12')
            conn.execute('DROP TABLE requests_v12')
            conn.execute('PRAGMA user_version = 11')
            conn.execute('COMMIT')
        finally:
            conn.close()

    def test_a_v11_ledger_rebuilds_only_its_request_log(self):
        # P4: the request log holds imports (plan §9.1). A v11 file written by
        # the P2 and P3 builds rebuilds that one table behind a verified backup.
        ledger = FopLedger(self.db_path)
        ledger.append(at(example_event('FUT trade: cash is minus fees, notional stays out'), T_FUT),
                      contracts=[CLZ6])
        for backup in self.backups():
            backup.unlink()
        self._as_v11()
        requests = _rows(self.db_path, 'cost_basis_fop_requests')
        self.assertEqual(len(requests), 1)
        others = {table: _rows(self.db_path, table) for table in _all_tables(self.db_path)
                  if table != 'cost_basis_fop_requests'}
        store = CostBasisStore(self.db_path).initialize()
        self.assertEqual(store.last_migration['fromVersion'], 11)
        self.assertEqual(_pragma(self.db_path, 'PRAGMA user_version')[0][0], SCHEMA_USER_VERSION)
        self.assertEqual(_rows(self.db_path, 'cost_basis_fop_requests'), requests)
        for table, rows in others.items():
            self.assertEqual(_rows(self.db_path, table), rows, table)
        [backup] = self.backups()
        self.assertIn('-from-v11-', backup.name)
        self.assertEqual(_pragma(backup, 'PRAGMA user_version')[0][0], 11)
        fresh = self.dir / 'fresh.db'
        CostBasisStore(fresh).initialize()
        self.assertEqual(_schema(self.db_path), _schema(fresh))
        self.assertEqual(_pragma(self.db_path, 'PRAGMA foreign_key_check'), [])

    def test_a_failed_v12_step_leaves_the_v11_file(self):
        FopLedger(self.db_path)
        self._as_v11()
        schema = _schema(self.db_path)
        for point in ('migrate_v12_after_copy', 'migrate_v12_before_commit'):
            with self.subTest(point=point):
                with self.assertRaises(InjectedFault):
                    CostBasisStore(self.db_path, fault_hook=_fault_at(point)).initialize()
                self.assertEqual(_pragma(self.db_path, 'PRAGMA user_version')[0][0], 11)
                self.assertEqual(_schema(self.db_path), schema)
        CostBasisStore(self.db_path).initialize()
        self.assertEqual(_pragma(self.db_path, 'PRAGMA user_version')[0][0], SCHEMA_USER_VERSION)


T_FUT = '2026-10-01T14:30:05.000000Z'
T_CALL = '2026-10-02T14:00:00.000000Z'
ASSIGN_RANGE = ('2026-11-16T05:00:00.000000Z', '2026-11-18T05:00:00.000000Z')


def _all_tables(path):
    conn = _raw(path)
    try:
        names = [row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")]
        return {name: sorted((tuple(sorted(dict(row).items()))
                              for row in conn.execute(f'SELECT * FROM {name}')), key=repr)
                for name in names}
    finally:
        conn.close()


def fut_trade(instant=T_FUT, **changes):
    event = at(example_event('FUT trade: cash is minus fees, notional stays out'), instant)
    event.update(changes)
    return event


def short_call(instant=T_CALL, **changes):
    event = at(example_event('short call with its contract record'), instant)
    event.update(changes)
    return event


def assignment(**changes):
    event = in_range(example_event('short call assigned: one FUT short at the strike, cash is the fee'),
                     *ASSIGN_RANGE, trade_date='2026-11-17')
    event.update(changes)
    return event


class FopWriteTests(unittest.TestCase):
    """Create, append and void on a FOP ledger (plan §8, §13.3 P2 items 1-2)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = pathlib.Path(self._tmp.name) / 'cost_basis.db'
        self.ledger = FopLedger(self.db_path)
        self.book_id = self.ledger.book_id

    def build_assigned_call(self):
        fut = self.ledger.append(fut_trade(), contracts=[CLZ6])['event']
        call = self.ledger.append(short_call(), contracts=[LOZ6])['event']
        assigned = self.ledger.append(assignment(), bindings=[MANUAL_BINDING])['event']
        return fut, call, assigned

    def test_fop_writes_stay_closed_until_released(self):
        closed = CostBasisStore(self.db_path).initialize()
        with self.assertRaises(FuturesBookFrozenError):
            closed.create_fop_book(account='U2222222', symbol='CL', start_date='2026-01-01',
                                   fop=dict(FOP_META))
        with self.assertRaises(FuturesBookFrozenError):
            self.ledger.append(fut_trade(), contracts=[CLZ6], store=closed)
        with self.assertRaises(FuturesBookFrozenError, msg='the stock path never writes a FOP ledger'):
            self.ledger.store.append_event(self.book_id, {
                'kind': 'futures_trade', 'tradeDate': '2026-10-01', 'account': IDENTITY['account'],
                'futureContracts': 1, 'price': 70, 'cashAmount': 0}, client_token=token())
        self.assertEqual(self.ledger.events(), [])

    def test_a_fop_ledger_keeps_no_stock_multiplier(self):
        book = self.ledger.store.get_book(self.book_id)
        self.assertIsNone(book['defaultSharesPerContract'])
        self.assertEqual(book['fop']['engineVersion'], 1)
        self.assertEqual(book['secType'], 'FUT')
        self.assertFalse(book['legacyFutures'])
        self.assertEqual(_pragma(self.db_path, 'SELECT default_shares_per_contract FROM '
                                 f"cost_basis_books WHERE book_id = '{self.book_id}'")[0][0], None)
        store = self.ledger.store
        with self.assertRaises(BookExistsError):
            store.create_fop_book(account=IDENTITY['account'], symbol='CL', start_date='2026-01-01',
                                  fop=dict(FOP_META))
        for fop, error in (
                (dict(FOP_META, productRules='NYMEX-MCL-v1'), InvalidRequestError),
                (dict(FOP_META, engineVersion=2), FopEngineVersionMismatchError),
                (dict(FOP_META, defaultSharesPerContract=1000), InvalidRequestError)):
            with self.subTest(fop=fop), self.assertRaises(error):
                store.create_fop_book(account='U2222222', symbol='CL', start_date='2026-01-01', fop=fop)
        with self.assertRaises(InvalidRequestError, msg='CL rules are for root CL'):
            store.create_fop_book(account='U2222222', symbol='MCL', start_date='2026-01-01',
                                  fop=dict(FOP_META))
        with self.assertRaises(InvalidRequestError, msg='a stock ledger still needs its multiplier'):
            store.create_book(account='U2222222', symbol='SPY', start_date='2026-01-01',
                              default_shares_per_contract=None)

    def test_a_stock_and_a_fop_ledger_of_one_root_stay_apart(self):
        # P6 migration list: one account holds a STK and a FOP ledger for the same root (F02).
        store = self.ledger.store
        stock = store.create_book(account=IDENTITY['account'], symbol='CL', start_date='2026-01-01',
                                  sec_type='STK', default_shares_per_contract=100)
        self.ledger.append(fut_trade(), contracts=[CLZ6])
        store.append_event(stock['bookId'], {
            'kind': 'share_trade', 'tradeDate': '2026-10-01', 'account': IDENTITY['account'], 'shares': 10,
            'price': 60, 'cashAmount': -600}, client_token=token())
        listed = {(book['symbol'], book['secType']): book for book in store.list_books()}
        self.assertEqual(set(listed), {('CL', 'STK'), ('CL', 'FUT')})
        self.assertEqual((listed[('CL', 'STK')]['defaultSharesPerContract'],
                          listed[('CL', 'FUT')]['fop']['engineVersion']), (100, 1))
        self.assertEqual([event['kind'] for event in store.list_events(stock['bookId'])['events']],
                         ['share_trade'])
        self.assertEqual([event['kind'] for event in self.ledger.events()], ['futures_trade'])
        with self.assertRaises(FuturesBookFrozenError, msg='the stock path never writes the FOP ledger'):
            store.append_event(self.book_id, {'kind': 'share_trade', 'tradeDate': '2026-10-01',
                                              'account': IDENTITY['account'], 'shares': 1, 'price': 60,
                                              'cashAmount': -60}, client_token=token())
        with self.assertRaises(cost_basis_store.CostBasisStoreError, msg='the FOP path never writes the stock ledger'):
            store.append_fop_event(stock['bookId'], package(fut_trade(), contracts=[CLZ6]), client_token=token(),
                                   expected_ledger_version=store.ledger_version(stock['bookId']),
                                   book_identity=dict(IDENTITY, secType='STK'))
        self.assertEqual(len(store.list_events(stock['bookId'])['events']), 1)

    def test_fut_fop_and_delivery_writes_read_back_their_quantities(self):
        fut, call, assigned = self.build_assigned_call()
        self.assertEqual((fut['futureContracts'], fut['contracts']), (1, None))
        self.assertEqual((call['contracts'], call['futureContracts']), (-1, None))
        self.assertEqual((assigned['contracts'], assigned['futureContracts']), (1, -1))
        self.assertEqual(assigned['display']['deliveredContractMonth'], '202612',
                         'the delivery month, never the last-trade month (F03)')
        self.assertEqual(assigned['fop']['bindingRef'], {'bindingId': 'bind-loz6-c75-1', 'revision': 1})
        # trade_date / broker_timestamp are server projections in [tws] timezone.
        self.assertEqual((fut['tradeDate'], fut['brokerTimestamp']), ('2026-10-01', '2026-10-01T10:30:05'))
        self.assertEqual((assigned['tradeDate'], assigned['brokerTimestamp']), ('2026-11-17', None))
        for event in self.ledger.events():
            self.assertEqual(schema.check('ListedFopEvent', event), [], event['kind'])
        conn = _raw(self.db_path)
        try:
            for row in conn.execute('SELECT * FROM cost_basis_events WHERE book_id = ?', (self.book_id,)):
                for column in ('right', 'strike', 'expiry', 'con_id', 'local_symbol', 'option_sec_type',
                               'shares_per_contract', 'shares', 'future_expiry', 'future_con_id',
                               'future_local_symbol', 'roll_to_expiry', 'roll_group', 'split_group'):
                    self.assertIsNone(row[column], (row['kind'], column))
                self.assertEqual((row['tag'], row['allow_overdraw']), ('', 0))
        finally:
            conn.close()

    def test_every_write_checks_identity_version_and_engine(self):
        self.ledger.append(fut_trade(), contracts=[CLZ6])
        stale = self.ledger.version()
        self.ledger.append(short_call(), contracts=[LOZ6])
        with self.assertRaises(LedgerChangedError):
            self.ledger.append(fut_trade('2026-10-03T14:00:00.000000Z'), expected=stale)
        with self.assertRaises(InvalidRequestError):
            self.ledger.append(fut_trade('2026-10-03T14:00:00.000000Z'),
                               identity=dict(IDENTITY, account='U2222222'))
        with self.assertRaises(InvalidRequestError):
            self.ledger.append(fut_trade('2026-10-03T14:00:00.000000Z'), identity=dict(IDENTITY, secType='STK'))
        with self.assertRaises(FopEngineVersionMismatchError):
            self.ledger.append(fut_trade('2026-10-03T14:00:00.000000Z'), engine=2)
        self.assertEqual(len(self.ledger.events()), 2)

    def test_the_same_token_replays_and_a_different_package_is_refused(self):
        first_token = token()
        first = self.ledger.append(fut_trade(), contracts=[CLZ6], client_token=first_token)
        again = self.ledger.append(fut_trade(), contracts=[CLZ6], client_token=first_token,
                                   expected={'digest': 'stale-digest-is-irrelevant-for-a-replay'})
        self.assertTrue(again['idempotentReplay'])
        self.assertEqual(again['event'], first['event'])
        for changed in (fut_trade(price=70.13), fut_trade('2026-10-01T14:30:06.000000Z'),
                        fut_trade(note='another note')):
            with self.subTest(changed=changed['price']), self.assertRaises(InvalidRequestError):
                self.ledger.append(changed, contracts=[CLZ6], client_token=first_token)
        self.assertEqual(len(self.ledger.events()), 1)

    def test_two_writes_prepared_on_one_version_land_only_once(self):
        self.ledger.append(fut_trade(), contracts=[CLZ6])
        version = self.ledger.version()
        barrier = threading.Barrier(2)
        outcomes = []

        def write(instant):
            store = CostBasisStore(self.db_path, fop_writes_enabled=True)
            barrier.wait()
            try:
                self.ledger.append(fut_trade(instant), store=store, expected=version)
                outcomes.append('ok')
            except LedgerChangedError:
                outcomes.append('changed')

        threads = [threading.Thread(target=write, args=(instant,)) for instant in
                   ('2026-10-03T14:00:00.000000Z', '2026-10-03T14:00:01.000000Z')]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(outcomes), ['changed', 'ok'])
        self.assertEqual(len(self.ledger.events()), 2)

    def test_identity_columns_stock_fields_and_other_kinds_are_refused(self):
        self.ledger.append(fut_trade(), contracts=[CLZ6])
        refused = {
            'identity column': fut_trade('2026-10-03T14:00:00.000000Z', futureExpiry='202612'),
            'stock field': fut_trade('2026-10-03T14:00:00.000000Z', shares=100),
            'client trade date': fut_trade('2026-10-03T14:00:00.000000Z', tradeDate='2026-10-03'),
            'client tag': fut_trade('2026-10-03T14:00:00.000000Z', tag='ibkr_open'),
            'client overdraw': fut_trade('2026-10-03T14:00:00.000000Z', allowOverdraw=True),
            'client mismatch flag': fut_trade('2026-10-03T14:00:00.000000Z', derivedMismatch=False),
            'quantity out of the cost': fut_trade('2026-10-03T14:00:00.000000Z', includeInCost=False),
            'aggregated roll': fut_trade('2026-10-03T14:00:00.000000Z', kind='futures_roll'),
            'stock kind': fut_trade('2026-10-03T14:00:00.000000Z', kind='dividend'),
            'notional as cash': fut_trade('2026-10-03T14:00:00.000000Z', cashAmount=-70122.02),
        }
        for name, event in refused.items():
            with self.subTest(name), self.assertRaises(InvalidRequestError):
                self.ledger.append(event)
        self.assertEqual(len(self.ledger.events()), 1)

    def test_contracts_are_one_record_per_contract(self):
        self.ledger.append(fut_trade(), contracts=[CLZ6])
        later = '2026-10-03T14:00:00.000000Z'
        conflicting = {
            'same record, other terms': dict(CLZ6, futurePointValue=100),
            'same conId, other contract': dict(CLZ6, contractId='fut-other-00001', localSymbol='CLF7',
                                               futureContractMonth='202701'),
            'same contract, other record': dict(CLZ6, contractId='fut-clz6-00002', conId=None),
            'other root': dict(CLZ6, contractId='fut-mcl-000001', root='MCL', conId=777),
        }
        for name, record in conflicting.items():
            ref = {'contractId': record['contractId'], 'revision': record['revision']}
            with self.subTest(name), self.assertRaises(FopIdentityConflictError):
                self.ledger.append(fut_trade(later, contractRef=ref), contracts=[record])
        with self.assertRaises(FopReferenceRevisionConflictError, msg='a new revision is a metadata commit'):
            self.ledger.append(fut_trade(later, contractRef={'contractId': CLZ6['contractId'], 'revision': 2}),
                               contracts=[dict(CLZ6, revision=2)])
        with self.assertRaises(FopReferenceRevisionConflictError, msg='an unknown reference'):
            self.ledger.append(fut_trade(later, contractRef={'contractId': 'fut-unknown-01', 'revision': 1}))
        self.assertEqual(len(self.ledger.events()), 1)

    def test_a_verified_binding_needs_this_servers_unexpired_credential(self):
        self.ledger.append(fut_trade(), contracts=[CLZ6])
        self.ledger.append(short_call(), contracts=[LOZ6])
        store = self.ledger.store
        evidence = {'underConId': 555, 'contractMonth': '202612'}
        good = store.issue_binding_credential(self.book_id, status='verified_broker', option=LOZ6,
                                              future=CLZ6, evidence=evidence)
        verified = dict(MANUAL_BINDING, status='verified_broker', evidenceCredential=good)
        forged = {
            'browser-made': dict(verified, evidenceCredential='cand-7f3a19c2'),
            'other status': dict(verified, status='verified_statement'),
            'other ledger': dict(verified, evidenceCredential=store.issue_binding_credential(
                'otherbook0001', status='verified_broker', option=LOZ6, future=CLZ6, evidence=evidence)),
            'other future': dict(verified, evidenceCredential=store.issue_binding_credential(
                self.book_id, status='verified_broker', option=LOZ6,
                future=dict(CLZ6, futureContractMonth='202701'), evidence=evidence)),
            'expired': dict(verified, evidenceCredential=store.issue_binding_credential(
                self.book_id, status='verified_broker', option=LOZ6, future=CLZ6, evidence=evidence,
                ttl_seconds=-1)),
            'another process': dict(verified, evidenceCredential=CostBasisStore(
                self.db_path).issue_binding_credential(self.book_id, status='verified_broker',
                                                       option=LOZ6, future=CLZ6, evidence=evidence)),
        }
        for name, binding in forged.items():
            with self.subTest(name), self.assertRaises(FopBindingEvidenceInvalidError):
                self.ledger.append(assignment(), bindings=[binding])
        assigned = self.ledger.append(assignment(), bindings=[verified])['event']
        digest = _pragma(self.db_path, 'SELECT evidence_digest FROM cost_basis_fop_bindings')[0][0]
        self.assertRegex(digest, r'^[0-9a-f]{64}$')
        self.assertEqual(assigned['fop']['bindingRef']['revision'], 1)

    def test_a_delivery_follows_its_binding_and_the_option_terms(self):
        self.ledger.append(fut_trade(), contracts=[CLZ6])
        self.ledger.append(short_call(), contracts=[LOZ6])
        refused = {
            'wrong direction': (assignment(futureContracts=1), InvalidRequestError),
            'wrong size': (assignment(contracts=1, futureContracts=-2), InvalidRequestError),
            'not the strike': (assignment(price=74.5), InvalidRequestError),
            'unresolved binding': (assignment(), FopBindingEvidenceInvalidError),
        }
        for name, (event, error) in refused.items():
            binding = (dict(MANUAL_BINDING, status='unresolved', futureContractId=None)
                       if name == 'unresolved binding' else MANUAL_BINDING)
            with self.subTest(name), self.assertRaises(error):
                self.ledger.append(event, bindings=[binding])
        self.assertEqual(len(self.ledger.events()), 2)

    def test_a_void_re_proves_the_whole_ledger(self):
        _fut, call, assigned = self.build_assigned_call()
        before = _all_tables(self.db_path)
        with self.assertRaises(PositionOverdrawError, msg='the assignment stands on the short call'):
            self.ledger.void(call['eventId'])
        self.assertEqual(_all_tables(self.db_path), before)
        void_token = token()
        self.ledger.void(assigned['eventId'], client_token=void_token)
        replay = self.ledger.store.void_fop_event(
            self.book_id, assigned['eventId'], reason='entered in error', client_token=void_token,
            expected_ledger_version={'digest': 'irrelevant'}, book_identity=dict(IDENTITY),
            engine_version=1)
        self.assertTrue(replay['idempotentReplay'])
        with self.assertRaises(InvalidRequestError, msg='one token, one void'):
            self.ledger.void(call['eventId'], client_token=void_token)
        with self.assertRaises(EventAlreadyVoidedError):
            self.ledger.void(assigned['eventId'])
        self.ledger.void(call['eventId'])
        self.assertEqual([event['kind'] for event in self.ledger.events()], ['futures_trade'])

    def test_a_failure_anywhere_leaves_every_table_as_it_was(self):
        self.ledger.append(fut_trade(), contracts=[CLZ6])
        before = _all_tables(self.db_path)
        for point in ('fop_after_relations', 'fop_after_event', 'fop_before_commit'):
            store = CostBasisStore(self.db_path, fop_writes_enabled=True, fault_hook=_fault_at(point))
            with self.subTest(point=point):
                with self.assertRaises(InjectedFault):
                    self.ledger.append(short_call(), contracts=[LOZ6], store=store)
                self.assertEqual(_all_tables(self.db_path), before)
        self.ledger.append(short_call(), contracts=[LOZ6])
        self.assertEqual(len(self.ledger.events()), 2)

    def test_a_fee_names_a_live_trade_and_keeps_it_from_being_voided(self):
        fut = self.ledger.append(fut_trade(), contracts=[CLZ6])['event']
        late_fee = at(example_event('a late fee names its stored trade by event id'),
                      '2026-10-05T15:00:00.000000Z')
        late_fee['feeSource'] = {'eventId': fut['eventId'], 'packageKey': None}
        fee = self.ledger.append(late_fee)['event']
        self.assertEqual(fee['fop']['feeSourceEventId'], fut['eventId'])
        with self.assertRaises(FopReferenceRevisionConflictError):
            self.ledger.void(fut['eventId'])
        self.ledger.void(fee['eventId'])
        self.ledger.void(fut['eventId'])
        dangling = copy.deepcopy(late_fee)
        with self.assertRaises(FopReferenceRevisionConflictError, msg='a voided trade is not a source'):
            self.ledger.append(dangling)

    def test_the_version_covers_references_not_only_rows(self):
        self.build_assigned_call()
        version = self.ledger.version()
        conn = _raw(self.db_path)
        try:
            conn.execute('UPDATE cost_basis_fop_event_details SET binding_revision = 2 '
                         'WHERE binding_id IS NOT NULL')
        finally:
            conn.close()
        changed = self.ledger.version()
        self.assertEqual(changed['eventCount'], version['eventCount'])
        self.assertNotEqual(changed['digest'], version['digest'])



class MetadataTests(unittest.TestCase):
    """Binding adoption, contract correction and cycle boundaries (plan §4.3, §1.3)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = pathlib.Path(self._tmp.name) / 'cost_basis.db'
        self.ledger = FopLedger(self.db_path)
        self.store = self.ledger.store
        self.book_id = self.ledger.book_id

    def commit(self, operation, *, client_token=None, expected=None):
        return self.store.commit_fop_metadata(
            self.book_id, operation, client_token=client_token or token(),
            expected_ledger_version=expected or self.ledger.version(),
            book_identity=dict(IDENTITY), engine_version=1)

    def assigned(self):
        self.ledger.append(fut_trade(), contracts=[CLZ6])
        self.ledger.append(short_call(), contracts=[LOZ6])
        return self.ledger.append(assignment(), bindings=[MANUAL_BINDING])['event']

    def verified_revision(self, revision=2, future=CLZ6):
        credential = self.store.issue_binding_credential(
            self.book_id, status='verified_broker', option=LOZ6, future=future,
            evidence={'underConId': 555, 'contractMonth': future['futureContractMonth']})
        return dict(MANUAL_BINDING, revision=revision, status='verified_broker',
                    evidenceCredential=credential,
                    futureContractId=future['contractId'])

    def change(self, event_id, reference, before, after, name):
        return {'eventId': event_id, 'reference': reference,
                'before': {'id': name, 'revision': before}, 'after': {'id': name, 'revision': after}}

    def test_adopting_a_verified_binding_moves_exactly_the_previewed_references(self):
        assigned = self.assigned()
        version = self.ledger.version()
        binding = self.verified_revision()
        with self.assertRaises(FopReferenceRevisionConflictError, msg='a stale preview lists nothing'):
            self.commit({'kind': 'adopt_binding', 'binding': binding, 'affected': []})
        with self.assertRaises(FopReferenceRevisionConflictError, msg='revisions do not skip'):
            self.commit({'kind': 'adopt_binding', 'binding': self.verified_revision(3), 'affected': []})
        affected = [self.change(assigned['eventId'], 'binding', 1, 2, 'bind-loz6-c75-1')]
        result = self.commit({'kind': 'adopt_binding', 'binding': binding, 'affected': affected})
        self.assertEqual(result['operation']['referenceChanges'], affected)
        self.assertNotEqual(result['ledgerVersion']['digest'], version['digest'])
        self.assertEqual(result['ledgerVersion']['eventCount'], version['eventCount'])
        listed = [e for e in self.ledger.events() if e['eventId'] == assigned['eventId']][0]
        self.assertEqual(listed['fop']['bindingRef'], {'bindingId': 'bind-loz6-c75-1', 'revision': 2})
        rows = _pragma(self.db_path, 'SELECT revision, status, superseded_by_revision FROM '
                                     'cost_basis_fop_bindings ORDER BY revision')
        self.assertEqual([tuple(row) for row in rows],
                         [(1, 'manual_attested', 2), (2, 'verified_broker', None)])

    def unresolved_call(self, option=LOZ6):
        """A short call no statement or broker has bound yet; the ledger holds no FUT."""
        unresolved = dict(MANUAL_BINDING, status='unresolved', futureContractId=None,
                          evidenceSummary='the statement names no underlying future')
        return self.ledger.append(short_call(), contracts=[option], bindings=[unresolved])['event']

    def broker_proof(self, option=LOZ6, future=CLZ6):
        """What request_cost_basis_fop_contract_details answers for the option (plan §19 P5-C2)."""
        future = dict(future, evidenceStatus='verified_broker', evidenceSummary='IB contract details via underConId')
        credential = self.store.issue_binding_credential(
            self.book_id, status='verified_broker', option=option,
            future=dict(future, contractId=None, revision=None),
            evidence={'optionConId': 9001, 'underConId': 555, 'contractMonth': future['futureContractMonth']})
        binding = dict(MANUAL_BINDING, revision=2, status='verified_broker', evidenceCredential=credential,
                       futureContractId=future['contractId'], evidenceSummary='IB: LOZ6 C7500 -> CLZ6')
        return binding, future

    def test_an_adoption_brings_the_future_the_broker_proved(self):
        self.unresolved_call()
        binding, future = self.broker_proof()
        before = _all_tables(self.db_path)
        refusals = [
            ({'kind': 'adopt_binding', 'binding': binding, 'affected': []}, FopIdentityConflictError,
             'the ledger holds no such future'),
            ({'kind': 'adopt_binding', 'binding': binding, 'contracts': [dict(future, conId=556)], 'affected': []},
             FopBindingEvidenceInvalidError, 'a future the broker did not prove'),
            ({'kind': 'adopt_binding', 'binding': dict(binding, status='manual_attested', evidenceCredential=None),
              'contracts': [future], 'affected': []}, FopBindingEvidenceInvalidError,
             'contracts travel only with verified evidence'),
            ({'kind': 'adopt_binding', 'binding': binding,
              'contracts': [future, dict(future, contractId='fut-clf7-0009', futureContractMonth='202701')],
              'affected': []}, FopIdentityConflictError, 'a contract that is neither side of the binding'),
        ]
        for operation, error, why in refusals:
            with self.subTest(why), self.assertRaises(error):
                self.commit(operation)
            self.assertEqual(_all_tables(self.db_path), before, why)
        confirm = token('adopt')
        result = self.commit({'kind': 'adopt_binding', 'binding': binding, 'contracts': [future], 'affected': []},
                             client_token=confirm)
        self.assertEqual(result['operation']['kind'], 'adopt_binding')
        rows = _pragma(self.db_path, 'SELECT contract_id, revision, evidence_status FROM cost_basis_fop_contracts '
                                     'WHERE sec_type = "FUT"')
        self.assertEqual([tuple(row) for row in rows], [('fut-clz6-0001', 1, 'verified_broker')])
        rows = _pragma(self.db_path, 'SELECT revision, status, future_contract_id FROM cost_basis_fop_bindings '
                                     'ORDER BY revision')
        self.assertEqual([tuple(row) for row in rows],
                         [(1, 'unresolved', None), (2, 'verified_broker', 'fut-clz6-0001')])
        # The same confirmation again is its first answer.
        after = _all_tables(self.db_path)
        again = self.commit({'kind': 'adopt_binding', 'binding': binding, 'contracts': [future], 'affected': []},
                            client_token=confirm, expected=self.ledger.version())
        self.assertTrue(again['idempotentReplay'])
        self.assertEqual(_all_tables(self.db_path), after)

    def test_an_adoption_fills_in_the_option_terms_the_broker_proved(self):
        call = self.unresolved_call(dict(LOZ6, conId=None, localSymbol=None))
        self.ledger.append(fut_trade(), contracts=[CLZ6])
        binding, _future = self.broker_proof(future=CLZ6)
        revised = dict(LOZ6, revision=2, evidenceStatus='verified_broker', evidenceSummary='IB contract details')
        moved = [self.change(call['eventId'], 'contract', 1, 2, LOZ6['contractId'])]
        with self.assertRaises(FopBindingEvidenceInvalidError, msg='the stored option lacks the proved conId'):
            self.commit({'kind': 'adopt_binding', 'binding': binding, 'affected': []})
        with self.assertRaises(FopReferenceRevisionConflictError, msg='the preview lists every moved reference'):
            self.commit({'kind': 'adopt_binding', 'binding': binding, 'contracts': [revised], 'affected': []})
        result = self.commit({'kind': 'adopt_binding', 'binding': binding, 'contracts': [revised],
                              'affected': moved})
        self.assertEqual(result['operation']['referenceChanges'], moved)
        listed = [event for event in self.ledger.events() if event['eventId'] == call['eventId']][0]
        self.assertEqual(listed['fop']['contractRef'], {'contractId': LOZ6['contractId'], 'revision': 2})
        self.assertEqual(listed['display']['localSymbol'], 'LOZ6 C7500')

    def test_a_confirmed_delivery_is_not_moved_to_another_future_by_a_binding(self):
        assigned = self.assigned()
        clf7 = dict(CLZ6, contractId='fut-clf7-0001', conId=556, localSymbol='CLF7',
                    futureContractMonth='202701', futureLastTradeDate='2026-12-17')
        self.ledger.append(fut_trade('2026-10-03T14:00:00.000000Z',
                                     contractRef={'contractId': 'fut-clf7-0001', 'revision': 1}),
                           contracts=[clf7])
        with self.assertRaises(FopIdentityConflictError):
            self.commit({'kind': 'adopt_binding', 'binding': self.verified_revision(future=clf7),
                         'affected': [self.change(assigned['eventId'], 'binding', 1, 2,
                                                  'bind-loz6-c75-1')]})

    def test_a_contract_correction_only_fills_in_what_was_unknown(self):
        without_con_id = dict(CLZ6, conId=None, localSymbol=None)
        fut = self.ledger.append(fut_trade(), contracts=[without_con_id])['event']
        filled = dict(CLZ6, revision=2, evidenceStatus='verified_broker')
        with self.assertRaises(FopIdentityConflictError, msg='a month change is an economic correction'):
            self.commit({'kind': 'correct_contract', 'contract': dict(filled, futureContractMonth='202701'),
                         'affected': [self.change(fut['eventId'], 'contract', 1, 2, CLZ6['contractId'])]})
        result = self.commit({'kind': 'correct_contract', 'contract': filled, 'affected': [
            self.change(fut['eventId'], 'contract', 1, 2, CLZ6['contractId'])]})
        self.assertEqual(len(result['operation']['referenceChanges']), 1)
        listed = self.ledger.events()[0]
        self.assertEqual(listed['fop']['contractRef']['revision'], 2)
        self.assertEqual(listed['display']['localSymbol'], 'CLZ6')
        with self.assertRaises(FopReferenceRevisionConflictError, msg='new writes use the current revision'):
            self.ledger.append(fut_trade('2026-10-04T14:00:00.000000Z'))

    def test_a_cycle_closes_only_where_every_balance_is_zero(self):
        opened = self.ledger.append(fut_trade(), contracts=[CLZ6])['event']
        closed = self.ledger.append(fut_trade('2026-10-02T15:00:00.000000Z', futureContracts=-1,
                                              openClose='C'))['event']
        with self.assertRaises(FopCycleBoundaryViolatedError):
            self.commit({'kind': 'close_cycle', 'boundaryId': 'cycle-000000001',
                         'anchorEventId': opened['eventId'], 'label': ''})
        self.commit({'kind': 'close_cycle', 'boundaryId': 'cycle-000000001',
                     'anchorEventId': closed['eventId'], 'label': '2026 第一轮'})
        with self.assertRaises(FopCycleBoundaryViolatedError, msg='a back-dated open moves the zero'):
            self.ledger.append(fut_trade('2026-10-02T09:00:00.000000Z'))
        with self.assertRaises(FopCycleBoundaryViolatedError, msg='the anchor cannot be voided'):
            self.ledger.void(closed['eventId'])
        self.ledger.append(fut_trade('2026-10-05T09:00:00.000000Z'))
        self.commit({'kind': 'revoke_cycle', 'boundaryId': 'cycle-000000001'})
        self.ledger.append(fut_trade('2026-10-02T09:00:00.000000Z'))
        rows = _pragma(self.db_path, 'SELECT revision, state, superseded_by_revision FROM '
                                     'cost_basis_fop_cycles ORDER BY revision')
        self.assertEqual([tuple(row) for row in rows], [(1, 'closed', 2), (2, 'revoked', None)])

    def test_one_token_one_operation(self):
        opened = self.ledger.append(fut_trade(), contracts=[CLZ6])['event']
        self.ledger.append(fut_trade('2026-10-02T15:00:00.000000Z', futureContracts=-1,
                                     openClose='C'))
        closing = self.ledger.events()[-1]
        once = token()
        operation = {'kind': 'close_cycle', 'boundaryId': 'cycle-000000002',
                     'anchorEventId': closing['eventId'], 'label': ''}
        first = self.commit(operation, client_token=once)
        again = self.commit(operation, client_token=once, expected={'digest': 'irrelevant'})
        self.assertTrue(again['idempotentReplay'])
        self.assertEqual(again['operation'], first['operation'])
        with self.assertRaises(InvalidRequestError):
            self.commit(dict(operation, label='another label'), client_token=once)
        with self.assertRaises(InvalidRequestError, msg='the shape is the contract'):
            self.commit({'kind': 'close_cycle', 'boundaryId': 'cycle-000000003',
                         'anchorEventId': opened['eventId']})

    def test_a_correction_cannot_make_two_records_of_one_contract(self):
        # P2 review R3: filling in tradingClass (conId still unknown) would make
        # this record the same real contract as another current one.
        cases = {
            'FUT': (dict(CLZ6, conId=None, tradingClass=None, localSymbol=None),
                    dict(CLZ6, contractId='fut-clz6-dup-001', conId=None, localSymbol=None),
                    fut_trade, '2026-10-02T14:30:05.000000Z'),
            'FOP': (dict(LOZ6, conId=None, tradingClass=None, localSymbol=None),
                    dict(LOZ6, contractId='fop-loz6-dup-001', conId=None, localSymbol=None),
                    short_call, '2026-10-03T14:00:00.000000Z'),
        }
        for index, (sec_type, (bare, other, event, later)) in enumerate(cases.items()):
            with self.subTest(sec_type):
                ledger = FopLedger(self.db_path.with_name(f'identity-{index}.db'))
                store = ledger.store
                first = ledger.append(event(), contracts=[bare])['event']
                ledger.append(event(later, contractRef={'contractId': other['contractId'],
                                                        'revision': 1}), contracts=[other])
                before = _all_tables(ledger.db_path)
                affected = [self.change(first['eventId'], 'contract', 1, 2, bare['contractId'])]

                def correct(record):
                    return store.commit_fop_metadata(
                        ledger.book_id, {'kind': 'correct_contract', 'contract': record,
                                         'affected': affected},
                        client_token=token(), expected_ledger_version=ledger.version(),
                        book_identity=dict(IDENTITY), engine_version=1)

                with self.assertRaises(FopIdentityConflictError):
                    correct(dict(bare, revision=2, tradingClass=other['tradingClass']))
                self.assertEqual(_all_tables(ledger.db_path), before,
                                 'no revision, reference move or operation is left behind')
                filled = correct(dict(bare, revision=2, localSymbol=other['localSymbol']))
                self.assertEqual(len(filled['operation']['referenceChanges']), 1)

    def test_a_retried_request_is_the_same_request_after_later_metadata_commits(self):
        # P2 review R7: a retry is recognised by what it asked, not re-judged
        # against references a later correction or adoption moved.
        delivery = token()
        self.ledger.append(fut_trade(), contracts=[CLZ6])
        self.ledger.append(short_call(), contracts=[LOZ6])
        assigned = self.ledger.append(assignment(), bindings=[MANUAL_BINDING],
                                      client_token=delivery)
        self.commit({'kind': 'adopt_binding', 'binding': self.verified_revision(), 'affected': [
            self.change(assigned['event']['eventId'], 'binding', 1, 2, 'bind-loz6-c75-1')]})
        again = self.ledger.append(assignment(), bindings=[MANUAL_BINDING], client_token=delivery)
        self.assertEqual(again, dict(assigned, idempotentReplay=True))
        self.assertEqual(len(self.ledger.events()), 3)

        ledger = FopLedger(self.db_path.with_name('retry.db'))
        without = dict(CLZ6, conId=None, localSymbol=None)
        once = token()
        first = ledger.append(fut_trade(), contracts=[without], client_token=once)
        ledger.store.commit_fop_metadata(
            ledger.book_id, {'kind': 'correct_contract', 'contract': dict(CLZ6, revision=2),
                             'affected': [self.change(first['event']['eventId'], 'contract', 1, 2,
                                                      CLZ6['contractId'])]},
            client_token=token(), expected_ledger_version=ledger.version(),
            book_identity=dict(IDENTITY), engine_version=1)
        again = ledger.append(fut_trade(), contracts=[without], client_token=once)
        self.assertEqual(again, dict(first, idempotentReplay=True))
        self.assertEqual(len(ledger.events()), 1)
        with self.assertRaises(InvalidRequestError, msg='the same token, another package'):
            ledger.append(fut_trade(price=70.2), contracts=[without], client_token=once)
        self.assertEqual(len(ledger.events()), 1)



def tws(event, ref, quantity, fees):
    """The event as one TWS execution: its source record and its allocation."""
    event = copy.deepcopy(event)
    event.update(source='execution_report', externalRef=ref,
                 sources=[{'namespace': 'tws_exec', 'sourceRef': ref, 'role': 'trade',
                           'quantity': quantity, 'fees': fees}])
    record = {'account': IDENTITY['account'], 'namespace': 'tws_exec', 'sourceRef': ref,
              'capabilityKey': None, 'format': 'tws_execution', 'section': None,
              'rawFields': {'execId': ref, 'shares': str(abs(quantity))},
              'statedQuantity': quantity, 'statedFees': fees}
    return event, record


def _graph(payload):
    """A payload without the fields a restore legitimately changes: the book's
    write stamp, and the request log, which also gains the reset and restore
    requests themselves (_assert_same_graph checks nothing of it was lost)."""
    payload = copy.deepcopy(payload)
    payload['book'].pop('updatedAtUtc')
    payload.pop('requests')
    return payload


def _assert_same_graph(test, restored, backup):
    test.assertEqual(_graph(restored), _graph(backup))
    logged = {request['clientToken']: request for request in restored['requests']}
    for request in backup['requests']:
        test.assertEqual(logged.get(request['clientToken']), request, 'the request log came through')


def _sealed(backup, payload):
    """backup carrying payload under a correct checksum: only the graph rules can refuse it."""
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return dict(backup, payload=payload, sha256=hashlib.sha256(encoded.encode()).hexdigest())


def _count(path, table):
    return _pragma(path, f'SELECT count(*) FROM {table}')[0][0]


class GraphTests(unittest.TestCase):
    """Backup v2, reset archives, restore, rebuild and delete (plan §8.3, §13.3 P2 item 4)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = pathlib.Path(self._tmp.name) / 'cost_basis.db'
        self.ledger = FopLedger(self.db_path)
        self.store = self.ledger.store
        self.book_id = self.ledger.book_id

    def commit(self, operation):
        return self.store.commit_fop_metadata(
            self.book_id, operation, client_token=token(),
            expected_ledger_version=self.ledger.version(), book_identity=dict(IDENTITY),
            engine_version=1)

    def build(self):
        """FUT bought, call sold, assigned (a closed cycle), a late fee on the
        FUT trade, an adopted binding revision, a voided row, TWS sources."""
        fut, fut_source = tws(fut_trade(), 'exec-fut-000001', 1, 2.02)
        fut = self.ledger.append(fut, contracts=[CLZ6], sources=[fut_source])['event']
        call, call_source = tws(short_call(), 'exec-call-00001', -1, 2.5)
        self.ledger.append(call, contracts=[LOZ6], sources=[call_source])
        assigned = self.ledger.append(assignment(), bindings=[MANUAL_BINDING])['event']
        fee = at(example_event('a late fee names its stored trade by event id'),
                 '2026-11-20T15:00:00.000000Z')
        fee['feeSource'] = {'eventId': fut['eventId'], 'packageKey': None}
        self.ledger.append(fee)
        mistaken = self.ledger.append(at(example_event('evidenced strategy adjustment'),
                                         '2026-11-21T15:00:00.000000Z'))['event']
        self.ledger.void(mistaken['eventId'])
        credential = self.store.issue_binding_credential(
            self.book_id, status='verified_broker', option=LOZ6, future=CLZ6,
            evidence={'underConId': 555})
        self.commit({'kind': 'adopt_binding', 'binding': dict(
            MANUAL_BINDING, revision=2, status='verified_broker', evidenceCredential=credential),
            'affected': [{'eventId': assigned['eventId'], 'reference': 'binding',
                          'before': {'id': 'bind-loz6-c75-1', 'revision': 1},
                          'after': {'id': 'bind-loz6-c75-1', 'revision': 2}}]})
        self.commit({'kind': 'close_cycle', 'boundaryId': 'cycle-000000001',
                     'anchorEventId': assigned['eventId'], 'label': '第一轮'})
        return assigned

    def plan(self):
        return self.store.reset_confirmation(self.book_id)

    def restore(self, backup, *, store=None, client_token=None, confirmation=None):
        plan = self.plan()
        return (store or self.store).restore_backup(
            self.book_id, backup, confirmation=confirmation or plan['phrase'],
            client_token=client_token or token(), expected_ledger_version=plan['ledgerVersion'],
            book_identity=dict(IDENTITY), engine_version=1)

    def reset(self, *, client_token=None, reason=''):
        plan = self.plan()
        return self.store.reset_book(
            self.book_id, confirmation=plan['phrase'], client_token=client_token or token(),
            reason=reason, expected_ledger_version=plan['ledgerVersion'],
            book_identity=dict(IDENTITY), engine_version=1)

    def restore_reset(self, reset_id, *, client_token=None):
        plan = self.plan()
        return self.store.restore_book_reset(
            self.book_id, reset_id, confirmation=plan['phrase'],
            client_token=client_token or token(), expected_ledger_version=plan['ledgerVersion'],
            book_identity=dict(IDENTITY), engine_version=1)

    def test_a_fop_backup_is_version_2_and_matches_the_contract(self):
        self.build()
        backup = self.store.export_backup(self.book_id)
        self.assertEqual((backup['version'], backup['kind']), (2, 'fop'))
        self.assertEqual(schema.check('BackupEnvelopeV2', backup), [])
        self.assertEqual(domain.backup_digest(backup['payload']), backup['sha256'])
        payload = backup['payload']
        self.assertEqual(len(payload['events']), 5)
        self.assertEqual(len(payload['bindings']), 2)
        self.assertEqual({op['kind'] for op in payload['operations']}, {'adopt_binding', 'close_cycle'})
        self.assertEqual(len(payload['referenceRevisions']), 1)
        self.assertEqual(len(payload['allocations']), 2)

    def test_a_backup_restores_the_whole_graph_into_its_ledger(self):
        self.build()
        backup = self.store.export_backup(self.book_id)
        version = self.ledger.version()
        plan = self.plan()
        self.store.reset_book(self.book_id, confirmation=plan['phrase'], client_token=token(),
                              expected_ledger_version=plan['ledgerVersion'],
                              book_identity=dict(IDENTITY), engine_version=1)
        self.assertEqual(self.ledger.events(include_voided=True), [])
        result = self.restore(backup)
        self.assertFalse(result['remapped'])
        self.assertEqual(result['restoredEvents'], 5)
        _assert_same_graph(self, self.store.export_backup(self.book_id)['payload'],
                           backup['payload'])
        self.assertEqual(self.ledger.version()['digest'], version['digest'])

    def test_a_backup_a_browser_parsed_and_wrote_again_still_restores(self):
        # P5: the page downloads a backup through JSON.parse/JSON.stringify,
        # which writes 70.0 as 70; the digest reads whole numbers as integers,
        # while any changed figure still fails it.
        self.build()
        backup = self.store.export_backup(self.book_id)
        script = ('let s = ""; process.stdin.on("data", (d) => { s += d; })'
                  '.on("end", () => process.stdout.write(JSON.stringify(JSON.parse(s))));')
        browser = json.loads(subprocess.check_output(['node', '-e', script], input=json.dumps(backup), text=True))
        self.assertNotEqual(json.dumps(browser['payload'], sort_keys=True),
                            json.dumps(backup['payload'], sort_keys=True), 'the fixture has whole floats')
        version = self.ledger.version()
        tampered = copy.deepcopy(browser)
        tampered['payload']['events'][0]['row']['price'] += 0.01
        with self.assertRaises(InvalidRequestError):
            self.restore(tampered)
        self.assertEqual(self.ledger.version(), version)
        self.assertEqual(self.restore(browser)['restoredEvents'], 5)
        self.assertEqual(self.ledger.version()['digest'], version['digest'])

    def test_a_backup_restores_into_another_ledger_id_with_every_id_remapped(self):
        self.build()
        backup = self.store.export_backup(self.book_id)
        original = self.ledger.version()
        self.store.archive_book(self.book_id)
        other = self.store.create_fop_book(account=IDENTITY['account'], symbol='CL',
                                           start_date='2026-01-01', fop=dict(FOP_META))
        plan = self.store.reset_confirmation(other['bookId'])
        result = self.store.restore_backup(
            other['bookId'], backup, confirmation=plan['phrase'], client_token=token(),
            expected_ledger_version=plan['ledgerVersion'], book_identity=dict(IDENTITY),
            engine_version=1)
        self.assertTrue(result['remapped'])
        restored = self.store.export_backup(other['bookId'])['payload']
        old_ids = {e['row']['eventId'] for e in backup['payload']['events']}
        new_ids = {e['row']['eventId'] for e in restored['events']}
        self.assertFalse(old_ids & new_ids)
        self.assertEqual([e['row']['kind'] for e in restored['events']],
                         [e['row']['kind'] for e in backup['payload']['events']])
        [cycle] = [c for c in restored['cycles'] if c['state'] == 'closed']
        self.assertIn(cycle['anchorEventId'], new_ids)
        fee = [e for e in restored['events'] if e['row']['kind'] == 'fee'][0]
        self.assertIn(fee['row']['fop']['feeSourceEventId'], new_ids)
        self.assertEqual(self.store.ledger_version(self.book_id), original, 'the source is untouched')
        self.assertEqual(_pragma(self.db_path, 'PRAGMA foreign_key_check'), [])

    def test_a_restore_refuses_damaged_or_foreign_backups_and_changes_nothing(self):
        self.build()
        backup = self.store.export_backup(self.book_id)
        before = _all_tables(self.db_path)

        def resealed(payload):
            encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
            return dict(backup, payload=payload, sha256=hashlib.sha256(encoded.encode()).hexdigest())

        bad_cash = copy.deepcopy(backup['payload'])
        bad_cash['events'][0]['row']['cashAmount'] = -70122.02
        dangling = copy.deepcopy(backup['payload'])
        dangling['allocations'][0]['eventId'] = 'evt-missing-0001'
        other_symbol = copy.deepcopy(backup['payload'])
        other_symbol['book']['symbol'] = 'MCL'
        cross_book = copy.deepcopy(backup['payload'])
        cross_book['events'][3]['row']['fop']['feeSourceEventId'] = 'evt-another-book'
        wrong_way = copy.deepcopy(backup['payload'])
        wrong_way['events'][2]['row']['futureContracts'] = 1  # a short call assigned delivers -1
        v1 = dict(backup, version=1)
        cases = {
            'delivery direction': (resealed(wrong_way), InvalidRequestError),
            'checksum': (dict(backup, sha256='0' * 64), InvalidRequestError),
            'kind rules': (resealed(bad_cash), InvalidRequestError),
            'dangling allocation': (resealed(dangling), InvalidRequestError),
            'another ledger identity': (resealed(other_symbol), InvalidRequestError),
            'fee source outside the graph': (resealed(cross_book), FopReferenceRevisionConflictError),
            'version 1': (v1, InvalidRequestError),
        }
        for name, (candidate, error) in cases.items():
            with self.subTest(name), self.assertRaises(error):
                self.restore(candidate)
            self.assertEqual(_all_tables(self.db_path), before, name)

    def test_reset_and_restore_of_its_archive_round_trip(self):
        self.build()
        backup = self.store.export_backup(self.book_id)
        plan = self.plan()
        reset = self.store.reset_book(self.book_id, confirmation=plan['phrase'], client_token=token(),
                                      expected_ledger_version=plan['ledgerVersion'],
                                      book_identity=dict(IDENTITY), engine_version=1)
        self.assertEqual(reset['removedEvents'], 5)
        for table in FOP_GRAPH_TABLES:
            if table != 'cost_basis_fop_books':
                self.assertEqual(_pragma(self.db_path, f'SELECT count(*) FROM {table}')[0][0], 0, table)
        self.assertIsNotNone(self.store.get_book(self.book_id)['fop'], 'still a FOP ledger')
        with self.assertRaises(ResetConfirmationError):
            self.store.restore_book_reset(self.book_id, reset['resetId'], confirmation='wrong',
                                          client_token=token(), book_identity=dict(IDENTITY), engine_version=1,
                                          expected_ledger_version=self.ledger.version())
        plan = self.plan()
        self.store.restore_book_reset(self.book_id, reset['resetId'], confirmation=plan['phrase'],
                                      client_token=token(), book_identity=dict(IDENTITY), engine_version=1,
                                      expected_ledger_version=plan['ledgerVersion'])
        _assert_same_graph(self, self.store.export_backup(self.book_id)['payload'],
                           backup['payload'])

    def test_a_failure_anywhere_in_a_graph_write_leaves_every_table(self):
        self.build()
        backup = self.store.export_backup(self.book_id)
        before = _all_tables(self.db_path)
        for point in ('fop_after_archive', 'fop_after_graph', 'fop_before_commit'):
            store = CostBasisStore(self.db_path, fop_writes_enabled=True, fault_hook=_fault_at(point))
            with self.subTest(point=point):
                with self.assertRaises(InjectedFault):
                    self.restore(backup, store=store)
                self.assertEqual(_all_tables(self.db_path), before)
        store = CostBasisStore(self.db_path, fop_writes_enabled=True,
                               fault_hook=_fault_at('fop_after_archive'))
        plan = self.plan()
        with self.assertRaises(InjectedFault):
            store.reset_book(self.book_id, confirmation=plan['phrase'], client_token=token(),
                             expected_ledger_version=plan['ledgerVersion'],
                             book_identity=dict(IDENTITY), engine_version=1)
        self.assertEqual(_all_tables(self.db_path), before)

    def rebuild(self, *events, contracts=(), bindings=(), sources=(), revoke=(), store=None,
                client_token=None, import_batch_id=None):
        plan = self.plan()
        return (store or self.store).rebuild_fop_book(
            self.book_id, package(*events, contracts=contracts, bindings=bindings, sources=sources),
            confirmation=plan['phrase'], client_token=client_token or token(),
            import_batch_id=import_batch_id or token('batch'), revoke_boundaries=revoke,
            expected_ledger_version=plan['ledgerVersion'], book_identity=dict(IDENTITY))

    def simple_cycle(self):
        opened, opened_source = tws(fut_trade(), 'exec-open-00001', 1, 2.02)
        closed, closed_source = tws(fut_trade('2026-10-02T15:00:00.000000Z', futureContracts=-1,
                                              openClose='C'), 'exec-close-0001', -1, 2.02)
        self.ledger.append(opened, contracts=[CLZ6], sources=[opened_source])
        anchor = self.ledger.append(closed, sources=[closed_source])['event']
        self.commit({'kind': 'close_cycle', 'boundaryId': 'cycle-000000001',
                     'anchorEventId': anchor['eventId'], 'label': ''})
        return (opened, opened_source), (closed, closed_source), anchor

    def test_a_rebuild_carries_a_boundary_to_the_one_matching_event(self):
        (opened, opened_source), (closed, closed_source), anchor = self.simple_cycle()
        fee = at(example_event('a late fee names its stored trade by event id'),
                 '2026-10-03T15:00:00.000000Z')
        fee['feeSource'] = {'eventId': None, 'packageKey': 'pkg-open-00001'}
        opened = dict(opened, packageKey='pkg-open-00001')
        result = self.rebuild(opened, closed, fee, contracts=[CLZ6],
                              sources=[opened_source, closed_source])
        self.assertEqual(result['inserted'], 3)
        mapped = {m['oldEventId']: m['newEventId'] for m in result['eventIdMappings']}
        self.assertIn(anchor['eventId'], mapped)
        [cycle] = _pragma(self.db_path, 'SELECT anchor_event_id, revision FROM cost_basis_fop_cycles')
        self.assertEqual(tuple(cycle), (mapped[anchor['eventId']], 2))
        kinds = {e['kind']: e for e in self.ledger.events()}
        self.assertEqual(kinds['fee']['fop']['feeSourceEventId'],
                         [e['eventId'] for e in self.ledger.events()
                          if e['kind'] == 'futures_trade' and e['futureContracts'] == 1][0])
        operation = _pragma(self.db_path, "SELECT kind FROM cost_basis_fop_operations")
        self.assertEqual([row[0] for row in operation], ['rebuild'])

    def test_a_rebuild_that_cannot_map_a_boundary_is_refused_unless_it_revokes_it(self):
        (opened, opened_source), (closed, closed_source), anchor = self.simple_cycle()
        before = _all_tables(self.db_path)
        repriced = dict(closed, price=71.5)
        with self.assertRaises(FopCycleBoundaryViolatedError):
            self.rebuild(opened, repriced, contracts=[CLZ6], sources=[opened_source, closed_source])
        self.assertEqual(_all_tables(self.db_path), before)
        store = CostBasisStore(self.db_path, fop_writes_enabled=True,
                               fault_hook=_fault_at('fop_after_event'))
        with self.assertRaises(InjectedFault):
            self.rebuild(opened, repriced, contracts=[CLZ6], sources=[opened_source, closed_source],
                         revoke=['cycle-000000001'], store=store)
        self.assertEqual(_all_tables(self.db_path), before)
        result = self.rebuild(opened, repriced, contracts=[CLZ6],
                              sources=[opened_source, closed_source], revoke=['cycle-000000001'])
        self.assertEqual(result['revokedBoundaries'], ['cycle-000000001'])
        self.assertEqual(_pragma(self.db_path, 'SELECT count(*) FROM cost_basis_fop_cycles')[0][0], 0)
        self.assertNotIn(anchor['eventId'], {m['oldEventId'] for m in result['eventIdMappings']})

    def test_a_whole_book_deletion_removes_the_whole_graph(self):
        self.build()
        other = FopLedger(self.db_path.with_name('other.db'))
        plan = self.store.delete_confirmation(self.book_id)
        self.store.delete_book(self.book_id, confirmation=plan['phrase'], client_token=token())
        for table in FOP_TABLES + ('cost_basis_events', 'cost_basis_book_resets'):
            self.assertEqual(_pragma(self.db_path, f'SELECT count(*) FROM {table}')[0][0], 0, table)
        self.assertEqual(_pragma(self.db_path, 'PRAGMA foreign_key_check'), [])
        self.assertEqual(len(other.store.list_books()), 1)

    # -- P2 review round 1 (CODE PLAN/COST_BASIS_FOP_P2_REVIEW_20260924.md) --

    def test_the_version_is_the_whole_content_so_a_changed_restore_expires_old_previews(self):
        # R1: a restore with other terms, economics, times or evidence under
        # the same ids and revisions is another version; the same content is
        # the same version.
        self.build()
        backup = self.store.export_backup(self.book_id)
        reviewed = self.ledger.version()

        def fut_record(payload):
            return next(c['record'] for c in payload['contracts']
                        if c['record']['contractId'] == CLZ6['contractId'])

        changes = {
            'point value': lambda p: fut_record(p).update(futurePointValue=500),
            'event price': lambda p: p['events'][0]['row'].update(price=70.5),
            'execution time': lambda p: p['events'][0]['row']['fop']['time'].update(
                executedAtUtc='2026-10-01T14:30:05.500000Z'),
            'binding evidence': lambda p: p['bindings'][0].update(evidenceSummary='another reading'),
            'source raw field': lambda p: p['sources'][0]['rawFields'].update(exchange='NYMEX'),
        }
        for name, change in changes.items():
            with self.subTest(name):
                payload = copy.deepcopy(backup['payload'])
                change(payload)
                self.restore(_sealed(backup, payload))
                self.assertNotEqual(self.ledger.version()['digest'], reviewed['digest'])
                with self.assertRaises(LedgerChangedError):
                    self.ledger.append(fut_trade('2026-12-01T14:00:00.000000Z'), expected=reviewed)
                self.restore(backup)
                self.assertEqual(self.ledger.version()['digest'], reviewed['digest'],
                                 'the reviewed content is the reviewed version again')

    def test_a_restore_proves_every_relation_before_it_writes(self):
        # R2: relations no live event uses are proven too, allocations stay
        # within their source, and every id must be inside this ledger.
        fut, fut_source = tws(fut_trade(), 'exec-fut-000001', 1, 2.02)
        self.ledger.append(fut, contracts=[CLZ6], sources=[fut_source])
        call, call_source = tws(short_call(), 'exec-call-00001', -1, 2.5)
        # A binding no delivery uses yet.
        self.ledger.append(call, contracts=[LOZ6], sources=[call_source], bindings=[MANUAL_BINDING])
        stock = self.store.create_book(account=IDENTITY['account'], symbol='SPY',
                                       start_date='2026-01-01', default_shares_per_contract=100)
        self.store.append_event(stock['bookId'], {
            'kind': 'share_trade', 'tradeDate': '2026-06-01', 'account': IDENTITY['account'],
            'shares': 100, 'price': 50, 'fees': 1, 'cashAmount': -5001}, client_token=token())
        [(stock_event,)] = _pragma(self.db_path, 'SELECT event_id FROM cost_basis_events '
                                                 f"WHERE book_id = '{stock['bookId']}'")
        backup = self.store.export_backup(self.book_id)
        before = _all_tables(self.db_path)
        version = self.ledger.version()
        once = token()
        clz6_rev2 = {'record': dict(CLZ6, revision=2, futurePointValue=500),
                     'supersededByRevision': None, 'createdAtUtc': '2026-10-03T00:00:00Z'}
        cases = {
            'a binding names a missing future':
                lambda p: p['bindings'][0].update(futureContractId='missing-future-0001'),
            'a binding binds a FUT as its option':
                lambda p: p['bindings'][0].update(optionContractId=CLZ6['contractId']),
            'an allocation beyond the stated quantity':
                lambda p: p['allocations'][0].update(quantity=99),
            'an allocation beyond the stated fees': lambda p: p['allocations'][0].update(fees=99),
            'a source no event uses': lambda p: p['sources'].append(
                dict(p['sources'][0], sourceId='source-extra-0001', sourceRef='exec-extra-0001')),
            "an allocation on another ledger's event":
                lambda p: p['allocations'][0].update(eventId=stock_event),
            "a boundary anchored on another ledger's event": lambda p: p['cycles'].extend([
                {'boundaryId': 'cycle-foreign-01', 'revision': 1, 'state': 'closed',
                 'anchorEventId': stock_event, 'label': '', 'supersededByRevision': 2,
                 'createdAtUtc': '2026-10-03T00:00:00Z'},
                {'boundaryId': 'cycle-foreign-01', 'revision': 2, 'state': 'revoked',
                 'anchorEventId': None, 'label': '', 'supersededByRevision': None,
                 'createdAtUtc': '2026-10-04T00:00:00Z'}]),
            'a revision chain with a gap':
                lambda p: p['contracts'][0].update(supersededByRevision=2),
            'a later revision that changes a term': lambda p: (
                next(c for c in p['contracts'] if c['record']['contractId'] == CLZ6['contractId'])
                .update(supersededByRevision=2), p['contracts'].append(clz6_rev2)),
        }
        refusals = (InvalidRequestError, FopIdentityConflictError,
                    FopReferenceRevisionConflictError, FopCycleBoundaryViolatedError)
        for name, change in cases.items():
            payload = copy.deepcopy(backup['payload'])
            change(payload)
            with self.subTest(name), self.assertRaises(refusals):
                self.restore(_sealed(backup, payload), client_token=once)
            self.assertEqual(_all_tables(self.db_path), before, name)
            self.assertEqual(self.ledger.version(), version, name)
        # No refusal consumed the token, and the valid graph still restores.
        result = self.restore(backup, client_token=once)
        self.assertFalse(result['idempotentReplay'])
        _assert_same_graph(self, self.store.export_backup(self.book_id)['payload'],
                           backup['payload'])

    def test_one_source_may_feed_several_events(self):
        # R4: one broker row of 2 contracts and 4.04 fees, allocated 1 + 1.
        first, record = tws(fut_trade(), 'exec-summary-0001', 1, 2.02)
        record.update(statedQuantity=2, statedFees=4.04)
        second = at(first, '2026-10-01T14:30:06.000000Z')
        before = _all_tables(self.db_path)
        store = CostBasisStore(self.db_path, fop_writes_enabled=True,
                               fault_hook=_fault_at('fop_after_event'))
        with self.assertRaises(InjectedFault):
            self.rebuild(first, second, contracts=[CLZ6], sources=[record], store=store)
        self.assertEqual(_all_tables(self.db_path), before, 'a failure halfway writes nothing')
        over_fee = copy.deepcopy(second)
        over_fee['sources'][0]['fees'] = 3.0
        for name, events in {'quantity': (first, second, at(first, '2026-10-01T14:30:07.000000Z')),
                             'fees': (first, over_fee)}.items():
            with self.subTest(beyond=name), self.assertRaises(InvalidRequestError):
                self.rebuild(*events, contracts=[CLZ6], sources=[record])
            self.assertEqual(_all_tables(self.db_path), before)

        once, batch = token(), token('batch')
        result = self.rebuild(first, second, contracts=[CLZ6], sources=[record], client_token=once,
                              import_batch_id=batch)
        self.assertEqual(result['inserted'], 2)
        events = self.ledger.events()
        self.assertEqual([e['externalRef'] for e in events], ['exec-summary-0001'] * 2)
        for event in events:
            self.assertEqual(schema.check('ListedFopEvent', event), [])
        self.assertEqual((_count(self.db_path, 'cost_basis_fop_sources'),
                          _count(self.db_path, 'cost_basis_fop_source_allocations')), (1, 2))
        again = self.rebuild(first, second, contracts=[CLZ6], sources=[record], client_token=once,
                             import_batch_id=batch)
        self.assertEqual(again, dict(result, idempotentReplay=True))
        self.assertEqual(len(self.ledger.events()), 2, 'a retry adds nothing')
        with self.assertRaises(ImportRevisionConflictError, msg='the source is consumed'):
            self.ledger.append(at(first, '2026-10-05T14:00:00.000000Z'), sources=[record])
        self.ledger.void(events[1]['eventId'])
        self.assertEqual((_count(self.db_path, 'cost_basis_fop_sources'),
                          _count(self.db_path, 'cost_basis_fop_source_allocations')), (1, 2),
                         'a void keeps the evidence that the source was consumed')
        backup = self.store.export_backup(self.book_id)
        version = self.ledger.version()
        self.reset()
        self.restore(backup)
        self.assertEqual(self.ledger.version(), version, 'the split survives a round trip')

    def test_a_graph_request_token_is_bound_to_what_it_asked(self):
        # R5: one token, one request (action and payload); a retry gets the
        # original answer and archives nothing more.
        self.build()
        backup = self.store.export_backup(self.book_id)
        repriced = copy.deepcopy(backup['payload'])
        repriced['events'][0]['row']['price'] = 70.5
        once = token()
        first = self.restore(backup, client_token=once)
        archives = _count(self.db_path, 'cost_basis_book_resets')
        again = self.restore(backup, client_token=once)
        self.assertEqual(again, dict(first, idempotentReplay=True))
        self.assertEqual(_count(self.db_path, 'cost_basis_book_resets'), archives)
        before = _all_tables(self.db_path)
        refused = {
            'another backup': lambda: self.restore(_sealed(backup, repriced), client_token=once),
            'a reset archive instead': lambda: self.restore_reset(first['resetId'], client_token=once),
            'a reset instead': lambda: self.reset(client_token=once),
        }
        for name, request in refused.items():
            with self.subTest(name), self.assertRaises(InvalidRequestError):
                request()
            self.assertEqual(_all_tables(self.db_path), before, name)

        from_archive = token()
        restored = self.restore_reset(first['resetId'], client_token=from_archive)
        with self.assertRaises(InvalidRequestError, msg='the same token, another archive'):
            self.restore_reset(restored['resetId'], client_token=from_archive)
        self.assertEqual(self.restore(backup, client_token=once), again,
                         'the log outlives the graph a later restore replaced')
        emptied = token()
        self.reset(client_token=emptied, reason='start over')
        with self.assertRaises(InvalidRequestError, msg='the same token, another reason'):
            self.reset(client_token=emptied, reason='something else')
        self.assertTrue(self.reset(client_token=emptied, reason='start over')['idempotentReplay'])

        opened, source = tws(fut_trade(), 'exec-open-00001', 1, 2.02)
        rebuilt = token()
        batch = token('batch')
        self.rebuild(opened, contracts=[CLZ6], sources=[source], client_token=rebuilt,
                     import_batch_id=batch)
        with self.assertRaises(InvalidRequestError, msg='the same token, another batch'):
            self.rebuild(opened, contracts=[CLZ6], sources=[source], client_token=rebuilt)

        # A refused request consumes no token.
        unused = token()
        with self.assertRaises(ResetConfirmationError):
            self.restore(backup, client_token=unused, confirmation='RESET wrong')
        self.assertFalse(self.restore(backup, client_token=unused)['idempotentReplay'])

    # -- P2 review round 2 (same document, sections 7-10) --

    def test_a_restore_takes_the_history_scope_of_its_backup(self):
        # R8: an unmodified backup, restored into a new database under another
        # ledger id, keeps the history scope its events were written under.
        for scope, other in (('since_baseline', 'full_history'), ('full_history', 'since_baseline')):
            with self.subTest(backup=scope):
                source = FopLedger(self.db_path.with_name(f'scope-{scope}.db'),
                                   history_scope=scope)
                source.append(fut_trade(), contracts=[CLZ6])
                backup = source.store.export_backup(source.book_id)
                self.assertEqual(backup['payload']['fopBook']['historyScope'], scope)
                target = FopLedger(self.db_path.with_name(f'target-{scope}.db'), history_scope=other)
                plan = target.store.reset_confirmation(target.book_id)
                result = target.store.restore_backup(
                    target.book_id, backup, confirmation=plan['phrase'], client_token=token(),
                    expected_ledger_version=plan['ledgerVersion'], book_identity=dict(IDENTITY),
                    engine_version=1)
                self.assertTrue(result['remapped'])
                self.assertEqual(target.store.get_book(target.book_id)['fop']['historyScope'], scope)
                self.assertEqual(target.store.export_backup(target.book_id)['payload']['fopBook']
                                 ['historyScope'], scope)
                # The graph it replaced, scope included, comes back from its archive.
                plan = target.store.reset_confirmation(target.book_id)
                target.store.restore_book_reset(
                    target.book_id, result['resetId'], confirmation=plan['phrase'],
                    client_token=token(), expected_ledger_version=plan['ledgerVersion'],
                    book_identity=dict(IDENTITY), engine_version=1)
                self.assertEqual(target.store.get_book(target.book_id)['fop']['historyScope'], other)
        self.ledger.append(fut_trade(), contracts=[CLZ6])
        same = self.store.export_backup(self.book_id)
        self.reset()
        self.restore(same)
        self.assertEqual(self.store.get_book(self.book_id)['fop']['historyScope'], 'full_history')

    def test_one_event_closes_one_cycle_on_every_path(self):
        # R9: a restore applies the rule the writes apply, to current closed
        # boundaries only.
        opened = self.ledger.append(fut_trade(), contracts=[CLZ6])['event']
        closed = self.ledger.append(fut_trade('2026-10-02T15:00:00.000000Z', futureContracts=-1,
                                              openClose='C'))['event']
        close = {'kind': 'close_cycle', 'boundaryId': 'cycle-000000001',
                 'anchorEventId': closed['eventId'], 'label': ''}
        self.commit(close)
        with self.assertRaises(FopCycleBoundaryViolatedError):
            self.commit(dict(close, boundaryId='cycle-000000002'))
        backup = self.store.export_backup(self.book_id)
        payload = copy.deepcopy(backup['payload'])
        payload['cycles'].append(dict(payload['cycles'][0], boundaryId='cycle-000000002'))
        before = _all_tables(self.db_path)
        version = self.ledger.version()
        once = token()
        with self.assertRaises(FopCycleBoundaryViolatedError):
            self.restore(_sealed(backup, payload), client_token=once)
        self.assertEqual(_all_tables(self.db_path), before)
        self.assertEqual(self.ledger.version(), version)
        self.assertFalse(self.restore(backup, client_token=once)['idempotentReplay'],
                         'the refusal left the token unused')
        # A revoked boundary's old revision may share the anchor of a current
        # one, and two cycles at two anchors are two cycles.
        self.commit({'kind': 'revoke_cycle', 'boundaryId': 'cycle-000000001'})
        self.commit(dict(close, boundaryId='cycle-000000002'))
        self.ledger.append(fut_trade('2026-10-03T14:00:00.000000Z'))
        second = self.ledger.append(fut_trade('2026-10-04T14:00:00.000000Z', futureContracts=-1,
                                              openClose='C'))['event']
        self.commit(dict(close, boundaryId='cycle-000000003', anchorEventId=second['eventId']))
        backup = self.store.export_backup(self.book_id)
        self.restore(backup)
        cycles = self.store.export_backup(self.book_id)['payload']['cycles']
        self.assertEqual(sorted((c['boundaryId'], c['revision'], c['state'], c['anchorEventId'])
                                for c in cycles),
                         [('cycle-000000001', 1, 'closed', closed['eventId']),
                          ('cycle-000000001', 2, 'revoked', None),
                          ('cycle-000000002', 1, 'closed', closed['eventId']),
                          ('cycle-000000003', 1, 'closed', second['eventId'])])
        self.assertNotEqual(opened['eventId'], closed['eventId'])

    def test_a_round_trip_keeps_each_events_primary_source(self):
        # R10: two sources with one reference text in two namespaces; the
        # primary is the one the event named, in either order, also when one
        # source is split over two events.
        statement = {'format': 'flex_csv', 'fileName': 'synthetic.csv', 'fileSha256': '1' * 64,
                     'account': IDENTITY['account'], 'periodFrom': '2026-10-01',
                     'periodThrough': '2026-10-01', 'checks': {}, 'confirmedDuplicates': 0}
        event, tws_record = tws(fut_trade(), 'shared-reference-001', 1, 2.02)
        tws_record.update(statedQuantity=2, statedFees=4.04)
        # The server reads a statement row's type from its own fields (P4 review).
        ib_record = dict(tws_record, namespace='ib_exec', format='flex_csv', section='Trades',
                         capabilityKey='flex/trades/FUT/trade', statedQuantity=1, statedFees=2.02,
                         rawFields={'AssetClass': 'FUT', 'Symbol': 'CLZ6', 'IBExecID': 'shared-reference-001',
                                    'Quantity': '1', 'TradePrice': '70', 'IBCommission': '-2.02',
                                    'Notes/Codes': 'O'})
        # A statement row writes only once its row type is verified (plan §9.7, P4).
        self.store._fop_capabilities = verified_capabilities()
        tws_source = event['sources'][0]
        ib_source = dict(tws_source, namespace='ib_exec')
        for order in ('tws first', 'ib first'):
            with self.subTest(order):
                first = copy.deepcopy(event)
                first['sources'] = ([tws_source, ib_source] if order == 'tws first'
                                    else [ib_source, tws_source])
                split = at(event, '2026-10-01T14:30:06.000000Z')  # tws row, second half
                plan = self.plan()
                self.store.rebuild_fop_book(
                    self.book_id, package(first, split, contracts=[CLZ6],
                                          sources=[ib_record, tws_record]),
                    confirmation=plan['phrase'], client_token=token(), import_batch_id=token('batch'),
                    statement=statement, expected_ledger_version=plan['ledgerVersion'],
                    book_identity=dict(IDENTITY))
                before = _pragma(self.db_path, 'SELECT event_id, external_ref FROM cost_basis_events '
                                               'ORDER BY seq')
                self.assertTrue(before[0][1].startswith(
                    'tws_exec:' if order == 'tws first' else 'ib_exec:'))
                version = self.ledger.version()
                backup = self.store.export_backup(self.book_id)
                self.restore(backup)
                self.assertEqual(_pragma(self.db_path, 'SELECT event_id, external_ref FROM '
                                                       'cost_basis_events ORDER BY seq'), before)
                self.assertEqual(self.ledger.version(), version)
                _assert_same_graph(self, self.store.export_backup(self.book_id)['payload'],
                                   backup['payload'])

    def test_a_restored_ledger_answers_retried_requests(self):
        # R11: in a new database, under the same ledger id, every request the
        # backup logs gets its first answer and writes nothing; under another
        # ledger id the old log stays out.
        opened, source = tws(fut_trade(), 'exec-open-00001', 1, 2.02)
        calls = {}

        def once(name, call):
            client_token = token()
            answer = call(client_token)
            calls[name] = (call, client_token, answer)
            return answer

        once('rebuild', lambda tok: self.rebuild(opened, contracts=[CLZ6], sources=[source],
                                                  client_token=tok, import_batch_id='batch-fixed-0001'))
        closing = fut_trade('2026-10-02T15:00:00.000000Z', futureContracts=-1, openClose='C')
        closed = once('append', lambda tok: self.ledger.append(closing, client_token=tok))['event']
        once('metadata', lambda tok: self.store.commit_fop_metadata(
            self.book_id, {'kind': 'close_cycle', 'boundaryId': 'cycle-000000001',
                           'anchorEventId': closed['eventId'], 'label': ''},
            client_token=tok, expected_ledger_version=self.ledger.version(),
            book_identity=dict(IDENTITY), engine_version=1))
        reset = once('reset', lambda tok: self.reset(client_token=tok, reason='check'))
        once('restore a reset', lambda tok: self.restore_reset(reset['resetId'], client_token=tok))
        fee = at(example_event('a late fee names its stored trade by event id'),
                 '2026-10-03T15:00:00.000000Z')
        fee['feeSource'] = {'eventId': closed['eventId'], 'packageKey': None}
        fee_event = self.ledger.append(fee)['event']
        once('void', lambda tok: self.ledger.void(fee_event['eventId'], client_token=tok))
        backup = self.store.export_backup(self.book_id)

        restored = CostBasisStore(self.db_path.with_name('new.db'), fop_writes_enabled=True).initialize()
        restored.create_fop_book(account=IDENTITY['account'], symbol='CL', start_date='2026-01-01',
                                 fop=dict(FOP_META), book_id=self.book_id)
        plan = restored.reset_confirmation(self.book_id)
        restored.restore_backup(self.book_id, backup, confirmation=plan['phrase'],
                                client_token=token(), expected_ledger_version=plan['ledgerVersion'],
                                book_identity=dict(IDENTITY), engine_version=1)
        self.store = restored          # every helper now writes the new database
        self.ledger.store = restored
        new_path = self.db_path.with_name('new.db')
        before = _all_tables(new_path)
        for name, (call, client_token, answer) in calls.items():
            with self.subTest(retry=name):
                self.assertEqual(call(client_token), dict(answer, idempotentReplay=True))
                self.assertEqual(_all_tables(new_path), before, name)
        with self.assertRaises(InvalidRequestError, msg='the same token, another package'):
            self.ledger.append(dict(closing, price=70.5), client_token=calls['append'][1])
        self.assertEqual(_all_tables(new_path), before)

        # Under another ledger id nothing of the old log comes along.
        other_path = self.db_path.with_name('other.db')
        other = FopLedger(other_path)
        plan = other.store.reset_confirmation(other.book_id)
        other.store.restore_backup(other.book_id, backup, confirmation=plan['phrase'],
                                   client_token=token(), expected_ledger_version=plan['ledgerVersion'],
                                   book_identity=dict(IDENTITY), engine_version=1)
        self.assertEqual([tuple(row) for row in _pragma(
            other_path, f"SELECT action FROM cost_basis_fop_requests WHERE book_id = '{other.book_id}'")],
            [('restore_backup',)])
        _, client_token, answer = calls['append']
        with self.assertRaises(LedgerChangedError, msg='an old request is not replayed there'):
            other.append(closing, client_token=client_token, expected=answer['ledgerVersion'])

        # The log is part of the checked backup.
        tampered = copy.deepcopy(backup)
        tampered['payload']['requests'][0]['requestDigest'] = '0' * 64
        foreign = copy.deepcopy(backup['payload'])
        foreign['requests'][0]['resultJson'] = json.dumps({'bookId': 'anotherbook0001'})
        repeated = copy.deepcopy(backup['payload'])
        repeated['requests'].append(dict(repeated['requests'][0]))
        for name, candidate in {'checksum': tampered, 'answer about another ledger':
                                _sealed(backup, foreign), 'token logged twice':
                                _sealed(backup, repeated)}.items():
            plan = other.store.reset_confirmation(other.book_id)
            with self.subTest(refused=name), self.assertRaises(InvalidRequestError):
                other.store.restore_backup(
                    other.book_id, candidate, confirmation=plan['phrase'], client_token=token(),
                    expected_ledger_version=plan['ledgerVersion'], book_identity=dict(IDENTITY),
                    engine_version=1)


class WriteGuardTests(unittest.TestCase):
    """Every FOP write, not only append, checks inside its write transaction
    that this engine supports the ledger, the engine the request names, the
    identity and the reviewed version, and changes nothing when one fails
    (P2 review R6)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = pathlib.Path(self._tmp.name) / 'cost_basis.db'
        self.ledger = FopLedger(self.db_path)
        self.book_id = self.ledger.book_id
        self.ledger.append(fut_trade(), contracts=[CLZ6])
        self.stale = self.ledger.version()
        self.closing = self.ledger.append(fut_trade('2026-10-02T15:00:00.000000Z', futureContracts=-1,
                                                    openClose='C'))['event']
        self.backup = self.ledger.store.export_backup(self.book_id)
        store = self.ledger.store
        plan = store.reset_confirmation(self.book_id)
        self.reset_id = store.reset_book(
            self.book_id, confirmation=plan['phrase'], client_token=token(),
            expected_ledger_version=plan['ledgerVersion'], book_identity=dict(IDENTITY),
            engine_version=1)['resetId']
        plan = store.reset_confirmation(self.book_id)
        store.restore_book_reset(self.book_id, self.reset_id, confirmation=plan['phrase'],
                                 client_token=token(), expected_ledger_version=plan['ledgerVersion'],
                                 book_identity=dict(IDENTITY), engine_version=1)

    def writes(self, store):
        """Each FOP write action as (engine, identity, expected version) -> result."""
        book_id = self.book_id
        phrase = store.reset_confirmation(book_id)['phrase']

        def fop_package(*events, contracts=(), engine):
            built = package(*events, contracts=contracts)
            if engine is None:
                del built['engineVersion']
            else:
                built['engineVersion'] = engine
            return built

        return {
            'append': lambda engine, identity, expected: store.append_fop_event(
                book_id, fop_package(fut_trade('2026-10-03T14:00:00.000000Z'), engine=engine),
                client_token=token(), expected_ledger_version=expected, book_identity=identity),
            'void': lambda engine, identity, expected: store.void_fop_event(
                book_id, self.closing['eventId'], reason='entered in error', client_token=token(),
                expected_ledger_version=expected, book_identity=identity, engine_version=engine),
            'metadata': lambda engine, identity, expected: store.commit_fop_metadata(
                book_id, {'kind': 'close_cycle', 'boundaryId': 'cycle-000000009',
                          'anchorEventId': self.closing['eventId'], 'label': ''},
                client_token=token(), expected_ledger_version=expected, book_identity=identity,
                engine_version=engine),
            'reset': lambda engine, identity, expected: store.reset_book(
                book_id, confirmation=phrase, client_token=token(), expected_ledger_version=expected,
                book_identity=identity, engine_version=engine),
            'restore a reset': lambda engine, identity, expected: store.restore_book_reset(
                book_id, self.reset_id, confirmation=phrase, client_token=token(),
                expected_ledger_version=expected, book_identity=identity, engine_version=engine),
            'restore a backup': lambda engine, identity, expected: store.restore_backup(
                book_id, self.backup, confirmation=phrase, client_token=token(),
                expected_ledger_version=expected, book_identity=identity, engine_version=engine),
            'rebuild': lambda engine, identity, expected: store.rebuild_fop_book(
                book_id, fop_package(fut_trade(), contracts=[CLZ6], engine=engine),
                confirmation=phrase, client_token=token(), import_batch_id=token('batch'),
                expected_ledger_version=expected, book_identity=identity),
        }

    def test_every_write_checks_engine_identity_and_version_and_changes_nothing(self):
        current = self.ledger.version()
        before = _all_tables(self.db_path)
        stale_error = {'append': LedgerChangedError, 'void': LedgerChangedError,
                       'metadata': LedgerChangedError}
        for action, write in self.writes(self.ledger.store).items():
            cases = {
                'no engine version': ((None, dict(IDENTITY), current), InvalidRequestError),
                'another engine version': ((2, dict(IDENTITY), current),
                                           FopEngineVersionMismatchError),
                'another identity': ((1, dict(IDENTITY, account='U2222222'), current),
                                     InvalidRequestError),
                'a stale preview': ((1, dict(IDENTITY), self.stale),
                                    stale_error.get(action, ResetConfirmationError)),
            }
            for name, (arguments, error) in cases.items():
                with self.subTest(action=action, case=name), self.assertRaises(error):
                    write(*arguments)
                self.assertEqual(_all_tables(self.db_path), before, (action, name))
        # The same calls with everything right go through, each on its own
        # copy: the refusals above come from the guard, not a broken call.
        for index, action in enumerate(self.writes(self.ledger.store)):
            copy_path = self.db_path.with_name(f'copy-{index}.db')
            source = sqlite3.connect(self.db_path)
            target = sqlite3.connect(copy_path)
            try:
                source.backup(target)
            finally:
                source.close()
                target.close()
            store = CostBasisStore(copy_path, fop_writes_enabled=True).initialize()
            with self.subTest(action=action, case='everything right'):
                result = self.writes(store)[action](1, dict(IDENTITY), current)
                self.assertFalse(result['idempotentReplay'])

    def test_a_ledger_of_another_engine_is_export_and_delete_only(self):
        conn = _raw(self.db_path)
        try:
            conn.execute('UPDATE cost_basis_fop_books SET engine_version = 2 WHERE book_id = ?',
                         (self.book_id,))
        finally:
            conn.close()
        current = self.ledger.version()
        before = _all_tables(self.db_path)
        for action, write in self.writes(self.ledger.store).items():
            with self.subTest(action), self.assertRaises(FopEngineVersionMismatchError):
                write(1, dict(IDENTITY), current)
            self.assertEqual(_all_tables(self.db_path), before, action)
        with self.assertRaises(FopEngineVersionMismatchError):
            self.ledger.store.archive_book(self.book_id)
        self.assertEqual(_all_tables(self.db_path), before)
        self.assertEqual(len(self.ledger.events()), 2, 'reads stay open')
        self.assertEqual(self.ledger.store.export_backup(self.book_id)['payload']['fopBook']
                         ['engineVersion'], 2)
        plan = self.ledger.store.delete_confirmation(self.book_id)
        self.ledger.store.delete_book(self.book_id, confirmation=plan['phrase'], client_token=token())
        for table in FOP_TABLES:
            self.assertEqual(_pragma(self.db_path, f'SELECT count(*) FROM {table}')[0][0], 0, table)


if __name__ == '__main__':
    unittest.main()
