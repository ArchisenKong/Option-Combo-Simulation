"""Statement rows as the server reads them (plan §9.7, §4.3).

CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §9.7 and §4.3. The FOP importer
(js/cost_basis_fop_import.js) reads a whole statement in the browser. For
what only a statement can prove the server does not take that reading on
trust: it reads the rows it is sent itself, through the same versioned
mapping (cost_basis_fop_capabilities.json), to

- hold every statement row of an import to its row type's capability status:
  only real_verified rows are written, out_of_scope rows are never submitted,
  unsupported rows block the batch;
- check a manual event that claims a synthetic_only row against that row:
  kind, contract, quantity, price, fees and time (plan §9.7 "例外处理");
- check the rows a statement binding credential is asked for: they must name
  the option, its underlying future and that future's delivery month;
- check a row a person named the same fill as a stored trade: its row type,
  contract, direction and day (plan §19 P5-C1).

Pure: no SQLite, no IB. Refusals are cost_basis_fop_domain.FopDomainError.
"""
import json
import pathlib
import re
from datetime import date, datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9 is not supported by the servers
    ZoneInfo = None

import cost_basis_fop_domain as domain

CAPABILITIES_PATH = pathlib.Path(__file__).with_name('cost_basis_fop_capabilities.json')
STATUSES = ('real_verified', 'synthetic_only', 'out_of_scope', 'unsupported')
_PRICE_TOLERANCE = 1e-6
_FEE_TOLERANCE = 0.005
_MONTH_CODES = {'F': '01', 'G': '02', 'H': '03', 'J': '04', 'K': '05', 'M': '06',
                'N': '07', 'Q': '08', 'U': '09', 'V': '10', 'X': '11', 'Z': '12'}
_FUT_SYMBOL = re.compile(r'^([A-Z0-9]{1,4}?)([FGHJKMNQUVXZ])(\d{1,2})$')
_NUMBER = re.compile(r'^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$')
# (asset, event) of a key -> the event kinds and the allocation role that read it.
_CLAIMS = {
    ('FUT', 'trade'): ({'futures_trade'}, 'trade'),
    ('FOP', 'trade'): ({'option_trade'}, 'trade'),
    ('FOP', 'assignment'): ({'option_assignment'}, 'option_leg'),
    ('FOP', 'exercise'): ({'option_exercise'}, 'option_leg'),
    ('FOP', 'expiry'): ({'option_expiry'}, 'trade'),
    ('FUT', 'delivery_leg'): ({'option_assignment', 'option_exercise'}, 'future_leg'),
}


class Capabilities:
    """The capability list and import mapping of one release (plan §9.7)."""

    def __init__(self, document):
        if not isinstance(document, dict) or document.get('format') != 'cost-basis-fop-capabilities':
            raise ValueError('not a cost-basis-fop-capabilities document')
        self.document = document
        self.mapping = document['mapping']
        self.mapping_version = document.get('importMappingVersion')
        self._status = {}
        for entry in document['keys']:
            if entry['status'] not in STATUSES:
                raise ValueError(f'{entry["key"]}: unknown status {entry["status"]}')
            self._status[entry['key']] = entry['status']

    def status_of(self, key):
        return self._status.get(key)

    def summary(self):
        """What a status response tells a page: every key and its status."""
        return {'mappingVersion': self.mapping_version,
                'keys': [{'key': key, 'status': status} for key, status in self._status.items()]}

    def with_statuses(self, overrides):
        """A copy with some statuses replaced (tests stand in for a real acceptance)."""
        document = json.loads(json.dumps(self.document))
        for entry in document['keys']:
            if entry['key'] in overrides:
                entry['status'] = overrides[entry['key']]
        return Capabilities(document)


_DEFAULT = None


def default_capabilities():
    """The capability list this code ships with."""
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = Capabilities(json.loads(CAPABILITIES_PATH.read_text(encoding='utf-8')))
    return _DEFAULT


# ----------------------------------------------------------------------
# Reading one row (the same rules as js/cost_basis_import_common.js)
# ----------------------------------------------------------------------

