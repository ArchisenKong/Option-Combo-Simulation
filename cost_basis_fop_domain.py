"""Server-side rules of the standalone FOP ledger.

CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §4, §6.1, §8.1, §9.2, §13.2. Pure:
no SQLite, no IB. The store (cost_basis_fop_store.py) hands in the request
parts and a lookup of what the ledger already holds, and writes what comes
back. Every payload is first checked against the frozen contract types
(cost_basis_fop_schema); the rules here are the cross-field ones the schema
language cannot express (tests/fixtures/cost_basis_fop/contract/
protocol.json "domainRules").

The quantity replay here is the P2 minimum: per contract, in a fixed order,
no close may take more than is open and a closed cycle boundary must sit where
every balance is zero. P3 replaces the order with the §9.2 ambiguity-group
comparator; nothing here computes economics. check_graph proves a whole
backup graph before a restore writes it.
"""
import json
import math
from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9 is not supported by the servers
    ZoneInfo = None

import cost_basis_fop_schema as schema

FOP_ENGINE_VERSION = 1
# Products the first release accepts, by the productRules name a ledger keeps.
SUPPORTED_PRODUCT_RULES = {
    'NYMEX-CL-v1': {'root': 'CL', 'exchange': 'NYMEX', 'currency': 'USD'},
}
FOP_EVENT_KINDS = (
    'futures_trade', 'option_trade', 'option_assignment', 'option_exercise',
    'option_expiry', 'opening_balance', 'fee', 'manual_adjust',
)
DELIVERY_KINDS = frozenset({'option_assignment', 'option_exercise'})
OPTION_CONTRACT_KINDS = frozenset({'option_trade', 'option_assignment', 'option_exercise',
                                   'option_expiry'})
RESOLVED_BINDING_STATUSES = frozenset({'verified_broker', 'verified_statement', 'manual_attested'})
VERIFIED_BINDING_STATUSES = frozenset({'verified_broker', 'verified_statement'})
STATEMENT_NAMESPACES = frozenset({'flex_trade', 'ib_exec', 'activity_row'})
# option_trade cash may differ from -contracts x multiplier x price - fees when
# the statement says so; the statement wins and derived_mismatch records it.
CASH_DERIVATION_TOLERANCE = 0.01
_EPSILON = 1e-9

_CONTRACT_FIELDS = (
    ('contractId', 'contract_id'), ('revision', 'revision'), ('secType', 'sec_type'),
    ('conId', 'con_id'), ('root', 'root'), ('tradingClass', 'trading_class'),
    ('localSymbol', 'local_symbol'), ('exchange', 'exchange'), ('currency', 'currency'),
    ('futureContractMonth', 'future_contract_month'),
    ('futureLastTradeDate', 'future_last_trade_date'),
    ('futureLastTradeAsOf', 'future_last_trade_as_of'),
    ('futurePointValue', 'future_point_value'), ('optionRight', 'option_right'),
    ('optionStrike', 'option_strike'), ('optionExpiry', 'option_expiry'),
    ('optionExpiryAsOf', 'option_expiry_as_of'), ('premiumMultiplier', 'premium_multiplier'),
    ('deliverableFuturesPerOption', 'deliverable_futures_per_option'),
    ('settlementType', 'settlement_type'), ('exerciseStyle', 'exercise_style'),
    ('ruleVersion', 'rule_version'), ('evidenceStatus', 'evidence_status'),
    ('evidenceSummary', 'evidence_summary'), ('observedAtUtc', 'observed_at_utc'),
)
_FUT_ONLY = ('futureContractMonth', 'futureLastTradeDate', 'futureLastTradeAsOf',
             'futurePointValue')
_FOP_ONLY = ('optionRight', 'optionStrike', 'optionExpiry', 'optionExpiryAsOf',
             'premiumMultiplier', 'deliverableFuturesPerOption', 'settlementType',
             'exerciseStyle')
# Not terms: which record, which revision, and how well it is evidenced.
CONTRACT_NON_TERMS = frozenset({'contractId', 'revision', 'evidenceStatus', 'evidenceSummary',
                                'observedAtUtc'})


