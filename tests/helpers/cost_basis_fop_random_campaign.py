"""A seeded FOP ledger campaign (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §13.3 P6 step 2, §14.2).

Every seed generates one economic history of CL futures and options on futures
from a list of broker actions (trades, split orders, partial rolls, early
assignments and exercises, expiries at the end), in account-local New York
time and with commissions, negative future prices included. The same history is
also written as a vector of tests/helpers/cost_basis_fop_model.py, the
independent rational model: every expected figure comes from there, never from
production code.

The history then goes through the chain the plan names (§14.2):

- ``vector``: js/cost_basis_fop_core.js replays the vector itself;
- ``preview``: tests/helpers/cost_basis_fop_statements.js (test-only) writes
  the fills as an Activity (English or Chinese) or Flex statement;
  js/cost_basis_fop_import.js reads and plans it without a ledger, exactly as
  the page previews a file, and the core replays the preview;
- ``store`` (store seeds): the page's own requests import the history into a
  temporary SQLite ledger in one to three statements (formats mixed); one of
  them is imported again (nothing new), late fees and adjustments are
  appended by hand, the last trade is voided, and the backup is restored into
  another ledger. After every step the ledger read back is replayed and held
  to the model.

Every figure the core states is compared: totals, the seller lens, the buyer's
options, positions, realized results by contract and cycles, with the
tolerances of §14.2. A failure names the seed, the stage and the action list;
``reduce`` removes actions while the same stage still fails.

Statement rows are synthetic_only (§9.7), so the store stands in for a real
acceptance with cost_basis_fop_test_support.verified_capabilities(). Temporary
databases only; nothing reaches TWS.
"""
import copy
import json
import pathlib
import random
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
for path in (REPO_ROOT, REPO_ROOT / 'tests'):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from cost_basis_fop_test_support import FOP_META, IDENTITY, example_event, token  # noqa: E402
from helpers import cost_basis_fop_model as model  # noqa: E402

ZONE = ZoneInfo('America/New_York')
VECTORS = json.loads((REPO_ROOT / 'tests/fixtures/cost_basis_fop/core_vectors.json').read_text(encoding='utf-8'))
CATALOGUE = dict(VECTORS['catalogue'], C80={
    'secType': 'FOP', 'contractId': 'fop-lof7-c80-01', 'localSymbol': 'LOF7 C8000', 'right': 'C', 'strike': 80,
    'expiry': '2026-12-16', 'future': 'F7', 'conId': 9003})
FUTURES = ('Z6', 'F7', 'G7', 'H7')
OPTIONS = ('C75', 'P65', 'C80')
NEXT_MONTH = {'Z6': 'F7', 'F7': 'G7', 'G7': 'H7'}
SYMBOL = {alias: spec['localSymbol'] for alias, spec in CATALOGUE.items()}
PRICES = {'averagePrice', 'breakEven', 'breakEvenIfOpenShortsExpire'}
START = datetime(2026, 10, 1, 13, 0, tzinfo=timezone.utc)
LAST_TRADE = datetime(2026, 12, 12, 21, 0, tzinfo=timezone.utc)
# The last New York instant a contract trades in the campaign: an option before its expiry day, a
# future before its last trade date (the delivery preview stops past it; plan §12.1).
TRADES_UNTIL = {alias: datetime.strptime(CATALOGUE[alias]['expiry' if alias in OPTIONS else 'lastTrade'],
                                         '%Y-%m-%d').replace(tzinfo=ZONE)
                for alias in FUTURES + OPTIONS}
OBSERVED = '2027-03-01T14:15:00.000000Z'
BOOK = {'bookId': 'fopbook0001', 'account': IDENTITY['account'], 'symbol': 'CL', 'currency': 'USD',
        'fop': dict(FOP_META)}


class CampaignFailure(AssertionError):
    """A seed whose stage disagrees with the model (or refuses a valid history)."""

    def __init__(self, stage, message):
        super().__init__(f'{stage}: {message}')
        self.stage = stage


# ----------------------------------------------------------------------
# Actions -> fills and model events
# ----------------------------------------------------------------------

def local_text(moment):
    return moment.astimezone(ZONE).strftime('%Y-%m-%dT%H:%M:%S')