def normalize_header(value):
    return re.sub(r'\s+', ' ', str(value if value is not None else '').strip().lower())


def upper(value):
    return re.sub(r'\s+', ' ', str(value if value is not None else '').strip()).upper()


def number(value):
    if value is None:
        return None
    text = str(value).strip().replace(',', '')
    if not text:
        return None
    negated = re.match(r'^\((.*)\)$', text)
    body = (negated.group(1) if negated else text).strip()
    if not _NUMBER.match(body):
        return None
    parsed = float(body)
    return -parsed if negated else parsed


def iso_date(value):
    text = str(value if value is not None else '').strip()
    if not text:
        return ''
    match = re.match(r'^(\d{4})-(\d{2})-(\d{2})', text) or re.match(r'^(\d{4})/(\d{2})/(\d{2})', text)
    if match:
        return f'{match.group(1)}-{match.group(2)}-{match.group(3)}'
    digits = re.sub(r'[^0-9]', '', text)
    if len(digits) >= 8:
        return f'{digits[:4]}-{digits[4:6]}-{digits[6:8]}'
    return ''


def local_timestamp(value):
    """'YYYY-MM-DDTHH:MM:SS' of an account-local statement time, or ''."""
    text = str(value if value is not None else '').strip()
    date = iso_date(text)
    if not date:
        return ''
    match = re.search(r'(?:^|[\s,T])(\d{1,2}):(\d{2})(?::(\d{2}))?', text)
    if match:
        return f'{date}T{int(match.group(1)):02d}:{match.group(2)}:{match.group(3) or "00"}'
    compact = (re.search(r'(?:^|[\s,T;])(\d{2})(\d{2})(\d{2})(?:\D|$)', text)
               or re.match(r'^\D*\d{8}(\d{2})(\d{2})(\d{2})\D*$', text))
    if not compact:
        return ''
    return f'{date}T{compact.group(1)}:{compact.group(2)}:{compact.group(3)}'


def _instant(moment):
    return moment.strftime('%Y-%m-%dT%H:%M:%S.') + f'{moment.microsecond:06d}Z'


def local_to_utc(local, zone_name):
    """{'instant'}, {'range': [first, last]} for a repeated local time, or {'error'}."""
    match = re.match(r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$', local or '')
    if not match or ZoneInfo is None:
        return {'error': f'{local} is not a local date and time'}
    try:
        zone = ZoneInfo(zone_name)
    except Exception:  # noqa: BLE001 - any unknown key is simply unknown here
        return {'error': f'unknown timezone {zone_name}'}
    naive = datetime(*(int(part) for part in match.groups()))
    found = set()
    for fold in (0, 1):
        moment = naive.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc)
        if moment.astimezone(zone).replace(tzinfo=None) == naive:
            found.add(moment)
    if not found:
        return {'error': f'{local} does not exist in {zone_name}'}
    ordered = sorted(found)
    if len(ordered) == 1:
        return {'instant': _instant(ordered[0])}
    return {'range': [_instant(ordered[0]), _instant(ordered[-1])]}


def day_range(date, zone_name, days_before):
    """[local 00:00 of date - days_before, local 00:00 of date + 1] in UTC, or {'error'}.

    The same range js/cost_basis_fop_import.js gives a row that has only a
    date: the earliest reading of the first midnight, the latest of the last.
    """
    try:
        day = datetime.strptime(date, '%Y-%m-%d')
    except (TypeError, ValueError):
        return {'error': f'{date} is not a date'}
    first = local_to_utc((day - timedelta(days=days_before)).strftime('%Y-%m-%dT00:00:00'), zone_name)
    last = local_to_utc((day + timedelta(days=1)).strftime('%Y-%m-%dT00:00:00'), zone_name)
    if 'error' in first or 'error' in last:
        return {'error': first.get('error') or last.get('error')}
    return {'range': [first.get('instant') or first['range'][0], last.get('instant') or last['range'][1]]}


