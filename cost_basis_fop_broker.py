"""Read-only FOP contract resolution for the standalone FOP ledger.

CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §4.2, §4.3, §10.1, §10.2. The
servers inject contract_details(query) -> list of details dicts (ib_server
wraps reqContractDetails; historical_server has none and reports the
capability as unavailable). Nothing here writes the ledger, places an order,
exercises or subscribes to market data.

It also takes one-shot quotes for a ledger's own contracts (snapshot_fop_quotes)
and reports each contract's evidence as the broker gave it; the page decides
how to value it (plan §10.3). position_evidence keeps the TWS positions of
one ledger's account and root; the page reconciles them (plan §19 P5-C3).

A FOP is resolved by its own contract details, then its underlying FUT by the
option's underConId, and the delivery month is that FUT's
ContractDetails.contractMonth. It is never derived from a last-trade date, an
option expiry, a front month or a pool selection (plan §4.1, §4.3): without
contractMonth the pair stays unresolved. Only a fully resolved pair whose
broker terms agree with the ledger's gets a credential, which the store checks
when a verified_broker binding is written.

Details dicts use IB's field names: conId, secType, symbol, tradingClass,
localSymbol, exchange, currency, right, strike, lastTradeDateOrContractMonth,
multiplier, underConId, contractMonth.
"""
import asyncio
import math
import re
from datetime import datetime, timezone

MAX_QUERIES = 20
MAX_CONCURRENCY = 4
TIMEOUT_SECONDS = 10.0

_DATE8 = re.compile(r'^(\d{4})(\d{2})(\d{2})')
_MONTH6 = re.compile(r'^\d{6}$')
_ISO_DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
_UTC_INSTANT = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$')


class BrokerResolutionError(Exception):
    """A request the resolver refuses outright (too many queries, bad shape)."""

    code = 'invalid_request'


def _iso_date(value):
    match = _DATE8.match(str(value or ''))
    return f'{match.group(1)}-{match.group(2)}-{match.group(3)}' if match else None


def _number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return int(number) if number.is_integer() else number


def _differences(expected, actual, fields):
    return sorted(field for field in fields
                  if expected.get(field) is not None and actual.get(field) is not None
                  and expected[field] != actual[field])


