"""Independent rational reference model of the FOP ledger economics (test only).

CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §5.1-§5.3, §6.1, §9.2 (baseline),
§13.2 and §13.3 P3 step 1. It reads the compact vectors of
tests/fixtures/cost_basis_fop/core_vectors.json directly and computes every
figure with fractions.Fraction, so a repeating average such as 211/3 stays
exact (F47). It shares no code with js/cost_basis_fop_core.js or
cost_basis_fop_domain.py: the expected values come from here and from the
hand-worked numbers in the vectors, never from production code.

Ordering here is deliberately simple: events are taken by (start, end), then by
their order evidence, then in the order the vector lists them. A vector whose
simultaneous events could be ordered two ways either lists them in the order
it means, or is about ordering and is not replayed here.

Cycles, read straight from plan §9.2 and §13.2: events whose times overlap
form a group, and a boundary sits after the whole group of its anchor. A late
fee goes to the cycle of its source. A fee or adjustment without a source that
shares a group with a boundary belongs to no single cycle: the whole book holds
it, the "unattributed" row shows it, and the cycles on both sides of that
boundary have no complete net result (nor a break-even, if it is seller money).
At an as-of instant an event has happened once its time has ended, or once its
order evidence puts it before one that has; a boundary counts once its whole
group has happened.
"""
from fractions import Fraction

DELIVERIES = ('option_assignment', 'option_exercise')


def rational(value):
    """A JSON number or a 'p/q' string as an exact Fraction (None stays None)."""
    if value is None:
        return None
    return Fraction(str(value))


def instant(text):
    """Vector time text as the fixed-width UtcInstant form (for ordering)."""
    if not text.endswith('Z'):
        raise ValueError(f'{text}: a vector time ends with Z')
    body = text[:-1]
    if '.' not in body:
        body += '.000000'
    head, fraction = body.split('.')
    return f'{head}.{fraction.ljust(6, "0")}Z'


def interval(event):
    if 'at' in event:
        moment = instant(event['at'])
        return moment, moment
    start, end = event['range']
    return instant(start), instant(end)


def evidence_sequence(event):
    text = event.get('evidence')
    if not text or '#' not in text:
        return None
    return int(text.rsplit('#', 1)[1])


def evidence_scope(event):
    text = event.get('evidence')
    return text.rsplit('#', 1)[0] if text and '#' in text else None


def overlap_groups(events):
    """{event id: group number} of events whose times overlap, directly or through others."""
    ordered = sorted(events, key=interval)
    group_of = {}
    number, latest = -1, None
    for event in ordered:
        start, end = interval(event)
        if latest is None or start > latest:
            number += 1
            latest = end
        else:
            latest = max(latest, end)
        group_of[event['id']] = number
    return group_of


def happened_by(events, cut):
    """Ids of the events that have happened at `cut` (see the module notes)."""
    done = {event['id'] for event in events if interval(event)[1] <= cut}
    for event in events:
        scope, sequence = evidence_scope(event), evidence_sequence(event)
        if event['id'] in done or scope is None or interval(event)[0] > cut:
            continue
        if any(other['id'] in done and evidence_scope(other) == scope
               and evidence_sequence(other) > sequence for other in events):
            done.add(event['id'])
    return done


class _Future:
    def __init__(self, point_value):
        self.point_value = point_value
        self.q = 0
        self.average = None
        self.realized = Fraction(0)
        self.closed_any = False

    def fill(self, delta, price):
        """plan §5.1: add at a weighted average, close at it, reverse the rest."""
        if self.q == 0 or (self.q > 0) == (delta > 0):
            total = self.q + delta
            self.average = price if self.q == 0 else (self.q * self.average + delta * price) / total
            self.q = total
            return Fraction(0)
        closed = min(abs(delta), abs(self.q))
        direction = 1 if self.q > 0 else -1
        realized = closed * self.point_value * direction * (price - self.average)
        self.realized += realized
        self.closed_any = True
        rest = abs(delta) - closed
        self.q += (1 if delta > 0 else -1) * closed
        if rest:
            self.q = (1 if delta > 0 else -1) * rest
            self.average = price
        elif self.q == 0:
            self.average = None
        return realized