def row_values(raw_fields, mapping):
    """{canonical field: text} of one row's raw fields, first unclaimed column per alias."""
    names = [normalize_header(re.sub(r'#\d+$', '', name)) for name in raw_fields]
    values = list(raw_fields.values())
    used = set()
    found = {}
    for field, aliases in mapping['columns'].items():
        for alias in aliases:
            position = next((index for index, name in enumerate(names)
                             if name == alias and index not in used), None)
            if position is not None:
                found[field] = values[position]
                used.add(position)
                break
    return found


_FORMATS = {'activity_csv': 'activity', 'flex_csv': 'flex'}


def _codes(value):
    return [code for code in re.split(r'[;,\s|]+', upper(value)) if code]


def _asset(mapping, value):
    text = normalize_header(value)
    for asset, aliases in mapping['assetClasses'].items():
        if text in aliases:
            return asset
    return None


def row_key(record, mapping):
    """The capability key a Trades row reads as, from its own raw fields, or None.

    The same reading as js/cost_basis_fop_import.js: the format, the asset
    class and the codes of the row itself (an assignment or exercise code
    makes a FUT row a delivery leg), and a cash-settled or non-positive
    strike option row is the unsupported key. The server never takes the
    row type a package names on trust (plan §9.7).
    """
    prefix = _FORMATS.get(record.get('format'))
    if prefix is None:
        return None
    if prefix == 'activity' and normalize_header(record.get('section')) not in mapping['sections']['trades']:
        return None
    row = row_values(record.get('rawFields') or {}, mapping)
    asset = _asset(mapping, row.get('assetClass'))
    if asset not in ('FUT', 'FOP'):
        return None
    if asset == 'FOP':
        if normalize_header(row.get('settlement')) in mapping['cashSettlement']:
            return f'{prefix}/trades/FOP.cash_settled/any'
        strike = number(row.get('strike'))
        if strike is not None and strike <= 0:
            return f'{prefix}/trades/FOP.nonpositive_strike/any'
    codes = _codes(row.get('codes'))
    known = mapping['codes']
    event = 'trade'
    if known['assignment'] in codes:
        event = 'assignment' if asset == 'FOP' else 'delivery_leg'
    elif known['exercise'] in codes:
        event = 'exercise' if asset == 'FOP' else 'delivery_leg'
    elif known['expiry'] in codes and asset == 'FOP':
        event = 'expiry'
    return f'{prefix}/trades/{asset}/{event}'


# ----------------------------------------------------------------------
# Capability statuses and manual claims (plan §9.7)
# ----------------------------------------------------------------------

def check_statement_rows(package, capabilities, *, contract_for, exchange_zone):
    """Every statement row of an import package against its capability status.

    contract_for(ref) resolves a contractRef of the package or the ledger;
    exchange_zone is the product's exchange timezone, which a row with only
    an exchange trade date is read in. The key a row is sent under must be
    the key its raw fields read as. A synthetic_only row is accepted only as
    the source of manual events that match it (a claim); any other status
    but real_verified refuses the batch.
    """
    uses = {}
    for event in package['events']:
        for allocation in event['sources']:
            uses.setdefault((allocation['namespace'], allocation['sourceRef']), []).append(
                (event, allocation))
    for record in package['sourceRecords']:
        if record['namespace'] not in domain.STATEMENT_NAMESPACES:
            continue
        reference = f'{record["namespace"]}:{record["sourceRef"]}'
        key = record['capabilityKey']
        status = capabilities.status_of(key) if key else None
        if status is None:
            raise domain.FopDomainError(
                'invalid_request', f'statement row {reference} names no known row type ({key})')
        if status == 'out_of_scope':
            raise domain.FopDomainError(
                'invalid_request', f'statement row {reference} is {key}, which is out of scope and never '
                'imported (plan §6.3)')
        derived = row_key(record, capabilities.mapping)
        if status == 'unsupported' or capabilities.status_of(derived) == 'unsupported':
            raise domain.FopDomainError(
                'fop_unsupported_row', f'statement row {reference} is {derived or key}, which the first '
                'release does not support; the batch stays blocked and the row cannot be claimed '
                '(plan §1.2, §9.7)')
        if derived != key:
            raise domain.FopDomainError(
                'invalid_request', f'statement row {reference} is sent as {key}, but its own fields read '
                f'as {derived or "no Trades row of this ledger"} (plan §9.7)')
        if status == 'real_verified':
            continue
        for event, allocation in uses.get((record['namespace'], record['sourceRef']), []):
            if event['source'] != 'manual':
                raise domain.FopDomainError(
                    'fop_capability_not_verified',
                    f'statement row {reference} is {key}, which has no real-statement acceptance yet; '
                    'import it only as a manually verified event that claims the row (plan §9.7)')
            mismatches = claim_mismatches(key, record, event, allocation, contract_for,
                                          capabilities.mapping, exchange_zone=exchange_zone)
            if mismatches:
                raise domain.FopDomainError(
                    'fop_capability_not_verified',
                    f'the manual event does not match statement row {reference}: '
                    + ', '.join(mismatches))


