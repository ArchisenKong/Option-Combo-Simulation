"""FOP ledger persistence, mixed into cost_basis_store.CostBasisStore.

CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §8. The stock store owns the
connection, the transaction and the book row; this module owns the FOP
relation graph around the shared events table (contracts, bindings, event
details, cycles, sources, operations) and never runs outside a transaction
the store opened. Payload rules live in cost_basis_fop_domain.py, which knows
nothing about SQLite.

This module does not import cost_basis_store at load time, so either may be
imported first; the store's error classes are imported where they are used.

Writes are not released: until P6, a store only accepts FOP writes when it was
constructed with fop_writes_enabled=True (the P2 suites). The public entry
points keep refusing them with futures_book_frozen.

Every FOP write runs the same steps inside one BEGIN IMMEDIATE: the gate
(release, a ledger this engine supports), the ledger identity, the engine the
client prepared the write for, the request log (a retried token gets its
stored answer; any other use of it is refused), the reviewed ledger version,
the write, the whole-ledger proof, and the request row with its answer.
"""
import base64
import hashlib
import hmac
import json
import sqlite3
import uuid

import cost_basis_fop_domain as domain

# Children before parents, so a whole-graph delete never trips a foreign key.
FOP_GRAPH_TABLES = (
    'cost_basis_fop_event_details',
    'cost_basis_fop_source_allocations',
    'cost_basis_fop_reference_revisions',
    'cost_basis_fop_event_id_mappings',
    'cost_basis_fop_cycles',
    'cost_basis_fop_sources',
    'cost_basis_fop_operations',
    'cost_basis_fop_bindings',
    'cost_basis_fop_contracts',
    'cost_basis_fop_books',
)

# The request log (one row per accepted write request) outlives every graph
# replacement; only deleting the ledger removes it.
FOP_REQUEST_TABLE = 'cost_basis_fop_requests'
FOP_TABLES = (FOP_REQUEST_TABLE,) + FOP_GRAPH_TABLES
# Where a token may already be recorded by a write of either ledger kind.
_TOKEN_COLUMNS = (
    ('cost_basis_events', 'client_token'), ('cost_basis_events', 'voided_by_event_id'),
    ('cost_basis_fop_operations', 'client_token'), ('cost_basis_book_resets', 'client_token'),
)

# Tables whose rows are keyed by book_id directly; the others hang off an
# operation or a source of the book.
_BOOK_KEYED = frozenset({
    'cost_basis_fop_event_details', 'cost_basis_fop_cycles', 'cost_basis_fop_sources',
    'cost_basis_fop_operations', 'cost_basis_fop_bindings', 'cost_basis_fop_contracts',
    'cost_basis_fop_books',
})

_DETAIL_COLUMNS = (
    'contract_id', 'contract_revision', 'delivered_contract_id', 'delivered_contract_revision',
    'binding_id', 'binding_revision', 'open_close', 'fee_category', 'fee_is_refund',
    'fee_source_event_id', 'adjustment_scope', 'baseline_kind', 'baseline_as_of_utc',
    'exchange_trade_date', 'executed_at_utc', 'time_range_start_utc', 'time_range_end_utc',
    'source_time_text', 'source_timezone', 'order_evidence',
)
# The shared event columns a FOP row writes; every other column stays NULL
# or at its default (event_columns.json).
_EVENT_WRITE_COLUMNS = (
    'kind', 'trade_date', 'broker_timestamp', 'account', 'contracts', 'future_contracts',
    'price', 'cash_amount', 'fees', 'include_in_cost', 'tag', 'source', 'external_ref',
    'derived_mismatch', 'allow_overdraw', 'note',
)
_BINDING_RECORD_FIELDS = ('bindingId', 'revision', 'optionContractId', 'futureContractId',
                          'status', 'evidenceSummary', 'observedAtUtc')
_SOURCE_FIELDS = (
    ('account', 'account'), ('namespace', 'namespace'), ('sourceRef', 'source_ref'),
    ('capabilityKey', 'capability_key'), ('format', 'format'), ('section', 'section'),
    ('statedQuantity', 'stated_quantity'), ('statedFees', 'stated_fees'),
)
CREDENTIAL_TTL_SECONDS = 15 * 60