class FopDomainError(Exception):
    """A FOP payload the ledger refuses; code is a protocol error code."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _refuse(message, code='invalid_request'):
    raise FopDomainError(code, message)


def require_shape(type_name, value, label=None):
    """Refuse a value the frozen contract refuses, naming the first errors."""
    errors = schema.check(type_name, value)
    if errors:
        shown = '; '.join(f'{path or "(root)"}: {code}' for path, code in errors[:5])
        more = f' (+{len(errors) - 5} more)' if len(errors) > 5 else ''
        _refuse(f'{label or type_name} does not match the FOP contract: {shown}{more}')


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
                      allow_nan=False)


def parse_instant(text):
    """A UtcInstant (YYYY-MM-DDTHH:MM:SS.ffffffZ) as an aware datetime."""
    return datetime.strptime(text, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)


def _zone(name):
    if ZoneInfo is None:
        _refuse('this Python has no zoneinfo; the FOP ledger cannot project trade dates')
    try:
        return ZoneInfo(name)
    except Exception:
        _refuse(f'unknown display timezone {name!r}; set [tws] timezone')


# ----------------------------------------------------------------------
# Books
# ----------------------------------------------------------------------

def check_fop_book_request(*, symbol, sec_type, currency, fop):
    """The FOP section of create_cost_basis_book (FopBookCreateRequest.fop)."""
    if str(sec_type or '').strip().upper() != 'FUT':
        _refuse('a FOP ledger has secType FUT')
    if not isinstance(fop, dict):
        _refuse('fop must be an object with engineVersion, productRules and historyScope')
    extra = set(fop) - {'engineVersion', 'productRules', 'historyScope'}
    missing = {'engineVersion', 'productRules', 'historyScope'} - set(fop)
    if extra or missing:
        _refuse(f'fop fields: missing {sorted(missing)}, not allowed {sorted(extra)}')
    engine = fop['engineVersion']
    if isinstance(engine, bool) or not isinstance(engine, int) or engine < 1:
        _refuse('fop.engineVersion must be a positive integer')
    if engine != FOP_ENGINE_VERSION:
        _refuse(f'this server writes FOP engine version {FOP_ENGINE_VERSION}, not {engine}; '
                'reload the page', 'fop_engine_version_mismatch')
    rules = SUPPORTED_PRODUCT_RULES.get(fop['productRules'])
    if rules is None:
        _refuse(f'productRules {fop["productRules"]!r} is not supported; supported: '
                f'{", ".join(sorted(SUPPORTED_PRODUCT_RULES))}')
    if fop['historyScope'] not in ('full_history', 'since_baseline'):
        _refuse('fop.historyScope must be full_history or since_baseline')
    if symbol != rules['root']:
        _refuse(f'{fop["productRules"]} ledgers are for root {rules["root"]}, not {symbol}')
    if currency != rules['currency']:
        _refuse(f'{fop["productRules"]} ledgers are in {rules["currency"]}, not {currency}')
    return {'engine_version': engine, 'product_rules': fop['productRules'],
            'history_scope': fop['historyScope']}


def check_ledger_supported(fop_book):
    """This server may write the ledger only under its own engine and product rules."""
    book_engine = int(fop_book['engineVersion'])
    if book_engine != FOP_ENGINE_VERSION:
        _refuse(f'this ledger uses FOP engine version {book_engine}; this server writes '
                f'{FOP_ENGINE_VERSION} and cannot change it; export or delete it only',
                'fop_engine_version_mismatch')
    if fop_book['productRules'] not in SUPPORTED_PRODUCT_RULES:
        _refuse(f'this ledger follows {fop_book["productRules"]}, which this server does not '
                'support; export or delete it only', 'fop_engine_version_mismatch')


def check_write_guard(fop_book, engine_version):
    """The engine version a FOP write was prepared for must be the ledger's."""
    check_ledger_supported(fop_book)
    book_engine = int(fop_book['engineVersion'])
    if engine_version is None:
        _refuse('engineVersion is required: every FOP write names the engine it was prepared for')
    if isinstance(engine_version, bool) or not isinstance(engine_version, int):
        _refuse('engineVersion must be an integer')
    if engine_version != book_engine:
        _refuse(f'this write was prepared for FOP engine version {engine_version}, but the '
                f'ledger uses {book_engine}; reload the page', 'fop_engine_version_mismatch')


# ----------------------------------------------------------------------
# Contracts and bindings
# ----------------------------------------------------------------------

def contract_row(record, *, book_id, created_at):
    """A shape-checked ContractRecord as cost_basis_fop_contracts columns."""
    row = {column: record.get(field) for field, column in _CONTRACT_FIELDS}
    row['book_id'] = book_id
    row['superseded_by_revision'] = None
    row['created_at_utc'] = created_at
    return row


def contract_record_from_row(row):
    """A stored contract row back as its ContractRecord (only the fields of its type)."""
    record = {}
    for field, column in _CONTRACT_FIELDS:
        value = row[column]
        if row['sec_type'] == 'FUT' and field in _FOP_ONLY:
            continue
        if row['sec_type'] == 'FOP' and field in _FUT_ONLY:
            continue
        if field in ('futurePointValue', 'optionStrike', 'premiumMultiplier',
                     'deliverableFuturesPerOption') and value is not None:
            value = _plain_number(value)
        record[field] = value
    return record


def _plain_number(value):
    number = float(value)
    return int(number) if number.is_integer() else number


def contract_terms(record):
    """What a contract IS: everything but its record id, revision and evidence."""
    return {field: value for field, value in record.items() if field not in CONTRACT_NON_TERMS}


def contract_identity_key(record):
    """The structural identity two current records may not share (plan §4.2)."""
    if record['secType'] == 'FUT':
        return ('FUT', record['root'], record['exchange'], record['currency'],
                record.get('tradingClass') or '', record['futureContractMonth'])
    return ('FOP', record['root'], record['exchange'], record['currency'],
            record.get('tradingClass') or '', record['optionRight'],
            repr(float(record['optionStrike'])), record['optionExpiry'])


# Contract fields a correction may fill in when they were unknown; any other
# change to a stored term is an economic correction (archived rebuild).
SUPPLEMENTABLE_TERMS = frozenset({
    'conId', 'tradingClass', 'localSymbol', 'futureLastTradeDate', 'futureLastTradeAsOf',
    'optionExpiryAsOf',
})


def check_contract_revision(before, after):
    """A later revision of one contract only fills in what was unknown (plan §4.3)."""
    if after['secType'] != before['secType']:
        _refuse(f'contract {after["contractId"]}: a correction keeps the contract type',
                'fop_identity_conflict')
    old_terms = contract_terms(before)
    new_terms = contract_terms(after)
    changed = sorted(field for field in set(old_terms) | set(new_terms)
                     if old_terms.get(field) != new_terms.get(field)
                     and not (field in SUPPLEMENTABLE_TERMS and old_terms.get(field) is None))
    if changed:
        _refuse(f'contract {after["contractId"]}: a correction may only fill in unknown fields '
                f'or better evidence; changing {", ".join(changed)} is an economic correction '
                '(archived rebuild)', 'fop_identity_conflict')


