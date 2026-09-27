"""Independent reference model of the FOP stress contract (test only).

CODE PLAN/COST_BASIS_FOP_STRESS_CONTRACT.md. It reads the vectors of
tests/fixtures/cost_basis_fop/stress_vectors.json and computes, for each
scenario point, what the contract says the stress curve shows. It shares no
code with the production modules (js/american_binomial.js, the future
js/cost_basis_fop_stress.js): the pricers, the implied volatility, the
scenario path and the position arithmetic are written here from the contract
text. Economic totals after a scenario delivery are checked separately
against the rational ledger model (tests/helpers/cost_basis_fop_model.py),
which replays the same ledger with the scenario's settlement events appended.

Units: prices in $/bbl, money in dollars, times as UtcInstant text, year
fractions ACT/365F on seconds, rates continuously compounded.
"""
import math
from datetime import datetime, timedelta, timezone
from fractions import Fraction
from zoneinfo import ZoneInfo

import cost_basis_fop_model as ledger_model

YEAR_SECONDS = 365 * 86400
STEPS = 201
SIGMA_MAX = 8.0
BISECTIONS = 60
PRICE_TOLERANCE = 1e-7
EXCHANGE = ZoneInfo('America/Chicago')  # NYMEX-CL-v1 exchangeTimeZone


class Stop(Exception):
    """The contract stops: the whole run, or one point, is unavailable with this reason."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def moment(text):
    return datetime.strptime(text.rstrip('Z').split('.')[0], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc)


def years(start, end):
    return (moment(end) - moment(start)).total_seconds() / YEAR_SECONDS


def later(text, days):
    return (moment(text) + timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ')


def exchange_day(text):
    """The exchange (America/Chicago) date of an instant."""
    return moment(text).astimezone(EXCHANGE).date().isoformat()


def expiry_at(spec):
    """An option's expiry instant (contract §3.4): its exact instant, else 13:30 Chicago on its expiry date."""
    if spec.get('expiryAt'):
        return spec['expiryAt']
    local = datetime.strptime(spec['expiry'], '%Y-%m-%d').replace(hour=13, minute=30, tzinfo=EXCHANGE)
    return local.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def trades_at(spec, text):
    """Whether a future still trades at an instant (contract §6.2): by its exact last trade instant, else
    by the exchange date against its last trade date; None when neither is known."""
    if spec.get('lastTradeAt'):
        return moment(text) <= moment(spec['lastTradeAt'])
    if spec.get('lastTrade'):
        return exchange_day(text) <= spec['lastTrade']
    return None


def require_trading(alias, spec, text):
    trading = trades_at(spec, text)
    if trading is None:
        raise Stop(f'future_last_trade_unknown:{alias}')
    if not trading:
        raise Stop(f'future_past_last_trade:{alias}')


# ----------------------------------------------------------------------
# Pricers (contract §3)
# ----------------------------------------------------------------------

def normal_cdf(x):
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def intrinsic(right, future, strike):
    return max(0.0, future - strike) if right == 'C' else max(0.0, strike - future)


def black76(right, future, strike, tau, rate, sigma):
    """European option on a future. At expiry the intrinsic value, whatever the sign of F; before it,
    None outside the model's domain (F <= 0)."""
    if strike <= 0 or tau < 0 or sigma < 0:
        return None
    if tau == 0:
        return intrinsic(right, future, strike)
    if future <= 0:
        return None
    discount = math.exp(-rate * tau)
    if sigma == 0:
        return discount * intrinsic(right, future, strike)
    root = sigma * math.sqrt(tau)
    d1 = (math.log(future / strike) + 0.5 * sigma * sigma * tau) / root
    d2 = d1 - root
    if right == 'C':
        return discount * (future * normal_cdf(d1) - strike * normal_cdf(d2))
    return discount * (strike * normal_cdf(-d2) - future * normal_cdf(-d1))


def black76_steps(right, future, strike, tau, rate, sigma):
    """The intermediate numbers of black76, for the step-by-step vector."""
    root = sigma * math.sqrt(tau)
    d1 = (math.log(future / strike) + 0.5 * sigma * sigma * tau) / root
    d2 = d1 - root
    return {'tau': tau, 'discount': math.exp(-rate * tau), 'd1': d1, 'd2': d2,
            'Nd1': normal_cdf(d1), 'Nd2': normal_cdf(d2),
            'value': black76(right, future, strike, tau, rate, sigma)}