class _Option:
    def __init__(self, multiplier):
        self.multiplier = multiplier
        self.n = 0
        self.premium = Fraction(0)
        self.premium_known = True

    def release(self, closed):
        """The open premium `closed` contracts take with them (all of it at the end)."""
        share = self.premium if closed >= abs(self.n) else self.premium * closed / abs(self.n)
        self.premium -= share
        known = self.premium_known
        if closed >= abs(self.n):
            self.premium = Fraction(0)
            self.premium_known = True
        return share if known else None


def _contract_terms(vector, alias):
    spec = vector['contracts'][alias]
    if spec['secType'] == 'FUT':
        return spec, rational(spec.get('pointValue', 1000))
    return spec, rational(spec.get('multiplier', 1000))


def event_cash(vector, event):
    """cashAmount the ledger stores for a vector event (plan §8.1 kind table)."""
    kind = event['kind']
    fees = rational(event.get('fees', 0))
    if kind == 'option_trade':
        if 'cash' in event:
            return rational(event['cash'])
        _spec, multiplier = _contract_terms(vector, event['contract'])
        return -event['q'] * multiplier * rational(event['price']) - fees
    if kind in ('fee', 'manual_adjust'):
        return rational(event['cash'])
    if kind == 'opening_balance':
        return Fraction(0)
    return -fees


def delivered_futures(vector, event):
    """(future alias, FUT quantity) a delivery moves (plan §6.1)."""
    spec = vector['contracts'][event['contract']]
    per_option = rational(spec.get('deliverable', 1))
    closing = event['q']  # >0: assignment closes a short; <0: exercise closes a long
    if closing > 0:
        sign = -1 if spec['right'] == 'C' else 1
    else:
        sign = 1 if spec['right'] == 'C' else -1
    quantity = sign * abs(closing) * per_option
    return spec['future'], int(event.get('fq', quantity))


def _buckets():
    return {name: Fraction(0) for name in ('Rf', 'Co', 'E', 'J', 'Rs', 'Es', 'Js')}