def check_current_contracts_distinct(records):
    """No two current records name one real contract: by structure or by conId."""
    by_identity = {}
    by_con_id = {}
    for record in records:
        identity = contract_identity_key(record)
        if identity in by_identity:
            _refuse(f'contracts {by_identity[identity]} and {record["contractId"]} are the same '
                    'contract; keep one record and reference it', 'fop_identity_conflict')
        by_identity[identity] = record['contractId']
        if record.get('conId') is not None:
            if record['conId'] in by_con_id:
                _refuse(f'conId {record["conId"]} belongs to both {by_con_id[record["conId"]]} '
                        f'and {record["contractId"]}', 'fop_identity_conflict')
            by_con_id[record['conId']] = record['contractId']


def check_contract_against_book(record, *, book, product_rules):
    rules = SUPPORTED_PRODUCT_RULES[product_rules]
    if record['root'] != book['symbol']:
        _refuse(f'contract {record["contractId"]} has root {record["root"]}; this ledger is '
                f'{book["symbol"]}', 'fop_identity_conflict')
    if record['exchange'] != rules['exchange'] or record['currency'] != rules['currency']:
        _refuse(f'contract {record["contractId"]} trades on {record["exchange"]} in '
                f'{record["currency"]}; {product_rules} is {rules["exchange"]} in '
                f'{rules["currency"]}', 'fop_identity_conflict')
    if record['ruleVersion'] != product_rules:
        _refuse(f'contract {record["contractId"]} follows {record["ruleVersion"]}; this ledger '
                f'follows {product_rules}', 'fop_identity_conflict')


def binding_row(record, *, book_id, created_at, evidence_digest):
    return {
        'binding_id': record['bindingId'], 'revision': record['revision'], 'book_id': book_id,
        'option_contract_id': record['optionContractId'],
        'future_contract_id': record['futureContractId'], 'status': record['status'],
        'evidence_summary': record['evidenceSummary'], 'evidence_digest': evidence_digest,
        'observed_at_utc': record['observedAtUtc'], 'superseded_by_revision': None,
        'created_at_utc': created_at,
    }


# ----------------------------------------------------------------------
# Events
# ----------------------------------------------------------------------

def time_projection(time, timezone_name):
    """trade_date and broker_timestamp as the shared events table shows them.

    Display and filter columns only (plan §8.1): with an instant, the calendar
    day and local time in [tws] timezone; with only a range, the exchange
    trade date (or the local day the range starts) and no timestamp. FOP
    ordering, dedupe, cycles and as-of views never read them.
    """
    zone = _zone(timezone_name)
    if time.get('executedAtUtc'):
        local = parse_instant(time['executedAtUtc']).astimezone(zone)
        return local.date().isoformat(), local.strftime('%Y-%m-%dT%H:%M:%S')
    if time.get('exchangeTradeDate'):
        return time['exchangeTradeDate'], None
    local = parse_instant(time['timeRange']['startUtc']).astimezone(zone)
    return local.date().isoformat(), None


def order_key(details, seq):
    """The P2 replay order: effective start, end, then entry order (P3: §9.2)."""
    start = details['executed_at_utc'] or details['time_range_start_utc']
    end = details['executed_at_utc'] or details['time_range_end_utc']
    return (start, end, seq)


def delivery_direction(right, closing_contracts):
    """The FUT delta sign of a delivery (plan §6.1).

    closing_contracts is the FOP delta: positive when an assignment closes a
    short, negative when an exercise closes a long.
    """
    if closing_contracts > 0:          # assigned: short call sells, short put buys
        return -1 if right == 'C' else 1
    return 1 if right == 'C' else -1   # exercised: long call buys, long put sells


