#!/usr/bin/env python3
"""Synthetic backend for the FOP ledger page's browser checks (plan §13.3 P5 item 4).

It serves the cost-basis WebSocket protocol on 127.0.0.1 against a temporary
database (OPTION_COMBO_COST_BASIS_DB_PATH), with FOP writes enabled and a
simulated broker for one-shot quotes. It never connects to TWS, never opens
the real ledger and refuses the live backend's port 8765.

It also serves the repository's static files on a second port, except the
root: "/" and "/index.html" are a blank page that stores this backend's port
for the ledger pages before anything else runs, so no page can fall back to
the live backend (the trading app's index.html is never served here).

Quotes, contract details and positions come from tables the browser
assertion script sets:

    POST /__synthetic/quotes     {"quotes": {"<localSymbol>": {bid, bidSize, ...}}}
    POST /__synthetic/contracts  {"available": bool, "details": [{"match": {field: value}, "result": [...]}]}
                                 IB-style contract details per query (plan §19 P5-C2); unavailable
                                 answers as the historical backend does
    POST /__synthetic/positions  {"available": bool, "connected": bool, "ready": bool, "accounts": [...],
                                 "items": [...]} the TWS position set (plan §19 P5-C3)
    POST /__synthetic/curve      {"available": bool, "curve": {...}, "status": "cached"|"cache_fallback",
                                 "error": "..."} the cached discount curve the stress view reads (stress
                                 contract §2.3) and how the yield-curve backend would answer it; by default
                                 a flat 4% canonical snapshot answered as current ("cached")
    GET  /__synthetic/actions    every WebSocket action received, in order

A quote entry omits nothing: bid, bidSize, ask, askSize, last, lastSize,
close, closeDate, settlement, settlementDate, observedAtUtc, marketDataType
(missing keys are null). A symbol without an entry gets no quote.

Usage:
    python3 scripts/cost_basis_fop_synthetic_backend.py --ws-port 8799 --http-port 8123
"""
import argparse
import asyncio
import functools
import http.server
import json
import os
import pathlib
import sys
import tempfile
import threading

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
LIVE_PORT = 8765
BLANK_PAGE = """<!doctype html><meta charset="utf-8"><title>synthetic FOP backend</title>
<p>Synthetic FOP backend on 127.0.0.1:{port}. The ledger pages opened from here use it.</p>
<script>localStorage.setItem('optionComboWsHost', '127.0.0.1');
localStorage.setItem('optionComboWsPort', '{port}');</script>
"""

QUOTES = {}
CONTRACTS = {'available': True, 'details': []}
POSITIONS = {'available': True, 'connected': True, 'ready': True, 'accounts': [], 'items': []}
# A flat 4% continuous zero curve in the backend's canonical (schema 2) form.
FLAT_CURVE = {'schemaVersion': 2, 'curveAsOf': '2026-11-11', 'currency': 'USD', 'source': 'synthetic_flat_4pct',
              'points': [{'tenorDays': days, 'zeroRate': 0.04, 'discountFactor': 2.718281828459045 ** (-0.04 * days / 365)}
                         for days in (1, 7, 30, 90, 180, 365)]}
CURVE = {'available': True, 'curve': FLAT_CURVE, 'status': 'cached', 'error': ''}
ACTIONS = []
LOCK = threading.Lock()
# The WebSocket handler's own environment, once main() made it.
ENV = {}


def _quote_for(query):
    with LOCK:
        entry = QUOTES.get(query.get('localSymbol') or '')
    if entry is None:
        return None
    fields = ('bid', 'bidSize', 'ask', 'askSize', 'last', 'lastSize', 'close', 'closeDate', 'settlement',
              'settlementDate', 'observedAtUtc', 'marketDataType')
    raw = {field: entry.get(field) for field in fields}
    raw.update(contractId=query['contractId'], conId=entry.get('conId', query.get('conId')),
               localSymbol=query.get('localSymbol'), secType=query['secType'])
    return raw


async def synthetic_market_snapshot(queries):
    """The simulated broker: one answer per query that the table knows."""
    return [raw for raw in (_quote_for(query) for query in queries) if raw is not None]


async def synthetic_contract_details(query):
    """The simulated broker's contract details: the first table entry whose match fields the query has."""
    with LOCK:
        entries = list(CONTRACTS['details'])
    for entry in entries:
        if all(query.get(field) == value for field, value in entry['match'].items()):
            return [dict(detail) for detail in entry['result']]
    return []


async def synthetic_positions():
    """The simulated TWS position set."""
    with LOCK:
        return {key: POSITIONS[key] for key in ('connected', 'ready', 'accounts', 'items')}


async def synthetic_discount_curve():
    """The cached discount curve, answered as the yield-curve backend answers."""
    with LOCK:
        curve, status, error = CURVE['curve'], CURVE['status'], CURVE['error']
    return {'action': 'discount_curve_snapshot', 'status': status, 'fallbackUsed': status == 'cache_fallback',
            'refreshAttempted': False, 'error': error, 'curve': curve}