def american_futures_crr(right, future, strike, tau, rate, sigma, steps=STEPS):
    """American option on a future: a Cox-Ross-Rubinstein tree with no drift.

    u = exp(sigma*sqrt(dt)), d = 1/u, p = (1 - d)/(u - d), one-step discount
    exp(-rate*dt), exercise checked at every node including the root. At zero
    volatility the tree is the deterministic path: the future stays put, so
    the value is the best discounted intrinsic over the step times. At expiry the intrinsic value,
    whatever the sign of F; before it, None when F <= 0.
    """
    if strike <= 0 or tau < 0 or sigma < 0:
        return None
    if tau == 0:
        return intrinsic(right, future, strike)
    if future <= 0:
        return None
    dt = tau / steps
    move = sigma * math.sqrt(dt)
    if move < 1e-7:
        return max(math.exp(-rate * dt * index) * intrinsic(right, future, strike) for index in range(steps + 1))
    up = math.exp(move)
    down = 1.0 / up
    p = (1.0 - down) / (up - down)
    step_discount = math.exp(-rate * dt)
    values = [intrinsic(right, future * up ** (2 * j - steps), strike) for j in range(steps + 1)]
    for level in range(steps - 1, -1, -1):
        values = [max(intrinsic(right, future * up ** (2 * j - level), strike),
                      step_discount * (p * values[j + 1] + (1.0 - p) * values[j]))
                  for j in range(level + 1)]
    return max(intrinsic(right, future, strike), values[0])


def price(option, future, tau, rate, sigma):
    style = option.get('exerciseStyle', 'american')
    pricer = american_futures_crr if style == 'american' else black76
    return pricer(option['right'], future, option['strike'], tau, rate, sigma)


def implied_sigma(option, future, tau, rate, mark):
    """Bisection on [0, SIGMA_MAX] for BISECTIONS halvings (contract §4)."""
    low_value = price(option, future, tau, rate, 0.0)
    high_value = price(option, future, tau, rate, SIGMA_MAX)
    if low_value is None:
        raise Stop('model_domain')
    if mark < low_value - PRICE_TOLERANCE:
        raise Stop('quote_below_model_floor')
    if mark > high_value + PRICE_TOLERANCE:
        raise Stop('quote_above_model_ceiling')
    low, high = 0.0, SIGMA_MAX
    for _ in range(BISECTIONS):
        middle = (low + high) / 2.0
        if price(option, future, tau, rate, middle) < mark:
            low = middle
        else:
            high = middle
    sigma = (low + high) / 2.0
    if abs(price(option, future, tau, rate, sigma) - mark) > PRICE_TOLERANCE:
        raise Stop('calibration_failed')
    return sigma


# ----------------------------------------------------------------------
# The stress run (contract §2, §5, §6)
# ----------------------------------------------------------------------

def month_index(month):
    return int(month[:4]) * 12 + int(month[4:])