def normalize_event(event, *, book, contract_for, binding_for, timezone_name, stored_fee_source):
    """Validate one shape-checked FopEvent and return what the store writes.

    contract_for(ref) and binding_for(ref) resolve a reference to a record in
    the same package or already stored (None when neither); stored_fee_source
    (event_id) returns the stored event a feeSource.eventId names, or None.
    """
    kind = event['kind']
    if event['account'] != book['account']:
        _refuse(f'a {kind} row for account {event["account"]} cannot enter the '
                f'{book["account"]} ledger')
    contract = None
    delivered = None
    binding = None
    if 'contractRef' in event:
        contract = contract_for(event['contractRef'])
        if contract is None:
            _refuse(f'{kind}: contractRef {event["contractRef"]["contractId"]} revision '
                    f'{event["contractRef"]["revision"]} is not in the package or the ledger',
                    'fop_reference_revision_conflict')
        expected = 'FOP' if kind in OPTION_CONTRACT_KINDS else ('FUT' if kind == 'futures_trade' else None)
        if expected and contract['secType'] != expected:
            _refuse(f'{kind} references a {contract["secType"]} contract; it needs a {expected}',
                    'fop_identity_conflict')
    if kind in DELIVERY_KINDS:
        delivered = contract_for(event['deliveredContractRef'])
        if delivered is None or delivered['secType'] != 'FUT':
            _refuse(f'{kind}: deliveredContractRef must name a FUT record of the package or the '
                    'ledger', 'fop_reference_revision_conflict')
        binding = binding_for(event['bindingRef'])
        if binding is None:
            _refuse(f'{kind}: bindingRef {event["bindingRef"]["bindingId"]} revision '
                    f'{event["bindingRef"]["revision"]} is not in the package or the ledger',
                    'fop_reference_revision_conflict')
        # delivery_follows_binding
        if binding['status'] not in RESOLVED_BINDING_STATUSES:
            _refuse(f'{kind}: binding {binding["bindingId"]} is {binding["status"]}; a delivery '
                    'needs a resolved binding', 'fop_binding_evidence_invalid')
        if (binding['optionContractId'] != contract['contractId']
                or binding['futureContractId'] != delivered['contractId']):
            _refuse(f'{kind}: binding {binding["bindingId"]} binds {binding["optionContractId"]} '
                    f'to {binding["futureContractId"]}, not {contract["contractId"]} to '
                    f'{delivered["contractId"]}', 'fop_identity_conflict')

    contracts = event.get('contracts')
    future_contracts = event.get('futureContracts')
    price = event.get('price')
    cash = float(event['cashAmount'])
    fees = float(event['fees'])
    derived_mismatch = 0

    if kind == 'option_trade':
        derived = -contracts * float(contract['premiumMultiplier']) * float(price) - fees
        derived_mismatch = 1 if abs(cash - derived) > CASH_DERIVATION_TOLERANCE else 0
    elif kind in DELIVERY_KINDS:
        per_option = float(contract['deliverableFuturesPerOption'])
        size = abs(contracts) * per_option
        if abs(size - round(size)) > _EPSILON:
            _refuse(f'{kind}: {abs(contracts)} options x {per_option} futures each is not a whole '
                    'number of futures')
        sign = delivery_direction(contract['optionRight'], contracts)
        if future_contracts != sign * int(round(size)):
            _refuse(f'{kind} of {contracts:+d} {contract["optionRight"]} delivers '
                    f'{sign * int(round(size)):+d} FUT, not {future_contracts:+d} (plan §6.1)')
        if abs(float(price) - float(contract['optionStrike'])) > _EPSILON:
            _refuse(f'{kind}: the delivery price is the strike {contract["optionStrike"]}, '
                    f'not {price}')
    elif kind == 'opening_balance':
        if contract['secType'] == 'FUT':
            if future_contracts is None or contracts is not None:
                _refuse('a FUT baseline states futureContracts, not contracts')
            if event['baselineKind'] == 'unknown_cost':
                # unknown_cost_only_for_options
                _refuse('a FUT baseline needs a trade cost or a reference price (plan §9.2)')
        else:
            if contracts is None or future_contracts is not None:
                _refuse('a FOP baseline states contracts, not futureContracts')

    fee_source = None
    if kind == 'fee' and event.get('feeSource') is not None:
        fee_source = dict(event['feeSource'])
        if fee_source['eventId'] is not None:
            target = stored_fee_source(fee_source['eventId'])
            if target is None:
                _refuse(f'fee: feeSource event {fee_source["eventId"]} is not a live event of '
                        'this ledger', 'fop_reference_revision_conflict')
            if target['kind'] == 'fee':
                _refuse('fee: a fee cannot be the source of another fee')

    time = event['time']
    trade_date, broker_timestamp = time_projection(time, timezone_name)
    time_range = time.get('timeRange')
    details = {
        'contract_id': contract['contractId'] if contract else None,
        'contract_revision': contract['revision'] if contract else None,
        'delivered_contract_id': delivered['contractId'] if delivered else None,
        'delivered_contract_revision': delivered['revision'] if delivered else None,
        'binding_id': binding['bindingId'] if binding else None,
        'binding_revision': binding['revision'] if binding else None,
        'open_close': event.get('openClose'),
        'fee_category': event.get('feeCategory'),
        'fee_is_refund': 1 if event.get('feeIsRefund') else 0,
        'fee_source_event_id': fee_source['eventId'] if fee_source else None,
        'adjustment_scope': event.get('adjustmentScope'),
        'baseline_kind': event.get('baselineKind'),
        'baseline_as_of_utc': event.get('baselineAsOfUtc'),
        'exchange_trade_date': time.get('exchangeTradeDate'),
        'executed_at_utc': time.get('executedAtUtc'),
        'time_range_start_utc': time_range['startUtc'] if time_range else None,
        'time_range_end_utc': time_range['endUtc'] if time_range else None,
        'source_time_text': time.get('sourceTimeText'),
        'source_timezone': time.get('sourceTimezone'),
        'order_evidence': time.get('orderEvidence'),
    }
    allocations = [dict(source) for source in event['sources']]
    external_ref = None
    primary_source = None
    if allocations:
        primary = allocations[0]
        if event['externalRef'] not in (None, primary['sourceRef']):
            _refuse(f'{kind}: externalRef {event["externalRef"]} is not the primary source '
                    f'{primary["sourceRef"]}')
        # The account-scoped key of the shared events table, from the primary
        # source; event_external_refs qualifies it when a source is split.
        primary_source = (primary['namespace'], primary['sourceRef'])
        external_ref = f'{primary["namespace"]}:{primary["sourceRef"]}'
    elif event['externalRef'] is not None:
        external_ref = f'manual:{event["externalRef"]}'
    row = {
        'kind': kind, 'trade_date': trade_date, 'broker_timestamp': broker_timestamp,
        'account': event['account'],
        'contracts': None if contracts is None else float(contracts),
        'future_contracts': None if future_contracts is None else float(future_contracts),
        'price': None if price is None else float(price),
        'cash_amount': cash, 'fees': fees,
        'include_in_cost': 1 if event['includeInCost'] else 0,
        'tag': '', 'source': event['source'], 'external_ref': external_ref,
        'derived_mismatch': derived_mismatch, 'allow_overdraw': 0, 'note': event['note'],
    }
    return {'event': row, 'details': details, 'allocations': allocations,
            'fee_source': fee_source, 'package_key': event.get('packageKey'),
            'primary_source': primary_source}


def event_external_refs(normalized, event_ids):
    """The external_ref each event row stores, in the order of event_ids.

    One source may be allocated to several events (plan §8.1): a broker row
    split into two fills, a summed fee over two trades. The source table keeps
    such a source once and de-duplicates it; the shared events table keeps
    external_ref unique per account, so an event whose primary source is also
    the primary source of another event of the same graph carries its own id
    after the source key. A source that feeds one event keeps the plain key.
    """
    counts = {}
    for item in normalized:
        if item['primary_source'] is not None:
            counts[item['primary_source']] = counts.get(item['primary_source'], 0) + 1
    refs = []
    for item, event_id in zip(normalized, event_ids):
        ref = item['event']['external_ref']
        if item['primary_source'] is not None and counts[item['primary_source']] > 1:
            ref = f'{ref}#{event_id}'
        refs.append(ref)
    return refs


