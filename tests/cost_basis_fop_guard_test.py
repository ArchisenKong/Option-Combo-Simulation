"""P0 guard: FUT/FOP ledgers are frozen until the standalone FOP ledger ships.

CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §2 (the month-key defect), §8.2 and
§13.3 P0. The shared engine can merge different futures months, and no FUT
ledger exists on the user's machines, so the store refuses to create one and
refuses every write to one. Reading, export and whole-book deletion stay open,
so a FUT ledger arriving in another database can still be taken out.

Every refusal is checked at both layers (the store and the WebSocket protocol
that both backends mount) and must leave the database byte-for-byte unchanged.
The legacy ledger is written with raw SQL, which is the only way one can exist
now.
"""
import configparser
import json
import pathlib
import re
import sqlite3
import sys
import tempfile
import unittest
import uuid

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from cost_basis_store import (  # noqa: E402
    CostBasisStore,
    FROZEN_BOOK_SEC_TYPES,
    FuturesBookFrozenError,
    InvalidRequestError,
)
from cost_basis_ws import create_store_env, handle_cost_basis_action  # noqa: E402

CAPABILITIES_PATH = REPO_ROOT / 'cost_basis_fop_capabilities.json'
ACCOUNT = 'U1111111'
FUT_BOOK_ID = 'legacyfut0001'
FUT_EVENT_ID = 'legacyfutevent01'

# Payloads from the pre-freeze FUT store tests (see
# tests/fixtures/cost_basis_fop/legacy_fut_migration_list.json). They used to
# be written; each must now be refused.
LEGACY_FUTURE_TRADE = {
    'kind': 'futures_trade', 'tradeDate': '2026-08-01', 'account': ACCOUNT,
    'futureExpiry': '202609', 'futureConId': 1001, 'futureLocalSymbol': 'ESU6',
    'futureContracts': 1, 'sharesPerContract': 50, 'price': 5000,
    'fees': 0, 'cashAmount': 0,
}
LEGACY_NEGATIVE_TRADE = dict(
    LEGACY_FUTURE_TRADE, tradeDate='2020-04-01', futureExpiry='202005',
    futureConId=5001, futureLocalSymbol='CLK20', sharesPerContract=1000,
    price=-37.63)
LEGACY_ROLL = {
    'kind': 'futures_roll', 'tradeDate': '2026-08-24', 'account': ACCOUNT,
    'futureExpiry': '202609', 'futureConId': 1001, 'futureLocalSymbol': 'ESU6',
    'futureContracts': 1, 'sharesPerContract': 50, 'price': 5100,
    'rollToExpiry': '202612', 'rollToConId': 1002, 'rollToLocalSymbol': 'ESZ6',
    'rollToPrice': 5120, 'rollGroup': 'roll-test-1', 'fees': 4, 'cashAmount': -4,
}
LEGACY_FOP_SHORT_PUT = {
    'kind': 'option_trade', 'optionSecType': 'FOP', 'tradeDate': '2026-08-01',
    'account': ACCOUNT, 'right': 'P', 'strike': 5000, 'expiry': '20260821',
    'contracts': -1, 'sharesPerContract': 50, 'price': 50,
    'fees': 0, 'cashAmount': 2500,
}
LEGACY_FOP_ASSIGNMENT = {
    'kind': 'option_assignment', 'optionSecType': 'FOP', 'tradeDate': '2026-08-21',
    'account': ACCOUNT, 'right': 'P', 'strike': 5000, 'expiry': '20260821',
    'contracts': 1, 'sharesPerContract': 50, 'futureExpiry': '202609',
    'futureContracts': 1, 'fees': 3, 'cashAmount': -3,
}
LEGACY_PAYLOADS = {
    'futures_trade': LEGACY_FUTURE_TRADE,
    'negative_futures_trade': LEGACY_NEGATIVE_TRADE,
    'futures_roll': LEGACY_ROLL,
    'fop_short_put': LEGACY_FOP_SHORT_PUT,
    'fop_assignment': LEGACY_FOP_ASSIGNMENT,
}
SPLIT_HEADER = {
    'kind': 'split', 'tradeDate': '2026-08-02', 'account': ACCOUNT,
    'splitRatio': 2, 'cashAmount': 0,
}