def utc_text(moment):
    return moment.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def repeated_local(moment):
    """A New York wall time that occurs twice (the autumn hour): its row would name a range."""
    wall = moment.astimezone(ZONE).replace(tzinfo=None)
    return wall.replace(tzinfo=ZONE, fold=0).utcoffset() != wall.replace(tzinfo=ZONE, fold=1).utcoffset()


def intent(position, quantity):
    """The open/close codes a fill of `quantity` prints against `position`."""
    if position == 0 or (position > 0) == (quantity > 0):
        return 'O'
    return 'C' if abs(quantity) <= abs(position) else 'C;O'


def delivery_future_change(alias, closing):
    """The future an assignment (closing > 0, a short) or exercise (closing < 0, a long) moves."""
    right = CATALOGUE[alias]['right']
    if closing > 0:
        return (-1 if right == 'C' else 1) * abs(closing)
    return (1 if right == 'C' else -1) * abs(closing)


def materialize(actions):
    """(fills, events) of an action list, or None when an action no longer fits the positions.

    Fills are statement rows in time order; events are model vector events. A
    delivery is one event of two rows at the same instant; every other row is
    one event. Codes follow the position each row meets.
    """
    futures = {alias: 0 for alias in FUTURES}
    options = {alias: 0 for alias in OPTIONS}
    traded = set()
    fills, events = [], []
    number = 0

    def fill(alias, moment, quantity, price, commission, codes, order=None):
        nonlocal number
        number += 1
        row = {'symbol': SYMBOL[alias], 'local': local_text(moment), 'qty': quantity, 'price': price,
               'commission': -commission if commission else 0, 'codes': codes, 'tradeId': str(1000 + number),
               'utc': utc_text(moment)}
        if order:
            row['orderId'] = order
        fills.append(row)
        return row

    def event(kind, alias, moment, quantity, price, fees):
        item = {'id': f'e{len(events) + 1:03d}', 'at': utc_text(moment), 'kind': kind, 'contract': alias,
                'q': quantity, 'fees': fees}
        if price is not None:
            item['price'] = price
        events.append(item)
        return item

    for action in actions:
        kind, moment = action['kind'], action['at']
        if kind in ('trade', 'order'):
            alias = action['contract']
            book = futures if alias in futures else options
            if alias in options and CATALOGUE[alias]['future'] not in traded:
                return None
            parts = action['parts'] if kind == 'order' else [(0, action['q'], action['price'], action['fees'])]
            for offset, quantity, price, fees in parts:
                at = moment + timedelta(seconds=offset)
                codes = intent(book[alias], quantity)
                fill(alias, at, quantity, price, fees, codes, order=action.get('order'))
                event('futures_trade' if alias in futures else 'option_trade', alias, at, quantity, price, fees)
                book[alias] += quantity
            traded.add(alias)
        elif kind == 'roll':
            old, new = action['contract'], NEXT_MONTH[action['contract']]
            held = futures[old]
            if held == 0 or action['close'] > abs(held):
                return None
            closing = -action['close'] if held > 0 else action['close']
            fill(old, moment, closing, action['closePrice'], action['fees'], intent(held, closing))
            event('futures_trade', old, moment, closing, action['closePrice'], action['fees'])
            futures[old] += closing
            opening = -closing // abs(closing) * action['open']
            later = moment + timedelta(seconds=1)
            fill(new, later, opening, action['openPrice'], action['fees'], intent(futures[new], opening))
            event('futures_trade', new, later, opening, action['openPrice'], action['fees'])
            futures[new] += opening
            traded.update((old, new))
        elif kind in ('deliver', 'expire'):
            alias = action['contract']
            held = options[alias]
            size = abs(held) if kind == 'expire' else action['size']
            if held == 0 or size > abs(held):
                return None
            closing = -size if held > 0 else size
            if kind == 'expire':
                fill(alias, moment, closing, 0, action['fees'], 'Ep')
                event('option_expiry', alias, moment, closing, None, action['fees'])
                options[alias] = 0
                continue
            code = 'A' if closing > 0 else 'Ex'
            future = CATALOGUE[alias]['future']
            change = delivery_future_change(alias, closing)
            fill(alias, moment, closing, 0, action['optionFees'], code)
            fill(future, moment, change, CATALOGUE[alias]['strike'], action['futureFees'], code)
            event('option_assignment' if closing > 0 else 'option_exercise', alias, moment, closing, None,
                  action['optionFees'] + action['futureFees'])
            options[alias] += closing
            futures[future] += change
            traded.add(future)
        else:
            raise ValueError(f'unknown action {kind}')
    return fills, events, {**futures, **options}