def listed_external_ref(external_ref, event_id):
    """The sourceRef or manual reference an external_ref shows (event_external_refs)."""
    if not external_ref:
        return None
    shown = external_ref.split(':', 1)[1] if ':' in external_ref else external_ref
    suffix = f'#{event_id}'
    return shown[:-len(suffix)] if shown.endswith(suffix) else shown


def check_source_records(package, *, book, kind, statement):
    """The protocol's source rules for one package (domainRules)."""
    records = {}
    for record in package['sourceRecords']:
        key = (record['namespace'], record['sourceRef'])
        if key in records:
            _refuse(f'source record {key[0]}:{key[1]} appears twice in one package')
        # source_account_matches
        if record['account'] != book['account']:
            _refuse(f'source record {key[1]} belongs to account {record["account"]}, not '
                    f'{book["account"]}')
        records[key] = record
    used = {key: {'quantity': 0.0, 'fees': 0.0, 'count': 0} for key in records}
    for index, event in enumerate(package['events']):
        for source in event['sources']:
            key = (source['namespace'], source['sourceRef'])
            if key not in used:
                # source_refs_resolve
                _refuse(f'events[{index}] allocates {key[0]}:{key[1]}, which the package does '
                        'not carry as a source record')
            used[key]['quantity'] += abs(source['quantity'] or 0)
            used[key]['fees'] += source['fees'] or 0
            used[key]['count'] += 1
    for key, record in records.items():
        check_allocation_bounds(key, record, used[key])
    # statement_rows_need_a_statement
    statement_rows = [record for key, record in records.items() if key[0] in STATEMENT_NAMESPACES]
    if kind == 'append' and statement_rows:
        _refuse('statement rows arrive by import with their statement, never by append')
    if statement_rows:
        if statement is None:
            _refuse('an import of statement rows needs its statement registration')
        formats = {record['format'] for record in statement_rows}
        if formats != {statement['format']}:
            _refuse(f'one file per import: rows in {sorted(formats)}, statement is '
                    f'{statement["format"]}')
        if statement['account'] != book['account'] and '*' not in statement['account']:
            _refuse(f'the statement is for {statement["account"]}, not {book["account"]}')
    return records


def check_allocation_bounds(key, record, used):
    """source_records_used and source_allocation_bounds for one source record.

    used: {'quantity': sum of |allocated quantity|, 'fees': sum of allocated
    fees, 'count': number of allocations}.
    """
    if used['count'] == 0:
        # source_records_used
        _refuse(f'source record {key[0]}:{key[1]} is not allocated by any event')
    # source_allocation_bounds
    if record['statedQuantity'] is not None and \
            used['quantity'] > abs(record['statedQuantity']) + _EPSILON:
        _refuse(f'{key[0]}:{key[1]} allocates {used["quantity"]:g} of '
                f'{abs(record["statedQuantity"]):g} stated contracts')
    if record['statedFees'] is not None and \
            used['fees'] > abs(record['statedFees']) + _EPSILON:
        _refuse(f'{key[0]}:{key[1]} allocates {used["fees"]:g} of '
                f'{abs(record["statedFees"]):g} stated fees')


def check_package_keys(package):
    """package_keys_resolve: unique keys; a fee's in-package source is a non-fee event."""
    keyed = {}
    for index, event in enumerate(package['events']):
        key = event.get('packageKey')
        if key is None:
            continue
        if key in keyed:
            _refuse(f'packageKey {key} labels two events')
        keyed[key] = index
    for index, event in enumerate(package['events']):
        source = event.get('feeSource') if event['kind'] == 'fee' else None
        if source and source['packageKey'] is not None:
            target = keyed.get(source['packageKey'])
            if target is None:
                _refuse(f'events[{index}] names packageKey {source["packageKey"]}, which no '
                        'event of the package carries')
            if package['events'][target]['kind'] == 'fee' or target == index:
                _refuse(f'events[{index}]: a fee names a trade, not another fee')
    return keyed


# ----------------------------------------------------------------------
# Timeline (P2 minimum)
# ----------------------------------------------------------------------

def replay_quantities(rows):
    """Replay live events per contract and refuse a close that overdraws.

    rows: dicts with event_id, kind, seq, contracts, future_contracts,
    contract_id, delivered_contract_id, open_close and the time columns of
    their details, for every live event of one ledger. Returns
    (ordered event ids, {event_id: balances after it}) where balances maps
    ('FOP'|'FUT', contract_id) to the open quantity.
    """
    ordered = sorted(rows, key=lambda row: order_key(row, row['seq']))
    balances = {}
    after = {}
    for row in ordered:
        kind = row['kind']
        if kind in ('fee', 'manual_adjust'):
            after[row['event_id']] = {k: v for k, v in balances.items() if abs(v) > _EPSILON}
            continue
        if kind == 'futures_trade' or (kind == 'opening_balance'
                                        and row['future_contracts'] is not None):
            key = ('FUT', row['contract_id'])
            delta = row['future_contracts']
        else:
            key = ('FOP', row['contract_id'])
            delta = row['contracts']
        position = balances.get(key, 0.0)
        _check_close(row, position, delta)
        balances[key] = position + delta
        if kind in DELIVERY_KINDS:
            fut_key = ('FUT', row['delivered_contract_id'])
            balances[fut_key] = balances.get(fut_key, 0.0) + row['future_contracts']
        after[row['event_id']] = {k: v for k, v in balances.items() if abs(v) > _EPSILON}
    return [row['event_id'] for row in ordered], after