def _expose():
    """Serve or withdraw a simulated broker capability, as the historical backend lacks it."""
    env = ENV.get('env')
    if env is None:
        return
    env['fetch_fop_contract_details'] = synthetic_contract_details if CONTRACTS['available'] else None
    env['fetch_fop_positions'] = synthetic_positions if POSITIONS['available'] else None
    env['fetch_discount_curve'] = synthetic_discount_curve if CURVE['available'] else None


class SiteHandler(http.server.SimpleHTTPRequestHandler):
    ws_port = None

    def log_message(self, fmt, *args):  # keep the console for actions
        pass

    def _json(self, status, body):
        data = json.dumps(body).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802 - http.server API
        path = self.path.split('?', 1)[0]
        if path in ('/', '/index.html'):
            data = BLANK_PAGE.format(port=self.ws_port).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path == '/__synthetic/actions':
            with LOCK:
                self._json(200, {'actions': list(ACTIONS)})
            return
        super().do_GET()

    def do_POST(self):  # noqa: N802 - http.server API
        path = self.path.split('?', 1)[0]
        if path not in ('/__synthetic/quotes', '/__synthetic/contracts', '/__synthetic/positions',
                        '/__synthetic/curve'):
            self._json(404, {'error': 'not found'})
            return
        length = int(self.headers.get('Content-Length') or 0)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
            if not isinstance(body, dict):
                raise ValueError('the body must be an object')
            if path == '/__synthetic/quotes' and not isinstance(body.get('quotes'), dict):
                raise ValueError('quotes must be an object')
        except ValueError as exc:
            self._json(400, {'error': str(exc)})
            return
        with LOCK:
            if path == '/__synthetic/quotes':
                QUOTES.clear()
                QUOTES.update(body['quotes'])
            elif path == '/__synthetic/contracts':
                CONTRACTS.update(available=bool(body.get('available', True)), details=list(body.get('details') or []))
            elif path == '/__synthetic/curve':
                CURVE.update(available=bool(body.get('available', True)), curve=body.get('curve') or FLAT_CURVE,
                             status=str(body.get('status') or 'cached'), error=str(body.get('error') or ''))
            else:
                POSITIONS.update(available=bool(body.get('available', True)),
                                 connected=bool(body.get('connected', True)), ready=bool(body.get('ready', True)),
                                 accounts=list(body.get('accounts') or []), items=list(body.get('items') or []))
            _expose()
        self._json(200, {'ok': True})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--ws-port', type=int, default=8799)
    parser.add_argument('--http-port', type=int, default=8123)
    parser.add_argument('--db', help='database path (default: a new temporary directory)')
    args = parser.parse_args(argv)
    if LIVE_PORT in (args.ws_port, args.http_port):
        parser.error(f'port {LIVE_PORT} belongs to the live backend')
    db_path = pathlib.Path(args.db) if args.db else pathlib.Path(tempfile.mkdtemp(prefix='fop-synthetic-')) / \
        'cost_basis.db'
    os.environ['OPTION_COMBO_COST_BASIS_DB_PATH'] = str(db_path)
    sys.path.insert(0, str(REPO_ROOT))

    import websockets

    import cost_basis_ws
    from cost_basis_store import CostBasisStore

    store = CostBasisStore(db_path, fop_writes_enabled=True).initialize()
    env = cost_basis_ws.create_store_env(None, environ={})
    env.update(store=store, available=True, _initialized=True,
               fetch_fop_market_snapshot=synthetic_market_snapshot,
               fetch_fop_contract_details=synthetic_contract_details, fetch_fop_positions=synthetic_positions,
               fetch_discount_curve=synthetic_discount_curve)
    ENV['env'] = env

    async def handler(socket):
        async for message in socket:
            try:
                data = json.loads(message)
            except ValueError:
                continue
            with LOCK:
                ACTIONS.append(data.get('action'))
            if await cost_basis_ws.handle_cost_basis_action(env, socket, data):
                continue
            await socket.send(json.dumps({'action': data.get('action'), 'requestId': data.get('requestId'),
                                          'success': False, 'code': 'not_served_by_this_backend'}))

    handler_class = functools.partial(type('Site', (SiteHandler,), {'ws_port': args.ws_port}),
                                      directory=str(REPO_ROOT))
    site = http.server.ThreadingHTTPServer(('127.0.0.1', args.http_port), handler_class)
    threading.Thread(target=site.serve_forever, daemon=True).start()

    async def serve():
        async with websockets.serve(handler, '127.0.0.1', args.ws_port):
            print(f'synthetic FOP backend: ws 127.0.0.1:{args.ws_port}, site 127.0.0.1:{args.http_port}, '
                  f'database {db_path}', flush=True)
            await asyncio.Future()

    asyncio.run(serve())


if __name__ == '__main__':
    main()
