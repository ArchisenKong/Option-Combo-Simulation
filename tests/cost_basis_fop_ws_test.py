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
    CLZ6, EXAMPLES, FOP_META, IDENTITY, LOZ6, at, example_event, package, token,
)
from cost_basis_store import CostBasisStore  # noqa: E402
from cost_basis_ws import create_store_env, handle_cost_basis_action  # noqa: E402

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

    def make_env(self, *, fop_writes_enabled, fetcher=None):
        config = configparser.ConfigParser()
        config.read_string(f'[cost_basis]\ndb_path = {self.db_path}\n')
        env = create_store_env(config, environ={})
        env.update(store=CostBasisStore(self.db_path, fop_writes_enabled=fop_writes_enabled)
                   .initialize(), available=True, _initialized=True)
        if fetcher is not None:
            env['fetch_fop_contract_details'] = fetcher
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
        self.assertEqual(status['features']['fopLedger'], {
            'engineVersion': 1, 'productRules': ['NYMEX-CL-v1'], 'writesReleased': True,
            'contractDetails': False})
        closed = await self.call('request_cost_basis_status',
                                 env=self.make_env(fop_writes_enabled=False))
        self.assertFalse(closed['features']['fopLedger']['writesReleased'])

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

    async def test_the_default_backend_keeps_fop_writes_closed(self):
        closed = self.make_env(fop_writes_enabled=False)
        response = await self.create(env=closed)
        self.assertEqual(response['code'], 'futures_book_frozen')
        book_id = (await self.create())['book']['bookId']
        refused = await self.call(
            'append_cost_basis_event', env=closed, bookId=book_id, clientToken=token(),
            expectedLedgerVersion=await self.version(book_id), bookIdentity=dict(IDENTITY),
            fopPackage=package(at(example_event('FUT trade: cash is minus fees, notional stays out'),
                                  '2026-10-01T14:30:05.000000Z'), contracts=[CLZ6]))
        self.assertEqual(refused['code'], 'futures_book_frozen')
        exported = await self.call('export_cost_basis_backup', env=closed, bookId=book_id)
        self.assertTrue(exported['success'], 'reads stay open')

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