def _check_close(row, position, delta):
    kind = row['kind']
    closes = kind in DELIVERY_KINDS or kind == 'option_expiry' or row.get('open_close') == 'C'
    if closes:
        if abs(position) < _EPSILON or position * delta > 0 or abs(delta) > abs(position) + _EPSILON:
            raise FopDomainError(
                'position_overdraw',
                f'{kind} {row["event_id"]} closes {delta:+g} but {position:+g} is open at that '
                'point; enter the opening first')
    elif row.get('open_close') == 'O' and abs(position) > _EPSILON and position * delta < 0:
        raise FopDomainError(
            'position_overdraw',
            f'{kind} {row["event_id"]} is marked as opening but reduces an open {position:+g}')
    elif row.get('open_close') == 'CO' and not (position * delta < 0
                                               and abs(delta) > abs(position) + _EPSILON):
        raise FopDomainError(
            'position_overdraw',
            f'{kind} {row["event_id"]} is marked close-and-open but does not cross the open '
            f'{position:+g}')


def check_cycle_anchors(boundaries, balances_after, live_event_ids):
    """Every current closed boundary sits on its own live event after which all
    balances are zero. Every write and every restore runs this same check;
    superseded revisions keep their old anchors and are not passed in."""
    anchored = {}
    for boundary in boundaries:
        anchor = boundary['anchor_event_id']
        if anchor in anchored:
            raise FopDomainError(
                'fop_cycle_boundary_violated',
                f'cycle boundaries {anchored[anchor]} and {boundary["boundary_id"]} both close a '
                f'cycle at {anchor}; one event closes one cycle')
        anchored[anchor] = boundary['boundary_id']
        if anchor not in live_event_ids:
            raise FopDomainError(
                'fop_cycle_boundary_violated',
                f'cycle boundary {boundary["boundary_id"]} is anchored on {anchor}, which is not '
                'a live event; revoke or move the boundary first')
        if balances_after.get(anchor):
            raise FopDomainError(
                'fop_cycle_boundary_violated',
                f'cycle boundary {boundary["boundary_id"]} no longer sits where every balance is '
                'zero; revoke it or enter the missing rows after it')


# ----------------------------------------------------------------------
# The whole graph (restore of a backup or a reset archive, plan §8.3)
# ----------------------------------------------------------------------

def _revision_chains(items, *, id_of, revision_of, superseded_of, what, from_one):
    """{id: [records by revision]}: revisions run without a gap, each one is
    superseded by the next and only the last is current. Contracts and bindings
    start at revision 1; a cycle boundary a rebuild carried starts later."""
    chains = {}
    for item in items:
        revisions = chains.setdefault(id_of(item), {})
        if revision_of(item) in revisions:
            _refuse(f'{what} {id_of(item)} revision {revision_of(item)} appears twice')
        revisions[revision_of(item)] = item
    ordered = {}
    for ident, revisions in chains.items():
        numbers = sorted(revisions)
        first = 1 if from_one else numbers[0]
        if numbers != list(range(first, first + len(numbers))):
            _refuse(f'{what} {ident} has revisions {numbers}; they must run from {first} '
                    'without a gap', 'fop_reference_revision_conflict')
        for number in numbers:
            expected = number + 1 if number != numbers[-1] else None
            if superseded_of(revisions[number]) != expected:
                _refuse(f'{what} {ident} revision {number} must be '
                        + (f'superseded by {expected}' if expected else 'the current one'),
                        'fop_reference_revision_conflict')
        ordered[ident] = [revisions[number] for number in numbers]
    return ordered


