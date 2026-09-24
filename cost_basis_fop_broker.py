"""Read-only FOP contract resolution for the standalone FOP ledger.

CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §4.2, §4.3, §10.1, §10.2. The
servers inject contract_details(query) -> list of details dicts (ib_server
wraps reqContractDetails; historical_server has none and reports the
capability as unavailable). Nothing here writes the ledger, places an order,
exercises or subscribes to market data.

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
import re

MAX_QUERIES = 20
MAX_CONCURRENCY = 4
TIMEOUT_SECONDS = 10.0

_DATE8 = re.compile(r'^(\d{4})(\d{2})(\d{2})')
_MONTH6 = re.compile(r'^\d{6}$')


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