def delete_fop_graph(conn, book_id, *, keep_book_row=False):
    """Remove every FOP relation row of one book inside the caller's transaction.

    keep_book_row keeps cost_basis_fop_books (the ledger stays a FOP ledger)
    and the request log for a reset or a restore that replaces the graph; a
    whole-book deletion removes both too. Returns {table: rows removed}.
    """
    removed = {}
    if not keep_book_row:
        removed[FOP_REQUEST_TABLE] = conn.execute(
            f'DELETE FROM {FOP_REQUEST_TABLE} WHERE book_id = ?', (book_id,)).rowcount
    for table in FOP_GRAPH_TABLES:
        if keep_book_row and table == 'cost_basis_fop_books':
            continue
        if table in _BOOK_KEYED:
            sql = f'DELETE FROM {table} WHERE book_id = ?'
        elif table == 'cost_basis_fop_source_allocations':
            sql = (f'DELETE FROM {table} WHERE source_id IN '
                   '(SELECT source_id FROM cost_basis_fop_sources WHERE book_id = ?)')
        else:
            sql = (f'DELETE FROM {table} WHERE operation_id IN '
                   '(SELECT operation_id FROM cost_basis_fop_operations WHERE book_id = ?)')
        removed[table] = conn.execute(sql, (book_id,)).rowcount
    return removed


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _unb64(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def terms_digest(record):
    """A digest of what a contract is, independent of its record id and evidence."""
    return hashlib.sha256(domain.canonical_json(domain.contract_terms(record)).encode()).hexdigest()


def _store_errors():
    import cost_basis_store as base
    return base


def raise_store_error(exc):
    """A FopDomainError as the store error class of the same protocol code."""
    base = _store_errors()
    by_code = {
        'invalid_request': base.InvalidRequestError,
        'position_overdraw': base.PositionOverdrawError,
        'ledger_changed': base.LedgerChangedError,
        'import_revision_conflict': base.ImportRevisionConflictError,
        'fop_engine_version_mismatch': base.FopEngineVersionMismatchError,
        'fop_identity_conflict': base.FopIdentityConflictError,
        'fop_binding_evidence_invalid': base.FopBindingEvidenceInvalidError,
        'fop_cycle_boundary_violated': base.FopCycleBoundaryViolatedError,
        'fop_reference_revision_conflict': base.FopReferenceRevisionConflictError,
    }
    raise by_code.get(exc.code, base.InvalidRequestError)(str(exc)) from exc


class _StoredGraph:
    """Read access to one book's stored FOP records inside a transaction."""

    def __init__(self, conn, book_id):
        self.conn = conn
        self.book_id = book_id

    def contract(self, contract_id, revision):
        row = self.conn.execute(
            'SELECT * FROM cost_basis_fop_contracts WHERE book_id = ? AND contract_id = ? '
            'AND revision = ?', (self.book_id, contract_id, revision)).fetchone()
        return row

    def current_contract(self, contract_id):
        return self.conn.execute(
            'SELECT * FROM cost_basis_fop_contracts WHERE book_id = ? AND contract_id = ? '
            'AND superseded_by_revision IS NULL', (self.book_id, contract_id)).fetchone()

    def has_contract_id(self, contract_id):
        return self.conn.execute(
            'SELECT 1 FROM cost_basis_fop_contracts WHERE contract_id = ?',
            (contract_id,)).fetchone() is not None

    def current_contracts(self):
        return self.conn.execute(
            'SELECT * FROM cost_basis_fop_contracts WHERE book_id = ? '
            'AND superseded_by_revision IS NULL', (self.book_id,)).fetchall()

    def binding(self, binding_id, revision):
        return self.conn.execute(
            'SELECT * FROM cost_basis_fop_bindings WHERE book_id = ? AND binding_id = ? '
            'AND revision = ?', (self.book_id, binding_id, revision)).fetchone()

    def has_binding_id(self, binding_id):
        return self.conn.execute(
            'SELECT 1 FROM cost_basis_fop_bindings WHERE binding_id = ?',
            (binding_id,)).fetchone() is not None

    def current_binding_for_option(self, option_contract_id):
        return self.conn.execute(
            'SELECT * FROM cost_basis_fop_bindings WHERE book_id = ? AND option_contract_id = ? '
            'AND superseded_by_revision IS NULL', (self.book_id, option_contract_id)).fetchone()

    def source(self, account, namespace, source_ref):
        return self.conn.execute(
            'SELECT * FROM cost_basis_fop_sources WHERE book_id = ? AND account = ? '
            'AND namespace = ? AND source_ref = ?',
            (self.book_id, account, namespace, source_ref)).fetchone()

    def live_event(self, event_id):
        return self.conn.execute(
            'SELECT * FROM cost_basis_events WHERE book_id = ? AND event_id = ? '
            'AND voided_at_utc IS NULL', (self.book_id, event_id)).fetchone()


def _binding_record_from_row(row):
    return {
        'bindingId': row['binding_id'], 'revision': int(row['revision']),
        'optionContractId': row['option_contract_id'],
        'futureContractId': row['future_contract_id'], 'status': row['status'],
        'evidenceSummary': row['evidence_summary'], 'observedAtUtc': row['observed_at_utc'],
    }


def _source_record_from_row(row):
    record = {field: row[column] for field, column in _SOURCE_FIELDS}
    record['rawFields'] = json.loads(row['raw_fields_json'])
    return record


def _plain(value):
    if value is None:
        return None
    number = float(value)
    return int(number) if number.is_integer() else number


class FopLedgerMixin:
    """The FOP half of CostBasisStore."""

    # Set by CostBasisStore.__init__.
    _fop_writes_enabled = False
    _display_timezone = 'America/New_York'
    _credential_key = b''

    @staticmethod
    def _delete_fop_graph(conn, book_id, *, keep_book_row=False):
        return delete_fop_graph(conn, book_id, keep_book_row=keep_book_row)

    # ------------------------------------------------------------------
    # Gates
    # ------------------------------------------------------------------

    def _get_fop_writable_book(self, conn, book_id, action):
        """The FOP ledger, provided FOP writes are released on this store and
        this engine supports the ledger's engine version and product rules.

        Every FOP write calls it inside its write transaction.
        """
        base = _store_errors()
        book = self._get_book(conn, book_id)
        if book['secType'] != 'FUT':
            raise base.InvalidRequestError(
                f'{action}: this is a stock ledger; FOP packages go to FOP ledgers only')
        if book['fop'] is None:
            raise base.FuturesBookFrozenError(
                f'{action} is disabled: this FUT ledger was written by another build and '
                'has no FOP metadata, so it can only be exported or deleted')
        if not self._fop_writes_enabled:
            raise base.FuturesBookFrozenError(
                f'{action} is disabled until the standalone FOP ledger is released')
        try:
            domain.check_ledger_supported(book['fop'])
        except domain.FopDomainError as exc:
            raise_store_error(exc)
        return book

    def _open_fop_write(self, conn, book_id, action, *, book_identity, engine_version):
        """Gate, identity and client engine of one FOP write, inside its transaction."""
        book = self._get_fop_writable_book(conn, book_id, action)
        self._require_book_identity(book, book_identity)
        try:
            domain.check_write_guard(book['fop'], engine_version)
        except domain.FopDomainError as exc:
            raise_store_error(exc)
        return book

    # ------------------------------------------------------------------
    # The request log (review R5, R7)
    # ------------------------------------------------------------------

    @staticmethod
    def _request_digest(action, book_id, request):
        """What a request asked, independent of the guards it carried."""
        return hashlib.sha256(domain.canonical_json(
            {'action': action, 'bookId': book_id, 'request': request}).encode()).hexdigest()

    @staticmethod
    def _replayed_request(conn, book_id, action, client_token, digest):
        """The stored answer to this very request, None for an unused token.

        The same token with another ledger, another action or another request
        digest is refused, and so is a token some other write already recorded.
        A retry never re-validates against the ledger as it is now: a later
        contract correction or binding adoption does not turn a retried request
        into a different one.
        """
        base = _store_errors()
        row = conn.execute(f'SELECT * FROM {FOP_REQUEST_TABLE} WHERE client_token = ?',
                           (client_token,)).fetchone()
        if row is None:
            for table, column in _TOKEN_COLUMNS:
                if conn.execute(f'SELECT 1 FROM {table} WHERE {column} = ?',
                                (client_token,)).fetchone() is not None:
                    raise base.InvalidRequestError(
                        'clientToken has already been used by another write; nothing was written')
            return None
        if row['book_id'] != book_id:
            raise base.InvalidRequestError('clientToken has already been used for another ledger')
        if row['action'] != action:
            raise base.InvalidRequestError(
                f'clientToken was already used for a {row["action"]} request, not {action}; '
                'nothing was written')
        if row['request_digest'] != digest:
            raise base.InvalidRequestError(
                f'clientToken was already used for a different {action} request; nothing was '
                'written')
        result = json.loads(row['result_json'])
        result['idempotentReplay'] = True
        return result

    def _record_request(self, conn, book_id, action, client_token, digest, result):
        conn.execute(
            f'INSERT INTO {FOP_REQUEST_TABLE} (client_token, book_id, action, request_digest, '
            'result_json, created_at_utc) VALUES (?, ?, ?, ?, ?, ?)',
            (client_token, book_id, action, digest, domain.canonical_json(result),
             self._utc_now_iso()))

    # ------------------------------------------------------------------
    # Credentials for verified bindings (plan §4.3)
    # ------------------------------------------------------------------

    def issue_binding_credential(self, book_id, *, status, option, future, evidence,
                                 ttl_seconds=CREDENTIAL_TTL_SECONDS):
        """A bounded, expiring server credential for one verified FOP -> FUT pair.

        Only the read-only resolver (cost_basis_fop_broker.py) or a statement
        preview calls this. A browser cannot mint one, so posting a status
        string never counts as verification.
        """
        if status not in domain.VERIFIED_BINDING_STATUSES:
            raise _store_errors().InvalidRequestError('only a verified status carries a credential')
        claims = {
            'v': 1, 'kind': 'binding', 'bookId': book_id, 'status': status,
            'option': terms_digest(option), 'future': terms_digest(future),
            'evidence': hashlib.sha256(domain.canonical_json(evidence).encode()).hexdigest(),
            'exp': int(self.now_utc().timestamp()) + int(ttl_seconds),
        }
        body = _b64(domain.canonical_json(claims).encode())
        signature = _b64(hmac.new(self._credential_key, body.encode(), hashlib.sha256).digest())
        return f'{body}.{signature}'

    def _verify_binding_credential(self, book_id, record, option, future):
        """The evidence digest a valid credential carries, or a refusal."""
        base = _store_errors()
        credential = record.get('evidenceCredential') or ''
        try:
            body, signature = credential.split('.', 1)
            expected = _b64(hmac.new(self._credential_key, body.encode(), hashlib.sha256).digest())
            if not hmac.compare_digest(signature, expected):
                raise ValueError('signature')
            claims = json.loads(_unb64(body))
        except (ValueError, TypeError, json.JSONDecodeError):
            raise base.FopBindingEvidenceInvalidError(
                f'binding {record["bindingId"]}: the evidence credential was not issued by this '
                'server; resolve the contract again') from None
        problems = []
        if claims.get('kind') != 'binding' or claims.get('bookId') != book_id:
            problems.append('it was issued for another ledger')
        if claims.get('status') != record['status']:
            problems.append(f'it proves {claims.get("status")}, not {record["status"]}')
        if claims.get('option') != terms_digest(option) or future is None \
                or claims.get('future') != terms_digest(future):
            problems.append('it was issued for another option or future')
        if int(claims.get('exp') or 0) < int(self.now_utc().timestamp()):
            problems.append('it has expired')
        if problems:
            raise base.FopBindingEvidenceInvalidError(
                f'binding {record["bindingId"]}: the credential is not valid: '
                + '; '.join(problems) + '; resolve the contract again')
        return claims['evidence']

    # ------------------------------------------------------------------
    # Books
    # ------------------------------------------------------------------

    def create_fop_book(self, *, account, symbol, start_date, currency='USD', note='', fop,
                        book_id=None):
        """Create a FOP ledger: secType FUT, no stock multiplier, FOP metadata row."""
        base = _store_errors()
        if not self._fop_writes_enabled:
            raise base.FuturesBookFrozenError(
                'creating a FOP ledger is disabled until the standalone FOP ledger is released')
        account = base._require_account(account)
        symbol = base._require_symbol(symbol)
        start_date = base._require_trade_date(start_date, 'startDate')
        currency = str(currency or '').strip().upper()
        note = base._optional_text(note, 'note', base.MAX_NOTE_CHARS)
        try:
            meta = domain.check_fop_book_request(symbol=symbol, sec_type='FUT',
                                                 currency=currency, fop=fop)
        except domain.FopDomainError as exc:
            raise_store_error(exc)
        book_id = base._require_token('bookId', book_id) if book_id else uuid.uuid4().hex
        stamp = self._utc_now_iso()
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            try:
                existing = conn.execute(
                    'SELECT book_id FROM cost_basis_books WHERE account = ? COLLATE NOCASE '
                    "AND symbol = ? AND sec_type = 'FUT' AND currency = ? "
                    'AND archived_at_utc IS NULL', (account, symbol, currency)).fetchone()
                if existing is not None:
                    raise base.BookExistsError(
                        f'an active FUT ledger for account {account} and {symbol} '
                        f'({currency}) already exists')
                conn.execute(
                    'INSERT INTO cost_basis_books (book_id, account, symbol, sec_type, currency, '
                    'default_shares_per_contract, start_date, note, created_at_utc, '
                    "updated_at_utc) VALUES (?, ?, ?, 'FUT', ?, NULL, ?, ?, ?, ?)",
                    (book_id, account, symbol, currency, start_date, note, stamp, stamp))
                conn.execute(
                    'INSERT INTO cost_basis_fop_books (book_id, engine_version, product_rules, '
                    'history_scope, created_at_utc, updated_at_utc) VALUES (?, ?, ?, ?, ?, ?)',
                    (book_id, meta['engine_version'], meta['product_rules'],
                     meta['history_scope'], stamp, stamp))
                self._fault('fop_create_before_commit')
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()
        return self.get_book(book_id)

    # ------------------------------------------------------------------
    # Packages
    # ------------------------------------------------------------------

    def _prepare_fop_package(self, conn, book, package, *, mode, statement=None):
        """Validate a shape-checked package against the stored graph; write nothing.

        Returns the plan _apply_fop_plan writes.
        """
        base = _store_errors()
        graph = _StoredGraph(conn, book['bookId'])
        fop_book = book['fop']
        new_contracts = {}
        new_identity = {}
        new_con_ids = {}
        for record in package['contracts']:
            key = (record['contractId'], record['revision'])
            domain.check_contract_against_book(record, book=book,
                                               product_rules=fop_book['productRules'])
            if key in new_contracts:
                domain._refuse(f'contract {key[0]} revision {key[1]} appears twice',
                               'fop_identity_conflict')
            stored = graph.contract(*key)
            if stored is not None:
                if domain.contract_record_from_row(stored) != record:
                    domain._refuse(f'contract {key[0]} revision {key[1]} is stored with other '
                                   'terms or evidence; correct it with a metadata commit',
                                   'fop_identity_conflict')
                continue
            if graph.has_contract_id(record['contractId']):
                domain._refuse(f'contract {key[0]} already exists; a new revision is a '
                               'correct_contract metadata commit', 'fop_reference_revision_conflict')
            if record['revision'] != 1:
                domain._refuse(f'a new contract starts at revision 1, not {record["revision"]}',
                               'fop_reference_revision_conflict')
            identity = domain.contract_identity_key(record)
            if identity in new_identity:
                domain._refuse(f'contracts {new_identity[identity]} and {key[0]} are the same '
                               'contract', 'fop_identity_conflict')
            for current in graph.current_contracts():
                current_record = domain.contract_record_from_row(current)
                if domain.contract_identity_key(current_record) == identity:
                    domain._refuse(f'contract {key[0]} is the stored contract '
                                   f'{current["contract_id"]}; reference that record',
                                   'fop_identity_conflict')
                if record['conId'] is not None and current['con_id'] == record['conId']:
                    domain._refuse(f'conId {record["conId"]} already belongs to contract '
                                   f'{current["contract_id"]} with other terms',
                                   'fop_identity_conflict')
            if record['conId'] is not None:
                if record['conId'] in new_con_ids:
                    domain._refuse(f'conId {record["conId"]} names two contracts in one package',
                                   'fop_identity_conflict')
                new_con_ids[record['conId']] = key[0]
            new_identity[identity] = key[0]
            new_contracts[key] = record

        def current_contract_record(contract_id):
            for (cid, _rev), record in new_contracts.items():
                if cid == contract_id:
                    return record
            row = graph.current_contract(contract_id)
            return domain.contract_record_from_row(row) if row is not None else None

        def contract_for(ref):
            key = (ref['contractId'], ref['revision'])
            if key in new_contracts:
                return new_contracts[key]
            row = graph.contract(*key)
            if row is None:
                return None
            if row['superseded_by_revision'] is not None:
                domain._refuse(f'contract {key[0]} revision {key[1]} was superseded by revision '
                               f'{row["superseded_by_revision"]}; reload and reference the '
                               'current one', 'fop_reference_revision_conflict')
            return domain.contract_record_from_row(row)

        new_bindings = {}
        for record in package['bindings']:
            key = (record['bindingId'], record['revision'])
            option = current_contract_record(record['optionContractId'])
            future = (current_contract_record(record['futureContractId'])
                      if record['futureContractId'] else None)
            if option is None or option['secType'] != 'FOP':
                domain._refuse(f'binding {key[0]} binds {record["optionContractId"]}, which is '
                               'not a FOP contract of the package or the ledger',
                               'fop_identity_conflict')
            if record['futureContractId'] and (future is None or future['secType'] != 'FUT'):
                domain._refuse(f'binding {key[0]} names {record["futureContractId"]}, which is '
                               'not a FUT contract of the package or the ledger',
                               'fop_identity_conflict')
            stored = graph.binding(*key)
            if stored is not None:
                comparable = {field: record[field] for field in _BINDING_RECORD_FIELDS}
                if _binding_record_from_row(stored) != comparable:
                    domain._refuse(f'binding {key[0]} revision {key[1]} is stored differently; '
                                   'adopt a new revision with a metadata commit',
                                   'fop_identity_conflict')
                continue
            if graph.has_binding_id(record['bindingId']):
                domain._refuse(f'binding {key[0]} already exists; a new revision is an '
                               'adopt_binding metadata commit', 'fop_reference_revision_conflict')
            if record['revision'] != 1:
                domain._refuse(f'a new binding starts at revision 1, not {record["revision"]}',
                               'fop_reference_revision_conflict')
            if graph.current_binding_for_option(record['optionContractId']) is not None or any(
                    other['optionContractId'] == record['optionContractId']
                    for other, _digest in new_bindings.values()):
                domain._refuse(f'{record["optionContractId"]} already has a binding; adopt a new '
                               'revision with a metadata commit', 'fop_identity_conflict')
            digest = None
            if record['status'] in domain.VERIFIED_BINDING_STATUSES:
                digest = self._verify_binding_credential(book['bookId'], record, option, future)
            new_bindings[key] = (record, digest)

        def binding_for(ref):
            key = (ref['bindingId'], ref['revision'])
            if key in new_bindings:
                return new_bindings[key][0]
            row = graph.binding(*key)
            if row is None:
                return None
            if row['superseded_by_revision'] is not None:
                domain._refuse(f'binding {key[0]} revision {key[1]} was superseded; reload and '
                               'reference the current one', 'fop_reference_revision_conflict')
            return _binding_record_from_row(row)

        records = domain.check_source_records(package, book=book, kind=mode, statement=statement)
        new_sources = []
        for (namespace, source_ref), record in records.items():
            stored = graph.source(record['account'], namespace, source_ref)
            if stored is not None:
                domain._refuse(f'source {namespace}:{source_ref} is already recorded in this '
                               'ledger', 'import_revision_conflict')
            new_sources.append(record)

        domain.check_package_keys(package)

        def stored_fee_source(event_id):
            row = graph.live_event(event_id)
            return dict(row) if row is not None else None

        events = [
            domain.normalize_event(
                event, book=book, contract_for=contract_for, binding_for=binding_for,
                timezone_name=self._display_timezone, stored_fee_source=stored_fee_source)
            for event in package['events']
        ]
        return {'contracts': list(new_contracts.values()), 'bindings': list(new_bindings.values()),
                'sources': new_sources, 'events': events}

    def _apply_fop_plan(self, conn, book, plan, *, tokens, import_batch_id=None):
        """Write a prepared plan; returns the new event ids in package order."""
        book_id = book['bookId']
        stamp = self._utc_now_iso()
        for record in plan['contracts']:
            row = domain.contract_row(record, book_id=book_id, created_at=stamp)
            columns = ', '.join(row)
            conn.execute(f'INSERT INTO cost_basis_fop_contracts ({columns}) '
                         f'VALUES ({", ".join("?" for _ in row)})', tuple(row.values()))
        for record, digest in plan['bindings']:
            row = domain.binding_row(record, book_id=book_id, created_at=stamp,
                                     evidence_digest=digest)
            conn.execute(f'INSERT INTO cost_basis_fop_bindings ({", ".join(row)}) '
                         f'VALUES ({", ".join("?" for _ in row)})', tuple(row.values()))
        source_ids = {}
        for record in plan['sources']:
            source_id = uuid.uuid4().hex
            source_ids[(record['namespace'], record['sourceRef'])] = source_id
            conn.execute(
                'INSERT INTO cost_basis_fop_sources (source_id, book_id, account, namespace, '
                'source_ref, capability_key, format, section, raw_fields_json, stated_quantity, '
                'stated_fees, import_batch_id, created_at_utc) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (source_id, book_id, record['account'], record['namespace'], record['sourceRef'],
                 record['capabilityKey'], record['format'], record['section'],
                 domain.canonical_json(record['rawFields']), record['statedQuantity'],
                 record['statedFees'], import_batch_id, stamp))
        self._fault('fop_after_relations')
        seq = int(conn.execute(
            'SELECT COALESCE(max(seq), 0) FROM cost_basis_events WHERE book_id = ?',
            (book_id,)).fetchone()[0])
        event_ids = [uuid.uuid4().hex for _ in plan['events']]
        external_refs = domain.event_external_refs(plan['events'], event_ids)
        by_package_key = {}
        for index, (event_id, normalized) in enumerate(zip(event_ids, plan['events'])):
            seq += 1
            row = dict(normalized['event'], external_ref=external_refs[index])
            conn.execute(
                'INSERT INTO cost_basis_events (event_id, book_id, seq, client_token, '
                f'{", ".join(_EVENT_WRITE_COLUMNS)}, import_batch_id, created_at_utc) '
                f'VALUES (?, ?, ?, ?, {", ".join("?" for _ in _EVENT_WRITE_COLUMNS)}, ?, ?)',
                (event_id, book_id, seq, tokens(index),
                 *(row[column] for column in _EVENT_WRITE_COLUMNS), import_batch_id, stamp))
            details = normalized['details']
            conn.execute(
                'INSERT INTO cost_basis_fop_event_details (event_id, book_id, '
                f'{", ".join(_DETAIL_COLUMNS)}) '
                f'VALUES (?, ?, {", ".join("?" for _ in _DETAIL_COLUMNS)})',
                (event_id, book_id, *(details[column] for column in _DETAIL_COLUMNS)))
            for allocation in normalized['allocations']:
                source_id = source_ids.get((allocation['namespace'], allocation['sourceRef']))
                if source_id is None:
                    raise _store_errors().InvalidRequestError(
                        f'allocation {allocation["namespace"]}:{allocation["sourceRef"]} has no '
                        'new source record')
                conn.execute(
                    'INSERT INTO cost_basis_fop_source_allocations (source_id, event_id, role, '
                    'quantity, fees, created_at_utc) VALUES (?, ?, ?, ?, ?, ?)',
                    (source_id, event_id, allocation['role'], allocation['quantity'],
                     allocation['fees'], stamp))
            if normalized['package_key'] is not None:
                by_package_key[normalized['package_key']] = event_id
            self._fault('fop_after_event')
        for event_id, normalized in zip(event_ids, plan['events']):
            source = normalized['fee_source']
            if source and source['packageKey'] is not None:
                conn.execute(
                    'UPDATE cost_basis_fop_event_details SET fee_source_event_id = ? '
                    'WHERE event_id = ?', (by_package_key[source['packageKey']], event_id))
        return event_ids

    def _validate_fop_ledger(self, conn, book_id):
        """The P2 timeline: quantities, cycle anchors and fee sources of the whole book."""
        rows = [dict(row) for row in conn.execute(
            'SELECT e.event_id, e.seq, e.kind, e.contracts, e.future_contracts, d.* '
            'FROM cost_basis_events e JOIN cost_basis_fop_event_details d '
            'ON d.event_id = e.event_id WHERE e.book_id = ? AND e.voided_at_utc IS NULL',
            (book_id,))]
        orphans = conn.execute(
            'SELECT count(*) FROM cost_basis_events e WHERE e.book_id = ? AND NOT EXISTS ('
            'SELECT 1 FROM cost_basis_fop_event_details d WHERE d.event_id = e.event_id)',
            (book_id,)).fetchone()[0]
        if orphans:
            domain._refuse(f'{orphans} events of this FOP ledger have no FOP details')
        live = {row['event_id']: row for row in rows}
        _order, after = domain.replay_quantities(rows)
        boundaries = [dict(row) for row in conn.execute(
            "SELECT * FROM cost_basis_fop_cycles WHERE book_id = ? AND state = 'closed' "
            'AND superseded_by_revision IS NULL', (book_id,))]
        domain.check_cycle_anchors(boundaries, after, set(live))
        for row in rows:
            source = row['fee_source_event_id']
            if row['kind'] != 'fee' or source is None:
                continue
            target = live.get(source)
            if target is None:
                domain._refuse(
                    f'fee {row["event_id"]} names {source} as its source, which is no longer a '
                    'live event; void or re-enter the fee first', 'fop_reference_revision_conflict')
            if target['kind'] == 'fee':
                domain._refuse('a fee cannot be the source of another fee')

    def append_fop_event(self, book_id, package, *, client_token, expected_ledger_version,
                         book_identity):
        """Append one FOP event package (AppendRequest.fopPackage).

        Inside the write lock: the gate, identity, the engine the package was
        prepared for, the request log, then the reviewed ledger version. The
        same clientToken with the same package gets the original answer, also
        after later metadata commits moved the event's references; with
        another package it is refused.
        """
        base = _store_errors()
        base._require_token('clientToken', client_token)
        try:
            domain.require_shape('FopPackageSingle', package, 'fopPackage')
        except domain.FopDomainError as exc:
            raise_store_error(exc)
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            try:
                book = self._open_fop_write(conn, book_id, 'appending an event',
                                            book_identity=book_identity,
                                            engine_version=package['engineVersion'])
                digest = self._request_digest('append', book_id, {'package': package})
                replay = self._replayed_request(conn, book_id, 'append', client_token, digest)
                if replay is not None:
                    conn.execute('ROLLBACK')
                    return replay
                self._require_ledger_version(conn, book_id, expected_ledger_version)
                try:
                    plan = self._prepare_fop_package(conn, book, package, mode='append')
                    event_ids = self._apply_fop_plan(conn, book, plan,
                                                     tokens=lambda index: client_token)
                    self._validate_fop_ledger(conn, book_id)
                except domain.FopDomainError as exc:
                    raise_store_error(exc)
                self._invalidate_coverage(conn, book_id, plan['events'][0]['event']['trade_date'])
                result = {'bookId': book_id, 'event': self._listed_fop_event(conn, event_ids[0]),
                          'ledgerVersion': self._ledger_version(conn, book_id),
                          'warnings': [], 'idempotentReplay': False}
                self._record_request(conn, book_id, 'append', client_token, digest, result)
                self._fault('fop_before_commit')
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return result
        except sqlite3.IntegrityError as exc:
            raise self._map_integrity_error(exc) from exc
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def void_fop_event(self, book_id, event_id, *, reason, client_token, expected_ledger_version,
                       book_identity, engine_version=None):
        """Void one FOP event (VoidRequest). The row stays; the whole book is re-proven."""
        base = _store_errors()
        base._require_token('clientToken', client_token)
        base._require_token('eventId', event_id)
        reason = base._optional_text(reason, 'reason', base.MAX_NOTE_CHARS)
        if not reason:
            raise base.InvalidRequestError('a void requires a reason')
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            try:
                self._open_fop_write(conn, book_id, 'voiding an event',
                                     book_identity=book_identity, engine_version=engine_version)
                digest = self._request_digest('void', book_id, {
                    'eventId': event_id, 'reason': reason, 'engineVersion': engine_version})
                replay = self._replayed_request(conn, book_id, 'void', client_token, digest)
                if replay is not None:
                    conn.execute('ROLLBACK')
                    return replay
                self._require_ledger_version(conn, book_id, expected_ledger_version)
                row = conn.execute(
                    'SELECT * FROM cost_basis_events WHERE book_id = ? AND event_id = ?',
                    (book_id, event_id)).fetchone()
                if row is None:
                    raise base.EventNotFoundError('no event with that id in this ledger')
                if row['voided_at_utc']:
                    raise base.EventAlreadyVoidedError('event is already voided')
                conn.execute(
                    'UPDATE cost_basis_events SET voided_at_utc = ?, voided_by_event_id = ?, '
                    'void_reason = ? WHERE event_id = ?',
                    (self._utc_now_iso(), client_token, reason, event_id))
                try:
                    self._validate_fop_ledger(conn, book_id)
                except domain.FopDomainError as exc:
                    raise_store_error(exc)
                self._invalidate_coverage(conn, book_id, row['trade_date'])
                result = {'bookId': book_id, 'event': self._listed_fop_event(conn, event_id),
                          'ledgerVersion': self._ledger_version(conn, book_id),
                          'idempotentReplay': False}
                self._record_request(conn, book_id, 'void', client_token, digest, result)
                self._fault('fop_before_commit')
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return result
        except sqlite3.IntegrityError as exc:
            raise self._map_integrity_error(exc) from exc
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Metadata operations (plan §4.3, §1.3, §10.2)
    # ------------------------------------------------------------------

    def commit_fop_metadata(self, book_id, operation, *, client_token, expected_ledger_version,
                            book_identity, engine_version=None):
        """Apply one typed metadata operation (MetadataCommitRequest.operation).

        adopt_binding and correct_contract write a new revision and move the
        references of exactly the live events the server finds; the request
        must list the same set (its preview), or it is stale. close_cycle and
        revoke_cycle revise a boundary. Every operation is recorded with its
        payload digest and the ledger digest before and after; the request
        log answers a retried token.
        """
        base = _store_errors()
        base._require_token('clientToken', client_token)
        try:
            domain.require_shape('MetadataOperation', operation, 'operation')
        except domain.FopDomainError as exc:
            raise_store_error(exc)
        payload_digest = hashlib.sha256(domain.canonical_json(operation).encode()).hexdigest()
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            try:
                book = self._open_fop_write(conn, book_id, 'committing FOP metadata',
                                            book_identity=book_identity,
                                            engine_version=engine_version)
                digest = self._request_digest('metadata', book_id, {
                    'operation': operation, 'engineVersion': engine_version})
                replay = self._replayed_request(conn, book_id, 'metadata', client_token, digest)
                if replay is not None:
                    conn.execute('ROLLBACK')
                    return replay
                self._require_ledger_version(conn, book_id, expected_ledger_version)
                digest_before = self._ledger_version(conn, book_id)['digest']
                operation_id = uuid.uuid4().hex
                try:
                    changes = getattr(self, f'_op_{operation["kind"]}')(conn, book, operation)
                    self._validate_fop_ledger(conn, book_id)
                except domain.FopDomainError as exc:
                    raise_store_error(exc)
                digest_after = self._ledger_version(conn, book_id)['digest']
                stamp = self._utc_now_iso()
                conn.execute(
                    'INSERT INTO cost_basis_fop_operations (operation_id, book_id, client_token, '
                    'kind, payload_digest, ledger_digest_before, ledger_digest_after, '
                    'created_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    (operation_id, book_id, client_token, operation['kind'], payload_digest,
                     digest_before, digest_after, stamp))
                for change in changes:
                    conn.execute(
                        'INSERT INTO cost_basis_fop_reference_revisions (operation_id, event_id, '
                        'reference, before_id, before_revision, after_id, after_revision) '
                        'VALUES (?, ?, ?, ?, ?, ?, ?)',
                        (operation_id, change['eventId'], change['reference'],
                         change['before']['id'], change['before']['revision'],
                         change['after']['id'], change['after']['revision']))
                stored = conn.execute('SELECT * FROM cost_basis_fop_operations WHERE operation_id = ?',
                                      (operation_id,)).fetchone()
                result = self._operation_result(conn, book_id, stored, replay=False)
                self._record_request(conn, book_id, 'metadata', client_token, digest, result)
                self._fault('fop_before_commit')
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return result
        except sqlite3.IntegrityError as exc:
            raise self._map_integrity_error(exc) from exc
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def _operation_result(self, conn, book_id, row, *, replay):
        changes = [
            {'eventId': change['event_id'], 'reference': change['reference'],
             'before': {'id': change['before_id'], 'revision': change['before_revision']},
             'after': {'id': change['after_id'], 'revision': change['after_revision']}}
            for change in conn.execute(
                'SELECT * FROM cost_basis_fop_reference_revisions WHERE operation_id = ? '
                'ORDER BY event_id, reference', (row['operation_id'],))
        ]
        return {
            'bookId': book_id,
            'operation': {'operationId': row['operation_id'], 'kind': row['kind'],
                          'ledgerDigestBefore': row['ledger_digest_before'],
                          'ledgerDigestAfter': row['ledger_digest_after'],
                          'createdAtUtc': row['created_at_utc'], 'referenceChanges': changes},
            'ledgerVersion': self._ledger_version(conn, book_id),
            'idempotentReplay': replay,
        }

    @staticmethod
    def _require_affected(submitted, expected, what):
        """The references a preview listed must be exactly the ones the ledger has."""
        def key(change):
            return (change['eventId'], change['reference'], change['before']['id'],
                    change['before']['revision'], change['after']['id'],
                    change['after']['revision'])
        if sorted(map(key, submitted)) != sorted(map(key, expected)):
            domain._refuse(
                f'{what}: the affected references in the request are not the ones this ledger '
                f'holds ({len(submitted)} listed, {len(expected)} found); preview again',
                'fop_reference_revision_conflict')

    def _op_adopt_binding(self, conn, book, operation):
        record = operation['binding']
        graph = _StoredGraph(conn, book['bookId'])
        current = conn.execute(
            'SELECT * FROM cost_basis_fop_bindings WHERE book_id = ? AND binding_id = ? '
            'AND superseded_by_revision IS NULL', (book['bookId'], record['bindingId'])).fetchone()
        if current is None:
            domain._refuse(f'binding {record["bindingId"]} does not exist; a first binding '
                           'travels with the package that needs it', 'fop_reference_revision_conflict')
        if record['revision'] != int(current['revision']) + 1:
            domain._refuse(f'binding {record["bindingId"]} is at revision {current["revision"]}; '
                           f'the next one is {int(current["revision"]) + 1}, not '
                           f'{record["revision"]}', 'fop_reference_revision_conflict')
        if record['optionContractId'] != current['option_contract_id']:
            domain._refuse('a binding revision keeps its option contract', 'fop_identity_conflict')
        option_row = graph.current_contract(record['optionContractId'])
        future_row = (graph.current_contract(record['futureContractId'])
                      if record['futureContractId'] else None)
        if record['futureContractId'] and (future_row is None or future_row['sec_type'] != 'FUT'):
            domain._refuse(f'{record["futureContractId"]} is not a FUT contract of this ledger',
                           'fop_identity_conflict')
        option = domain.contract_record_from_row(option_row)
        future = domain.contract_record_from_row(future_row) if future_row is not None else None
        affected_rows = conn.execute(
            'SELECT d.event_id FROM cost_basis_fop_event_details d JOIN cost_basis_events e '
            'ON e.event_id = d.event_id WHERE d.book_id = ? AND d.binding_id = ? '
            'AND d.binding_revision = ? AND e.voided_at_utc IS NULL ORDER BY d.event_id',
            (book['bookId'], record['bindingId'], int(current['revision']))).fetchall()
        if affected_rows and current['future_contract_id'] != record['futureContractId']:
            # A confirmed delivery moving to another FUT moves realized P&L to
            # another month: an economic correction, not a binding adoption.
            domain._refuse(
                f'{len(affected_rows)} deliveries rest on {current["future_contract_id"]}; moving '
                'them to another future is an economic correction (archived rebuild)',
                'fop_identity_conflict')
        digest = None
        if record['status'] in domain.VERIFIED_BINDING_STATUSES:
            digest = self._verify_binding_credential(book['bookId'], record, option, future)
        expected = [
            {'eventId': row['event_id'], 'reference': 'binding',
             'before': {'id': record['bindingId'], 'revision': int(current['revision'])},
             'after': {'id': record['bindingId'], 'revision': record['revision']}}
            for row in affected_rows
        ]
        self._require_affected(operation['affected'], expected, 'adopt_binding')
        conn.execute('UPDATE cost_basis_fop_bindings SET superseded_by_revision = ? '
                     'WHERE binding_id = ? AND revision = ?',
                     (record['revision'], record['bindingId'], int(current['revision'])))
        row = domain.binding_row(record, book_id=book['bookId'], created_at=self._utc_now_iso(),
                                 evidence_digest=digest)
        conn.execute(f'INSERT INTO cost_basis_fop_bindings ({", ".join(row)}) '
                     f'VALUES ({", ".join("?" for _ in row)})', tuple(row.values()))
        for change in expected:
            conn.execute('UPDATE cost_basis_fop_event_details SET binding_revision = ? '
                         'WHERE event_id = ?', (record['revision'], change['eventId']))
        return expected

    def _op_correct_contract(self, conn, book, operation):
        record = operation['contract']
        graph = _StoredGraph(conn, book['bookId'])
        current = graph.current_contract(record['contractId'])
        if current is None:
            domain._refuse(f'contract {record["contractId"]} does not exist',
                           'fop_reference_revision_conflict')
        if record['revision'] != int(current['revision']) + 1:
            domain._refuse(f'contract {record["contractId"]} is at revision {current["revision"]}; '
                           f'the next one is {int(current["revision"]) + 1}',
                           'fop_reference_revision_conflict')
        domain.check_contract_against_book(record, book=book,
                                           product_rules=book['fop']['productRules'])
        domain.check_contract_revision(domain.contract_record_from_row(current), record)
        # Filling in tradingClass or conId can make this record name the same
        # real contract as another current one: one real contract, one record,
        # as for a new contract in a package (plan §4.2).
        domain.check_current_contracts_distinct([record] + [
            domain.contract_record_from_row(other) for other in graph.current_contracts()
            if other['contract_id'] != record['contractId']])
        revision = int(current['revision'])
        affected_rows = conn.execute(
            "SELECT d.event_id, 'contract' AS reference FROM cost_basis_fop_event_details d "
            'JOIN cost_basis_events e ON e.event_id = d.event_id WHERE d.book_id = ? '
            'AND d.contract_id = ? AND d.contract_revision = ? AND e.voided_at_utc IS NULL '
            "UNION ALL SELECT d.event_id, 'delivered_contract' FROM cost_basis_fop_event_details d "
            'JOIN cost_basis_events e ON e.event_id = d.event_id WHERE d.book_id = ? '
            'AND d.delivered_contract_id = ? AND d.delivered_contract_revision = ? '
            'AND e.voided_at_utc IS NULL',
            (book['bookId'], record['contractId'], revision,
             book['bookId'], record['contractId'], revision)).fetchall()
        expected = [
            {'eventId': row['event_id'], 'reference': row['reference'],
             'before': {'id': record['contractId'], 'revision': revision},
             'after': {'id': record['contractId'], 'revision': record['revision']}}
            for row in affected_rows
        ]
        self._require_affected(operation['affected'], expected, 'correct_contract')
        conn.execute('UPDATE cost_basis_fop_contracts SET superseded_by_revision = ? '
                     'WHERE contract_id = ? AND revision = ?',
                     (record['revision'], record['contractId'], revision))
        row = domain.contract_row(record, book_id=book['bookId'], created_at=self._utc_now_iso())
        conn.execute(f'INSERT INTO cost_basis_fop_contracts ({", ".join(row)}) '
                     f'VALUES ({", ".join("?" for _ in row)})', tuple(row.values()))
        for change in expected:
            column = 'contract_revision' if change['reference'] == 'contract' \
                else 'delivered_contract_revision'
            conn.execute(f'UPDATE cost_basis_fop_event_details SET {column} = ? WHERE event_id = ?',
                         (record['revision'], change['eventId']))
        return expected

    def _current_boundary(self, conn, book_id, boundary_id):
        return conn.execute(
            'SELECT * FROM cost_basis_fop_cycles WHERE book_id = ? AND boundary_id = ? '
            'AND superseded_by_revision IS NULL', (book_id, boundary_id)).fetchone()

    def _write_boundary(self, conn, book_id, boundary_id, current, *, state, anchor, label):
        revision = 1 if current is None else int(current['revision']) + 1
        if current is not None:
            conn.execute('UPDATE cost_basis_fop_cycles SET superseded_by_revision = ? '
                         'WHERE boundary_id = ? AND revision = ?',
                         (revision, boundary_id, int(current['revision'])))
        conn.execute(
            'INSERT INTO cost_basis_fop_cycles (boundary_id, revision, book_id, state, '
            'anchor_event_id, label, superseded_by_revision, created_at_utc) '
            'VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
            (boundary_id, revision, book_id, state, anchor, label, self._utc_now_iso()))

    def _op_close_cycle(self, conn, book, operation):
        book_id = book['bookId']
        if conn.execute('SELECT 1 FROM cost_basis_fop_cycles WHERE boundary_id = ? AND book_id <> ?',
                        (operation['boundaryId'], book_id)).fetchone():
            domain._refuse('that boundary id belongs to another ledger')
        current = self._current_boundary(conn, book_id, operation['boundaryId'])
        if current is not None and current['state'] == 'closed':
            domain._refuse(f'boundary {operation["boundaryId"]} is already closed',
                           'fop_cycle_boundary_violated')
        anchor = operation['anchorEventId']
        if _StoredGraph(conn, book_id).live_event(anchor) is None:
            domain._refuse(f'{anchor} is not a live event of this ledger',
                           'fop_cycle_boundary_violated')
        self._write_boundary(conn, book_id, operation['boundaryId'], current, state='closed',
                             anchor=anchor, label=operation['label'])
        return []

    def _op_revoke_cycle(self, conn, book, operation):
        current = self._current_boundary(conn, book['bookId'], operation['boundaryId'])
        if current is None or current['state'] != 'closed':
            domain._refuse(f'boundary {operation["boundaryId"]} is not a closed boundary of this '
                           'ledger', 'fop_cycle_boundary_violated')
        self._write_boundary(conn, book['bookId'], operation['boundaryId'], current,
                             state='revoked', anchor=None, label=current['label'])
        return []

    # ------------------------------------------------------------------
    # The whole graph: backup v2, reset archives, restore and rebuild (plan §8.3)
    # ------------------------------------------------------------------

    GRAPH_FORMAT = 'cost-basis-fop-graph'
    RESTORE_LIMIT_EVENTS = 100000

    def _fop_graph_payload(self, conn, book):
        """BackupPayloadV2: the ledger and every FOP relation, voided events included."""
        book_id = book['bookId']
        fop_row = self._fop_book_row(conn, book_id)
        contracts = [
            {'record': domain.contract_record_from_row(row),
             'supersededByRevision': row['superseded_by_revision'],
             'createdAtUtc': row['created_at_utc']}
            for row in conn.execute('SELECT * FROM cost_basis_fop_contracts WHERE book_id = ? '
                                    'ORDER BY contract_id, revision', (book_id,))]
        bindings = [
            {**_binding_record_from_row(row), 'evidenceDigest': row['evidence_digest'],
             'supersededByRevision': row['superseded_by_revision'],
             'createdAtUtc': row['created_at_utc']}
            for row in conn.execute('SELECT * FROM cost_basis_fop_bindings WHERE book_id = ? '
                                    'ORDER BY binding_id, revision', (book_id,))]
        events = []
        for row in conn.execute('SELECT * FROM cost_basis_events WHERE book_id = ? ORDER BY seq',
                                (book_id,)).fetchall():
            details = conn.execute('SELECT * FROM cost_basis_fop_event_details WHERE event_id = ?',
                                   (row['event_id'],)).fetchone()
            events.append({'row': self._listed_fop_row(conn, row, details),
                           'clientToken': row['client_token'], 'createdAtUtc': row['created_at_utc'],
                           'voidedByEventId': row['voided_by_event_id'],
                           'voidReason': row['void_reason'],
                           'primarySourceId': self._primary_source_id(conn, row)})
        cycles = [
            {'boundaryId': row['boundary_id'], 'revision': int(row['revision']),
             'state': row['state'], 'anchorEventId': row['anchor_event_id'], 'label': row['label'],
             'supersededByRevision': row['superseded_by_revision'],
             'createdAtUtc': row['created_at_utc']}
            for row in conn.execute('SELECT * FROM cost_basis_fop_cycles WHERE book_id = ? '
                                    'ORDER BY boundary_id, revision', (book_id,))]
        sources = [
            {'sourceId': row['source_id'], **_source_record_from_row(row),
             'importBatchId': row['import_batch_id'], 'createdAtUtc': row['created_at_utc']}
            for row in conn.execute('SELECT * FROM cost_basis_fop_sources WHERE book_id = ? '
                                    'ORDER BY source_id', (book_id,))]
        allocations = [
            {'sourceId': row['source_id'], 'eventId': row['event_id'], 'role': row['role'],
             'quantity': row['quantity'], 'fees': row['fees'], 'createdAtUtc': row['created_at_utc']}
            for row in conn.execute(
                'SELECT a.* FROM cost_basis_fop_source_allocations a JOIN cost_basis_fop_sources s '
                'ON s.source_id = a.source_id WHERE s.book_id = ? '
                'ORDER BY a.source_id, a.event_id, a.role', (book_id,))]
        operations = [
            {'operationId': row['operation_id'], 'clientToken': row['client_token'],
             'kind': row['kind'], 'payloadDigest': row['payload_digest'],
             'ledgerDigestBefore': row['ledger_digest_before'],
             'ledgerDigestAfter': row['ledger_digest_after'], 'createdAtUtc': row['created_at_utc']}
            for row in conn.execute('SELECT * FROM cost_basis_fop_operations WHERE book_id = ? '
                                    'ORDER BY created_at_utc, operation_id', (book_id,))]
        revisions = [
            {'operationId': row['operation_id'], 'eventId': row['event_id'],
             'reference': row['reference'],
             'before': {'id': row['before_id'], 'revision': row['before_revision']},
             'after': {'id': row['after_id'], 'revision': row['after_revision']}}
            for row in conn.execute(
                'SELECT r.* FROM cost_basis_fop_reference_revisions r JOIN '
                'cost_basis_fop_operations o ON o.operation_id = r.operation_id WHERE o.book_id = ? '
                'ORDER BY r.operation_id, r.event_id, r.reference', (book_id,))]
        mappings = [
            {'operationId': row['operation_id'], 'oldEventId': row['old_event_id'],
             'newEventId': row['new_event_id']}
            for row in conn.execute(
                'SELECT m.* FROM cost_basis_fop_event_id_mappings m JOIN cost_basis_fop_operations o '
                'ON o.operation_id = m.operation_id WHERE o.book_id = ? '
                'ORDER BY m.operation_id, m.old_event_id', (book_id,))]
        requests = [
            {'clientToken': row['client_token'], 'action': row['action'],
             'requestDigest': row['request_digest'], 'resultJson': row['result_json'],
             'createdAtUtc': row['created_at_utc']}
            for row in conn.execute(f'SELECT * FROM {FOP_REQUEST_TABLE} WHERE book_id = ? '
                                    'ORDER BY created_at_utc, client_token', (book_id,))]
        record = {key: book[key] for key in (
            'bookId', 'account', 'symbol', 'secType', 'currency', 'defaultSharesPerContract',
            'startDate', 'note', 'createdAtUtc', 'updatedAtUtc', 'archivedAtUtc')}
        return {
            'book': record,
            'fopBook': {'engineVersion': int(fop_row['engine_version']),
                        'productRules': fop_row['product_rules'],
                        'historyScope': fop_row['history_scope'],
                        'createdAtUtc': fop_row['created_at_utc'],
                        'updatedAtUtc': fop_row['updated_at_utc']},
            'contracts': contracts, 'bindings': bindings, 'events': events, 'cycles': cycles,
            'sources': sources, 'allocations': allocations, 'operations': operations,
            'referenceRevisions': revisions, 'eventIdMappings': mappings, 'requests': requests,
        }

    @staticmethod
    def _primary_source_id(conn, row):
        """The source record an event's external_ref was derived from, or None.

        external_ref is namespace:sourceRef (plus #eventId when the source is
        split, domain.event_external_refs); a backup names the record itself,
        so a restore never has to guess the namespace (review R10).
        """
        external = row['external_ref']
        if not external or ':' not in external:
            return None
        namespace, source_ref = external.split(':', 1)
        suffix = f'#{row["event_id"]}'
        if source_ref.endswith(suffix):
            source_ref = source_ref[:-len(suffix)]
        found = conn.execute(
            'SELECT source_id FROM cost_basis_fop_sources WHERE book_id = ? AND account = ? '
            'AND namespace = ? AND source_ref = ?',
            (row['book_id'], row['account'], namespace, source_ref)).fetchone()
        return found['source_id'] if found is not None else None

    def _export_fop_backup(self, conn, book):
        payload = self._fop_graph_payload(conn, book)
        return {'format': 'cost-basis-backup', 'version': 2, 'kind': 'fop',
                'sha256': hashlib.sha256(domain.canonical_json(payload).encode()).hexdigest(),
                'payload': payload}

    @staticmethod
    def _request_from_stored_event(stored, allocations):
        """The FopEvent a stored row answers to, to re-check it against the kind rules."""
        row = stored['row']
        fields = domain.schema.protocol()['types']['FopEvent']['cases'][row['kind']]['fields']
        fop = row['fop']
        external = row['externalRef']
        primary = stored['primarySourceId']
        ordered = sorted(allocations, key=lambda a: (a['sourceId'] != primary, a['namespace'],
                                                     a['sourceRef'], a['role']))
        values = {
            'kind': row['kind'], 'account': row['account'], 'source': row['source'],
            'externalRef': external, 'packageKey': None, 'note': row['note'], 'time': fop['time'],
            'sources': [{'namespace': a['namespace'], 'sourceRef': a['sourceRef'],
                         'role': a['role'], 'quantity': a['quantity'], 'fees': a['fees']}
                        for a in ordered],
            'contractRef': fop['contractRef'], 'deliveredContractRef': fop['deliveredContractRef'],
            'bindingRef': fop['bindingRef'], 'contracts': row['contracts'],
            'futureContracts': row['futureContracts'], 'price': row['price'],
            'cashAmount': row['cashAmount'], 'fees': row['fees'],
            'includeInCost': row['includeInCost'], 'openClose': fop['openClose'],
            'feeCategory': fop['feeCategory'], 'feeIsRefund': fop['feeIsRefund'],
            'feeSource': (None if fop['feeSourceEventId'] is None
                          else {'eventId': fop['feeSourceEventId'], 'packageKey': None}),
            'adjustmentScope': fop['adjustmentScope'], 'baselineKind': fop['baselineKind'],
            'baselineAsOfUtc': fop['baselineAsOfUtc'],
        }
        return {field: values[field] for field in fields}

    def _load_fop_graph(self, conn, book, payload, *, remap):
        """Write a BackupPayloadV2 into an emptied FOP ledger, all or nothing.

        Before anything is written, domain.check_graph proves every relation of
        the graph (also the ones no live event uses) and every event is
        re-checked against its kind's rules and must resolve its contract,
        delivery, binding and fee source inside the graph. After the write,
        foreign keys and the whole-book timeline are proven again. With remap,
        every id gets a new value first, so a backup restores into another
        ledger id without colliding with the one it came from.
        """
        try:
            domain.require_shape('BackupPayloadV2', payload, 'backup payload')
        except domain.FopDomainError as exc:
            raise_store_error(exc)
        book_id = book['bookId']
        base = _store_errors()
        source_book = payload['book']
        self._require_book_identity(book, source_book)
        fop_book = book['fop']
        if (payload['fopBook']['engineVersion'] != fop_book['engineVersion']
                or payload['fopBook']['productRules'] != fop_book['productRules']):
            raise base.FopEngineVersionMismatchError(
                'the backup was written for another FOP engine or product rules')
        if len(payload['events']) > self.RESTORE_LIMIT_EVENTS:
            raise base.InvalidRequestError(
                f'a restore is limited to {self.RESTORE_LIMIT_EVENTS} events')
        # The history scope describes the events: the ledger takes the one of
        # the graph it now holds (review R8).
        conn.execute('UPDATE cost_basis_fop_books SET history_scope = ?, updated_at_utc = ? '
                     'WHERE book_id = ? AND history_scope <> ?',
                     (payload['fopBook']['historyScope'], self._utc_now_iso(), book_id,
                      payload['fopBook']['historyScope']))
        new_id = (lambda value: uuid.uuid4().hex) if remap else (lambda value: value)
        ids = {kind: {} for kind in ('event', 'contract', 'binding', 'boundary', 'source',
                                     'operation', 'token')}

        def mapped(kind, value):
            if value is None:
                return None
            if value not in ids[kind]:
                ids[kind][value] = new_id(value)
            return ids[kind][value]

        try:
            events = domain.check_graph(payload, book=book, product_rules=fop_book['productRules'])
        except domain.FopDomainError as exc:
            raise_store_error(exc)
        # Everything the events refer to is part of the graph.
        contracts = {(c['record']['contractId'], c['record']['revision']): c['record']
                     for c in payload['contracts']}
        bindings = {(b['bindingId'], b['revision']): b for b in payload['bindings']}
        allocations = {}
        source_by_id = {source['sourceId']: source for source in payload['sources']}
        for allocation in payload['allocations']:
            source = source_by_id[allocation['sourceId']]
            allocations.setdefault(allocation['eventId'], []).append(
                {**allocation, 'namespace': source['namespace'], 'sourceRef': source['sourceRef']})

        def contract_for(ref):
            return contracts.get((ref['contractId'], ref['revision']))

        def binding_for(ref):
            stored = bindings.get((ref['bindingId'], ref['revision']))
            return None if stored is None else {key: stored[key] for key in _BINDING_RECORD_FIELDS}

        def stored_fee_source(event_id):
            stored = events.get(event_id)
            return None if stored is None else {'kind': stored['row']['kind']}

        normalized = {}
        for event_id, stored in events.items():
            request = self._request_from_stored_event(stored, allocations.get(event_id, []))
            try:
                domain.require_shape('FopEvent', request, f'backup event {event_id}')
                normalized[event_id] = domain.normalize_event(
                    request, book=book, contract_for=contract_for, binding_for=binding_for,
                    timezone_name=self._display_timezone, stored_fee_source=stored_fee_source)
            except domain.FopDomainError as exc:
                raise_store_error(exc)
        external_refs = dict(zip(events, domain.event_external_refs(
            [normalized[event_id] for event_id in events],
            [mapped('event', event_id) for event_id in events])))

        for stored in payload['contracts']:
            row = domain.contract_row(stored['record'], book_id=book_id,
                                      created_at=stored['createdAtUtc'])
            row['contract_id'] = mapped('contract', row['contract_id'])
            row['superseded_by_revision'] = stored['supersededByRevision']
            conn.execute(f'INSERT INTO cost_basis_fop_contracts ({", ".join(row)}) '
                         f'VALUES ({", ".join("?" for _ in row)})', tuple(row.values()))
        for stored in payload['bindings']:
            conn.execute(
                'INSERT INTO cost_basis_fop_bindings (binding_id, revision, book_id, '
                'option_contract_id, future_contract_id, status, evidence_summary, evidence_digest, '
                'observed_at_utc, superseded_by_revision, created_at_utc) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (mapped('binding', stored['bindingId']), stored['revision'], book_id,
                 mapped('contract', stored['optionContractId']),
                 mapped('contract', stored['futureContractId']), stored['status'],
                 stored['evidenceSummary'], stored['evidenceDigest'], stored['observedAtUtc'],
                 stored['supersededByRevision'], stored['createdAtUtc']))
        for event_id, stored in events.items():
            row = stored['row']
            event = dict(normalized[event_id]['event'], external_ref=external_refs[event_id])
            conn.execute(
                'INSERT INTO cost_basis_events (event_id, book_id, seq, client_token, '
                f'{", ".join(_EVENT_WRITE_COLUMNS)}, created_at_utc, voided_at_utc, '
                'voided_by_event_id, void_reason) '
                f'VALUES (?, ?, ?, ?, {", ".join("?" for _ in _EVENT_WRITE_COLUMNS)}, ?, ?, ?, ?)',
                (mapped('event', event_id), book_id, row['seq'],
                 mapped('token', stored['clientToken']),
                 *(event[column] for column in _EVENT_WRITE_COLUMNS), stored['createdAtUtc'],
                 row['voidedAtUtc'], mapped('token', stored['voidedByEventId']),
                 stored['voidReason']))
        for event_id in events:
            details = dict(normalized[event_id]['details'])
            for column, kind in (('contract_id', 'contract'), ('delivered_contract_id', 'contract'),
                                 ('binding_id', 'binding'), ('fee_source_event_id', 'event')):
                details[column] = mapped(kind, details[column])
            conn.execute(
                'INSERT INTO cost_basis_fop_event_details (event_id, book_id, '
                f'{", ".join(_DETAIL_COLUMNS)}) VALUES (?, ?, '
                f'{", ".join("?" for _ in _DETAIL_COLUMNS)})',
                (mapped('event', event_id), book_id, *(details[c] for c in _DETAIL_COLUMNS)))
        for source in payload['sources']:
            conn.execute(
                'INSERT INTO cost_basis_fop_sources (source_id, book_id, account, namespace, '
                'source_ref, capability_key, format, section, raw_fields_json, stated_quantity, '
                'stated_fees, import_batch_id, created_at_utc) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (mapped('source', source['sourceId']), book_id, source['account'],
                 source['namespace'], source['sourceRef'], source['capabilityKey'], source['format'],
                 source['section'], domain.canonical_json(source['rawFields']),
                 source['statedQuantity'], source['statedFees'], source['importBatchId'],
                 source['createdAtUtc']))
        for allocation in payload['allocations']:
            conn.execute(
                'INSERT INTO cost_basis_fop_source_allocations (source_id, event_id, role, quantity, '
                'fees, created_at_utc) VALUES (?, ?, ?, ?, ?, ?)',
                (mapped('source', allocation['sourceId']), mapped('event', allocation['eventId']),
                 allocation['role'], allocation['quantity'], allocation['fees'],
                 allocation['createdAtUtc']))
        for cycle in payload['cycles']:
            conn.execute(
                'INSERT INTO cost_basis_fop_cycles (boundary_id, revision, book_id, state, '
                'anchor_event_id, label, superseded_by_revision, created_at_utc) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (mapped('boundary', cycle['boundaryId']), cycle['revision'], book_id, cycle['state'],
                 mapped('event', cycle['anchorEventId']), cycle['label'],
                 cycle['supersededByRevision'], cycle['createdAtUtc']))
        for operation in payload['operations']:
            conn.execute(
                'INSERT INTO cost_basis_fop_operations (operation_id, book_id, client_token, kind, '
                'payload_digest, ledger_digest_before, ledger_digest_after, created_at_utc) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (mapped('operation', operation['operationId']), book_id,
                 mapped('token', operation['clientToken']), operation['kind'],
                 operation['payloadDigest'], operation['ledgerDigestBefore'],
                 operation['ledgerDigestAfter'], operation['createdAtUtc']))
        for revision in payload['referenceRevisions']:
            kind = {'contract': 'contract', 'delivered_contract': 'contract', 'binding': 'binding',
                    'fee_source': 'event'}[revision['reference']]
            conn.execute(
                'INSERT INTO cost_basis_fop_reference_revisions (operation_id, event_id, reference, '
                'before_id, before_revision, after_id, after_revision) VALUES (?, ?, ?, ?, ?, ?, ?)',
                (mapped('operation', revision['operationId']), mapped('event', revision['eventId']),
                 revision['reference'], mapped(kind, revision['before']['id']),
                 revision['before']['revision'], mapped(kind, revision['after']['id']),
                 revision['after']['revision']))
        for mapping in payload['eventIdMappings']:
            conn.execute(
                'INSERT INTO cost_basis_fop_event_id_mappings (operation_id, old_event_id, '
                'new_event_id) VALUES (?, ?, ?)',
                (mapped('operation', mapping['operationId']), mapping['oldEventId'],
                 mapped('event', mapping['newEventId'])))
        if not remap:
            self._restore_request_log(conn, book_id, payload['requests'])
        self._fault('fop_after_graph')
        violations = conn.execute('PRAGMA foreign_key_check').fetchall()
        if violations:
            raise base.InvalidRequestError(
                f'the backup graph has {len(violations)} dangling references; nothing restored')
        for table, key in (('cost_basis_fop_contracts', 'contract_id'),
                           ('cost_basis_fop_bindings', 'binding_id'),
                           ('cost_basis_fop_cycles', 'boundary_id')):
            broken = conn.execute(
                f'SELECT {key} FROM {table} WHERE book_id = ? GROUP BY {key} '
                'HAVING sum(superseded_by_revision IS NULL) <> 1', (book_id,)).fetchall()
            if broken:
                raise base.InvalidRequestError(
                    f'{table[15:]} {broken[0][0]} does not have exactly one current revision')
        try:
            self._validate_fop_ledger(conn, book_id)
        except domain.FopDomainError as exc:
            raise_store_error(exc)
        return len(events)

    @staticmethod
    def _restore_request_log(conn, book_id, requests):
        """A backup's request log back under the same ledger id (review R11).

        A restored ledger answers a retried token the way the ledger it came
        from did, also in a new database. A token this database already logs
        must be the same request; one it logs as anything else refuses the
        restore. A restore into another ledger id does not come here: every id
        and token is new there, so no answer about the old ledger can reach it.
        """
        base = _store_errors()
        for request in requests:
            held = conn.execute(f'SELECT * FROM {FOP_REQUEST_TABLE} WHERE client_token = ?',
                                (request['clientToken'],)).fetchone()
            if held is not None:
                if (held['book_id'], held['action'], held['request_digest']) != (
                        book_id, request['action'], request['requestDigest']):
                    raise base.InvalidRequestError(
                        f'the backup logs token {request["clientToken"]} for a request this '
                        'database logs as another one; nothing restored')
                continue
            conn.execute(
                f'INSERT INTO {FOP_REQUEST_TABLE} (client_token, book_id, action, request_digest, '
                'result_json, created_at_utc) VALUES (?, ?, ?, ?, ?, ?)',
                (request['clientToken'], book_id, request['action'], request['requestDigest'],
                 request['resultJson'], request['createdAtUtc']))

    def _archive_fop_graph(self, conn, book, client_token, reason):
        """Archive the whole current graph as a reset row; returns (reset_id, event_count)."""
        payload = self._fop_graph_payload(conn, book)
        encoded = domain.canonical_json({'format': self.GRAPH_FORMAT, 'version': 2,
                                         'payload': payload})
        reset_id = uuid.uuid4().hex
        conn.execute(
            'INSERT INTO cost_basis_book_resets (reset_id, book_id, client_token, reset_at_utc, '
            'event_count, events_sha256, events_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (reset_id, book['bookId'], client_token, self._utc_now_iso(), len(payload['events']),
             hashlib.sha256(encoded.encode('utf-8')).hexdigest(), encoded, reason))
        self._archive_coverage(conn, book['bookId'], reset_id)
        self._fault('fop_after_archive')
        return reset_id, len(payload['events'])

    def _empty_fop_graph(self, conn, book_id):
        delete_fop_graph(conn, book_id, keep_book_row=True)
        conn.execute('DELETE FROM cost_basis_events WHERE book_id = ?', (book_id,))

    def _confirm_reset(self, conn, book, confirmation, expected_ledger_version, action):
        base = _store_errors()
        total = conn.execute('SELECT count(*) FROM cost_basis_events WHERE book_id = ?',
                             (book['bookId'],)).fetchone()[0]
        expected = base._reset_phrase(book['account'], book['symbol'], total)
        if str(confirmation or '').strip() != expected:
            raise base.ResetConfirmationError(f'type exactly: {expected}')
        try:
            self._require_ledger_version(conn, book['bookId'], expected_ledger_version)
        except base.LedgerChangedError:
            raise base.ResetConfirmationError(
                f'the ledger changed after this {action} was planned; nothing was changed') from None

    def reset_fop_book(self, book_id, *, confirmation, client_token, reason='',
                       expected_ledger_version=None, book_identity=None, engine_version=None):
        """Archive the whole FOP graph, then empty the ledger (it stays a FOP ledger)."""
        base = _store_errors()
        base._require_token('clientToken', client_token)
        reason = base._optional_text(reason, 'reason', base.MAX_NOTE_CHARS)
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            try:
                book = self._open_fop_write(conn, book_id, 'resetting the ledger',
                                            book_identity=book_identity,
                                            engine_version=engine_version)
                digest = self._request_digest('reset', book_id, {
                    'reason': reason, 'engineVersion': engine_version})
                replay = self._replayed_request(conn, book_id, 'reset', client_token, digest)
                if replay is not None:
                    conn.execute('ROLLBACK')
                    return replay
                self._confirm_reset(conn, book, confirmation, expected_ledger_version, 'reset')
                reset_id, removed = self._archive_fop_graph(conn, book, client_token,
                                                            reason or 'reset')
                self._empty_fop_graph(conn, book_id)
                conn.execute('UPDATE cost_basis_books SET updated_at_utc = ? WHERE book_id = ?',
                             (self._utc_now_iso(), book_id))
                result = {'bookId': book_id, 'resetId': reset_id, 'removedEvents': removed,
                          'ledgerVersion': self._ledger_version(conn, book_id),
                          'idempotentReplay': False}
                self._record_request(conn, book_id, 'reset', client_token, digest, result)
                self._fault('fop_before_commit')
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return result
        except sqlite3.IntegrityError as exc:
            raise self._map_integrity_error(exc) from exc
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def restore_fop_graph(self, book_id, *, reset_id=None, backup=None, confirmation,
                          client_token, expected_ledger_version=None, book_identity=None,
                          engine_version=None):
        """Put an archived or backed-up graph back, archiving the current one first.

        From a reset archive of this ledger, ids come back unchanged and the
        archived coverage is restored. From a backup file (BackupEnvelopeV2),
        a backup of this same ledger keeps its ids; one of another ledger id is
        remapped whole. Either way the graph is re-proven before commit. The
        request is the archive's resetId or the backup's checksum: the same
        token with another archive, another backup or another action is refused.
        """
        base = _store_errors()
        base._require_token('clientToken', client_token)
        if backup is not None:
            payload = self._validated_fop_backup(backup)
            action, label = 'restore_backup', 'file-backup'
            request = {'backupSha256': backup['sha256'], 'engineVersion': engine_version}
        else:
            base._require_token('resetId', reset_id)
            action, label = 'restore_reset', reset_id
            request = {'resetId': reset_id, 'engineVersion': engine_version}
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            try:
                book = self._open_fop_write(conn, book_id, 'restoring the ledger',
                                            book_identity=book_identity,
                                            engine_version=engine_version)
                digest = self._request_digest(action, book_id, request)
                replay = self._replayed_request(conn, book_id, action, client_token, digest)
                if replay is not None:
                    conn.execute('ROLLBACK')
                    return replay
                if backup is None:
                    archive = conn.execute(
                        'SELECT * FROM cost_basis_book_resets WHERE book_id = ? AND reset_id = ?',
                        (book_id, reset_id)).fetchone()
                    if archive is None:
                        raise base.InvalidRequestError('reset archive not found for this ledger')
                    if hashlib.sha256(archive['events_json'].encode('utf-8')).hexdigest() \
                            != archive['events_sha256']:
                        raise base.InvalidRequestError('archive checksum mismatch; nothing restored')
                    document = json.loads(archive['events_json'])
                    if not isinstance(document, dict) or document.get('format') != self.GRAPH_FORMAT:
                        raise base.InvalidRequestError('that archive is not a FOP graph')
                    payload = document['payload']
                self._confirm_reset(conn, book, confirmation, expected_ledger_version, 'restore')
                new_reset_id, removed = self._archive_fop_graph(
                    conn, book, client_token, f'restore of {label}')
                self._empty_fop_graph(conn, book_id)
                remap = backup is not None and payload['book']['bookId'] != book_id
                restored = self._load_fop_graph(conn, book, payload, remap=remap)
                if backup is None:
                    self._restore_coverage(conn, book_id, reset_id)
                conn.execute('UPDATE cost_basis_books SET updated_at_utc = ? WHERE book_id = ?',
                             (self._utc_now_iso(), book_id))
                result = {'bookId': book_id, 'resetId': new_reset_id, 'restoredFrom': label,
                          'removedEvents': removed, 'restoredEvents': restored,
                          'remapped': remap, 'ledgerVersion': self._ledger_version(conn, book_id),
                          'idempotentReplay': False}
                self._record_request(conn, book_id, action, client_token, digest, result)
                self._fault('fop_before_commit')
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return result
        except sqlite3.IntegrityError as exc:
            raise self._map_integrity_error(exc) from exc
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    @staticmethod
    def _validated_fop_backup(backup):
        base = _store_errors()
        try:
            domain.require_shape('BackupEnvelopeV2', backup, 'backup')
        except domain.FopDomainError as exc:
            if isinstance(backup, dict) and backup.get('version') == 1:
                raise base.InvalidRequestError(
                    'a version 1 backup holds no FOP graph; a FOP ledger restores version 2 '
                    'backups only') from exc
            raise_store_error(exc)
        encoded = domain.canonical_json(backup['payload'])
        if hashlib.sha256(encoded.encode()).hexdigest() != backup['sha256']:
            raise base.InvalidRequestError('backup checksum mismatch; nothing restored')
        return backup['payload']

    @staticmethod
    def _economic_key(conn, event_id):
        """What an event is, for a rebuild's old -> new mapping: its primary
        source, its source allocations and its economic content, with
        contracts by their terms."""
        row = conn.execute('SELECT * FROM cost_basis_events WHERE event_id = ?',
                           (event_id,)).fetchone()
        details = conn.execute('SELECT * FROM cost_basis_fop_event_details WHERE event_id = ?',
                               (event_id,)).fetchone()

        def terms(contract_id, revision):
            if contract_id is None:
                return None
            contract = conn.execute(
                'SELECT * FROM cost_basis_fop_contracts WHERE contract_id = ? AND revision = ?',
                (contract_id, revision)).fetchone()
            return terms_digest(domain.contract_record_from_row(contract))

        source = row['external_ref']
        if source and source.endswith(f'#{event_id}'):
            source = source[:-len(event_id) - 1]
        allocations = sorted(domain.canonical_json(list(allocation)) for allocation in conn.execute(
            'SELECT s.namespace, s.source_ref, a.role, a.quantity, a.fees '
            'FROM cost_basis_fop_source_allocations a JOIN cost_basis_fop_sources s '
            'ON s.source_id = a.source_id WHERE a.event_id = ?', (event_id,)))
        return domain.canonical_json({
            'source': source, 'allocations': allocations,
            'event': {column: row[column] for column in (
                'kind', 'account', 'contracts', 'future_contracts', 'price', 'cash_amount', 'fees',
                'include_in_cost')},
            'contract': terms(details['contract_id'], details['contract_revision']),
            'delivered': terms(details['delivered_contract_id'],
                               details['delivered_contract_revision']),
            'details': {column: details[column] for column in (
                'open_close', 'fee_category', 'fee_is_refund', 'adjustment_scope', 'baseline_kind',
                'baseline_as_of_utc', 'exchange_trade_date', 'executed_at_utc',
                'time_range_start_utc', 'time_range_end_utc', 'order_evidence')},
        })

    def rebuild_fop_book(self, book_id, package, *, confirmation, client_token, import_batch_id,
                         statement=None, revoke_boundaries=(), reason='',
                         expected_ledger_version=None, book_identity=None):
        """Archive the graph and replace it with a full package in one transaction.

        New events get new ids. A closed cycle boundary survives only when its
        anchor maps to exactly one new event with the same primary source,
        allocations and economic content; otherwise the request must revoke it
        by id, or the rebuild is refused (plan §8.3). Fee sources inside the
        package use package keys. The operation records the complete old -> new
        mapping.
        """
        base = _store_errors()
        base._require_token('clientToken', client_token)
        base._require_token('importBatchId', import_batch_id)
        reason = base._optional_text(reason, 'reason', base.MAX_NOTE_CHARS)
        revoke = set(revoke_boundaries or ())
        try:
            domain.require_shape('FopPackage', package, 'fopPackage')
            if statement is not None:
                domain.require_shape('StatementRegistration', statement, 'statement')
        except domain.FopDomainError as exc:
            raise_store_error(exc)
        if len(package['events']) > base.MAX_IMPORT_EVENTS:
            raise base.InvalidRequestError(
                f'a rebuild is limited to {base.MAX_IMPORT_EVENTS} events')
        payload_digest = self._request_digest('rebuild', book_id, {
            'package': package, 'statement': statement, 'revokeBoundaries': sorted(revoke),
            'importBatchId': import_batch_id, 'reason': reason})
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            try:
                book = self._open_fop_write(conn, book_id, 'rebuilding the ledger',
                                            book_identity=book_identity,
                                            engine_version=package['engineVersion'])
                replay = self._replayed_request(conn, book_id, 'rebuild', client_token,
                                                payload_digest)
                if replay is not None:
                    conn.execute('ROLLBACK')
                    return replay
                self._confirm_reset(conn, book, confirmation, expected_ledger_version, 'rebuild')
                digest_before = self._ledger_version(conn, book_id)['digest']
                old_keys = {row['event_id']: self._economic_key(conn, row['event_id'])
                            for row in conn.execute(
                                'SELECT event_id FROM cost_basis_events WHERE book_id = ? '
                                'AND voided_at_utc IS NULL', (book_id,)).fetchall()}
                boundaries = [dict(row) for row in conn.execute(
                    "SELECT * FROM cost_basis_fop_cycles WHERE book_id = ? AND state = 'closed' "
                    'AND superseded_by_revision IS NULL', (book_id,))]
                unknown = revoke - {b['boundary_id'] for b in boundaries}
                if unknown:
                    raise base.InvalidRequestError(
                        f'revokeBoundaries names {sorted(unknown)}, which are not closed '
                        'boundaries of this ledger')
                reset_id, removed = self._archive_fop_graph(
                    conn, book, client_token, reason or 'rebuild from statement')
                self._empty_fop_graph(conn, book_id)
                try:
                    plan = self._prepare_fop_package(conn, book, package, mode='import',
                                                     statement=statement)
                    new_ids = self._apply_fop_plan(
                        conn, book, plan, tokens=lambda index: f'{client_token}-{index:05d}',
                        import_batch_id=import_batch_id)
                except domain.FopDomainError as exc:
                    raise_store_error(exc)
                new_by_key = {}
                for event_id in new_ids:
                    new_by_key.setdefault(self._economic_key(conn, event_id), []).append(event_id)
                mapping = {old: new_by_key[key][0] for old, key in old_keys.items()
                           if len(new_by_key.get(key, [])) == 1
                           and sum(1 for other in old_keys.values() if other == key) == 1}
                for boundary in boundaries:
                    if boundary['boundary_id'] in revoke:
                        continue
                    anchor = mapping.get(boundary['anchor_event_id'])
                    if anchor is None:
                        raise base.FopCycleBoundaryViolatedError(
                            f'cycle boundary {boundary["boundary_id"]} is anchored on an event the '
                            'rebuild cannot map to exactly one new event; revoke it in this '
                            'request or keep that event unchanged')
                    conn.execute(
                        'INSERT INTO cost_basis_fop_cycles (boundary_id, revision, book_id, state, '
                        'anchor_event_id, label, superseded_by_revision, created_at_utc) '
                        "VALUES (?, ?, ?, 'closed', ?, ?, NULL, ?)",
                        (boundary['boundary_id'], int(boundary['revision']) + 1, book_id, anchor,
                         boundary['label'], self._utc_now_iso()))
                try:
                    self._validate_fop_ledger(conn, book_id)
                except domain.FopDomainError as exc:
                    raise_store_error(exc)
                digest_after = self._ledger_version(conn, book_id)['digest']
                operation_id = uuid.uuid4().hex
                conn.execute(
                    'INSERT INTO cost_basis_fop_operations (operation_id, book_id, client_token, '
                    "kind, payload_digest, ledger_digest_before, ledger_digest_after, "
                    "created_at_utc) VALUES (?, ?, ?, 'rebuild', ?, ?, ?, ?)",
                    (operation_id, book_id, client_token, payload_digest, digest_before,
                     digest_after, self._utc_now_iso()))
                for old, new in sorted(mapping.items()):
                    conn.execute(
                        'INSERT INTO cost_basis_fop_event_id_mappings (operation_id, old_event_id, '
                        'new_event_id) VALUES (?, ?, ?)', (operation_id, old, new))
                if statement is not None:
                    registration = self._statement_registration(statement)
                    self._register_batch(conn, book_id, import_batch_id, 'rebuild', registration,
                                         inserted=len(new_ids), skipped=0)
                conn.execute('UPDATE cost_basis_books SET updated_at_utc = ? WHERE book_id = ?',
                             (self._utc_now_iso(), book_id))
                result = {'bookId': book_id, 'resetId': reset_id, 'removedEvents': removed,
                          'inserted': len(new_ids),
                          'eventIdMappings': [{'oldEventId': old, 'newEventId': new}
                                              for old, new in sorted(mapping.items())],
                          'revokedBoundaries': sorted(revoke),
                          'ledgerVersion': self._ledger_version(conn, book_id),
                          'idempotentReplay': False}
                self._record_request(conn, book_id, 'rebuild', client_token, payload_digest,
                                     result)
                self._fault('fop_before_commit')
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return result
        except sqlite3.IntegrityError as exc:
            raise self._map_integrity_error(exc) from exc
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Reading
    # ------------------------------------------------------------------

    def _listed_fop_event(self, conn, event_id):
        """One event as ListedFopEvent: the shared row, its FOP details and a
        read-only display projection generated from the contract records."""
        row = conn.execute('SELECT * FROM cost_basis_events WHERE event_id = ?',
                           (event_id,)).fetchone()
        details = conn.execute('SELECT * FROM cost_basis_fop_event_details WHERE event_id = ?',
                               (event_id,)).fetchone()
        return self._listed_fop_row(conn, row, details)

    def _listed_fop_row(self, conn, row, details):
        def contract(contract_id, revision):
            if contract_id is None:
                return None
            return conn.execute(
                'SELECT * FROM cost_basis_fop_contracts WHERE contract_id = ? AND revision = ?',
                (contract_id, revision)).fetchone()

        def ref(id_value, revision, id_field):
            return None if id_value is None else {id_field: id_value, 'revision': int(revision)}

        main = contract(details['contract_id'], details['contract_revision'])
        delivered = contract(details['delivered_contract_id'],
                             details['delivered_contract_revision'])
        external = domain.listed_external_ref(row['external_ref'], row['event_id'])
        time_range = None
        if details['time_range_start_utc'] is not None:
            time_range = {'startUtc': details['time_range_start_utc'],
                          'endUtc': details['time_range_end_utc']}
        is_fop = main is not None and main['sec_type'] == 'FOP'
        return {
            'eventId': row['event_id'], 'seq': int(row['seq']), 'kind': row['kind'],
            'tradeDate': row['trade_date'], 'brokerTimestamp': row['broker_timestamp'],
            'account': row['account'],
            'contracts': None if row['contracts'] is None else int(row['contracts']),
            'futureContracts': (None if row['future_contracts'] is None
                                else int(row['future_contracts'])),
            'price': _plain(row['price']), 'cashAmount': _plain(row['cash_amount']),
            'fees': _plain(row['fees']), 'includeInCost': bool(row['include_in_cost']),
            'source': row['source'], 'externalRef': external, 'note': row['note'],
            'voidedAtUtc': row['voided_at_utc'],
            'fop': {
                'contractRef': ref(details['contract_id'], details['contract_revision'],
                                   'contractId'),
                'deliveredContractRef': ref(details['delivered_contract_id'],
                                            details['delivered_contract_revision'], 'contractId'),
                'bindingRef': ref(details['binding_id'], details['binding_revision'],
                                  'bindingId'),
                'openClose': details['open_close'], 'feeCategory': details['fee_category'],
                'feeIsRefund': bool(details['fee_is_refund']),
                'feeSourceEventId': details['fee_source_event_id'],
                'adjustmentScope': details['adjustment_scope'],
                'baselineKind': details['baseline_kind'],
                'baselineAsOfUtc': details['baseline_as_of_utc'],
                'time': {
                    'exchangeTradeDate': details['exchange_trade_date'],
                    'executedAtUtc': details['executed_at_utc'], 'timeRange': time_range,
                    'sourceTimeText': details['source_time_text'],
                    'sourceTimezone': details['source_timezone'],
                    'orderEvidence': details['order_evidence'],
                },
            },
            'display': {
                'localSymbol': main['local_symbol'] if main is not None else None,
                'contractMonth': (main['future_contract_month']
                                  if main is not None and not is_fop else None),
                'right': main['option_right'] if is_fop else None,
                'strike': _plain(main['option_strike']) if is_fop else None,
                'expiry': main['option_expiry'] if is_fop else None,
                'deliveredLocalSymbol': delivered['local_symbol'] if delivered is not None else None,
                'deliveredContractMonth': (delivered['future_contract_month']
                                           if delivered is not None else None),
            },
        }

    def _list_fop_events(self, conn, book_id, *, include_voided, limit, offset):
        where = 'e.book_id = ?' + ('' if include_voided else ' AND e.voided_at_utc IS NULL')
        total = conn.execute(f'SELECT count(*) FROM cost_basis_events e WHERE {where}',
                             (book_id,)).fetchone()[0]
        rows = conn.execute(
            'SELECT e.event_id FROM cost_basis_events e JOIN cost_basis_fop_event_details d '
            f'ON d.event_id = e.event_id WHERE {where} ORDER BY '
            'COALESCE(d.executed_at_utc, d.time_range_start_utc) ASC, '
            'COALESCE(d.executed_at_utc, d.time_range_end_utc) ASC, e.seq ASC LIMIT ? OFFSET ?',
            (book_id, limit, offset)).fetchall()
        return int(total), [self._listed_fop_event(conn, row['event_id']) for row in rows]

    # ------------------------------------------------------------------
    # Digest
    # ------------------------------------------------------------------

    # Bookkeeping columns the digest leaves out: write stamps, and the batch
    # an event arrived with (a restore does not carry it back).
    _DIGEST_SKIPPED_COLUMNS = frozenset({'created_at_utc', 'updated_at_utc', 'import_batch_id'})
    # Every FOP table of one book, with the order that makes its rows a list.
    _DIGEST_TABLES = (
        ('book', 'SELECT * FROM cost_basis_fop_books WHERE book_id = ?'),
        ('event', 'SELECT * FROM cost_basis_events WHERE book_id = ? ORDER BY seq'),
        ('details', 'SELECT * FROM cost_basis_fop_event_details WHERE book_id = ? '
                    'ORDER BY event_id'),
        ('contract', 'SELECT * FROM cost_basis_fop_contracts WHERE book_id = ? '
                     'ORDER BY contract_id, revision'),
        ('binding', 'SELECT * FROM cost_basis_fop_bindings WHERE book_id = ? '
                    'ORDER BY binding_id, revision'),
        ('cycle', 'SELECT * FROM cost_basis_fop_cycles WHERE book_id = ? '
                  'ORDER BY boundary_id, revision'),
        ('source', 'SELECT * FROM cost_basis_fop_sources WHERE book_id = ? '
                   'ORDER BY source_id'),
        ('allocation', 'SELECT a.* FROM cost_basis_fop_source_allocations a '
                       'JOIN cost_basis_fop_sources s ON s.source_id = a.source_id '
                       'WHERE s.book_id = ? ORDER BY a.source_id, a.event_id, a.role'),
        ('operation', 'SELECT * FROM cost_basis_fop_operations WHERE book_id = ? '
                      'ORDER BY created_at_utc, operation_id'),
        ('revision', 'SELECT r.* FROM cost_basis_fop_reference_revisions r '
                     'JOIN cost_basis_fop_operations o ON o.operation_id = r.operation_id '
                     'WHERE o.book_id = ? ORDER BY r.operation_id, r.event_id, r.reference'),
        ('mapping', 'SELECT m.* FROM cost_basis_fop_event_id_mappings m '
                    'JOIN cost_basis_fop_operations o ON o.operation_id = m.operation_id '
                    'WHERE o.book_id = ? ORDER BY m.operation_id, m.old_event_id'),
    )

    @staticmethod
    def _fop_digest_lines(conn, book_id):
        """What a FOP ledger's version covers beyond its event ids (plan §8.1).

        The whole content of the ledger: every column of every event row, its
        FOP details and references, every contract, binding and cycle revision
        with all of its terms and evidence, every source record with its raw
        fields and every allocation, every metadata operation, reference
        revision and rebuild mapping, and the ledger's engine and product
        rules. Two FOP ledgers with the same version hold the same content;
        any accepted change to it, a restore of other content included, gives
        another version, so a preview reviewed on the old content is refused.
        Only write stamps and the import batch of an event stay out.
        """
        skipped = FopLedgerMixin._DIGEST_SKIPPED_COLUMNS
        lines = []
        for prefix, sql in FopLedgerMixin._DIGEST_TABLES:
            for row in conn.execute(sql, (book_id,)):
                values = [[key, row[key]] for key in row.keys() if key not in skipped]
                lines.append(f'{prefix}|{domain.canonical_json(values)}')
        return lines