def claim_mismatches(key, record, event, allocation, contract_for, mapping, *, exchange_zone):
    """What a claiming manual event states differently from its row (empty when it matches)."""
    parts = key.split('/')
    asset, row_event = parts[2], parts[3]
    kinds, role = _CLAIMS.get((asset, row_event), (set(), None))
    row = row_values(record['rawFields'], mapping)
    mismatches = []
    if event['kind'] not in kinds:
        mismatches.append(f'kind ({event["kind"]}, the row is {asset} {row_event})')
    if allocation['role'] != role:
        mismatches.append(f'role ({allocation["role"]}, the row is the {role})')
    reference = event.get('deliveredContractRef') if row_event == 'delivery_leg' else event.get('contractRef')
    contract = contract_for(reference) if reference else None
    symbol = upper(row.get('symbol'))
    if contract is None:
        mismatches.append('contract (none)')
    else:
        if symbol and contract.get('localSymbol') and symbol != upper(contract['localSymbol']):
            mismatches.append(f'contract ({contract["localSymbol"]}, the row is {symbol})')
        con_id = number(row.get('conId'))
        if con_id and contract.get('conId') and int(con_id) != int(contract['conId']):
            mismatches.append(f'conId ({contract["conId"]}, the row is {int(con_id)})')
    quantity = number(row.get('quantity'))
    stated = event.get('futureContracts') if (asset == 'FUT') else event.get('contracts')
    if quantity is None or stated is None or abs(float(stated) - quantity) > 1e-9:
        mismatches.append(f'quantity ({stated}, the row is {row.get("quantity")})')
    elif abs(abs(quantity) - float(allocation['quantity'] or 0)) > 1e-9:
        mismatches.append(f'allocated quantity ({allocation["quantity"]}, the row is {abs(quantity):g})')
    if row_event in ('trade', 'delivery_leg'):
        price = number(row.get('price'))
        if price is None or event.get('price') is None \
                or abs(float(event['price']) - price) > _PRICE_TOLERANCE:
            mismatches.append(f'price ({event.get("price")}, the row is {row.get("price")})')
    fees = abs(number(row.get('commission')) or 0.0)
    if abs(float(allocation['fees'] or 0) - fees) > _FEE_TOLERANCE:
        mismatches.append(f'fees ({allocation["fees"]}, the row is {fees:g})')
    mismatches.extend(_time_mismatches(row, event['time'], record.get('format'), exchange_zone))
    return mismatches


def row_day(record, mapping):
    """The date a Trades row states (its local date, else its exchange trade date), or ''."""
    row = row_values(record.get('rawFields') or {}, mapping)
    local = local_timestamp(str(row.get('dateTime') or '').strip())
    if local:
        return local[:10]
    return iso_date(row.get('tradeDate')) or iso_date(row.get('dateTime')) or ''