def check_graph(payload, *, book, product_rules):
    """Every relation of a BackupPayloadV2, before a restore writes any of it.

    A restore must not store a graph the write paths would refuse: every
    contract, binding, boundary, source, allocation, operation record,
    reference revision and logged request is checked, also the ones no live
    event uses, and every id they name must be inside this graph (another
    ledger's ids are outside it). Event rows themselves are re-checked by
    normalize_event and the timeline (quantities, one cycle per anchor) by
    the store after the write, in the same transaction.
    """
    events = {}
    seqs = set()
    for stored in payload['events']:
        row = stored['row']
        if row['eventId'] in events:
            _refuse(f'the backup names event {row["eventId"]} twice')
        if row['seq'] in seqs:
            _refuse(f'the backup gives seq {row["seq"]} to two events')
        events[row['eventId']] = stored
        seqs.add(row['seq'])

    tokens = set()
    for request in payload['requests']:
        if request['clientToken'] in tokens:
            _refuse(f'the request log names token {request["clientToken"]} twice')
        tokens.add(request['clientToken'])
        try:
            answer = json.loads(request['resultJson'])
        except ValueError:
            answer = None
        if not isinstance(answer, dict) or answer.get('bookId') != payload['book']['bookId']:
            _refuse(f'the logged answer to {request["clientToken"]} is not an answer about this '
                    'ledger')

    contract_chains = _revision_chains(
        payload['contracts'], id_of=lambda c: c['record']['contractId'],
        revision_of=lambda c: c['record']['revision'],
        superseded_of=lambda c: c['supersededByRevision'], what='contract', from_one=True)
    for chain in contract_chains.values():
        for stored in chain:
            check_contract_against_book(stored['record'], book=book, product_rules=product_rules)
        for before, after in zip(chain, chain[1:]):
            check_contract_revision(before['record'], after['record'])
    check_current_contracts_distinct([chain[-1]['record'] for chain in contract_chains.values()])
    sec_types = {ident: chain[0]['record']['secType'] for ident, chain in contract_chains.items()}
    contract_revisions = {(ident, stored['record']['revision'])
                          for ident, chain in contract_chains.items() for stored in chain}

    binding_chains = _revision_chains(
        payload['bindings'], id_of=lambda b: b['bindingId'], revision_of=lambda b: b['revision'],
        superseded_of=lambda b: b['supersededByRevision'], what='binding', from_one=True)
    current_option = {}
    for ident, chain in binding_chains.items():
        option = chain[0]['optionContractId']
        for stored in chain:
            if stored['optionContractId'] != option:
                _refuse(f'binding {ident}: a revision keeps its option contract',
                        'fop_identity_conflict')
            if sec_types.get(option) != 'FOP':
                _refuse(f'binding {ident} revision {stored["revision"]} binds {option}, which is '
                        'not a FOP contract of this ledger', 'fop_identity_conflict')
            future = stored['futureContractId']
            if future is not None and sec_types.get(future) != 'FUT':
                _refuse(f'binding {ident} revision {stored["revision"]} names {future}, which is '
                        'not a FUT contract of this ledger', 'fop_identity_conflict')
        if option in current_option:
            _refuse(f'{option} has two current bindings, {current_option[option]} and {ident}',
                    'fop_identity_conflict')
        current_option[option] = ident
    binding_revisions = {(ident, stored['revision'])
                         for ident, chain in binding_chains.items() for stored in chain}

    # A live event holds the current revision of what it names; only a voided
    # event keeps a revision a later metadata commit superseded.
    current = {
        'contractRef': {ident: chain[-1]['record']['revision']
                        for ident, chain in contract_chains.items()},
        'bindingRef': {ident: chain[-1]['revision'] for ident, chain in binding_chains.items()},
    }
    current['deliveredContractRef'] = current['contractRef']
    for event_id, stored in events.items():
        if stored['row']['voidedAtUtc'] is not None:
            continue
        fop = stored['row']['fop']
        for field, id_field in (('contractRef', 'contractId'),
                                ('deliveredContractRef', 'contractId'),
                                ('bindingRef', 'bindingId')):
            ref = fop[field]
            if ref is not None and current[field].get(ref[id_field]) != ref['revision']:
                _refuse(f'live event {event_id} holds {field} {ref[id_field]} revision '
                        f'{ref["revision"]}, which is not the current revision',
                        'fop_reference_revision_conflict')

    sources = {}
    source_keys = set()
    for source in payload['sources']:
        key = (source['account'], source['namespace'], source['sourceRef'])
        if source['sourceId'] in sources or key in source_keys:
            _refuse(f'source {source["namespace"]}:{source["sourceRef"]} appears twice')
        if source['account'] != book['account']:
            _refuse(f'source {source["sourceRef"]} belongs to account {source["account"]}, not '
                    f'{book["account"]}')
        sources[source['sourceId']] = source
        source_keys.add(key)
    used = {source_id: {'quantity': 0.0, 'fees': 0.0, 'count': 0} for source_id in sources}
    allocation_keys = set()
    for allocation in payload['allocations']:
        if allocation['sourceId'] not in sources or allocation['eventId'] not in events:
            _refuse('an allocation names a source or event outside the backup')
        key = (allocation['sourceId'], allocation['eventId'], allocation['role'])
        if key in allocation_keys:
            _refuse('an allocation appears twice')
        allocation_keys.add(key)
        used[allocation['sourceId']]['quantity'] += abs(allocation['quantity'] or 0)
        used[allocation['sourceId']]['fees'] += allocation['fees'] or 0
        used[allocation['sourceId']]['count'] += 1
    for source_id, source in sources.items():
        check_allocation_bounds((source['namespace'], source['sourceRef']), source, used[source_id])
    # The primary source is named, never inferred: an event that allocates
    # sources names one of them, and its listed externalRef is that source's.
    allocated = {}
    for allocation in payload['allocations']:
        allocated.setdefault(allocation['eventId'], set()).add(allocation['sourceId'])
    for event_id, stored in events.items():
        primary = stored['primarySourceId']
        if event_id not in allocated:
            if primary is not None:
                _refuse(f'event {event_id} names primary source {primary} but allocates none')
            continue
        if primary not in allocated[event_id]:
            _refuse(f'event {event_id} must name one of the sources it allocates as its primary')
        if stored['row']['externalRef'] != sources[primary]['sourceRef']:
            _refuse(f'event {event_id} shows externalRef {stored["row"]["externalRef"]}, not its '
                    f'primary source {sources[primary]["sourceRef"]}')

    cycle_chains = _revision_chains(
        payload['cycles'], id_of=lambda c: c['boundaryId'], revision_of=lambda c: c['revision'],
        superseded_of=lambda c: c['supersededByRevision'], what='cycle boundary', from_one=False)
    for ident, chain in cycle_chains.items():
        for cycle in chain:
            if cycle['anchorEventId'] is not None and cycle['anchorEventId'] not in events:
                _refuse(f'cycle boundary {ident} revision {cycle["revision"]} is anchored on an '
                        'event outside this ledger', 'fop_cycle_boundary_violated')

    operations = {}
    operation_tokens = set()
    for operation in payload['operations']:
        if operation['operationId'] in operations or operation['clientToken'] in operation_tokens:
            _refuse(f'operation {operation["operationId"]} or its token appears twice')
        operations[operation['operationId']] = operation
        operation_tokens.add(operation['clientToken'])
    revision_keys = set()
    for revision in payload['referenceRevisions']:
        if revision['operationId'] not in operations or revision['eventId'] not in events:
            _refuse('a reference revision names an operation or event outside the backup')
        key = (revision['operationId'], revision['eventId'], revision['reference'])
        if key in revision_keys:
            _refuse('a reference revision appears twice')
        revision_keys.add(key)
        for side in ('before', 'after'):
            value = revision[side]
            if value['id'] is None:
                continue
            target = (value['id'], value['revision'])
            if revision['reference'] in ('contract', 'delivered_contract'):
                known = target in contract_revisions
            elif revision['reference'] == 'binding':
                known = target in binding_revisions
            else:
                known = value['id'] in events
            if not known:
                _refuse(f'a {revision["reference"]} revision of event {revision["eventId"]} names '
                        f'{value["id"]} revision {value["revision"]}, which is not in this ledger',
                        'fop_reference_revision_conflict')
    mapping_keys = set()
    for mapping in payload['eventIdMappings']:
        operation = operations.get(mapping['operationId'])
        if operation is None or operation['kind'] != 'rebuild':
            _refuse('an event id mapping names no rebuild of this backup')
        if mapping['newEventId'] not in events:
            _refuse('an event id mapping names an event outside the backup')
        key = (mapping['operationId'], mapping['oldEventId'])
        if key in mapping_keys:
            _refuse('an event id mapping appears twice')
        mapping_keys.add(key)
    return events