def generate(seed, steps):
    """The action list of one seed (plan §14.2: dates, months, partial rolls, fees, deliveries)."""
    rng = random.Random(seed)
    actions = []
    moment = START
    futures = {alias: 0 for alias in FUTURES}
    options = {alias: 0 for alias in OPTIONS}
    traded = set()
    orders = 0

    def money(low, high):
        return round(rng.uniform(low, high), 2)

    def fees(*choices):
        return rng.choice(choices)

    def advance(span=0):
        """The start of the next action, after every second the last one used; it uses `span` more."""
        nonlocal moment
        start = moment + timedelta(seconds=rng.choice([rng.randint(1, 900), rng.randint(900, 60000),
                                                       rng.randint(60000, 260000)]))
        while repeated_local(start) or repeated_local(start + timedelta(seconds=span)):
            start += timedelta(minutes=30)
        moment = start + timedelta(seconds=span)
        return start

    def open_(alias):
        # The clock moves up to about three days after the choice: four days of margin keep the
        # whole action inside the contract's window.
        return moment + timedelta(days=4) < TRADES_UNTIL[alias]

    def future_trade(alias):
        quantity = rng.choice([-3, -2, -1, 1, 2, 3])
        actions.append({'kind': 'trade', 'contract': alias, 'at': advance(), 'q': quantity,
                        'price': money(-5, 90), 'fees': fees(0, 1.25, 2.02, 2.5)})
        futures[alias] += quantity
        traded.add(alias)

    for _step in range(steps):
        if moment > LAST_TRADE:
            break
        choice = rng.random()
        if choice < 0.36:
            tradable = [alias for alias in FUTURES if open_(alias)]
            if tradable:
                future_trade(rng.choice(tradable))
        elif choice < 0.62:
            tradable = [alias for alias in OPTIONS if open_(alias) and open_(CATALOGUE[alias]['future'])]
            if not tradable:
                continue
            alias = rng.choice(tradable)
            if CATALOGUE[alias]['future'] not in traded:
                future_trade(CATALOGUE[alias]['future'])
            quantity = rng.choice([-2, -1, 1, 2])
            actions.append({'kind': 'trade', 'contract': alias, 'at': advance(), 'q': quantity,
                            'price': money(0, 4), 'fees': fees(0, 1.2, 2.5)})
            options[alias] += quantity
            traded.add(alias)
        elif choice < 0.72:
            # One order in two or three executions a few seconds apart.
            tradable = [alias for alias in FUTURES + OPTIONS if open_(alias)
                        and (alias in futures or open_(CATALOGUE[alias]['future']))]
            if not tradable:
                continue
            alias = rng.choice(tradable)
            if alias in options and CATALOGUE[alias]['future'] not in traded:
                future_trade(CATALOGUE[alias]['future'])
            sign = rng.choice([-1, 1])
            parts, offset = [], 0
            for _part in range(rng.randint(2, 3)):
                price = money(-5, 90) if alias in futures else money(0, 4)
                parts.append((offset, sign * rng.randint(1, 2), price, fees(0, 0.85, 1.25)))
                offset += rng.randint(1, 4)
            orders += 1
            actions.append({'kind': 'order', 'contract': alias, 'at': advance(parts[-1][0]), 'parts': parts,
                            'order': f'ord{seed}-{orders}'})
            (futures if alias in futures else options)[alias] += sum(part[1] for part in parts)
            traded.add(alias)
        elif choice < 0.84:
            held = [alias for alias in ('Z6', 'F7', 'G7') if futures[alias] and open_(alias)]
            if not held:
                continue
            alias = rng.choice(held)
            close = rng.randint(1, abs(futures[alias]))
            opening = max(1, close + rng.choice([-1, 0, 0, 1]))
            actions.append({'kind': 'roll', 'contract': alias, 'at': advance(1), 'close': close, 'open': opening,
                            'closePrice': money(40, 90), 'openPrice': money(40, 90), 'fees': fees(0, 2.5)})
            closing = -close if futures[alias] > 0 else close
            futures[alias] += closing
            futures[NEXT_MONTH[alias]] += -closing // close * opening
            traded.update((alias, NEXT_MONTH[alias]))
        else:
            held = [alias for alias in OPTIONS if options[alias] and open_(alias)]
            if not held:
                continue
            alias = rng.choice(held)
            size = rng.randint(1, abs(options[alias]))
            actions.append({'kind': 'deliver', 'contract': alias, 'at': advance(), 'size': size,
                            'optionFees': fees(0, 1.5), 'futureFees': fees(0, 1.25)})
            closing = -size if options[alias] > 0 else size
            options[alias] += closing
            futures[CATALOGUE[alias]['future']] += delivery_future_change(alias, closing)
            traded.add(CATALOGUE[alias]['future'])
    # Some options still open at the end expire on their expiry day (a statement row 'Ep').
    for index, alias in enumerate(OPTIONS):
        if options[alias] and rng.random() < 0.5:
            day = datetime.strptime(CATALOGUE[alias]['expiry'], '%Y-%m-%d')
            at = datetime(day.year, day.month, day.day, 17, 0, index, tzinfo=ZONE).astimezone(timezone.utc)
            actions.append({'kind': 'expire', 'contract': alias, 'at': at, 'fees': fees(0, 0.5)})
            options[alias] = 0
    actions.sort(key=lambda action: action['at'])
    marks = {alias: (money(-5, 90) if alias in FUTURES else money(0, 5))
             for alias in FUTURES + OPTIONS if rng.random() < 0.9}
    shape = {
        'format': rng.choice(['activity', 'activity', 'flex']),
        'chinese': rng.random() < 0.3,
        'bom': rng.random() < 0.2,
        'chunks': rng.choice([1, 2, 2, 3]),
        'formats': [rng.choice(['activity', 'flex']) for _ in range(3)],
        'repeat': rng.random() < 0.8,
        'fees': rng.randint(0, 2),
        'adjust': rng.random() < 0.5,
        'void': rng.random() < 0.6,
        'restore': True,
        'rng': rng.random(),
    }
    return {'seed': seed, 'actions': actions, 'marks': marks, 'shape': shape}