def same_fill_mismatches(record, event, contract, mapping, future=None):
    """How a row a person named the same fill as a stored trade differs from it (plan §19 P5-C1).

    event: {kind, quantity, days} with days the UTC dates the stored fill's
    time touches; contract: its contract record; future: the contract record
    the ledger binds an option to, or None. The row must read as a trade row
    of the same contract, in the same direction, within a day of the fill,
    with a price and a readable commission, naming no other future than the
    bound one. Its quantity, price, fees and cash may be a part of the fill at
    another granularity: same_fill_total_mismatches adds the rows up.
    """
    problems = []
    key = row_key(record, mapping)
    asset = 'FUT' if event['kind'] == 'futures_trade' else 'FOP'
    parts = (key or '').split('/')
    if len(parts) != 4 or parts[2] != asset or parts[3] != 'trade':
        problems.append(f'row type ({key or "no Trades row"}; the stored fill is a {asset} trade)')
    row = row_values(record.get('rawFields') or {}, mapping)
    symbol = upper(row.get('symbol'))
    con_id = number(row.get('conId'))
    if not symbol and not con_id:
        problems.append('contract (the row names none)')
    if symbol and contract.get('localSymbol') and symbol != upper(contract['localSymbol']):
        problems.append(f'contract ({contract["localSymbol"]} stored, the row is {symbol})')
    if con_id and contract.get('conId') and int(con_id) != int(contract['conId']):
        problems.append(f'conId ({contract["conId"]} stored, the row is {int(con_id)})')
    quantity = number(row.get('quantity'))
    if not quantity or (quantity > 0) != (event['quantity'] > 0):
        problems.append(f'direction ({event["quantity"]:g} stored, the row is {row.get("quantity")})')
    day = row_day(record, mapping)
    if not day:
        problems.append('day (the row has none)')
    else:
        stated = date.fromisoformat(day)
        if not any(abs((stated - date.fromisoformat(other)).days) <= 1 for other in event['days']):
            problems.append(f'day ({day}; the stored fill is on {", ".join(sorted(event["days"]))})')
    if number(row.get('price')) is None:
        problems.append(f'price (the row states {row.get("price")!r})')
    if number(row.get('commission')) is None and str(row.get('commission') or '').strip():
        problems.append(f'fees (the row states {row.get("commission")!r})')
    if future is not None:
        # The same reading as bindingDifference in js/cost_basis_fop_import.js.
        underlying = upper(row.get('underlyingSymbol'))
        underlying_con_id = number(row.get('underlyingConId'))
        option = contract.get('localSymbol') or contract['contractId']
        if _FUT_SYMBOL.match(underlying) and future.get('localSymbol') \
                and underlying != upper(future['localSymbol']):
            problems.append(f'underlying future ({option} is bound to {future["localSymbol"]}, the row names '
                            f'{underlying})')
        elif underlying_con_id and future.get('conId') and int(underlying_con_id) != int(future['conId']):
            problems.append(f'underlying future ({option} is bound to conId {future["conId"]}, the row names '
                            f'{int(underlying_con_id)})')
    return problems


def open_close_of(codes):
    """The open/close intent a row's codes state: O, C, CO or None (openCloseOf in the importer)."""
    stated = set(codes)
    if {'O', 'C'} <= stated:
        return 'CO'
    return 'C' if 'C' in stated else ('O' if 'O' in stated else None)


def same_fill_worth(record, kind, contract, mapping):
    """What a row named the same fill is worth, read as js/cost_basis_fop_import.js reads it.

    {quantity (signed), price, fees, cash, openClose, tradeDate}: fees are the
    commission's size; a FUT row's cash is minus its fees, an option row's its
    proceeds plus commission (or minus quantity x multiplier x price minus
    fees when it states no proceeds); tradeDate is a Flex exchange trade date.
    """
    row = row_values(record.get('rawFields') or {}, mapping)
    quantity = number(row.get('quantity')) or 0.0
    price = number(row.get('price')) or 0.0
    commission = number(row.get('commission')) or 0.0
    fees = abs(commission)
    if kind == 'futures_trade':
        cash = -fees
    else:
        proceeds = number(row.get('proceeds'))
        cash = (-quantity * float(contract['premiumMultiplier']) * price - fees) if proceeds is None \
            else proceeds + commission
    return {'quantity': quantity, 'price': price, 'fees': fees, 'cash': cash,
            'openClose': open_close_of(_codes(row.get('codes'))),
            'tradeDate': iso_date(row.get('tradeDate')) if record.get('format') == 'flex_csv' else ''}


