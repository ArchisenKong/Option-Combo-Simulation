"""P2: the FOP ledger through the shared WebSocket protocol (plan §10.1, §10.2).

Both backends mount cost_basis_ws, so these calls go through the same
handler either one runs. Stores are temporary; nothing reaches TWS.
"""
import asyncio
import configparser
import copy
import json
import pathlib
import sys
import tempfile
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
for path in (REPO_ROOT, REPO_ROOT / 'tests'):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import cost_basis_fop_schema as schema  # noqa: E402
from cost_basis_fop_test_support import (  # noqa: E402
    CLZ6, EXAMPLES, FOP_META, IDENTITY, LOZ6, at, example_event, package, token, verified_capabilities,
)
from cost_basis_store import CostBasisStore  # noqa: E402
from cost_basis_ws import create_store_env, ensure_store_initialized, handle_cost_basis_action  # noqa: E402

LOZ6_DETAILS = {'conId': 9001, 'secType': 'FOP', 'symbol': 'CL', 'tradingClass': 'LO',
                'localSymbol': 'LOZ6 C7500', 'exchange': 'NYMEX', 'currency': 'USD', 'right': 'C',
                'strike': 75.0, 'lastTradeDateOrContractMonth': '20261117', 'multiplier': '1000',
                'underConId': 555}
CLZ6_DETAILS = {'conId': 555, 'secType': 'FUT', 'symbol': 'CL', 'tradingClass': 'CL',
                'localSymbol': 'CLZ6', 'exchange': 'NYMEX', 'currency': 'USD',
                'lastTradeDateOrContractMonth': '20261119', 'contractMonth': '202612',
                'multiplier': '1000'}


class FakeWebSocket:
    remote_address = ('127.0.0.1', 51000)

    def __init__(self):
        self.sent = []

    async def send(self, message):
        self.sent.append(message)


class FopProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = pathlib.Path(self._tmp.name) / 'c.db'
        self.env = self.make_env(fop_writes_enabled=True)

    def make_env(self, *, fop_writes_enabled, fetcher=None, quotes=None):
        config = configparser.ConfigParser()
        config.read_string(f'[cost_basis]\ndb_path = {self.db_path}\n')
        env = create_store_env(config, environ={})
        env.update(store=CostBasisStore(self.db_path, fop_writes_enabled=fop_writes_enabled)
                   .initialize(), available=True, _initialized=True)
        if fetcher is not None:
            env['fetch_fop_contract_details'] = fetcher
        if quotes is not None:
            env['fetch_fop_market_snapshot'] = quotes
        return env

    async def call(self, action, env=None, **fields):
        socket = FakeWebSocket()
        handled = await handle_cost_basis_action(
            env or self.env, socket, {'action': action, 'requestId': 'req-1', **fields})
        self.assertTrue(handled)
        return json.loads(socket.sent[0])

    async def create(self, env=None):
        return await self.call('create_cost_basis_book', env=env, account=IDENTITY['account'],
                               symbol='CL', startDate='2026-01-01', secType='FUT', currency='USD',
                               note='', fop=dict(FOP_META))

    async def version(self, book_id):
        listed = await self.call('list_cost_basis_events', bookId=book_id)
        return listed['ledgerVersion']

    async def append(self, book_id, event, **parts):
        return await self.call(
            'append_cost_basis_event', bookId=book_id, clientToken=token(),
            expectedLedgerVersion=await self.version(book_id), bookIdentity=dict(IDENTITY),
            fopPackage=package(event, **parts))

    async def test_status_reports_the_fop_engine_and_release_state(self):
        status = await self.call('request_cost_basis_status')
        fop = dict(status['features']['fopLedger'])
        capabilities = fop.pop('importCapabilities')
        self.assertEqual(fop, {
            'engineVersion': 1, 'productRules': ['NYMEX-CL-v1'], 'writesReleased': True,
            'contractDetails': False, 'marketSnapshot': False, 'positions': False})
        # The page hands the statement row types to the importer (plan §9.7, P4).
        self.assertEqual(capabilities, json.loads(
            (REPO_ROOT / 'cost_basis_fop_capabilities.json').read_text(encoding='utf-8')))
        closed = await self.call('request_cost_basis_status',
                                 env=self.make_env(fop_writes_enabled=False))
        self.assertFalse(closed['features']['fopLedger']['writesReleased'])

    async def test_a_statement_import_and_its_bindings_go_through_the_protocol(self):
        # P4: a statement binding is asked for with the rows it rests on; an
        # import carries the whole statement and is held to the row types.
        created = await self.create()
        book_id = created['book']['bookId']
        asked = copy.deepcopy(EXAMPLES['a statement binding rests on the statement rows'])
        asked.update(bookId=book_id)
        answered = await self.call('request_cost_basis_fop_statement_bindings', **{
            key: value for key, value in asked.items() if key not in ('action', 'requestId')})
        self.assertTrue(answered['success'], answered)
        self.assertEqual(schema.check('StatementBindingResponse', answered), [])
        self.assertEqual([result['status'] for result in answered['results']], ['verified_statement'])
        example = copy.deepcopy(EXAMPLES['statement import: two rows with their raw fields and the file '
                                         'registration'])
        fields = {key: value for key, value in example.items() if key not in ('action', 'requestId')}
        fields.update(bookId=book_id, bookIdentity=dict(IDENTITY), expectedLedgerVersion=await self.version(book_id))
        refused = await self.call('import_cost_basis_events', **fields)
        self.assertEqual(refused['code'], 'fop_capability_not_verified', refused)
        self.env['store']._fop_capabilities = verified_capabilities()
        imported = await self.call('import_cost_basis_events', **fields)
        self.assertTrue(imported['success'], imported)
        self.assertEqual(imported['inserted'], 2)
        fields.update(importBatchId=token('batch'), expectedLedgerVersion=imported['ledgerVersion'])
        again = await self.call('import_cost_basis_events', **fields)
        self.assertEqual((again['inserted'], len(again['duplicates'])), (0, 2))
        # A statement without trades registers its period with no package;
        # without its statement the contract refuses it before the store.
        bare = copy.deepcopy(EXAMPLES['a statement without trades registers its period and carries no package'])
        fields = {key: value for key, value in bare.items() if key not in ('action', 'requestId')}
        fields.update(bookId=book_id, bookIdentity=dict(IDENTITY), expectedLedgerVersion=again['ledgerVersion'],
                      importBatchId=token('batch'))
        refused = await self.call('import_cost_basis_events', **dict(fields, statement=None))
        self.assertEqual(refused['code'], 'invalid_request', refused)
        registered = await self.call('import_cost_basis_events', **fields)
        self.assertTrue(registered['success'], registered)
        self.assertEqual((registered['inserted'], registered['ledgerVersion']), (0, again['ledgerVersion']))
        self.assertIn('2026-11-01', [batch['periodFrom'] for batch in
                                     self.env['store'].list_import_batches(book_id)])

    async def test_one_quote_batch_for_the_ledgers_own_contracts(self):
        # P5: a quote batch names ledger contracts by id; the servers read the
        # terms from the stored records and answer in one shape, the
        # historical server with its capability error (plan §10.1-§10.3, F26).
        asked = []

        async def quotes(queries):
            asked.extend(queries)
            return [{'contractId': query['contractId'], 'conId': 555, 'localSymbol': 'CLZ6', 'secType': 'FUT',
                     'bid': 70.1, 'bidSize': 2, 'ask': 70.2, 'askSize': 3, 'last': 70.15, 'lastSize': 1,
                     'close': 69.8, 'closeDate': None, 'settlement': None, 'settlementDate': None,
                     'observedAtUtc': '2026-10-02T14:30:05.120000Z', 'marketDataType': 1} for query in queries]

        env = self.make_env(fop_writes_enabled=True, quotes=quotes)
        created = await self.create(env=env)
        book_id = created['book']['bookId']
        fut = await self.call('append_cost_basis_event', env=env, bookId=book_id, clientToken=token(),
                              expectedLedgerVersion=(await self.call('list_cost_basis_events', env=env,
                                                                     bookId=book_id))['ledgerVersion'],
                              bookIdentity=dict(IDENTITY),
                              fopPackage=package(at(example_event('FUT trade: cash is minus fees, notional stays out'),
                                                    '2026-10-01T14:30:05.000000Z'), contracts=[CLZ6]))
        self.assertTrue(fut['success'], fut)
        status = await self.call('request_cost_basis_status', env=env)
        self.assertTrue(status['features']['fopLedger']['marketSnapshot'])
        batch = await self.call('request_cost_basis_fop_market_snapshot', env=env, bookId=book_id,
                                contractIds=[CLZ6['contractId']])
        self.assertTrue(batch['success'], batch)
        self.assertEqual(schema.check('MarketSnapshotResponse', batch), [])
        self.assertEqual(batch['ledgerVersion'], fut['ledgerVersion'])
        self.assertEqual([(query['conId'], query['contractMonth']) for query in asked], [(555, '202612')])
        # The page cannot ask for another ledger's contract, or for too many.
        for contract_ids in (['fut-other-0001'], [f'fut-{index:04d}' for index in range(41)]):
            refused = await self.call('request_cost_basis_fop_market_snapshot', env=env, bookId=book_id,
                                      contractIds=contract_ids)
            self.assertEqual(refused['code'], 'invalid_request', refused)
        # A server without a broker answers with the same action and its capability error.
        unavailable = await self.call('request_cost_basis_fop_market_snapshot', bookId=book_id,
                                      contractIds=[CLZ6['contractId']])
        self.assertEqual((unavailable['action'], unavailable['success'], unavailable['code']),
                         ('cost_basis_fop_market_snapshot', False, 'fop_market_snapshot_unavailable'))
        self.assertEqual(len(asked), 1, 'refused batches never reach the broker')

    async def test_a_fop_ledger_round_trips_through_the_protocol(self):
        created = await self.create()
        self.assertTrue(created['success'], created)
        book_id = created['book']['bookId']
        self.assertIsNone(created['book']['defaultSharesPerContract'])
        fut = await self.append(book_id, at(example_event(
            'FUT trade: cash is minus fees, notional stays out'), '2026-10-01T14:30:05.000000Z'),
            contracts=[CLZ6])
        self.assertTrue(fut['success'], fut)
        self.assertEqual(schema.check('ListedFopEvent', fut['event']), [])
        listed = await self.call('list_cost_basis_events', bookId=book_id)
        self.assertEqual(schema.check('LedgerVersion', listed['ledgerVersion']), [])
        self.assertEqual([e['kind'] for e in listed['events']], ['futures_trade'])
        closing = at(example_event('FUT trade: cash is minus fees, notional stays out'),
                     '2026-10-02T14:30:05.000000Z')
        closing.update(futureContracts=-1, openClose='C')
        closed = await self.append(book_id, closing)
        committed = await self.call(
            'commit_cost_basis_fop_metadata', bookId=book_id, clientToken=token(),
            expectedLedgerVersion=await self.version(book_id), bookIdentity=dict(IDENTITY),
            engineVersion=1,
            operation={'kind': 'close_cycle', 'boundaryId': 'cycle-000000001',
                       'anchorEventId': closed['event']['eventId'], 'label': ''})
        self.assertTrue(committed['success'], committed)
        refused_void = await self.call(
            'void_cost_basis_event', bookId=book_id, eventId=closed['event']['eventId'],
            reason='entered in error', clientToken=token(),
            expectedLedgerVersion=await self.version(book_id), bookIdentity=dict(IDENTITY),
            engineVersion=1)
        self.assertEqual(refused_void['code'], 'fop_cycle_boundary_violated')
        backup = await self.call('export_cost_basis_backup', bookId=book_id)
        envelope = {key: backup[key] for key in ('format', 'version', 'kind', 'sha256', 'payload')}
        self.assertEqual(schema.check('BackupEnvelopeV2', envelope), [])
        plan = await self.call('request_cost_basis_reset_plan', bookId=book_id)
        reset = await self.call('reset_cost_basis_book', bookId=book_id, clientToken=token(),
                                confirmation=plan['phrase'], reason='',
                                expectedLedgerVersion=plan['ledgerVersion'],
                                bookIdentity=dict(IDENTITY), engineVersion=1)
        self.assertTrue(reset['success'], reset)
        plan = await self.call('request_cost_basis_reset_plan', bookId=book_id)
        restored = await self.call(
            'restore_cost_basis_backup', bookId=book_id, clientToken=token(),
            confirmation=plan['phrase'], expectedLedgerVersion=plan['ledgerVersion'],
            bookIdentity=dict(IDENTITY), engineVersion=1, backup=envelope)
        self.assertTrue(restored['success'], restored)
        self.assertEqual(restored['restoredEvents'], 2)

    async def test_messages_the_contract_refuses_never_reach_the_store(self):
        book_id = (await self.create())['book']['bookId']
        fut = at(example_event('FUT trade: cash is minus fees, notional stays out'),
                 '2026-10-01T14:30:05.000000Z')
        version = await self.version(book_id)
        refused = {
            'extra field': dict(action='append_cost_basis_event', bookId=book_id,
                                clientToken=token(), expectedLedgerVersion=version,
                                bookIdentity=dict(IDENTITY), allowOverdraw=True,
                                fopPackage=package(fut, contracts=[CLZ6])),
            'void without its version': dict(action='void_cost_basis_event', bookId=book_id,
                                             eventId='evt-0000000001', reason='x',
                                             clientToken=token(), bookIdentity=dict(IDENTITY)),
            'reset without identity': dict(action='reset_cost_basis_book', bookId=book_id,
                                           clientToken=token(), confirmation='RESET',
                                           reason='', expectedLedgerVersion=version),
            'stock multiplier on a FOP ledger': dict(
                action='create_cost_basis_book', account='U2222222', symbol='CL',
                startDate='2026-01-01', secType='FUT', currency='USD', note='',
                defaultSharesPerContract=1000, fop=dict(FOP_META)),
            'metadata of another shape': dict(action='commit_cost_basis_fop_metadata',
                                              bookId=book_id, clientToken=token(),
                                              expectedLedgerVersion=version,
                                              bookIdentity=dict(IDENTITY), engineVersion=1,
                                              operation={'kind': 'rename_ledger'}),
        }
        for name, message in refused.items():
            action = message.pop('action')
            with self.subTest(name):
                response = await self.call(action, **message)
                self.assertFalse(response['success'])
                self.assertEqual(response['code'], 'invalid_request', response)
        self.assertEqual((await self.call('list_cost_basis_events', bookId=book_id))['events'], [])
        self.assertEqual(len((await self.call('list_cost_basis_books'))['books']), 1)

    async def test_every_fop_write_names_the_engine_it_was_prepared_for(self):
        # P2 review R6: through the protocol, a void, a metadata commit, a
        # reset and a restore carry engineVersion like a package does.
        book_id = (await self.create())['book']['bookId']
        fut = await self.append(book_id, at(example_event(
            'FUT trade: cash is minus fees, notional stays out'), '2026-10-01T14:30:05.000000Z'),
            contracts=[CLZ6])
        void = dict(bookId=book_id, eventId=fut['event']['eventId'], reason='entered in error',
                    bookIdentity=dict(IDENTITY))
        missing = await self.call('void_cost_basis_event', clientToken=token(),
                                  expectedLedgerVersion=await self.version(book_id), **void)
        self.assertEqual(missing['code'], 'invalid_request')
        other = await self.call('void_cost_basis_event', clientToken=token(), engineVersion=2,
                                expectedLedgerVersion=await self.version(book_id), **void)
        self.assertEqual(other['code'], 'fop_engine_version_mismatch')
        plan = await self.call('request_cost_basis_reset_plan', bookId=book_id)
        reset = await self.call('reset_cost_basis_book', bookId=book_id, clientToken=token(),
                                confirmation=plan['phrase'], reason='', engineVersion=2,
                                expectedLedgerVersion=plan['ledgerVersion'],
                                bookIdentity=dict(IDENTITY))
        self.assertEqual(reset['code'], 'fop_engine_version_mismatch')
        listed = await self.call('list_cost_basis_events', bookId=book_id)
        self.assertEqual([e['voidedAtUtc'] for e in listed['events']], [None])

    def server_env(self, db_path, switch=None):
        """The store as both servers build it: create_store_env, then the first request opens it."""
        config = configparser.ConfigParser()
        config.read_string(f'[cost_basis]\ndb_path = {db_path}\n'
                           + ('' if switch is None else f'fop_writes_enabled = {switch}\n'))
        env = create_store_env(config, environ={})
        ensure_store_initialized(env)
        self.assertTrue(env['available'], env)
        return env

    async def test_the_release_backend_writes_new_fop_ledgers_and_nothing_older(self):
        # Plan §13.3 P6 step 6: after the release gates, both servers open the
        # new engine's writes; the old FUT format and synthetic_only row types
        # stay refused; [cost_basis] fop_writes_enabled = false closes them again.
        released = self.server_env(pathlib.Path(self._tmp.name) / 'released.db')
        status = await self.call('request_cost_basis_status', env=released)
        self.assertTrue(status['features']['fopLedger']['writesReleased'])
        created = await self.create(env=released)
        self.assertTrue(created['success'], created)
        book_id = created['book']['bookId']
        trade = package(at(example_event('FUT trade: cash is minus fees, notional stays out'),
                           '2026-10-01T14:30:05.000000Z'), contracts=[CLZ6])
        version = (await self.call('list_cost_basis_events', env=released, bookId=book_id))['ledgerVersion']
        written = await self.call('append_cost_basis_event', env=released, bookId=book_id, clientToken=token(),
                                  expectedLedgerVersion=version, bookIdentity=dict(IDENTITY), fopPackage=trade)
        self.assertTrue(written['success'], 'a new FOP ledger is writable')
        version = written['ledgerVersion']
        # The old FUT format: a FUT ledger without FOP metadata, a stock-path write, an aggregated roll.
        legacy = await self.call('create_cost_basis_book', env=released, account='U2222222', symbol='ES',
                                 startDate='2026-01-01', secType='FUT', defaultSharesPerContract=50)
        self.assertEqual(legacy['code'], 'futures_book_frozen', legacy)
        stock_path = await self.call('append_cost_basis_event', env=released, bookId=book_id, clientToken=token(),
                                     event={'kind': 'futures_roll', 'tradeDate': '2026-10-02', 'futureExpiry': '202612',
                                            'futureContracts': 1, 'price': 70, 'rollToExpiry': '202701',
                                            'rollToPrice': 71, 'rollGroup': 'r1', 'cashAmount': 0})
        self.assertEqual(stock_path['code'], 'futures_book_frozen', stock_path)
        roll = copy.deepcopy(trade)
        roll['events'][0]['kind'] = 'futures_roll'
        aggregated = await self.call('append_cost_basis_event', env=released, bookId=book_id, clientToken=token(),
                                     expectedLedgerVersion=version, bookIdentity=dict(IDENTITY), fopPackage=roll)
        self.assertFalse(aggregated['success'], aggregated)
        # A statement row type that no real statement has verified yet writes nothing.
        example = copy.deepcopy(EXAMPLES['statement import: two rows with their raw fields and the file '
                                         'registration'])
        fields = {key: value for key, value in example.items() if key not in ('action', 'requestId')}
        fields.update(bookId=book_id, bookIdentity=dict(IDENTITY), expectedLedgerVersion=version)
        synthetic = await self.call('import_cost_basis_events', env=released, **fields)
        self.assertEqual(synthetic['code'], 'fop_capability_not_verified', synthetic)
        self.assertEqual((await self.call('list_cost_basis_events', env=released, bookId=book_id))['ledgerVersion'],
                         version, 'nothing refused was written')
        # The switch closes FOP writes again; reads stay open.
        closed = self.server_env(pathlib.Path(self._tmp.name) / 'released.db', switch='false')
        status = await self.call('request_cost_basis_status', env=closed)
        self.assertFalse(status['features']['fopLedger']['writesReleased'])
        refused = await self.call('append_cost_basis_event', env=closed, bookId=book_id, clientToken=token(),
                                  expectedLedgerVersion=version, bookIdentity=dict(IDENTITY), fopPackage=trade)
        self.assertEqual(refused['code'], 'futures_book_frozen', refused)
        self.assertEqual((await self.create(env=closed))['code'], 'futures_book_frozen')
        exported = await self.call('export_cost_basis_backup', env=closed, bookId=book_id)
        self.assertTrue(exported['success'], 'reads stay open')
        self.assertTrue(self.server_env(pathlib.Path(self._tmp.name) / 'on.db', switch='on')['store']._fop_writes_enabled)
        with self.assertLogs('cost_basis.ws', 'WARNING'):
            odd = self.server_env(pathlib.Path(self._tmp.name) / 'odd.db', switch='maybe')
        self.assertFalse(odd['store']._fop_writes_enabled, 'an unreadable switch keeps writes closed')

    async def test_contract_details_are_served_only_where_a_resolver_exists(self):
        book_id = (await self.create())['book']['bookId']
        missing = await self.call('request_cost_basis_fop_contract_details', bookId=book_id,
                                  contracts=[LOZ6])
        self.assertEqual(missing['code'], 'fop_contract_details_unavailable')

        async def fetcher(query):
            return [copy.deepcopy(d) for d in (LOZ6_DETAILS, CLZ6_DETAILS)
                    if d['conId'] == query.get('conId')]

        live = self.make_env(fop_writes_enabled=True, fetcher=fetcher)
        response = await self.call('request_cost_basis_fop_contract_details', env=live,
                                   bookId=book_id, contracts=[LOZ6])
        self.assertTrue(response['success'], response)
        self.assertEqual(schema.check('ContractDetailsResponse', {
            key: response[key] for key in ('action', 'requestId', 'success', 'bookId', 'results')}), [])
        self.assertEqual(response['results'][0]['future']['futureContractMonth'], '202612')
        too_many = await self.call('request_cost_basis_fop_contract_details', env=live,
                                   bookId=book_id, contracts=[LOZ6] * 21)
        self.assertEqual(too_many['code'], 'invalid_request')

    def positions_env(self, items, *, accounts=None, ready=True, connected=True):
        env = self.make_env(fop_writes_enabled=True)

        async def fetch():
            return {'connected': connected, 'ready': ready,
                    'accounts': [IDENTITY['account']] if accounts is None else accounts,
                    'items': copy.deepcopy(items)}

        env['fetch_fop_positions'] = fetch
        return env

    TWS_ITEMS = [
        {'account': IDENTITY['account'], 'conId': 555, 'secType': 'FUT', 'symbol': 'CL', 'localSymbol': 'CLZ6',
         'expDate': '20261119', 'right': '', 'strike': 0.0, 'multiplier': '1000', 'tradingClass': 'CL',
         'position': 1.0, 'averageCost': 70002.02},
        {'account': IDENTITY['account'], 'conId': 9001, 'secType': 'FOP', 'symbol': 'CL',
         'localSymbol': 'LOZ6 C7500', 'expDate': '20261117', 'right': 'C', 'strike': 75.0, 'multiplier': '1000',
         'tradingClass': 'LO', 'position': -1.0, 'averageCost': 1197.5},
        # Another account, another root and a stock never reach the page.
        {'account': 'U2222222', 'conId': 555, 'secType': 'FUT', 'symbol': 'CL', 'localSymbol': 'CLZ6',
         'expDate': '20261119', 'right': '', 'strike': 0.0, 'multiplier': '1000', 'tradingClass': 'CL',
         'position': 3.0, 'averageCost': 69000.0},
        {'account': IDENTITY['account'], 'conId': 777, 'secType': 'FUT', 'symbol': 'MCL', 'localSymbol': 'MCLZ6',
         'expDate': '20261119', 'right': '', 'strike': 0.0, 'multiplier': '100', 'tradingClass': 'MCL',
         'position': 2.0, 'averageCost': 7000.0},
        {'account': IDENTITY['account'], 'conId': 320227571, 'secType': 'STK', 'symbol': 'QQQ', 'localSymbol': 'QQQ',
         'expDate': '', 'right': '', 'strike': 0.0, 'multiplier': '', 'tradingClass': 'NMS', 'position': 100.0,
         'averageCost': 400.0},
    ]

    async def held(self, env):
        book_id = (await self.create(env))['book']['bookId']
        for event, parts in (
                (at(example_event('FUT trade: cash is minus fees, notional stays out'),
                    '2026-10-01T14:30:05.000000Z'), {'contracts': [CLZ6]}),
                (at(example_event('short call with its contract record'), '2026-10-02T15:00:00.000000Z'),
                 {'contracts': [LOZ6]})):
            answer = await self.call('append_cost_basis_event', env=env, bookId=book_id, clientToken=token(),
                                     expectedLedgerVersion=await self.version_in(env, book_id),
                                     bookIdentity=dict(IDENTITY), fopPackage=package(event, **parts))
            self.assertTrue(answer['success'], answer)
        return book_id

    async def version_in(self, env, book_id):
        return (await self.call('list_cost_basis_events', env=env, bookId=book_id))['ledgerVersion']

    async def test_positions_are_only_the_ledger_account_and_root(self):
        book_id = (await self.create())['book']['bookId']
        missing = await self.call('request_cost_basis_fop_positions', bookId=book_id)
        self.assertEqual(missing['code'], 'fop_positions_unavailable', 'the historical backend has none')
        env = self.positions_env(self.TWS_ITEMS)
        answer = await self.call('request_cost_basis_fop_positions', env=env, bookId=book_id)
        self.assertTrue(answer['success'], answer)
        self.assertEqual(schema.check('FopPositionsResponse', answer), [])
        self.assertEqual([(item['localSymbol'], item['position'], item['averageCost'], item['multiplier'])
                          for item in answer['positions']],
                         [('CLZ6', 1, 70002.02, 1000), ('LOZ6 C7500', -1, 1197.5, 1000)])
        self.assertTrue(answer['accountConnected'] and answer['positionsReady'] and answer['evidenceCredential'])
        self.assertEqual(answer['ledgerVersion'], await self.version_in(env, book_id))
        # An account TWS does not manage: nothing is read, so nothing can be reconciled.
        offline = self.positions_env(self.TWS_ITEMS, accounts=['U2222222'])
        answer = await self.call('request_cost_basis_fop_positions', env=offline, bookId=book_id)
        self.assertEqual((answer['accountConnected'], answer['positionsReady'], answer['positions'],
                          answer['evidenceCredential']), (False, False, [], None))
        self.assertEqual(schema.check('FopPositionsResponse', answer), [])
        waiting = self.positions_env(self.TWS_ITEMS, ready=False)
        answer = await self.call('request_cost_basis_fop_positions', env=waiting, bookId=book_id)
        self.assertEqual((answer['accountConnected'], answer['positionsReady'], answer['evidenceCredential']),
                         (True, False, None))

    @staticmethod
    def rows_for(positions, status='matched', avg_cost='not_comparable'):
        """One FopReconciliationRow per position, as the page shows them."""
        return [{'contractId': None, 'localSymbol': item['localSymbol'], 'ledgerQuantity': item['position'],
                 'twsQuantity': item['position'], 'quantityStatus': status, 'ledgerAverage': None,
                 'twsAverage': None, 'avgCostStatus': avg_cost, 'note': ''} for item in positions['positions']]

    def snapshot_fields(self, book_id, version, positions=None, *, reconciled, rows=None, status='matched',
                        avg_cost='not_comparable'):
        evidence = None
        if positions is not None:
            evidence = {'kind': 'fop_positions', 'account': positions['account'],
                        'observedAtUtc': positions['observedAtUtc'], 'ledgerVersion': positions['ledgerVersion'],
                        'accountConnected': positions['accountConnected'],
                        'positionsReady': positions['positionsReady'], 'positions': positions['positions'],
                        'evidenceCredential': positions['evidenceCredential'],
                        'rows': self.rows_for(positions, status) if rows is None else rows,
                        'quantityStatus': status, 'avgCostStatus': avg_cost}
        return {'bookId': book_id, 'expectedLedgerVersion': version, 'bookIdentity': dict(IDENTITY),
                'asOfDate': '2026-11-12', 'accountScope': IDENTITY['account'], 'twsSnapshot': evidence,
                'reconciled': reconciled, 'note': 'end of day',
                'summary': {'ledgerVersion': version, 'quoteBatchId': None, 'quotes': [],
                            'completeness': {'quantity': 'complete' if status == 'matched' else 'incomplete',
                                             'openingCost': 'complete', 'binding': 'complete',
                                             'marketData': 'not_checked', 'coverage': 'not_checked',
                                             'cash': 'not_checked'}}}

    async def test_a_reconciliation_snapshot_is_held_to_its_evidence(self):
        env = self.positions_env(self.TWS_ITEMS)
        book_id = await self.held(env)
        version = await self.version_in(env, book_id)
        positions = await self.call('request_cost_basis_fop_positions', env=env, bookId=book_id)
        saved = await self.call('save_cost_basis_snapshot', env=env,
                                **self.snapshot_fields(book_id, version, positions, reconciled=True))
        self.assertTrue(saved['success'], saved)
        self.assertEqual((saved['snapshot']['reconciled'], saved['idempotentReplay']), (True, False))
        self.assertEqual(saved['snapshot']['eventsSha256'], version['digest'])
        self.assertEqual(await self.version_in(env, book_id), version, 'a snapshot changes no ledger version')
        # The same confirmation again is the first snapshot.
        again = await self.call('save_cost_basis_snapshot', env=env,
                                **self.snapshot_fields(book_id, version, positions, reconciled=True))
        self.assertEqual((again['snapshot']['snapshotId'], again['idempotentReplay']),
                         (saved['snapshot']['snapshotId'], True))
        listed = await self.call('list_cost_basis_snapshots', env=env, bookId=book_id)
        self.assertEqual(len(listed['snapshots']), 1)
        self.assertEqual(listed['snapshots'][0]['twsSnapshot']['positions'], positions['positions'])

        async def refused(fields, code, pattern):
            answer = await self.call('save_cost_basis_snapshot', env=env, **fields)
            self.assertEqual(answer.get('code'), code, answer)
            self.assertRegex(answer['message'], pattern)
            listed = await self.call('list_cost_basis_snapshots', env=env, bookId=book_id)
            self.assertEqual(len(listed['snapshots']), 1)

        # No broker evidence: never reconciled.
        await refused(self.snapshot_fields(book_id, version, reconciled=True), 'invalid_request', 'reconciled needs')
        # Positions other than the ones read.
        tampered = copy.deepcopy(positions)
        tampered['positions'][0]['position'] = 2
        await refused(self.snapshot_fields(book_id, version, tampered, reconciled=True), 'invalid_request',
                      'not the positions that were read')
        # Positions that differ from the ledger: a record of the mismatch, never "reconciled".
        env_two = self.positions_env([dict(self.TWS_ITEMS[0], position=2.0)] + self.TWS_ITEMS[1:])
        env_two['store'] = env['store']
        differing = await self.call('request_cost_basis_fop_positions', env=env_two, bookId=book_id)
        await refused(self.snapshot_fields(book_id, version, differing, reconciled=True), 'invalid_request',
                      '1 in the ledger, 2 in TWS')
        kept = await self.call('save_cost_basis_snapshot', env=env, **self.snapshot_fields(
            book_id, version, differing, reconciled=False, status='mismatch'))
        self.assertTrue(kept['success'], kept)
        self.assertFalse(kept['snapshot']['reconciled'])
        # Evidence read before the ledger moved belongs to that version.
        await self.call('append_cost_basis_event', env=env, bookId=book_id, clientToken=token(),
                        expectedLedgerVersion=version, bookIdentity=dict(IDENTITY),
                        fopPackage=package(at(example_event('FUT trade: cash is minus fees, notional stays out'),
                                              '2026-10-05T14:30:05.000000Z')))
        moved = await self.version_in(env, book_id)
        answer = await self.call('save_cost_basis_snapshot', env=env,
                                 **self.snapshot_fields(book_id, moved, positions, reconciled=False))
        self.assertEqual(answer['code'], 'ledger_changed', answer)
        # Writes closed: nothing is saved.
        closed = self.make_env(fop_writes_enabled=False)
        closed['store'] = CostBasisStore(self.db_path, fop_writes_enabled=False).initialize()
        answer = await self.call('save_cost_basis_snapshot', env=closed,
                                 **self.snapshot_fields(book_id, moved, reconciled=False))
        self.assertEqual(answer['code'], 'futures_book_frozen', answer)

    async def test_a_conid_conflict_or_a_partial_avg_cost_is_never_saved_as_agreeing(self):
        # Review P5-C3: TWS names CLZ6 with another conId than the ledger's 555.
        env = self.positions_env([dict(self.TWS_ITEMS[0], conId=999999)] + self.TWS_ITEMS[1:])
        book_id = await self.held(env)
        version = await self.version_in(env, book_id)
        conflicting = await self.call('request_cost_basis_fop_positions', env=env, bookId=book_id)
        self.assertEqual([item['conId'] for item in conflicting['positions']], [999999, 9001])

        async def refused(fields, pattern):
            answer = await self.call('save_cost_basis_snapshot', env=env, **fields)
            self.assertEqual(answer.get('code'), 'invalid_request', answer)
            self.assertRegex(answer['message'], pattern)
            listed = await self.call('list_cost_basis_snapshots', env=env, bookId=book_id)
            self.assertEqual(listed['snapshots'], [])

        await refused(self.snapshot_fields(book_id, version, conflicting, reconciled=True),
                      r'CLZ6 is conId 999999 in TWS but conId 555 in the ledger')
        # The summaries are what the rows say: some AvgCost comparable and the rest not is partial.
        env['fetch_fop_positions'] = self.positions_env(self.TWS_ITEMS)['fetch_fop_positions']
        positions = await self.call('request_cost_basis_fop_positions', env=env, bookId=book_id)
        rows = self.rows_for(positions)
        rows[1]['avgCostStatus'] = 'matched'
        await refused(self.snapshot_fields(book_id, version, positions, reconciled=True, rows=rows,
                                           avg_cost='matched'),
                      'avgCostStatus is matched, but its rows make it partial')
        mismatched = self.rows_for(positions)
        mismatched[0]['quantityStatus'] = 'mismatch'
        await refused(self.snapshot_fields(book_id, version, positions, reconciled=False, rows=mismatched),
                      'quantityStatus is matched, but its rows make it mismatch')
        # Positions TWS never read compare nothing.
        env['fetch_fop_positions'] = self.positions_env(self.TWS_ITEMS, accounts=['U2222222'])['fetch_fop_positions']
        unread = await self.call('request_cost_basis_fop_positions', env=env, bookId=book_id)
        self.assertEqual((unread['accountConnected'], unread['positions']), (False, []))
        await refused(self.snapshot_fields(book_id, version, unread, reconciled=False, rows=[], avg_cost='matched'),
                      'positions that were not read compare nothing')
        saved = await self.call('save_cost_basis_snapshot', env=env, **self.snapshot_fields(
            book_id, version, positions, reconciled=True, rows=rows, avg_cost='partial'))
        self.assertTrue(saved['success'], saved)
        self.assertEqual(saved['snapshot']['twsSnapshot']['avgCostStatus'], 'partial')
        offline = await self.call('save_cost_basis_snapshot', env=env, **self.snapshot_fields(
            book_id, version, unread, reconciled=False, rows=[], status='not_checked', avg_cost='not_checked'))
        self.assertTrue(offline['success'], offline)

    async def test_one_failing_request_answers_its_own_request_id(self):
        book_id = (await self.create())['book']['bookId']

        def explode(*args, **kwargs):
            raise RuntimeError('unexpected')

        self.env['store'].append_fop_event = explode
        response = await self.append(book_id, at(example_event(
            'FUT trade: cash is minus fees, notional stays out'), '2026-10-01T14:30:05.000000Z'),
            contracts=[CLZ6])
        self.assertEqual((response['success'], response['requestId'], response['code']),
                         (False, 'req-1', 'internal_store_error'))
        status = await self.call('request_cost_basis_status')
        self.assertTrue(status['success'], 'the connection keeps serving')


if __name__ == '__main__':
    unittest.main()