# ----------------------------------------------------------------------
# Statements
# ----------------------------------------------------------------------

def statement_options(kind, fills, positions, shape, *, period=None):
    rows = [{key: value for key, value in fill.items() if key != 'utc'} for fill in fills]
    if kind == 'flex':
        for row in rows:
            local = datetime.strptime(row['local'], '%Y-%m-%dT%H:%M:%S')
            # A CL evening session belongs to the next exchange trade date.
            trade_day = local + timedelta(days=1) if local.hour >= 18 else local
            row['tradeDate'] = trade_day.strftime('%Y-%m-%d')
        return {'fills': rows}
    days = sorted(fill['local'][:10] for fill in fills)
    period = period or {'from': days[0], 'through': days[-1]}
    held = [{'symbol': SYMBOL[alias], 'quantity': quantity} for alias, quantity in sorted(positions.items())
            if quantity]
    underlying = sorted({SYMBOL[CATALOGUE[alias]['future']] for alias in OPTIONS
                         if any(fill['symbol'] == SYMBOL[alias] for fill in fills)})
    for row in rows:
        row.pop('orderId', None)
    orders = {}
    for index, fill in enumerate(fills):
        if fill.get('orderId'):
            orders.setdefault(fill['orderId'], []).append(index)
    return {'period': period, 'fills': rows, 'openPositions': held, 'chinese': shape['chinese'],
            'bom': shape['bom'], 'extraInstruments': underlying,
            'orders': [{'fills': members} for members in orders.values()]}


# ----------------------------------------------------------------------
# Comparison with the model (plan §14.2 tolerances)
# ----------------------------------------------------------------------

def close_to(expected, actual, field):
    if expected is None:
        return actual is None
    tolerance = 1e-9 if field in PRICES else 1e-7
    return actual is not None and abs(float(expected) - actual) <= tolerance


def vector_of(events, marks, extra=()):
    return {'name': 'campaign', 'events': [*events, *extra], 'marks': marks, 'contracts': CATALOGUE,
            'expect': {}}