def _amount(value):
    return f'{round(value, 6):.6f}'.rstrip('0').rstrip('.')


def same_fill_total_mismatches(stored, rows):
    """How the rows named the same fill differ, added up, from the stored fill (plan §19 P5-C1).

    stored: {quantity (signed), price, fees, cash, openClose, exchangeTradeDate}
    of the fill; rows: same_fill_worth of each row. They must add up to its
    quantity, then to its average price, fees and cash; the intents they
    state together must be its intent, and the exchange trade dates they
    state must be its date, where the fill states one.
    """
    problems = []
    quantity = sum(row['quantity'] for row in rows)
    if abs(abs(quantity) - abs(stored['quantity'])) > 1e-9:
        return [f'quantity ({abs(stored["quantity"]):g} stored, {abs(quantity):g} in the rows named the same fill)']
    average = sum(row['quantity'] * row['price'] for row in rows) / quantity
    if stored['price'] is None or abs(average - float(stored['price'])) > _PRICE_TOLERANCE:
        problems.append(f'average price ({_amount(stored["price"] or 0)} stored, {_amount(average)} in the rows '
                        'named the same fill)')
    for name in ('fees', 'cash'):
        total = sum(row[name] for row in rows)
        if abs(total - float(stored[name] or 0)) > _FEE_TOLERANCE:
            problems.append(f'{name} ({_amount(float(stored[name] or 0))} stored, {_amount(total)} in the rows '
                            'named the same fill)')
    intents = [row['openClose'] for row in rows if row['openClose']]
    intent = open_close_of([code for stated in intents for code in stated]) if intents else None
    if intent and stored['openClose'] and intent != stored['openClose']:
        problems.append(f'open/close ({stored["openClose"]} stored, {intent} in the rows named the same fill)')
    dates = {row['tradeDate'] for row in rows if row['tradeDate']}
    if dates and stored['exchangeTradeDate'] and dates != {stored['exchangeTradeDate']}:
        other = sorted(dates - {stored['exchangeTradeDate']})
        problems.append(f'exchange trade date ({stored["exchangeTradeDate"]} stored, {", ".join(other)} in the '
                        'rows named the same fill)')
    return problems


def _time_mismatches(row, time, source_format, exchange_zone):
    """How an event's time facts differ from what its row says (plan §9.2).

    A row with a time of day is that instant (or both readings of a repeated
    local time) in the stated zone. A row with only a date is a range the
    server works out itself: a Flex exchange trade date covers the evening
    session before it in the exchange timezone, a calendar date its own day
    in the stated zone. The event may never narrow or move it.
    """
    text = str(row.get('dateTime') or '').strip()
    local = local_timestamp(text)
    trade_date = iso_date(row.get('tradeDate')) if source_format == 'flex_csv' else ''
    if trade_date and time.get('exchangeTradeDate') != trade_date:
        return [f'exchange trade date ({time.get("exchangeTradeDate")}, the row is {trade_date})']
    if not local:
        date = trade_date or iso_date(text)
        if not date:
            return ['time (the row has none)']
        stated_text = text or str(row.get('tradeDate') or '').strip()
        if (time.get('sourceTimeText') or '').strip() != stated_text:
            return [f'time text ({time.get("sourceTimeText")}, the row is {stated_text})']
        zone = exchange_zone if trade_date else time.get('sourceTimezone') or ''
        if trade_date and time.get('sourceTimezone') != exchange_zone:
            return [f'timezone ({time.get("sourceTimezone")}; an exchange trade date is read in {exchange_zone})']
        expected = day_range(date, zone, 1 if trade_date else 0)
        if 'error' in expected:
            return [f'time ({expected["error"]})']
        stated = time.get('timeRange') or {}
        if time.get('executedAtUtc') is not None \
                or [stated.get('startUtc'), stated.get('endUtc')] != expected['range']:
            return [f'time range ({time.get("executedAtUtc") or stated}, the row covers {expected["range"]})']
        return []
    if (time.get('sourceTimeText') or '').strip() != text:
        return [f'time text ({time.get("sourceTimeText")}, the row is {text})']
    converted = local_to_utc(local, time.get('sourceTimezone') or '')
    if 'error' in converted:
        return [f'time ({converted["error"]})']
    if 'instant' in converted:
        if time.get('executedAtUtc') != converted['instant']:
            return [f'time ({time.get("executedAtUtc")}, the row is {converted["instant"]} in '
                    f'{time.get("sourceTimezone")})']
        return []
    stated = time.get('timeRange') or {}
    if [stated.get('startUtc'), stated.get('endUtc')] != converted['range']:
        return [f'time range ({stated}, the row is {converted["range"]})']
    return []