def _token(prefix='tok'):
    return f'{prefix}-{uuid.uuid4().hex[:16]}'


def _db_image(path):
    """Every row of every table, plus the schema version."""
    conn = sqlite3.connect(path)
    try:
        tables = [row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        image = {name: sorted(repr(row) for row in conn.execute(f'SELECT * FROM "{name}"'))
                 for name in tables}
        image['__user_version__'] = conn.execute('PRAGMA user_version').fetchone()[0]
        return image
    finally:
        conn.close()


def _insert_legacy_futures_book(path):
    """A FUT ledger as another database could still carry one."""
    stamp = '2026-08-01T00:00:00Z'
    conn = sqlite3.connect(path, isolation_level=None)
    try:
        conn.execute(
            'INSERT INTO cost_basis_books (book_id, account, symbol, sec_type, currency, '
            'default_shares_per_contract, start_date, note, created_at_utc, updated_at_utc) '
            "VALUES (?, ?, 'ES', 'FUT', 'USD', 50, '2026-01-01', '', ?, ?)",
            (FUT_BOOK_ID, ACCOUNT, stamp, stamp))
        conn.execute(
            'INSERT INTO cost_basis_events (event_id, book_id, seq, client_token, kind, '
            'trade_date, account, future_expiry, future_con_id, future_local_symbol, '
            'future_contracts, shares_per_contract, price, cash_amount, fees, '
            'source, created_at_utc) '
            "VALUES (?, ?, 1, 'legacyfuttoken01', 'futures_trade', '2026-08-01', ?, "
            "'202609', 1001, 'ESU6', 1, 50, 5000, 0, 0, 'manual', ?)",
            (FUT_EVENT_ID, FUT_BOOK_ID, ACCOUNT, stamp))
    finally:
        conn.close()


class FuturesLedgerFreezeStoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = pathlib.Path(self._tmp.name) / 'cost_basis.db'
        self.store = CostBasisStore(self.db_path).initialize()
        _insert_legacy_futures_book(self.db_path)

    def fut_book(self):
        return self.store.get_book(FUT_BOOK_ID)

    def write_attempts(self):
        book = self.fut_book()
        version = self.store.ledger_version(FUT_BOOK_ID)
        phrase = self.store.reset_confirmation(FUT_BOOK_ID)['phrase']
        backup = self.store.export_backup(FUT_BOOK_ID)
        store = self.store
        attempts = {
            'archive_book': lambda: store.archive_book(FUT_BOOK_ID),
            'import_events': lambda: store.import_events(
                FUT_BOOK_ID, [dict(LEGACY_FUTURE_TRADE, source='csv_import',
                                   externalRef='csv-fut-1')],
                import_batch_id=_token('batch'), client_token_prefix=_token('prefix'),
                expected_ledger_version=version, book_identity=book),
            'append_split_group': lambda: store.append_split_group(
                FUT_BOOK_ID, [dict(SPLIT_HEADER)], client_token=_token(),
                expected_ledger_version=version, book_identity=book),
            'void_split_group': lambda: store.void_split_group(
                FUT_BOOK_ID, 'split-abcdef1234', reason='test', client_token=_token()),
            'void_event': lambda: store.void_event(
                FUT_BOOK_ID, FUT_EVENT_ID, reason='test', client_token=_token()),
            'reset_book': lambda: store.reset_book(
                FUT_BOOK_ID, confirmation=phrase, client_token=_token(),
                expected_ledger_version=version, book_identity=book),
            'rebuild_book': lambda: store.rebuild_book(
                FUT_BOOK_ID, [dict(LEGACY_FUTURE_TRADE)], confirmation=phrase,
                client_token=_token(), import_batch_id=_token('batch'),
                expected_ledger_version=version, book_identity=book),
            'restore_backup': lambda: store.restore_backup(
                FUT_BOOK_ID, backup, confirmation=phrase, client_token=_token(),
                expected_ledger_version=version, book_identity=book),
            'restore_book_reset': lambda: store.restore_book_reset(
                FUT_BOOK_ID, 'reset-abcdef1234', confirmation=phrase,
                client_token=_token(), expected_ledger_version=version,
                book_identity=book),
            'save_snapshot': lambda: store.save_snapshot(
                FUT_BOOK_ID, as_of_date='2026-09-01', summary={'futuresContracts': 1}),
        }
        for name, payload in LEGACY_PAYLOADS.items():
            attempts[f'append_event:{name}'] = (
                lambda payload=payload: store.append_event(
                    FUT_BOOK_ID, dict(payload), client_token=_token()))
        return attempts

    def test_creating_a_futures_ledger_is_refused(self):
        before = _db_image(self.db_path)
        with self.assertRaises(FuturesBookFrozenError) as ctx:
            self.store.create_book(
                account=ACCOUNT, symbol='CL', sec_type='FUT', start_date='2026-01-01',
                default_shares_per_contract=1000)
        self.assertEqual(ctx.exception.code, 'futures_book_frozen')
        self.assertEqual(_db_image(self.db_path), before)
        self.assertEqual(FROZEN_BOOK_SEC_TYPES, frozenset({'FUT'}))

    def test_every_write_to_a_legacy_futures_ledger_is_refused_and_changes_nothing(self):
        for name, attempt in self.write_attempts().items():
            with self.subTest(write=name):
                before = _db_image(self.db_path)
                with self.assertRaises(FuturesBookFrozenError):
                    attempt()
                self.assertEqual(_db_image(self.db_path), before)

    def test_legacy_futures_ledger_can_still_be_read_exported_and_deleted(self):
        self.assertEqual(self.fut_book()['secType'], 'FUT')
        events = self.store.list_events(FUT_BOOK_ID)
        self.assertEqual(events['total'], 1)
        self.assertEqual(events['events'][0]['kind'], 'futures_trade')
        self.assertTrue(self.store.ledger_version(FUT_BOOK_ID)['digest'])
        backup = self.store.export_backup(FUT_BOOK_ID)
        self.assertEqual(backup['payload']['book']['secType'], 'FUT')
        self.assertEqual(len(backup['payload']['events']), 1)
        plan = self.store.delete_confirmation(FUT_BOOK_ID)
        self.store.delete_book(
            FUT_BOOK_ID, confirmation=plan['phrase'], client_token=_token())
        self.assertNotIn(
            FUT_BOOK_ID, [book['bookId'] for book in self.store.list_books(include_archived=True)])

    def test_futures_backup_cannot_be_restored_into_a_stock_ledger(self):
        stock = self.store.create_book(account=ACCOUNT, symbol='ES', start_date='2026-01-01')
        backup = self.store.export_backup(FUT_BOOK_ID)
        phrase = self.store.reset_confirmation(stock['bookId'])['phrase']
        before = _db_image(self.db_path)
        with self.assertRaises(InvalidRequestError):
            self.store.restore_backup(
                stock['bookId'], backup, confirmation=phrase, client_token=_token(),
                expected_ledger_version=self.store.ledger_version(stock['bookId']),
                book_identity=stock)
        self.assertEqual(_db_image(self.db_path), before)

    def test_stock_ledgers_are_unaffected(self):
        book = self.store.create_book(account=ACCOUNT, symbol='TQQQ', start_date='2026-01-01')
        bid = book['bookId']
        appended = self.store.append_event(bid, {
            'kind': 'share_trade', 'tradeDate': '2026-06-01', 'account': ACCOUNT,
            'shares': 100, 'price': 50, 'fees': 0, 'cashAmount': -5000,
        }, client_token=_token())['event']
        imported = self.store.import_events(bid, [{
            'kind': 'share_trade', 'tradeDate': '2026-06-02', 'account': ACCOUNT,
            'shares': 10, 'price': 51, 'fees': 0, 'cashAmount': -510,
            'source': 'csv_import', 'externalRef': 'csv-stk-1',
        }], import_batch_id=_token('batch'), client_token_prefix=_token('prefix'),
            expected_ledger_version=self.store.ledger_version(bid), book_identity=book)
        self.assertEqual(imported['inserted'], 1)
        self.store.void_event(bid, appended['eventId'], reason='test', client_token=_token())
        self.store.save_snapshot(bid, as_of_date='2026-06-03', summary={'shares': 10})
        self.assertTrue(self.store.archive_book(bid)['archivedAtUtc'])
        # The type boundary still holds on the stock side.
        other = self.store.create_book(account=ACCOUNT, symbol='SPY', start_date='2026-01-01')
        with self.assertRaises(InvalidRequestError):
            self.store.append_event(
                other['bookId'], dict(LEGACY_FUTURE_TRADE), client_token=_token())


def _config(tmpdir):
    config = configparser.ConfigParser()
    config.read_string(
        f"[cost_basis]\ndb_path = {pathlib.Path(tmpdir) / 'cost_basis.db'}\n")
    return config


class FakeWebSocket:
    remote_address = ('127.0.0.1', 51000)

    def __init__(self):
        self.sent = []

    async def send(self, message):
        self.sent.append(message)


class FuturesLedgerFreezeWsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = pathlib.Path(self._tmp.name) / 'cost_basis.db'
        self.env = create_store_env(_config(self._tmp.name), environ={})
        # Open the ledger through the protocol, then plant the legacy book.
        listed = await self.call('list_cost_basis_books')
        self.assertTrue(listed['success'], listed)
        _insert_legacy_futures_book(self.db_path)

    async def call(self, action, **fields):
        socket = FakeWebSocket()
        handled = await handle_cost_basis_action(
            self.env, socket, {'action': action, 'requestId': 'req-1', **fields})
        self.assertTrue(handled)
        self.assertEqual(len(socket.sent), 1)
        return json.loads(socket.sent[0])

    async def test_protocol_refuses_to_create_a_futures_ledger(self):
        before = _db_image(self.db_path)
        response = await self.call(
            'create_cost_basis_book', account=ACCOUNT, symbol='CL', secType='FUT',
            startDate='2026-01-01', defaultSharesPerContract=1000)
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'futures_book_frozen')
        self.assertEqual(_db_image(self.db_path), before)
        stock = await self.call(
            'create_cost_basis_book', account=ACCOUNT, symbol='CL', startDate='2026-01-01',
            secType='STK')
        self.assertTrue(stock['success'], stock)

    async def test_protocol_refuses_every_write_action_on_a_legacy_futures_ledger(self):
        book = next(item for item in (await self.call('list_cost_basis_books'))['books']
                    if item['bookId'] == FUT_BOOK_ID)
        version = (await self.call('list_cost_basis_events', bookId=FUT_BOOK_ID))['ledgerVersion']
        plan = await self.call('request_cost_basis_reset_plan', bookId=FUT_BOOK_ID)
        self.assertTrue(plan['success'], plan)
        backup = await self.call('export_cost_basis_backup', bookId=FUT_BOOK_ID)
        self.assertTrue(backup['success'], backup)
        guard = {'expectedLedgerVersion': version, 'bookIdentity': book}
        requests = {
            'archive_cost_basis_book': {},
            'append_cost_basis_event': {
                'event': dict(LEGACY_FUTURE_TRADE), 'clientToken': _token()},
            'void_cost_basis_event': {
                'eventId': FUT_EVENT_ID, 'reason': 'test', 'clientToken': _token()},
            'append_cost_basis_split_group': {
                'events': [dict(SPLIT_HEADER)], 'clientToken': _token(), **guard},
            'void_cost_basis_split_group': {
                'splitGroup': 'split-abcdef1234', 'reason': 'test', 'clientToken': _token()},
            'import_cost_basis_events': {
                'events': [dict(LEGACY_FUTURE_TRADE, source='csv_import',
                                externalRef='csv-fut-1')],
                'importBatchId': _token('batch'), 'clientTokenPrefix': _token('prefix'),
                **guard},
            'reset_cost_basis_book': {
                'confirmation': plan['phrase'], 'clientToken': _token(), **guard},
            'rebuild_cost_basis_book': {
                'events': [dict(LEGACY_FUTURE_TRADE)], 'confirmation': plan['phrase'],
                'clientToken': _token(), 'importBatchId': _token('batch'), **guard},
            'restore_cost_basis_reset': {
                'resetId': 'reset-abcdef1234', 'confirmation': plan['phrase'],
                'clientToken': _token(), **guard},
            'restore_cost_basis_backup': {
                'backup': {key: backup[key] for key in ('format', 'version', 'payload', 'sha256')
                           if key in backup},
                'confirmation': plan['phrase'], 'clientToken': _token(), **guard},
            'save_cost_basis_snapshot': {
                'asOfDate': '2026-09-01', 'summary': {'futuresContracts': 1}},
        }
        for action, fields in requests.items():
            with self.subTest(action=action):
                before = _db_image(self.db_path)
                response = await self.call(action, bookId=FUT_BOOK_ID, **fields)
                self.assertFalse(response['success'], response)
                self.assertEqual(response['code'], 'futures_book_frozen', response)
                self.assertEqual(_db_image(self.db_path), before)

    async def test_protocol_still_reads_exports_and_deletes_a_legacy_futures_ledger(self):
        events = await self.call('list_cost_basis_events', bookId=FUT_BOOK_ID)
        self.assertTrue(events['success'], events)
        self.assertEqual(events['total'], 1)
        backup = await self.call('export_cost_basis_backup', bookId=FUT_BOOK_ID)
        self.assertTrue(backup['success'], backup)
        plan = await self.call('request_cost_basis_delete_plan', bookId=FUT_BOOK_ID)
        self.assertTrue(plan['success'], plan)
        deleted = await self.call(
            'delete_cost_basis_book', bookId=FUT_BOOK_ID,
            confirmation=plan['phrase'], clientToken=_token())
        self.assertTrue(deleted['success'], deleted)