def expected_figures(vector):
    return model.ledger(vector, marks=vector.get('marks'))


def compare(expected, output, symbol_of, label):
    """Problems between the model and one core output; contracts go by local symbol."""
    problems = []

    def check(value, metric, field, name):
        actual = metric['value'] if isinstance(metric, dict) else metric
        if not close_to(value, actual, field):
            problems.append(f'{name}: core {metric} != model {value if value is None else float(value)}')

    for field, value in expected['totals'].items():
        check(value, output['totals'][field], field, f'totals.{field}')
    for field in ('Rs', 'Es', 'Js', 'breakEven', 'breakEvenIfOpenShortsExpire'):
        check(expected['sellerLens'][field], output['sellerLens'][field], field, f'sellerLens.{field}')
    if output['sellerLens']['longExerciseAffectsBreakEven'] != expected['sellerLens']['longExerciseAffectsBreakEven']:
        problems.append('sellerLens.longExerciseAffectsBreakEven')
    for field, value in expected['buyer'].items():
        check(value, output['buyerOptions'][field], field, f'buyerOptions.{field}')
    rows = {symbol_of[row['contractId']]: row for row in output['futures'] + output['options']}
    wanted = {SYMBOL[alias]: fields for alias, fields in expected['positions'].items()}
    if sorted(rows) != sorted(wanted):
        problems.append(f'open contracts: core {sorted(rows)} != model {sorted(wanted)}')
    for symbol, fields in wanted.items():
        for field, value in fields.items():
            if symbol in rows:
                check(value, rows[symbol][field], field, f'{symbol}.{field}')
    realized = {symbol_of[row['contractId']]: row['realized'] for row in output['realizedByContract']}
    wanted = {SYMBOL[alias]: value for alias, value in expected['realized'].items()}
    if sorted(realized) != sorted(wanted):
        problems.append(f'realized contracts: core {sorted(realized)} != model {sorted(wanted)}')
    for symbol, value in wanted.items():
        if symbol in realized:
            check(value, realized[symbol], 'realized', f'realized {symbol}')
    if len(output['cycles']) != len(expected['cycles']):
        problems.append(f'cycles: core {len(output["cycles"])} != model {len(expected["cycles"])}')
    else:
        for index, cycle in enumerate(expected['cycles']):
            for field, value in cycle.items():
                check(value, output['cycles'][index]['totals'][field], field, f'cycle {index} {field}')
    for field, value in expected['unattributed'].items():
        check(value, output['unattributed'][field], field, f'unattributed.{field}')
    return [f'{label}: {problem}' for problem in problems]


# ----------------------------------------------------------------------
# The campaign
# ----------------------------------------------------------------------

class _Shim:
    """What the pipeline's Ledger needs of a test case."""

    def __init__(self, node, directory):
        self.node = node
        self.directory = directory

    def assertFalse(self, value, message=None):  # noqa: N802 - the unittest name the Ledger calls
        if value:
            raise AssertionError(message)

    def assertEqual(self, first, second, message=None):  # noqa: N802
        if first != second:
            raise AssertionError(f'{first!r} != {second!r}: {message}')


