"""Shared helpers for the FOP ledger Python suites (not a test module)."""
import contextlib
from unittest import mock

import cost_basis_fop_statement
import cost_basis_store
from cost_basis_fop_store import FOP_TABLES
from cost_basis_store import CostBasisStore


@contextlib.contextmanager
def previous_build():
    """Run the store as the v10 build did: it writes and reads v10 ledgers.

    Lets a suite create a realistic v10 file (books, events, snapshots written
    through the real code paths) and then open it with the current build to
    exercise the v11 migration on it.
    """
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(cost_basis_store, 'SCHEMA_USER_VERSION', 10))
        stack.enter_context(mock.patch.object(
            CostBasisStore, '_migrate_v10_to_v11', lambda self, conn: None))
        stack.enter_context(mock.patch.object(
            CostBasisStore, '_backup_before_migration', lambda self, conn, version: None))
        stack.enter_context(mock.patch.object(
            CostBasisStore, '_fop_book_row', staticmethod(lambda conn, book_id: None)))
        stack.enter_context(mock.patch.object(
            CostBasisStore, '_delete_fop_graph',
            staticmethod(lambda conn, book_id, keep_book_row=False: {})))
        yield


def verified_capabilities():
    """The shipped capability list with every synthetic_only row type promoted
    to real_verified: what a store would accept once real statements verified
    them (plan §9.7). Only tests that write statement rows use it."""
    shipped = cost_basis_fop_statement.default_capabilities()
    return shipped.with_statuses({entry['key']: 'real_verified' for entry in shipped.document['keys']
                                  if entry['status'] == 'synthetic_only'})


def strip_v11_tables(conn):
    """Drop the tables v11 added, so a suite that rewinds user_version to an
    older schema hands the migration chain a file of that older shape."""
    for table in FOP_TABLES:
        conn.execute(f'DROP TABLE IF EXISTS {table}')


# ----------------------------------------------------------------------
# A FOP ledger built from the frozen contract examples
# ----------------------------------------------------------------------

import copy  # noqa: E402
import itertools  # noqa: E402
import json  # noqa: E402
import pathlib  # noqa: E402

PROTOCOL = json.loads((pathlib.Path(__file__).resolve().parent / 'fixtures' / 'cost_basis_fop'
                       / 'contract' / 'protocol.json').read_text(encoding='utf-8'))
EXAMPLES = {example['name']: example['value'] for example in PROTOCOL['examples']['valid']}
ACCOUNT = 'U1111111'
IDENTITY = {'account': ACCOUNT, 'symbol': 'CL', 'secType': 'FUT', 'currency': 'USD'}
FOP_META = {'engineVersion': 1, 'productRules': 'NYMEX-CL-v1', 'historyScope': 'full_history'}
CLZ6 = EXAMPLES['CLZ6 with delivery month and last trade date kept apart']
LOZ6 = EXAMPLES['LO call bound through a separate binding record']
MANUAL_BINDING = EXAMPLES['manual attestation carries no credential']
_TOKENS = itertools.count(1)


def token(prefix='tok'):
    return f'{prefix}-{next(_TOKENS):010d}'


def example_event(name, index=0):
    return copy.deepcopy(EXAMPLES[name]['fopPackage']['events'][index])


def at(event, instant):
    """The event executed at one instant (UtcInstant)."""
    event = copy.deepcopy(event)
    event['time'] = dict(event['time'], executedAtUtc=instant, timeRange=None)
    return event


def in_range(event, start, end, trade_date=None):
    event = copy.deepcopy(event)
    event['time'] = dict(event['time'], executedAtUtc=None,
                         timeRange={'startUtc': start, 'endUtc': end},
                         exchangeTradeDate=trade_date)
    return event


def package(*events, contracts=(), bindings=(), sources=(), engine=1):
    return {'version': 1, 'engineVersion': engine, 'contracts': [copy.deepcopy(c) for c in contracts],
            'bindings': [copy.deepcopy(b) for b in bindings],
            'sourceRecords': [copy.deepcopy(s) for s in sources], 'events': list(events)}


class FopLedger:
    """A temporary FOP ledger with FOP writes enabled, written through the store."""

    def __init__(self, db_path, *, history_scope='full_history', **store_options):
        self.db_path = db_path
        self.options = dict(store_options)
        self.store = CostBasisStore(db_path, fop_writes_enabled=True, **store_options).initialize()
        self.book = self.store.create_fop_book(account=ACCOUNT, symbol='CL',
                                               start_date='2026-01-01',
                                               fop=dict(FOP_META, historyScope=history_scope))
        self.book_id = self.book['bookId']

    def version(self):
        return self.store.ledger_version(self.book_id)

    def append(self, event, *, contracts=(), bindings=(), sources=(), client_token=None,
               store=None, expected=None, identity=None, engine=1):
        return (store or self.store).append_fop_event(
            self.book_id, package(event, contracts=contracts, bindings=bindings, sources=sources,
                                  engine=engine),
            client_token=client_token or token(),
            expected_ledger_version=expected if expected is not None else self.version(),
            book_identity=identity if identity is not None else dict(IDENTITY))

    def void(self, event_id, *, reason='entered in error', client_token=None, store=None,
             expected=None, identity=None, engine=1):
        return (store or self.store).void_fop_event(
            self.book_id, event_id, reason=reason, client_token=client_token or token(),
            expected_ledger_version=expected if expected is not None else self.version(),
            book_identity=identity if identity is not None else dict(IDENTITY),
            engine_version=engine)

    def events(self, include_voided=False):
        return self.store.list_events(self.book_id, include_voided=include_voided)['events']