class Run:
    """One compiled run: positions, anchors and implied volatilities at asOf.

    vector: a stress vector with its contract catalogue under 'contracts' and
    the ledger's events in the compact form of core_vectors.json. The open
    positions come from the rational ledger replay of those events.
    """

    def __init__(self, vector):
        self.vector = vector
        self.catalogue = vector['contracts']
        self.as_of = vector['asOf']
        state = ledger_model.replay(vector)
        self.futures = {alias: int(s.q) for alias, s in state['futures'].items() if s.q}
        self.options = {alias: int(s.n) for alias, s in state['options'].items() if s.n}
        self.anchor, self.sigma, self.anchor_value, self.reference = {}, {}, {}, None
        # Nothing open: nothing to move, so no quote, rate or axis is needed (contract §7.5).
        self.empty = not self.futures and not self.options
        if self.empty:
            return
        self.rate = vector.get('rate')
        if self.rate is None:
            raise Stop('rate_unavailable')
        quotes = vector['quotes']
        for alias in self.options:
            spec = self.catalogue[alias]
            if spec.get('future') is None:
                raise Stop(f'binding_unresolved:{alias}')
            if spec.get('multiplier', 1000) != spec.get('deliverable', 1) * self.catalogue[spec['future']].get(
                    'pointValue', 1000):
                raise Stop(f'multiplier_mismatch:{alias}')
            if moment(expiry_at(spec)) <= moment(self.as_of):
                raise Stop(f'option_expired_open:{alias}')
        # Anchors: every held future and every future an open option is bound to.
        needed = set(self.futures) | {self.catalogue[alias]['future'] for alias in self.options}
        for alias in sorted(needed):
            quote = quotes.get(alias)
            if not quote or quote.get('level', 'mid') == 'unavailable':
                raise Stop(f'future_anchor_missing:{alias}')
            bound = any(self.catalogue[o]['future'] == alias for o in self.options)
            if bound and quote.get('level', 'mid') != 'mid':
                raise Stop(f'iv_needs_live_future:{alias}')
            self.anchor[alias] = quote_mark(quote)
        for alias in sorted(self.options):
            spec = self.catalogue[alias]
            quote = quotes.get(alias)
            if not quote or quote.get('level', 'mid') != 'mid':
                raise Stop(f'iv_needs_mid:{alias}')
            future = self.anchor[spec['future']]
            if future <= 0:
                raise Stop(f'model_domain:{alias}')
            tau = years(self.as_of, expiry_at(spec))
            try:
                self.sigma[alias] = implied_sigma(spec, future, tau, self.rate, quote_mark(quote))
            except Stop as stop:
                raise Stop(f'{stop.reason}:{alias}') from None
            self.anchor_value[alias] = price(spec, future, tau, self.rate, self.sigma[alias])
        fronts = sorted(needed, key=lambda alias: month_index(self.catalogue[alias]['month']))
        self.reference = vector.get('reference') or fronts[0]

    def scenario_futures(self, shift, slope):
        base = month_index(self.catalogue[self.reference]['month'])
        return {alias: price_ + shift + slope * (month_index(self.catalogue[alias]['month']) - base)
                for alias, price_ in self.anchor.items()}

    def point(self, shift=0.0, slope=0.0, horizon_days=0, iv_scale=1.0, early=()):
        """change, the settlements and the per-leg values at one scenario point."""
        if self.empty:
            return {'change': 0.0, 'futures': {}, 'values': {}, 'settlements': [], 'positions': {},
                    'notDelivered': []}
        target = later(self.as_of, horizon_days)
        prices = self.scenario_futures(shift, slope)
        futures = dict(self.futures)
        settlements = []
        # Options that expire inside the horizon settle at their expiry, at the scenario price.
        for alias in sorted(self.options, key=lambda a: (expiry_at(self.catalogue[a]), a)):
            spec = self.catalogue[alias]
            expiry = expiry_at(spec)
            if moment(expiry) > moment(target):
                continue
            future = spec['future']
            n = self.options[alias]
            if in_the_money(spec, prices[future]):
                # The delivered future must still trade when the option expires.
                require_trading(future, self.catalogue[future], expiry)
                delta = direction(spec['right'], n) * abs(n) * spec.get('deliverable', 1)
                futures[future] = futures.get(future, 0) + delta
                settlements.append({'option': alias, 'action': 'assign' if n < 0 else 'exercise',
                                    'contracts': abs(n), 'closing': -n, 'future': future,
                                    'futureContracts': delta, 'at': expiry})
            else:
                settlements.append({'option': alias, 'action': 'expire', 'contracts': abs(n), 'closing': -n,
                                    'at': expiry})
        open_options = {a: n for a, n in self.options.items() if moment(expiry_at(self.catalogue[a])) > moment(target)}
        # Chosen early deliveries (contract §6.3): an American option of this ledger, delivered at the
        # horizon only where it is strictly in the money there; otherwise it stays as it is, and says why.
        not_delivered = []
        for alias in early:
            if alias not in self.options:
                raise Stop(f'early_delivery_unknown:{alias}')
            spec = self.catalogue[alias]
            if spec.get('exerciseStyle', 'american') != 'american':
                raise Stop(f'early_delivery_european:{alias}')
            if alias not in open_options:
                not_delivered.append({'option': alias, 'why': 'settled_at_expiry'})
                continue
            if not in_the_money(spec, prices[spec['future']]):
                not_delivered.append({'option': alias, 'why': 'out_of_the_money'})
                continue
            require_trading(spec['future'], self.catalogue[spec['future']], target)
            n = open_options.pop(alias)
            delta = direction(spec['right'], n) * abs(n) * spec.get('deliverable', 1)
            futures[spec['future']] = futures.get(spec['future'], 0) + delta
            settlements.append({'option': alias, 'action': 'assign' if n < 0 else 'exercise', 'contracts': abs(n),
                                'closing': -n, 'future': spec['future'], 'futureContracts': delta, 'at': target})
        for alias, quantity in futures.items():
            if quantity != 0 and horizon_days != 0:
                require_trading(alias, self.catalogue[alias], target)
        values = {}
        for alias, n in open_options.items():
            spec = self.catalogue[alias]
            future = prices[spec['future']]
            tau = years(target, expiry_at(spec))
            value = price(spec, future, tau, self.rate, self.sigma[alias] * iv_scale)
            if value is None:
                raise Stop(f'model_domain:{alias}')
            values[alias] = value
        # change = held futures' move + each delivery (a future bought or sold at
        # the strike, valued at the scenario price) - the anchor value of each
        # settled option + the move of each option still open.
        change = 0.0
        for alias, quantity in self.futures.items():
            point_value = self.catalogue[alias].get('pointValue', 1000)
            change += quantity * point_value * (prices[alias] - self.anchor[alias])
        for settlement in settlements:
            spec = self.catalogue[settlement['option']]
            n = self.options[settlement['option']]
            multiplier = spec.get('multiplier', 1000)
            if 'future' in settlement:
                point_value = self.catalogue[settlement['future']].get('pointValue', 1000)
                change += settlement['futureContracts'] * point_value * (prices[settlement['future']] - spec['strike'])
            change -= n * multiplier * self.anchor_value[settlement['option']]
        for alias, value in values.items():
            multiplier = self.catalogue[alias].get('multiplier', 1000)
            change += open_options[alias] * multiplier * (value - self.anchor_value[alias])
        return {'change': change, 'futures': prices, 'values': values, 'settlements': settlements,
                'positions': {a: q for a, q in futures.items() if q}, 'notDelivered': not_delivered}