class CapabilityDraftTests(unittest.TestCase):
    """The row-type capability list (plan §9.7) as P0 leaves it."""

    KEY = re.compile(r'^(activity|flex)/[a-z_]+/[A-Z]+(\.[a-z_]+)?/[a-z_]+$')
    STATUSES = {'real_verified', 'synthetic_only', 'out_of_scope', 'unsupported'}

    def test_capability_draft_is_well_formed_and_writes_nothing(self):
        document = json.loads(CAPABILITIES_PATH.read_text(encoding='utf-8'))
        self.assertEqual(document['format'], 'cost-basis-fop-capabilities')
        self.assertEqual(set(document['statusDefinitions']), self.STATUSES)
        keys = [entry['key'] for entry in document['keys']]
        self.assertEqual(len(keys), len(set(keys)))
        for entry in document['keys']:
            with self.subTest(key=entry['key']):
                self.assertRegex(entry['key'], self.KEY)
                self.assertIn(entry['status'], self.STATUSES)
                self.assertNotEqual(entry['status'], 'real_verified')
                self.assertEqual(
                    [item for item in entry['evidence']
                     if item.get('kind') == 'deidentified_real'], [])
        statuses = {entry['status'] for entry in document['keys']}
        self.assertEqual(statuses, {'synthetic_only', 'out_of_scope', 'unsupported'})


if __name__ == '__main__':
    unittest.main()