def replay(vector, *, as_of=None):
    """Replay a vector: {'steps': [...], 'state': {...}} with exact Fractions."""
    indexed = list(enumerate(vector['events']))
    live = [(index, event) for index, event in indexed if not event.get('void')]
    everything = [event for _index, event in live]
    group_of = overlap_groups(everything)
    done = {event['id'] for event in everything}
    if as_of is not None:
        done = happened_by(everything, instant(as_of))
        live = [(index, event) for index, event in live if event['id'] in done]
    live.sort(key=lambda item: (*interval(item[1]),
                                evidence_sequence(item[1]) if evidence_sequence(item[1]) is not None else -1,
                                item[0]))
    order = [event['id'] for _index, event in live]
    # Boundaries by the group they close; one counts once its group has happened.
    closing = sorted(group_of[boundary['anchor']] for boundary in vector.get('boundaries', []))
    passed = []
    for group in closing:
        if not all(event['id'] in done for event in everything if group_of[event['id']] == group):
            break
        passed.append(group)
    cycle_of = {event['id']: sum(1 for group in passed if group < group_of[event['id']])
                for event in everything}
    cycle = len(passed)
    # A cash row without a source that shares a boundary's group: which cycles it may belong to.
    sizes = {}
    for event in everything:
        sizes[group_of[event['id']]] = sizes.get(group_of[event['id']], 0) + 1
    straddles = {}
    for event in everything:
        group = group_of[event['id']]
        if (event['kind'] in ('fee', 'manual_adjust') and not event.get('feeSource')
                and group in closing and sizes[group] > 1):
            before = sum(1 for other in passed if other < group)
            straddles[event['id']] = [index for index in (before, before + 1) if index <= cycle]
    cycles = [_buckets() for _ in range(cycle + 1)]
    exercised = [False] * (cycle + 1)
    incomplete = [False] * (cycle + 1)
    seller_incomplete = [False] * (cycle + 1)
    unattributed = {'E': Fraction(0), 'J': Fraction(0)}
    book = _buckets()
    futures = {}
    options = {}
    opening_value = Fraction(0)
    opening_known = True
    baseline_at_reference = True
    steps = []

    def future(alias):
        if alias not in futures:
            futures[alias] = _Future(_contract_terms(vector, alias)[1])
        return futures[alias]

    def option(alias):
        if alias not in options:
            options[alias] = _Option(_contract_terms(vector, alias)[1])
        return options[alias]

    def add(name, amount, cycle_index):
        book[name] += amount
        if cycle_index is not None:
            cycles[cycle_index][name] += amount
            return
        if name in unattributed:
            unattributed[name] += amount
        for index in straddles[event['id']]:
            if amount:
                incomplete[index] = True
                seller_incomplete[index] = seller_incomplete[index] or name in ('Es', 'Js')

    for _index, event in live:
        kind = event['kind']
        home = cycle_of[event['id']]
        if kind == 'fee' and event.get('feeSource') in cycle_of:
            home = cycle_of[event['feeSource']]
        if event['id'] in straddles:
            home = None
        fees = rational(event.get('fees', 0))
        cash = event_cash(vector, event)
        if kind == 'futures_trade':
            add('Rf', future(event['contract']).fill(event['q'], rational(event['price'])), home)
            add('E', fees, home)
            add('Es', fees, home)
        elif kind == 'option_trade':
            state = option(event['contract'])
            add('Co', cash, home)
            delta = event['q']
            if state.n == 0 or (state.n > 0) == (delta > 0):
                state.n += delta
                state.premium += cash
            else:
                closed = min(abs(delta), abs(state.n))
                short = state.n < 0
                released = state.release(closed)
                close_cash = cash if closed == abs(delta) else cash * closed / abs(delta)
                state.n += (1 if delta > 0 else -1) * closed
                rest = abs(delta) - closed
                if rest:
                    state.n = (1 if delta > 0 else -1) * rest
                    state.premium = cash - close_cash
                    state.premium_known = True
                if short:
                    add('Rs', (released or 0) + close_cash, home)
        elif kind in ('option_expiry',) + DELIVERIES:
            state = option(event['contract'])
            short = state.n < 0
            released = state.release(abs(event['q']))
            state.n += abs(event['q']) if state.n < 0 else -abs(event['q'])
            if short:
                add('Rs', released or 0, home)
            add('E', fees, home)
            if short:
                add('Es', fees, home)
            if kind in DELIVERIES:
                alias, quantity = delivered_futures(vector, event)
                strike = rational(vector['contracts'][event['contract']]['strike'])
                add('Rf', future(alias).fill(quantity, strike), home)
            if kind == 'option_exercise':
                exercised[home] = True
        elif kind == 'opening_balance':
            spec, multiplier = _contract_terms(vector, event['contract'])
            price = rational(event.get('price'))
            if spec['secType'] == 'FUT':
                future(event['contract']).fill(event['q'], price)
                if event['baseline'] != 'reference_price':
                    baseline_at_reference = False
            else:
                state = option(event['contract'])
                state.n += event['q']
                if event['baseline'] == 'trade_cost':
                    state.premium += -event['q'] * multiplier * price
                    opening_known = False
                elif event['baseline'] == 'reference_price':
                    state.premium_known = False
                    opening_value += event['q'] * multiplier * price
                else:
                    state.premium_known = False
                    opening_known = False
        elif kind == 'fee':
            if event.get('includeInCost', True):
                add('E', -cash, home)
                if event.get('category') in ('futures', 'short_option'):
                    add('Es', -cash, home)
        elif kind == 'manual_adjust':
            if event.get('includeInCost', True):
                add('J', cash, home)
                if event.get('scope') == 'seller_lens':
                    add('Js', cash, home)
        steps.append({
            'after': event['id'],
            'positions': {
                **{alias: [state.q, state.average] for alias, state in futures.items() if state.q},
                **{alias: [state.n, state.premium if state.premium_known else None]
                   for alias, state in options.items() if state.n},
            },
            **{name: book[name] for name in ('Rf', 'Co', 'E', 'J', 'Rs', 'Es', 'Js')},
        })
    return {
        'order': order, 'steps': steps, 'futures': futures, 'options': options,
        'book': book, 'cycles': cycles, 'exercised': exercised, 'unattributed': unattributed,
        'incomplete': incomplete, 'seller_incomplete': seller_incomplete,
        'opening_value': opening_value if opening_known else None,
        'baseline_at_reference': baseline_at_reference,
    }