def is_finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


# ----------------------------------------------------------------------
# Repeated source references (protocol.json domainRules
# repeated_source_matches_or_conflicts; imports use it from P4)
# ----------------------------------------------------------------------

# Every FopEvent field and time fact has exactly one policy.
REPEAT_EVENT_VALUES = (
    'kind', 'contracts', 'futureContracts', 'price', 'cashAmount', 'fees', 'includeInCost',
    'openClose', 'feeCategory', 'feeIsRefund', 'adjustmentScope', 'baselineKind',
    'baselineAsOfUtc',
)
# Compared by meaning: contracts by terms, a binding through the contract pair
# delivery_follows_binding ties it to, a fee source by the event it resolves
# to, time by its compared facts, sources by the record's own allocation.
REPEAT_EVENT_BY_MEANING = frozenset({'contractRef', 'deliveredContractRef', 'bindingRef',
                                     'feeSource', 'time', 'sources'})
REPEAT_EVENT_PROVENANCE = frozenset({'account', 'source', 'externalRef', 'packageKey', 'note'})
REPEAT_TIME_COMPARED = ('exchangeTradeDate', 'executedAtUtc', 'timeRange', 'orderEvidence')
REPEAT_TIME_REPORTED = ('sourceTimeText', 'sourceTimezone')


def _repeat_side(side):
    """(reference, compared values, reported values) of one side of a comparison.

    side: {'record': SourceSubmission, 'events': [FopEvent allocated to it],
    'contracts': [ContractRecord], 'bindings': [BindingRecord],
    'matchedPackageKeys': {packageKey: stored event id}}.
    """
    record = side['record']
    key = (record['account'], record['namespace'], record['sourceRef'])
    contracts = {(c['contractId'], c['revision']): c for c in side.get('contracts', [])}
    bindings = {(b['bindingId'], b['revision']): b for b in side.get('bindings', [])}
    matched = side.get('matchedPackageKeys', {})
    events = [event for event in side['events']
              if any((source['namespace'], source['sourceRef']) == key[1:]
                     for source in event['sources'])]
    compared = {'record.statedQuantity': record['statedQuantity'],
                'record.statedFees': record['statedFees'], 'events': len(events)}
    reported = {f'rawFields.{name}': value for name, value in record['rawFields'].items()}
    for index, event in enumerate(events):
        prefix = f'events[{index}]'
        for field in REPEAT_EVENT_VALUES:
            compared[f'{prefix}.{field}'] = event.get(field)
        for field in REPEAT_TIME_COMPARED:
            compared[f'{prefix}.time.{field}'] = canonical_json(event['time'][field])
        for field in REPEAT_TIME_REPORTED:
            reported[f'{prefix}.time.{field}'] = event['time'][field]
        for ref in ('contractRef', 'deliveredContractRef'):
            if event.get(ref):
                contract = contracts[(event[ref]['contractId'], event[ref]['revision'])]
                for field, value in contract_terms(contract).items():
                    compared[f'{prefix}.{ref}.{field}'] = value
        if event.get('bindingRef'):
            binding = bindings[(event['bindingRef']['bindingId'], event['bindingRef']['revision'])]
            if (binding['optionContractId'] != event['contractRef']['contractId']
                    or binding['futureContractId'] != event['deliveredContractRef']['contractId']):
                _refuse('a delivery names a binding of another contract pair',
                        'fop_identity_conflict')
            reported[f'{prefix}.bindingRef'] = canonical_json(event['bindingRef'])
        fee_source = event.get('feeSource')
        if fee_source is not None:
            compared[f'{prefix}.feeSource'] = fee_source['eventId'] or matched.get(
                fee_source['packageKey'], f"new:{fee_source['packageKey']}")
        allocation = next(source for source in event['sources']
                          if (source['namespace'], source['sourceRef']) == key[1:])
        for field in ('role', 'quantity', 'fees'):
            compared[f'{prefix}.allocation.{field}'] = allocation[field]
    return key, compared, reported


def repeat_outcome(stored, incoming):
    """What an import does with an incoming source that may repeat a stored one.

    {'outcome': 'new'} for another reference; {'outcome': 'duplicate',
    'reported': [...]} when the economic content is equal (the reported list
    names differences that do not decide it); {'outcome': 'conflict',
    'code': 'import_revision_conflict', 'fields': [...]} otherwise.
    """
    stored_key, before, before_reported = _repeat_side(stored)
    incoming_key, after, after_reported = _repeat_side(incoming)
    if stored_key != incoming_key:
        return {'outcome': 'new'}
    fields = sorted(field for field in set(before) | set(after)
                    if before.get(field) != after.get(field))
    if fields:
        return {'outcome': 'conflict', 'code': 'import_revision_conflict', 'fields': fields}
    return {'outcome': 'duplicate', 'reported': sorted(
        field for field in set(before_reported) | set(after_reported)
        if before_reported.get(field) != after_reported.get(field))}