async def _details(contract_details, query, semaphore):
    async with semaphore:
        try:
            result = await asyncio.wait_for(contract_details(query), timeout=TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            return None, 'timeout'
        except Exception as exc:  # the broker's own error, reported per query
            return None, f'broker_error: {exc}'
    return list(result or []), None


async def resolve_fop_contracts(store, book, queries, *, contract_details, observed_at):
    """Resolve up to MAX_QUERIES option contracts of one FOP ledger.

    queries: option ContractRecords (secType FOP) as the ledger or an import
    preview holds them. Returns one result per query: status verified_broker
    with option and future candidate records, the evidence summary and a
    credential; or unresolved / conflict with the reasons and no credential.
    """
    if not isinstance(queries, list) or not queries:
        raise BrokerResolutionError('contracts must be a non-empty list')
    if len(queries) > MAX_QUERIES:
        raise BrokerResolutionError(f'resolve at most {MAX_QUERIES} contracts per request')
    semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
    return await asyncio.gather(*(
        _resolve_one(store, book, query, contract_details, semaphore, observed_at)
        for query in queries))


async def _resolve_one(store, book, query, contract_details, semaphore, observed_at):
    result = {'contractId': query.get('contractId'), 'status': 'unresolved', 'option': None,
              'future': None, 'evidenceSummary': '', 'evidenceCredential': None, 'problems': []}
    if query.get('secType') != 'FOP':
        result['problems'].append('only option contracts are resolved')
        return result
    if query.get('conId'):
        lookup = {'conId': query['conId']}
    else:
        lookup = {'secType': 'FOP', 'symbol': query.get('root'),
                  'tradingClass': query.get('tradingClass'), 'right': query.get('optionRight'),
                  'strike': query.get('optionStrike'), 'exchange': query.get('exchange'),
                  'currency': query.get('currency'),
                  'lastTradeDateOrContractMonth': str(query.get('optionExpiry') or '').replace('-', '')}
    options, error = await _details(contract_details, lookup, semaphore)
    if error:
        result['problems'].append(error)
        return result
    if not options:
        result['problems'].append('not_found')
        return result
    if len(options) > 1:
        result['problems'].append('ambiguous: ' + ', '.join(str(d.get('conId')) for d in options))
        return result
    detail = options[0]
    option = {
        **{key: query.get(key) for key in ('contractId', 'revision', 'ruleVersion')},
        'secType': 'FOP', 'conId': _number(detail.get('conId')), 'root': detail.get('symbol'),
        'tradingClass': detail.get('tradingClass'), 'localSymbol': detail.get('localSymbol'),
        'exchange': detail.get('exchange'), 'currency': detail.get('currency'),
        'optionRight': detail.get('right'), 'optionStrike': _number(detail.get('strike')),
        'optionExpiry': _iso_date(detail.get('lastTradeDateOrContractMonth')),
        'optionExpiryAsOf': query.get('optionExpiryAsOf'),
        'premiumMultiplier': _number(detail.get('multiplier')),
        'deliverableFuturesPerOption': query.get('deliverableFuturesPerOption'),
        'settlementType': query.get('settlementType'), 'exerciseStyle': query.get('exerciseStyle'),
        'evidenceStatus': 'verified_broker', 'evidenceSummary': 'IB contract details',
        'observedAtUtc': observed_at,
    }
    conflicts = _differences(query, option, (
        'conId', 'root', 'tradingClass', 'localSymbol', 'exchange', 'currency', 'optionRight',
        'optionStrike', 'optionExpiry', 'premiumMultiplier'))
    if option['root'] != book['symbol']:
        conflicts.append('root')
    if conflicts:
        result.update(status='conflict', option=option)
        result['problems'].append('the broker terms differ in ' + ', '.join(sorted(set(conflicts))))
        return result
    under_con_id = _number(detail.get('underConId'))
    if not under_con_id:
        result.update(option=option)
        result['problems'].append('no_underlying: the option details carry no underConId')
        return result
    futures, error = await _details(contract_details, {'conId': under_con_id}, semaphore)
    if error:
        result.update(option=option)
        result['problems'].append(error)
        return result
    if len(futures or []) != 1 or futures[0].get('secType') != 'FUT':
        result.update(option=option)
        result['problems'].append(f'underConId {under_con_id} is not exactly one FUT')
        return result
    fut = futures[0]
    month = str(fut.get('contractMonth') or '')
    if not _MONTH6.match(month):
        # Never guess the delivery month from a last-trade date (plan §4.1).
        result.update(option=option)
        result['problems'].append('contract_month_missing: the FUT details carry no contractMonth')
        return result
    future = {
        'contractId': None, 'revision': None, 'secType': 'FUT',
        'conId': _number(fut.get('conId')), 'root': fut.get('symbol'),
        'tradingClass': fut.get('tradingClass'), 'localSymbol': fut.get('localSymbol'),
        'exchange': fut.get('exchange'), 'currency': fut.get('currency'),
        'futureContractMonth': month,
        'futureLastTradeDate': _iso_date(fut.get('lastTradeDateOrContractMonth')),
        'futureLastTradeAsOf': None, 'futurePointValue': _number(fut.get('multiplier')),
        'ruleVersion': query.get('ruleVersion'), 'evidenceStatus': 'verified_broker',
        'evidenceSummary': 'IB contract details via underConId', 'observedAtUtc': observed_at,
    }
    mismatch = [field for field in ('root', 'exchange', 'currency')
                if future[field] != option[field]]
    if mismatch:
        result.update(status='conflict', option=option, future=future)
        result['problems'].append('the underlying differs from the option in ' + ', '.join(mismatch))
        return result
    evidence = {'optionConId': option['conId'], 'underConId': under_con_id,
                'contractMonth': month,
                'lastTradeDateOrContractMonth': str(fut.get('lastTradeDateOrContractMonth') or ''),
                'observedAtUtc': observed_at}
    summary = (f'IB: {option["localSymbol"] or option["conId"]} -> underConId {under_con_id} '
               f'{future["localSymbol"] or ""} contractMonth {month}').strip()
    result.update(status='verified_broker', option=option, future=future, evidenceSummary=summary)
    result['evidenceCredential'] = store.issue_binding_credential(
        book['bookId'], status='verified_broker', option=option, future=future, evidence=evidence)
    return result


# ----------------------------------------------------------------------
# One-shot quotes (plan §10.2, §10.3)
# ----------------------------------------------------------------------

MAX_QUOTE_CONTRACTS = 40
QUOTE_TIMEOUT_SECONDS = 20.0
_QUOTE_FIELDS = ('bid', 'bidSize', 'ask', 'askSize', 'last', 'lastSize', 'close', 'closeDate',
                 'settlement', 'settlementDate', 'observedAtUtc', 'marketDataType')


def quote_query(record):
    """What the servers' snapshot adapter is asked for one stored contract.

    The terms come from the ledger's own record, never from the page: a conId
    when the record has one, else the full identity (a FUT by its delivery
    month, a FOP by class, right, strike and expiry).
    """
    query = {'contractId': record['contractId'], 'secType': record['secType'],
             'conId': record.get('conId'), 'symbol': record['root'],
             'exchange': record['exchange'], 'currency': record['currency'],
             'tradingClass': record.get('tradingClass'), 'localSymbol': record.get('localSymbol')}
    if record['secType'] == 'FUT':
        query['contractMonth'] = record['futureContractMonth']
    else:
        query.update(right=record['optionRight'], strike=record['optionStrike'],
                     expiry=str(record['optionExpiry'] or '').replace('-', ''))
    return query


def _finite(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _price(value, size, sec_type):
    """A quoted price, or None for no value.

    NaN is no value. IB's -1 is a sentinel for "no quote" unless a size says a
    real order stands there: a FUT may trade at -1 (CL did in 2020), an
    option price is never negative (plan §6.4, §10.3).
    """
    price = _finite(value)
    if price is None:
        return None
    if price < 0 and sec_type == 'FOP':
        return None
    if price == -1 and not ((_finite(size) or 0) > 0):
        return None
    return price


def quote_evidence(query, raw):
    """One contract's quote evidence from the adapter's raw answer (plan §10.3).

    The server only reports what the broker said: prices with their sizes,
    the prior close and settlement with their dates when the source gives
    them, the time the quote was observed and its market data type. The
    valuation order (mid, one-sided, reference, unavailable) is the page's.
    """
    result = {'contractId': query['contractId'], 'conId': query.get('conId'),
              'localSymbol': query.get('localSymbol'), 'status': 'no_data', 'reason': None}
    result.update({field: None for field in _QUOTE_FIELDS})
    if raw is None:
        result['reason'] = 'the broker returned nothing for this contract'
        return result
    if raw.get('error'):
        result.update(status='failed', reason=str(raw['error'])[:200])
        return result
    identity = []
    for field in ('conId', 'localSymbol'):
        stated, seen = query.get(field), raw.get(field)
        if stated not in (None, '') and seen not in (None, '') and str(stated) != str(seen):
            identity.append(f'{field} {seen}, the ledger says {stated}')
    if raw.get('secType') and raw['secType'] != query['secType']:
        identity.append(f'secType {raw["secType"]}')
    if identity:
        result.update(status='identity_conflict', reason='; '.join(identity))
        return result
    sec_type = query['secType']
    result['conId'] = raw.get('conId') or query.get('conId')
    result['localSymbol'] = raw.get('localSymbol') or query.get('localSymbol')
    for price, size in (('bid', 'bidSize'), ('ask', 'askSize'), ('last', 'lastSize')):
        result[size] = _finite(raw.get(size))
        result[price] = _price(raw.get(price), raw.get(size), sec_type)
    for price, date in (('close', 'closeDate'), ('settlement', 'settlementDate')):
        value = _finite(raw.get(price))
        if value is not None and (sec_type != 'FOP' or value >= 0):
            result[price] = value
            result[date] = raw.get(date) if _ISO_DATE.match(str(raw.get(date) or '')) else None
    observed = str(raw.get('observedAtUtc') or '')
    result['observedAtUtc'] = observed if _UTC_INSTANT.match(observed) else None
    data_type = raw.get('marketDataType')
    result['marketDataType'] = data_type if isinstance(data_type, int) and not isinstance(data_type, bool) \
        else None
    if any(result[field] is not None for field in ('bid', 'ask', 'last', 'close', 'settlement')):
        result['status'] = 'ok'
    else:
        result['reason'] = 'the broker gave no usable price'
    return result


async def snapshot_fop_quotes(scope, contract_ids, *, market_snapshot, observed_at, batch_id):
    """One quote batch for contracts of one FOP ledger (plan §10.2, §10.3).

    scope is the store's fop_quote_scope(bookId): the ledger's current
    contract records and version. contract_ids names which of them to quote
    (the page asks for what is open); an id the ledger does not hold refuses
    the request. market_snapshot(queries) is the server's one-shot adapter
    (ib_server; the historical server has none). The answer carries the
    ledger version it was taken against, so the page drops a batch that no
    longer belongs to what it shows. Nothing is written or subscribed.
    """
    if not isinstance(contract_ids, list) or not contract_ids:
        raise BrokerResolutionError('contractIds must be a non-empty list')
    if len(contract_ids) > MAX_QUOTE_CONTRACTS:
        raise BrokerResolutionError(f'quote at most {MAX_QUOTE_CONTRACTS} contracts per batch')
    if len(set(contract_ids)) != len(contract_ids):
        raise BrokerResolutionError('contractIds names a contract twice')
    records = {record['contractId']: record for record in scope['contracts']}
    unknown = [contract_id for contract_id in contract_ids if contract_id not in records]
    if unknown:
        raise BrokerResolutionError(f'this ledger holds no contract {", ".join(map(str, unknown))}')
    queries = [quote_query(records[contract_id]) for contract_id in contract_ids]
    try:
        raw = await asyncio.wait_for(market_snapshot(queries), timeout=QUOTE_TIMEOUT_SECONDS)
        failure = None
    except asyncio.TimeoutError:
        raw, failure = [], 'timeout'
    except Exception as exc:  # the broker's own error, reported per contract
        raw, failure = [], f'broker_error: {exc}'
    by_id = {}
    for item in raw or []:
        if isinstance(item, dict) and item.get('contractId') in records:
            by_id.setdefault(item['contractId'], item)
    quotes = []
    for query in queries:
        answer = by_id.get(query['contractId'])
        if failure and answer is None:
            answer = {'error': failure}
        quotes.append(quote_evidence(query, answer))
    return {'quoteBatchId': batch_id, 'requestedAtUtc': observed_at,
            'ledgerVersion': scope['ledgerVersion'], 'quotes': quotes}


def ticker_quote(contract_id, contract, ticker):
    """The adapter's raw answer for one contract, from an IB ticker (pure; tested with stubs).

    ticker.time is when this server received the ticks, the only sampling
    time a snapshot carries; IB's close tick states no date, so it goes out
    without one and the page cannot use it as a dated reference.
    """
    def value(name):
        return getattr(ticker, name, None)

    observed = value('time')
    if isinstance(observed, datetime):
        if observed.tzinfo is None:
            observed = observed.replace(tzinfo=timezone.utc)
        observed = observed.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    else:
        observed = None
    con_id = getattr(contract, 'conId', None)
    return {'contractId': contract_id, 'conId': int(con_id) if con_id else None,
            'localSymbol': getattr(contract, 'localSymbol', None) or None,
            'secType': getattr(contract, 'secType', None) or None,
            'bid': value('bid'), 'bidSize': value('bidSize'), 'ask': value('ask'), 'askSize': value('askSize'),
            'last': value('last'), 'lastSize': value('lastSize'), 'close': value('close'), 'closeDate': None,
            'settlement': None, 'settlementDate': None, 'observedAtUtc': observed,
            'marketDataType': value('marketDataType')}


# ----------------------------------------------------------------------
# TWS positions of one ledger's account (plan §10.3, §19 P5-C3)
# ----------------------------------------------------------------------

def _right(value):
    text = str(value or '').strip().upper()
    return text[:1] if text[:1] in ('C', 'P') else None


def position_evidence(book, snapshot):
    """(accountConnected, positionsReady, positions) of one ledger, as TWS reported them.

    snapshot: {connected, ready, accounts, items} read from the server's
    authoritative position set; items carry ib_server's serialized fields
    (account, conId, secType, symbol, localSymbol, tradingClass, expDate,
    right, strike, multiplier, position, averageCost). Only this account's
    FUT and FOP positions of the ledger's root are kept: another account or
    another root (MCL is not CL) never reaches the page. The account must be
    one TWS manages, and the positions must be read, or nothing is kept.
    Nothing is matched to a ledger contract here and IB's averageCost is
    kept as reported (per contract, multiplier included).
    """
    account = book['account']
    accounts = {str(item or '').strip() for item in snapshot.get('accounts') or ()}
    connected = bool(snapshot.get('connected')) and account in accounts
    ready = connected and bool(snapshot.get('ready'))
    positions = []
    if not ready:
        return connected, ready, positions
    for item in snapshot.get('items') or ():
        if str(item.get('account') or '').strip() != account:
            continue
        sec_type = str(item.get('secType') or '').strip().upper()
        if sec_type not in ('FUT', 'FOP') or str(item.get('symbol') or '').strip().upper() != book['symbol']:
            continue
        position = _number(item.get('position'))
        if not position:
            continue
        con_id = _number(item.get('conId'))
        positions.append({
            'account': account, 'conId': int(con_id) if con_id else None, 'secType': sec_type,
            'symbol': book['symbol'], 'localSymbol': str(item.get('localSymbol') or '').strip() or None,
            'tradingClass': str(item.get('tradingClass') or '').strip() or None,
            'lastTradeDateOrContractMonth': str(item.get('lastTradeDateOrContractMonth')
                                                or item.get('expDate') or '').strip() or None,
            'right': _right(item.get('right')) if sec_type == 'FOP' else None,
            'strike': _number(item.get('strike')) if sec_type == 'FOP' else None,
            'multiplier': _number(item.get('multiplier')) or None,
            'currency': str(item.get('currency') or '').strip() or None,
            'position': position, 'averageCost': _number(item.get('averageCost')),
        })
    positions.sort(key=lambda item: (item['secType'] != 'FUT', item['localSymbol'] or '', item['conId'] or 0))
    return connected, ready, positions