class Campaign:
    """Runs seeds through the vector, preview and store stages (see the module docstring)."""

    def __init__(self):
        import cost_basis_fop_import_pipeline_test as pipeline
        from cost_basis_fop_core_test import Bridge
        self.pipeline = pipeline
        self.node = pipeline.Node()
        self.bridge = Bridge()
        self.directory = tempfile.TemporaryDirectory(prefix='fop-random-')
        self.coverage = {}
        self.last_case = None
        self.last_stage = None
        self.cases = 0

    def close(self):
        self.node.close()
        self.bridge.close()
        self.directory.cleanup()

    def count(self, name, amount=1):
        self.coverage[name] = self.coverage.get(name, 0) + amount

    def stage(self, name):
        self.last_stage = name

    def fail(self, message):
        raise CampaignFailure(self.last_stage, message)

    def verify_case(self, seed, steps, store=False):
        case = generate(seed, steps)
        self.last_case = case
        self.run(case, store=store)

    def run(self, case, *, store=False):
        self.stage('generate')
        made = materialize(case['actions'])
        if made is None:
            self.fail('the generator produced an action list that does not fit its positions')
        fills, events, positions = made
        if not events:
            return
        self.node.call(op='forget')
        self.cases += 1
        self.count('events', len(events))
        for item in events:
            self.count(item['kind'])
        self.count('fills', len(fills))
        self.count('orders', len({fill['orderId'] for fill in fills if fill.get('orderId')}))
        self.count('negative future prices', sum(1 for fill in fills if fill['price'] < 0))
        vector = vector_of(events, case['marks'])
        self.stage('model')
        expected = expected_figures(vector)

        self.stage('vector')
        output = self.bridge.compute({'vector': vector, 'catalogue': CATALOGUE, 'options': {}})
        symbol_of = {spec['contractId']: spec['localSymbol'] for spec in CATALOGUE.values()}
        self.require(compare(expected, output, symbol_of, 'vector replay'))

        self.stage('preview')
        kind = case['shape']['format']
        text = self.statement(kind, fills, positions, case['shape'])
        plan_id, _summary = self.plan(text, {'book': BOOK, 'graph': None, 'coverage': []})
        graph = self.node.call(op='previewGraph', planId=plan_id, book=BOOK)['graph']
        got, symbols = self.compute(graph, case['marks'])
        self.require(compare(expected, got, symbols, f'{kind} preview'))
        self.count(f'preview {kind}')
        if store:
            self.store_case(case, fills, events, expected)

    def require(self, problems):
        if problems:
            self.fail('; '.join(problems[:6]) + (f' (+{len(problems) - 6} more)' if len(problems) > 6 else ''))

    def statement(self, kind, fills, positions, shape, **options):
        return self.node.call(op='statement', kind=kind,
                              options=statement_options(kind, fills, positions, shape, **options))['text']

    def plan(self, text, context):
        answer = self.node.call(op='plan', text=text, fileName='campaign.csv',
                                context={'observedAtUtc': OBSERVED, 'timeZone': 'America/New_York', **context})
        summary = answer['summary']
        if summary['blocking']:
            self.fail(f'a valid history was blocked: {json.dumps(summary["problems"][:4], ensure_ascii=False)}')
        return answer['planId'], summary

    def compute(self, graph, marks):
        """(the core output, {contract id: local symbol}) of a graph; marks go by local symbol."""
        symbols = {item['record']['contractId']: item['record']['localSymbol'] for item in graph['contracts']}
        by_id = {contract_id: marks[alias] for contract_id, symbol in symbols.items()
                 for alias in marks if SYMBOL[alias] == symbol}
        return self.node.call(op='compute', graph=graph, options={'marks': by_id})['output'], symbols

    # ------------------------------------------------------------------
    # Through a temporary store
    # ------------------------------------------------------------------

    def ledger(self, name):
        return self.pipeline.Ledger(_Shim(self.node, self.directory), token(name))

    def stored_output(self, ledger, marks):
        return self.compute(ledger.graph(), marks)

    def import_text(self, ledger, text):
        plan_id, summary = ledger.plan(text, 'campaign.csv', timeZone='America/New_York')
        if summary['blocking'] and summary['bindingUpgrades'] \
                and {item['code'] for item in summary['problems']} == {'binding_missing'}:
            # The file proves a binding the ledger stored unresolved: adopt it as the page
            # offers (a server credential, one metadata commit each), then preview again.
            results = ledger.store.issue_statement_binding_credentials(ledger.book_id, [
                {key: item[key] for key in ('bindingId', 'option', 'future', 'evidence')}
                for item in summary['bindingUpgrades']])
            adoption = self.node.call(op='adoption', planId=plan_id, graph=ledger.graph(), book=ledger.book(),
                                      results=results)
            if adoption['refused']:
                self.fail(f'the server did not sign a binding the file proves: {adoption["refused"]}')
            for operation in adoption['operations']:
                ledger.store.commit_fop_metadata(ledger.book_id, operation, client_token=token('adopt'),
                                                 expected_ledger_version=ledger.ledger.version(),
                                                 book_identity=dict(ledger.ledger.identity), engine_version=1)
                self.count('store binding adoption')
            plan_id, summary = ledger.plan(text, 'campaign.csv', timeZone='America/New_York')
        if summary['blocking']:
            self.fail(f'a valid statement was blocked: {json.dumps(summary["problems"][:4], ensure_ascii=False)}')
        return ledger.send(ledger.request(plan_id, summary, text)), summary

    def store_case(self, case, fills, events, expected):
        shape = case['shape']
        rng = random.Random(shape['rng'])
        marks = case['marks']
        ledger = self.ledger('campaign')
        # One to three statements, split where both the local and the UTC day change.
        cuts = [index for index in range(1, len(fills))
                if fills[index]['local'][:10] > fills[index - 1]['local'][:10]
                and fills[index]['utc'][:10] > fills[index - 1]['utc'][:10]]
        chosen = sorted(rng.sample(cuts, min(len(cuts), shape['chunks'] - 1)))
        bounds = [0, *chosen, len(fills)]
        texts = []
        positions = {alias: 0 for alias in FUTURES + OPTIONS}
        by_symbol = {spec['localSymbol']: alias for alias, spec in CATALOGUE.items()}
        imported_events = []
        for number, (start, end) in enumerate(zip(bounds, bounds[1:])):
            part = fills[start:end]
            for fill in part:
                positions[by_symbol[fill['symbol']]] += fill['qty']
            kind = shape['formats'][number] if len(bounds) > 2 else shape['format']
            self.stage(f'store import {number + 1}/{len(bounds) - 1} ({kind})')
            text = self.statement(kind, part, positions, shape)
            texts.append(text)
            self.import_text(ledger, text)
            times = {fill['utc'] for fill in part}
            imported_events = [item for item in events if item['at'] in times or item in imported_events]
            got, symbols = self.stored_output(ledger, marks)
            self.require(compare(expected_figures(vector_of(imported_events, marks)), got, symbols,
                                 f'after statement {number + 1}'))
            self.count(f'store import {kind}')
        if shape['repeat']:
            self.stage('store repeat')
            before = ledger.ledger.version()
            result, _summary = self.import_text(ledger, rng.choice(texts))
            if result.get('inserted', 0) != 0:
                self.fail(f'a statement imported again added {result.get("inserted")} events')
            got, symbols = self.stored_output(ledger, marks)
            self.require(compare(expected, got, symbols, 'after the repeat'))
            if ledger.ledger.version()['liveEventCount'] != before['liveEventCount']:
                self.fail('a repeated statement changed the live events')
            self.count('store repeat')
        extra = []
        if shape['void']:
            self.stage('store void')
            last = events[-1]
            if last['kind'] in ('futures_trade', 'option_trade'):
                stored = self.stored_event(ledger, last)
                ledger.ledger.void(stored)
                events = events[:-1]
                expected = expected_figures(vector_of(events, marks))
                got, symbols = self.stored_output(ledger, marks)
                self.require(compare(expected, got, symbols, 'after voiding the last trade'))
                self.count('store void')
        stored_ids = {}
        for number in range(shape['fees']):
            self.stage('store late fee')
            source = rng.choice(events)
            stored = stored_ids.get(source['id']) or self.stored_event(ledger, source)
            stored_ids[source['id']] = stored
            when = self.after(events, extra, 3600 * (number + 1))
            refund = rng.random() < 0.2
            cash = (1 if refund else -1) * rng.choice([0.85, 3.5, 10])
            category = rng.choice(['futures', 'short_option', 'long_option', 'strategy'])
            include = rng.random() < 0.9
            fee = example_event('a late fee names its stored trade by event id')
            fee.update(feeSource={'eventId': stored, 'packageKey': None}, feeCategory=category,
                       feeIsRefund=refund, cashAmount=cash, includeInCost=include,
                       time=self.manual_time(fee['time'], when))
            ledger.ledger.append(fee)
            extra.append({'id': f'f{number}', 'at': utc_text(when), 'kind': 'fee', 'cash': cash,
                          'category': category, 'refund': refund, 'feeSource': source['id'],
                          'includeInCost': include})
            self.count('store late fee')
        if shape['adjust']:
            self.stage('store adjustment')
            when = self.after(events, extra, 7200 * 3)
            cash = rng.choice([-20, 15.5, 40])
            scope = rng.choice(['strategy', 'seller_lens'])
            include = rng.random() < 0.9
            adjust = example_event('evidenced strategy adjustment')
            adjust.update(adjustmentScope=scope, cashAmount=cash, includeInCost=include,
                          time=self.manual_time(adjust['time'], when))
            ledger.ledger.append(adjust)
            extra.append({'id': 'a0', 'at': utc_text(when), 'kind': 'manual_adjust', 'cash': cash, 'scope': scope,
                          'includeInCost': include})
            self.count('store adjustment')
        if extra:
            self.stage('store manual entries')
            expected = expected_figures(vector_of(events, marks, extra))
            got, symbols = self.stored_output(ledger, marks)
            self.require(compare(expected, got, symbols, 'after the manual entries'))
        if shape['restore']:
            self.stage('store restore')
            store = ledger.store
            backup = store.export_backup(ledger.book_id)
            # One active ledger per account and root: the original steps aside for its restore.
            store.archive_book(ledger.book_id)
            other = store.create_fop_book(account=IDENTITY['account'], symbol='CL', start_date='2026-01-01',
                                          fop=dict(FOP_META))
            plan = store.reset_confirmation(other['bookId'])
            store.restore_backup(other['bookId'], backup, confirmation=plan['phrase'], client_token=token(),
                                 expected_ledger_version=plan['ledgerVersion'], book_identity=dict(IDENTITY),
                                 engine_version=1)
            got, symbols = self.compute(store.export_backup(other['bookId'])['payload'], marks)
            self.require(compare(expected, got, symbols, 'the restored ledger'))
            self.count('store restore')
        self.count('store cases')

    @staticmethod
    def after(events, extra, seconds):
        latest = max(item['at'] for item in [*events, *extra])
        return datetime.strptime(latest, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc) + timedelta(
            seconds=seconds)

    @staticmethod
    def manual_time(time, moment):
        local = moment.astimezone(ZONE)
        return dict(time, exchangeTradeDate=local.strftime('%Y-%m-%d'),
                    executedAtUtc=moment.strftime('%Y-%m-%dT%H:%M:%S.000000Z'), timeRange=None,
                    sourceTimeText=local.strftime('%Y-%m-%d, %H:%M:%S'), sourceTimezone='America/New_York',
                    orderEvidence=None)

    def stored_event(self, ledger, item):
        """The stored event id of a model event: the live event of its kind at its instant."""
        instant = item['at'].replace('Z', '.000000Z')
        found = [stored['row']['eventId'] for stored in ledger.graph()['events']
                 if not stored['row']['voidedAtUtc'] and stored['row']['kind'] == item['kind']
                 and stored['row']['fop']['time']['executedAtUtc'] == instant]
        if len(found) != 1:
            self.fail(f'{item["id"]} ({item["kind"]} at {item["at"]}) is {len(found)} stored events')
        return found[0]