def ledger(vector, *, marks=None, as_of=None):
    """The figures a ledger shows: totals, cycles and the seller lens (Fractions or None)."""
    result = replay(vector, as_of=as_of)
    marks = {alias: rational(price) for alias, price in (marks or {}).items()}
    history = vector.get('historyScope', 'full_history')
    uf = Fraction(0)
    for alias, state in result['futures'].items():
        if state.q:
            uf = None if uf is None or marks.get(alias) is None else \
                uf + state.q * state.point_value * (marks[alias] - state.average)
    vo = Fraction(0)
    for alias, state in result['options'].items():
        if state.n:
            vo = None if vo is None or marks.get(alias) is None else \
                vo + state.n * state.multiplier * marks[alias]
    book = result['book']

    def pnl(buckets, uf_part, vo_part, opening):
        if uf_part is None or vo_part is None or opening is None:
            return None
        return buckets['Rf'] + uf_part + buckets['Co'] + vo_part - buckets['E'] + buckets['J'] - opening

    opening = result['opening_value'] if history == 'since_baseline' else Fraction(0)
    if history == 'since_baseline' and not result['baseline_at_reference']:
        opening = None
    totals = {'Rf': book['Rf'], 'Uf': uf, 'Co': book['Co'], 'Vo': vo, 'E': book['E'], 'J': book['J'],
              'economicPnl': pnl(book, uf, vo, opening)}
    last = len(result['cycles']) - 1
    cycles = []
    for index, buckets in enumerate(result['cycles']):
        current = index == last
        cycles.append({
            'Rf': buckets['Rf'], 'Co': buckets['Co'], 'E': buckets['E'], 'J': buckets['J'],
            'economicPnl': None if result['incomplete'][index] else pnl(
                buckets, uf if current else Fraction(0), vo if current else Fraction(0),
                opening if index == 0 else Fraction(0)),
        })
    lens_buckets = result['cycles'][last]
    open_futures = [(alias, state) for alias, state in result['futures'].items() if state.q]
    lens = {'Rs': lens_buckets['Rs'], 'Es': lens_buckets['Es'], 'Js': lens_buckets['Js'],
            'breakEven': None, 'breakEvenIfOpenShortsExpire': None,
            'longExerciseAffectsBreakEven': result['exercised'][last]}
    premiums_known = all(state.premium_known for state in result['options'].values() if state.n)
    lens_ok = (len(open_futures) == 1 and premiums_known and not result['seller_incomplete'][last]
               and not (history == 'since_baseline' and last == 0))
    if lens_ok:
        _alias, state = open_futures[0]
        exposure = state.q * state.point_value
        settled = lens_buckets['Rf'] + lens_buckets['Rs'] - lens_buckets['Es'] + lens_buckets['Js']
        lens['breakEven'] = state.average - settled / exposure
        open_short = sum((option.premium for option in result['options'].values() if option.n < 0),
                         Fraction(0))
        lens['breakEvenIfOpenShortsExpire'] = lens['breakEven'] - open_short / exposure
    positions = {alias: {'contracts': state.q, 'averagePrice': state.average}
                 for alias, state in result['futures'].items() if state.q}
    positions.update({alias: {'contracts': state.n,
                              'remainingNetPremium': state.premium if state.premium_known else None}
                      for alias, state in result['options'].items() if state.n})
    realized = {alias: state.realized for alias, state in result['futures'].items() if state.closed_any}
    return {'totals': totals, 'cycles': cycles, 'sellerLens': lens, 'positions': positions,
            'realized': realized, 'unattributed': result['unattributed'],
            'steps': result['steps'], 'order': result['order'],
            'openingValue': result['opening_value'] if history == 'since_baseline' else None}