# ----------------------------------------------------------------------
# Statement evidence for a binding (plan §4.3)
# ----------------------------------------------------------------------

def _month_from_symbol_agrees(symbol, month):
    match = _FUT_SYMBOL.match(upper(symbol))
    if not match or len(month or '') != 6:
        return False
    code, year = match.group(2), match.group(3)
    return _MONTH_CODES[code] == month[4:] and month[:4].endswith(year)


def binding_evidence_problems(evidence, option, future, mapping):
    """Why statement rows do not prove option -> future (empty when they do).

    The rows must name the option (its local symbol or conId) with terms that
    agree with the record, name its underlying future (local symbol or
    conId), and show that future's delivery month: a delivery-month field or
    a local symbol whose month code and year agree with it. The same day and
    quantity is never a binding (plan §4.3).
    """
    problems = []
    if option.get('secType') != 'FOP' or future.get('secType') != 'FUT':
        return ['a binding binds a FOP to a FUT']
    rows = [(item.get('role'), row_values(item.get('rawFields') or {}, mapping))
            for item in evidence.get('rows') or []]
    option_rows = [row for role, row in rows if role in ('option', 'option_instrument')]
    future_rows = [row for role, row in rows if role in ('future', 'future_instrument')]

    def names(row, record):
        con_id = number(row.get('conId'))
        return (upper(row.get('symbol')) == upper(record.get('localSymbol'))
                or bool(con_id and record.get('conId') and int(con_id) == int(record['conId'])))

    named = [row for row in option_rows if names(row, option)]
    if not named:
        problems.append(f'no row names the option {option.get("localSymbol")}')
    for row in named:
        strike = number(row.get('strike'))
        if strike is not None and abs(strike - float(option['optionStrike'])) > _PRICE_TOLERANCE:
            problems.append(f'a row gives the strike as {strike}')
        right = upper(row.get('right'))[:1]
        if right in ('C', 'P') and right != option['optionRight']:
            problems.append(f'a row gives the right as {right}')
        expiry = iso_date(row.get('expiry'))
        if expiry and expiry != option['optionExpiry']:
            problems.append(f'a row gives the expiry as {expiry}')

    def underlying(row):
        con_id = number(row.get('underlyingConId'))
        if con_id and future.get('conId') and int(con_id) == int(future['conId']):
            return True
        return upper(row.get('underlyingSymbol')) == upper(future.get('localSymbol'))

    if not any(underlying(row) for row in named):
        problems.append(f'no row names {future.get("localSymbol")} as the option\'s underlying future')
    month = future['futureContractMonth']
    shown = False
    for row in future_rows:
        if not names(row, future):
            continue
        digits = re.sub(r'[^0-9]', '', str(row.get('deliveryMonth') or ''))
        if len(digits) == 6:
            if digits != month:
                problems.append(f'a row gives the delivery month of {future.get("localSymbol")} as {digits}')
            shown = True
        elif _month_from_symbol_agrees(row.get('symbol'), month):
            shown = True
    if not shown:
        problems.append(f'no row shows the delivery month {month} of {future.get("localSymbol")}')
    return problems