def reduce(campaign, case, *, store, attempts=150):
    """The shortest action list (greedy) on which the same stage still fails; None if it passes."""
    def failing(actions):
        trial = dict(case, actions=actions)
        if materialize(actions) is None:
            return None
        try:
            campaign.run(trial, store=store)
        except CampaignFailure as failure:
            return failure.stage
        except Exception as error:  # noqa: BLE001 - any other error is its own stage
            return f'error {type(error).__name__}'
        return None

    stage = failing(case['actions'])
    if stage is None:
        return None
    actions = list(case['actions'])
    tries = 0
    changed = True
    while changed and tries < attempts:
        changed = False
        for index in range(len(actions) - 1, -1, -1):
            if tries >= attempts:
                break
            trial = actions[:index] + actions[index + 1:]
            tries += 1
            if failing(trial) == stage:
                actions = trial
                changed = True
    campaign.last_stage = stage
    return {'seed': case['seed'], 'stage': stage, 'store': store, 'actions': serializable(actions),
            'marks': case['marks'], 'shape': case['shape'], 'tries': tries}


def serializable(actions):
    out = []
    for action in actions:
        item = copy.deepcopy(action)
        item['at'] = utc_text(item['at'])
        out.append(item)
    return out


def load_actions(items):
    out = []
    for item in items:
        action = copy.deepcopy(item)
        action['at'] = datetime.strptime(action['at'], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
        if action['kind'] == 'order':
            action['parts'] = [tuple(part) for part in action['parts']]
        out.append(action)
    return out