def in_the_money(spec, future):
    """Strictly in the money: at the strike an option expires (plan §6.1, contract §6.1)."""
    return future > spec['strike'] if spec['right'] == 'C' else future < spec['strike']


def direction(right, n):
    """FUT contracts per option contract delivered (plan §6.1)."""
    if n < 0:
        return 1 if right == 'P' else -1
    return 1 if right == 'C' else -1


def quote_mark(quote):
    if 'mark' in quote:
        return quote['mark']
    return (quote['bid'] + quote['ask']) / 2.0


def band(run, point, fraction):
    """The IV level members at one point: the lowest and highest change of center, low and high."""
    members = [run.point(**point)['change'],
               run.point(**dict(point, iv_scale=point.get('iv_scale', 1.0) * (1 - fraction)))['change'],
               run.point(**dict(point, iv_scale=point.get('iv_scale', 1.0) * (1 + fraction)))['change']]
    return min(members), max(members)


def settlement_events(point):
    """The scenario's settlements as compact ledger events (for the rational replay)."""
    events = []
    for index, settlement in enumerate(point['settlements']):
        kind = {'expire': 'option_expiry', 'assign': 'option_assignment', 'exercise': 'option_exercise'}[
            settlement['action']]
        events.append({'id': f'scenario-{index + 1}', 'kind': kind, 'contract': settlement['option'],
                       'q': settlement['closing'], 'at': settlement['at']})
    return events


def economic_pnl(vector, marks, extra_events=()):
    """The rational ledger model's economic P&L for these marks (floats become exact decimals)."""
    replayed = dict(vector, events=list(vector['events']) + list(extra_events))
    exact = {alias: Fraction(repr(value)) for alias, value in marks.items()}
    return ledger_model.ledger(replayed, marks=exact)['totals']['economicPnl']
