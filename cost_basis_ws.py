"""Shared WebSocket protocol layer for the blended-cost ledger.

Both backends route the same client actions through here so Live and
Historical answer with identical response shapes and error codes. This
module owns ledger access enforcement (loopback, explicitly trusted peers,
or an opt-in remote switch), request validation, and the sync-store to
event-loop bridge (asyncio.to_thread); it never writes SQL itself and never
leaks database paths or raw SQL errors to the browser.

A raised exception must never escape handle_cost_basis_action(): one bad
ledger request must not tear down a socket that is also carrying live
market data and order supervision.

The ledger is a write path for money records, so two rules hold here as
well as in the store: every write carries a client token, event/reset writes
are replay-safe, and nothing in this protocol writes an event the operator
did not confirm in the page. Permanent whole-book deletion cannot retain a
durable idempotency receipt without retaining data about the deleted book;
a retry is still target-safe because the immutable book id no longer exists.
"""

import asyncio
import ipaddress
import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timezone

import cost_basis_fop_broker
import cost_basis_fop_domain
import cost_basis_fop_schema
from cost_basis_store import (
    CostBasisStore,
    CostBasisStoreError,
    EVENT_KINDS,
    InvalidRequestError,
    MAX_IMPORT_EVENTS,
    SCHEMA_USER_VERSION,
    resolve_db_path,
)

logger = logging.getLogger('cost_basis.ws')
OPTION_SCENARIO_INPUT_TIMEOUT_SECONDS = 15.0

SERVER_ACTIONS = {
    'request_cost_basis_status': 'cost_basis_status',
    'list_cost_basis_books': 'cost_basis_books_list',
    'create_cost_basis_book': 'cost_basis_book_created',
    'archive_cost_basis_book': 'cost_basis_book_archived',
    'request_cost_basis_delete_plan': 'cost_basis_delete_plan',
    'delete_cost_basis_book': 'cost_basis_book_deleted',
    'list_cost_basis_events': 'cost_basis_events_list',
    'append_cost_basis_event': 'cost_basis_event_appended',
    'void_cost_basis_event': 'cost_basis_event_voided',
    'append_cost_basis_split_group': 'cost_basis_split_group_appended',
    'void_cost_basis_split_group': 'cost_basis_split_group_voided',
    'import_cost_basis_events': 'cost_basis_events_imported',
    'save_cost_basis_snapshot': 'cost_basis_snapshot_saved',
    'list_cost_basis_snapshots': 'cost_basis_snapshots_list',
    'request_cost_basis_reset_plan': 'cost_basis_reset_plan',
    'reset_cost_basis_book': 'cost_basis_book_reset',
    'rebuild_cost_basis_book': 'cost_basis_book_rebuilt',
    'list_cost_basis_resets': 'cost_basis_resets_list',
    'restore_cost_basis_reset': 'cost_basis_reset_restored',
    'export_cost_basis_backup': 'cost_basis_backup',
    'restore_cost_basis_backup': 'cost_basis_backup_restored',
    'list_cost_basis_import_batches': 'cost_basis_import_batches_list',
    'request_cost_basis_executions': 'cost_basis_executions',
    'request_cost_basis_market_price': 'cost_basis_market_price',
    'request_cost_basis_option_scenario_inputs': 'cost_basis_option_scenario_inputs',
    # Standalone FOP ledger (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §10.2).
    'commit_cost_basis_fop_metadata': 'cost_basis_fop_metadata_committed',
    'request_cost_basis_fop_contract_details': 'cost_basis_fop_contract_details',
    'request_cost_basis_fop_statement_bindings': 'cost_basis_fop_statement_bindings',
    'request_cost_basis_fop_market_snapshot': 'cost_basis_fop_market_snapshot',
    'request_cost_basis_fop_positions': 'cost_basis_fop_positions',
}

COST_BASIS_CLIENT_ACTIONS = frozenset(SERVER_ACTIONS)
# The stress view refreshes its own book and the linked book as one pair and
# sends both snapshot requests at once. Per-connection dispatch is otherwise
# sequential, which would queue the second request behind the first's 8-second
# quote window; the browser's 20-second timeout can then expire before this
# handler's own 15-second deadline has even started. These read-only actions
# run as tasks so paired requests overlap. Ledger writes stay ordered.
CONCURRENT_CLIENT_ACTIONS = frozenset({'request_cost_basis_option_scenario_inputs'})


def build_scenario_inputs_busy_response(data):
    """Keep overload replies correlated and identical to normal endpoint errors."""
    return _error_response(
        SERVER_ACTIONS['request_cost_basis_option_scenario_inputs'], _request_id(data),
        'broker_option_scenario_inputs_busy',
        'Scenario quote requests are busy; retry after the current requests finish',
    )


def read_trusted_peers(config=None, env=None):
    """Parse explicit socket peers, never forwarded headers or DNS names.

    An empty environment override revokes remote access configured in INI.
    Parse the whole list before returning so one typo cannot partially enable it.
    """
    env = os.environ if env is None else env
    key = 'OPTION_COMBO_COST_BASIS_TRUSTED_PEERS'
    if key in env:
        raw = env[key]
    else:
        raw = (config.get('cost_basis', 'trusted_peers', fallback='', raw=True)
               if config is not None else '')
    networks = []
    for entry in str(raw).replace('\n', ',').split(','):
        entry = entry.strip()
        if not entry:
            continue
        if '%' in entry:
            raise ValueError('Scoped trusted peers are not supported')
        network = ipaddress.ip_network(entry, strict=True)
        # Socket peers normalize IPv4-mapped IPv6; policy entries must too.
        if isinstance(network, ipaddress.IPv6Network) and network.network_address.ipv4_mapped:
            if network.prefixlen < 96:
                raise ValueError('Invalid mapped IPv4 network')
            network = ipaddress.ip_network(
                (network.network_address.ipv4_mapped, network.prefixlen - 96))
        if (network.prefixlen == 0 or network.network_address.is_unspecified
                or network.is_multicast):
            raise ValueError('Trusted peers must be specific unicast addresses or networks')
        if network not in networks:
            networks.append(network)
    return tuple(networks)


def create_store_env(config=None, *, environ=None):
    """Describe the ledger store without touching the filesystem.

    Cheap enough to run at module import. The database is opened lazily on
    the first accepted request; a failure only disables the ledger while
    market data, replay, and IB keep running.
    """
    enabled = True
    if config is not None:
        try:
            enabled = config.getboolean('cost_basis', 'enabled', fallback=True)
        except ValueError:
            enabled = True
    try:
        trusted_peers = read_trusted_peers(config, env=environ)
    except ValueError:
        # An invalid remote policy must not interrupt IB or grant partial access.
        logger.warning(
            'Invalid cost_basis.trusted_peers / OPTION_COMBO_COST_BASIS_TRUSTED_PEERS; '
            'remote ledger access disabled. Use explicit IP addresses or CIDRs.')
        trusted_peers = ()
    # Independently of trusted peers, remote access may be an explicit
    # deployment opt-in for every peer, relying on an external
    # authenticated network (e.g. Tailscale). Docker NAT may hide the original
    # peer, so do not infer authentication from private IPs or forwarded headers.
    environment = os.environ if environ is None else environ
    remote_value = environment.get('OPTION_COMBO_COST_BASIS_ALLOW_REMOTE')
    if remote_value is None and config is not None:
        remote_value = config.get('cost_basis', 'allow_remote', fallback='false', raw=True)
    normalized = str(remote_value or '').strip().lower()
    allow_remote = normalized in ('1', 'true', 'yes', 'on')
    if normalized not in ('', '0', 'false', 'no', 'off', '1', 'true', 'yes', 'on'):
        logger.warning('invalid cost basis allow_remote value; remote access disabled')
    if allow_remote:
        logger.warning('cost basis remote access enabled; restrict backend access '
                       'to the authenticated Tailscale network or equivalent')
    return {
        '_config': config,
        '_trusted_peers': trusted_peers,
        '_enabled': enabled,
        'allow_remote': allow_remote,
        '_init_lock': threading.Lock(),
        '_initialized': False,
        'store': None,
        'available': False,
        'reason': '' if enabled else 'disabled',
    }


def ensure_store_initialized(store_env):
    """Open (or create) the ledger once, from a worker thread. Idempotent
    and never raises."""
    if store_env is None:
        return None
    lock = store_env.get('_init_lock')
    if lock is None:
        return store_env
    with lock:
        if store_env.get('_initialized'):
            return store_env
        store_env['_initialized'] = True
        if not store_env.get('_enabled', True):
            logger.info('cost basis ledger disabled by configuration')
            return store_env
        try:
            db_path = resolve_db_path(config=store_env.get('_config'))
            store = CostBasisStore(
                db_path, display_timezone=_display_timezone(store_env.get('_config'))
            ).initialize()
        except CostBasisStoreError as exc:
            logger.error(
                'cost basis ledger unavailable (%s): %s — market data and '
                'replay continue; fix the database location and restart.',
                exc.code, exc,
            )
            store_env['reason'] = exc.code
            return store_env
        store_env['store'] = store
        store_env['available'] = True
        store_env['reason'] = ''
        logger.info('cost basis ledger ready at %s', store.db_path)
        migration = store.last_migration
        if migration and migration.get('backupPath'):
            logger.warning(
                'cost basis ledger migrated from schema v%s to v%s; the previous build '
                'cannot open it. A verified copy of the old file is at %s',
                migration['fromVersion'], migration['toVersion'], migration['backupPath'])
            if migration.get('preservedOrphans'):
                logger.warning(
                    'rows of ledgers deleted before v11 were kept, not removed: %s',
                    migration['preservedOrphans'])
        return store_env


def _display_timezone(config):
    """[tws] timezone: the zone of a FOP row's trade date projection (plan §8.1)."""
    if config is None:
        return 'America/New_York'
    try:
        return (config.get('tws', 'timezone', fallback='') or '').strip() or 'America/New_York'
    except Exception:
        return 'America/New_York'


def _fop_message(data, type_name):
    """Refuse a FOP message the frozen contract refuses, before the store runs."""
    try:
        cost_basis_fop_domain.require_shape(type_name, data, type_name)
    except cost_basis_fop_domain.FopDomainError as exc:
        raise InvalidRequestError(str(exc)) from exc
    return data


def _peer_ip(remote_address):
    """Normalize the transport's actual IP without trusting proxy headers."""
    if not isinstance(remote_address, (tuple, list)):
        return None
    try:
        host = remote_address[0]
    except (TypeError, IndexError, KeyError):
        return None
    if not isinstance(host, str) or not host:
        return None
    candidate = host.strip().lower()
    if '%' in candidate:  # scoped IPv6 like fe80::1%lo0
        candidate = candidate.split('%', 1)[0]
    try:
        ip = ipaddress.ip_address(candidate)
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip


def is_loopback_address(remote_address):
    """Strict loopback check; fails closed on anything unparseable."""
    ip = _peer_ip(remote_address)
    return ip is not None and ip.is_loopback


def is_trusted_peer(remote_address, trusted_peers=()):
    """Loopback is always local; remote ledger access requires explicit opt-in."""
    ip = _peer_ip(remote_address)
    if ip is None:
        return False
    return ip.is_loopback or any(
        ip.version == network.version and ip in network for network in trusted_peers)


async def handle_cost_basis_action(store_env, websocket, data, *,
                                   client_ip='Unknown', send=None):
    """Answer a ledger action. Returns True when the action belonged to this
    protocol (a response was sent), False otherwise."""
    action = data.get('action') if isinstance(data, dict) else None
    if action not in COST_BASIS_CLIENT_ACTIONS:
        return False
    try:
        response = await build_cost_basis_response(
            store_env, websocket, data, client_ip=client_ip
        )
    except Exception:
        logger.exception('cost basis handler failed for action %r', action)
        response = _error_response(
            SERVER_ACTIONS[action], _request_id(data),
            'internal_store_error', 'internal store error',
        )
    try:
        message = json.dumps(response)
        if send is not None:
            await send(websocket, message)
        else:
            await websocket.send(message)
    except Exception:
        logger.warning('failed to send cost basis response for %r', action)
    return True


async def build_cost_basis_response(store_env, websocket, data, *,
                                    client_ip='Unknown'):
    action = data.get('action')
    server_action = SERVER_ACTIONS[action]
    request_id = _request_id(data)
    started = time.monotonic()

    store_env = store_env or {}
    if store_env.get('allow_remote') is not True and not is_trusted_peer(
            getattr(websocket, 'remote_address', None),
            store_env.get('_trusted_peers', ())):
        logger.warning(
            'rejected untrusted cost basis request %s from %s', action, client_ip)
        if action == 'request_cost_basis_status':
            # No path, schema, or availability detail crosses the boundary.
            return {
                'action': server_action,
                'requestId': request_id,
                'success': True,
                'available': False,
                'reason': 'remote_access_disabled',
            }
        return _error_response(
            server_action, request_id,
            'remote_access_disabled',
            'the cost basis ledger requires loopback or an explicitly trusted peer',
        )

    if not store_env.get('_initialized') and store_env.get('_init_lock') is not None:
        await asyncio.to_thread(ensure_store_initialized, store_env)

    store = store_env.get('store')
    if action == 'request_cost_basis_status':
        response = {
            'action': server_action,
            'requestId': request_id,
            'success': True,
            'available': store is not None,
        }
        if store is None:
            response['reason'] = store_env.get('reason') or 'store_unavailable'
        else:
            response['storeSchemaVersion'] = SCHEMA_USER_VERSION
            response['eventKinds'] = list(EVENT_KINDS)
            response['maxImportEvents'] = MAX_IMPORT_EVENTS
            response['features'] = {
                'optionScenarioInputs': callable(
                    store_env.get('fetch_option_scenario_inputs')),
                # A client whose FOP engine differs gets an explicit upgrade
                # error on every FOP write (plan §8.2 item 5).
                'fopLedger': {
                    'engineVersion': cost_basis_fop_domain.FOP_ENGINE_VERSION,
                    'productRules': sorted(cost_basis_fop_domain.SUPPORTED_PRODUCT_RULES),
                    'writesReleased': bool(getattr(store, '_fop_writes_enabled', False)),
                    'contractDetails': callable(store_env.get('fetch_fop_contract_details')),
                    # One-shot quotes (plan §10.2); the historical server has none.
                    'marketSnapshot': callable(store_env.get('fetch_fop_market_snapshot')),
                    # TWS positions of the ledger's account (plan §19 P5-C3).
                    'positions': callable(store_env.get('fetch_fop_positions')),
                    # The statement row types and their mapping (plan §9.7):
                    # the page hands this document to the FOP importer.
                    'importCapabilities': store._fop_capability_list().document,
                },
            }
        return response

    if store is None:
        return _error_response(
            server_action, request_id,
            store_env.get('reason') or 'store_unavailable',
            'the cost basis ledger is unavailable',
        )

    if action == 'request_cost_basis_fop_statement_bindings':
        try:
            _fop_message(data, 'StatementBindingRequest')
            results = await asyncio.to_thread(
                store.issue_statement_binding_credentials, data['bookId'], data['bindings'])
        except CostBasisStoreError as exc:
            _log_result(action, request_id, data, started, error=exc.code)
            return _error_response(server_action, request_id, exc.code, str(exc))
        response = {'action': server_action, 'requestId': request_id, 'success': True,
                    'bookId': data['bookId'], 'results': results}
        _log_result(action, request_id, data, started, result={'results': len(results)})
        return response

    if action == 'request_cost_basis_fop_contract_details':
        fetcher = store_env.get('fetch_fop_contract_details')
        if not callable(fetcher):
            return _error_response(
                server_action, request_id, 'fop_contract_details_unavailable',
                'this backend cannot resolve FOP contracts')
        try:
            _fop_message(data, 'ContractDetailsRequest')
            book = await asyncio.to_thread(store.get_book, _required_str(data, 'bookId'))
            if book.get('fop') is None:
                raise InvalidRequestError('contracts are resolved for FOP ledgers only')
            observed_at = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
            results = await cost_basis_fop_broker.resolve_fop_contracts(
                store, book, data['contracts'], contract_details=fetcher,
                observed_at=observed_at)
        except cost_basis_fop_broker.BrokerResolutionError as exc:
            return _error_response(server_action, request_id, exc.code, str(exc))
        except CostBasisStoreError as exc:
            _log_result(action, request_id, data, started, error=exc.code)
            return _error_response(server_action, request_id, exc.code, str(exc))
        response = {'action': server_action, 'requestId': request_id, 'success': True,
                    'bookId': book['bookId'], 'results': results}
        _log_result(action, request_id, data, started, result={'results': len(results)})
        return response

    if action == 'request_cost_basis_fop_market_snapshot':
        fetcher = store_env.get('fetch_fop_market_snapshot')
        if not callable(fetcher):
            return _error_response(
                server_action, request_id, 'fop_market_snapshot_unavailable',
                'this backend cannot take FOP quotes')
        try:
            _fop_message(data, 'MarketSnapshotRequest')
            scope = await asyncio.to_thread(store.fop_quote_scope, data['bookId'])
            observed_at = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
            result = await cost_basis_fop_broker.snapshot_fop_quotes(
                scope, data['contractIds'], market_snapshot=fetcher, observed_at=observed_at,
                batch_id=f'quotes-{uuid.uuid4().hex}')
        except cost_basis_fop_broker.BrokerResolutionError as exc:
            return _error_response(server_action, request_id, exc.code, str(exc))
        except CostBasisStoreError as exc:
            _log_result(action, request_id, data, started, error=exc.code)
            return _error_response(server_action, request_id, exc.code, str(exc))
        response = {'action': server_action, 'requestId': request_id, 'success': True,
                    'bookId': data['bookId'], **result}
        _log_result(action, request_id, data, started, result={'quotes': len(result['quotes'])})
        return response

    if action == 'request_cost_basis_fop_positions':
        fetcher = store_env.get('fetch_fop_positions')
        if not callable(fetcher):
            return _error_response(
                server_action, request_id, 'fop_positions_unavailable',
                'this backend has no TWS positions to reconcile against')
        try:
            _fop_message(data, 'FopPositionsRequest')
            book = await asyncio.to_thread(store.get_book, data['bookId'])
            if book.get('fop') is None:
                raise InvalidRequestError('positions are reconciled for FOP ledgers only')
            snapshot = await fetcher()
            observed_at = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
            connected, ready, positions = cost_basis_fop_broker.position_evidence(book, snapshot)
            version = await asyncio.to_thread(store.ledger_version, book['bookId'])
            credential = store.issue_positions_credential(
                book['bookId'], ledger_version=version, observed_at=observed_at, account=book['account'],
                positions=positions) if ready else None
        except CostBasisStoreError as exc:
            _log_result(action, request_id, data, started, error=exc.code)
            return _error_response(server_action, request_id, exc.code, str(exc))
        except Exception:
            logger.exception('TWS position read failed')
            return _error_response(server_action, request_id, 'fop_positions_failed',
                                   'failed to read the TWS positions')
        response = {'action': server_action, 'requestId': request_id, 'success': True,
                    'bookId': book['bookId'], 'account': book['account'], 'observedAtUtc': observed_at,
                    'ledgerVersion': version, 'accountConnected': connected, 'positionsReady': ready,
                    'positions': positions, 'evidenceCredential': credential}
        _log_result(action, request_id, data, started, result={'positions': len(positions)})
        return response

    if action == 'request_cost_basis_executions':
        fetcher = store_env.get('fetch_executions')
        if not callable(fetcher):
            return _error_response(
                server_action, request_id, 'broker_execution_history_unavailable',
                'this backend cannot request TWS executions',
            )
        try:
            book = await asyncio.to_thread(
                store.get_book, _required_str(data, 'bookId'))
            result = await fetcher({
                'account': book['account'],
                'symbol': book['symbol'],
                'secType': book['secType'],
                'sinceTimestamp': data.get('sinceTimestamp') or '',
            })
        except CostBasisStoreError as exc:
            _log_result(action, request_id, data, started, error=exc.code)
            return _error_response(server_action, request_id, exc.code, str(exc))
        except Exception:
            logger.exception('TWS execution-history request failed')
            return _error_response(
                server_action, request_id, 'broker_execution_history_failed',
                'failed to request recent TWS executions',
            )
        response = {'action': server_action, 'requestId': request_id, 'success': True}
        response.update(result)
        _log_result(action, request_id, data, started, result=result)
        return response

    if action == 'request_cost_basis_market_price':
        fetcher = store_env.get('fetch_market_price')
        if not callable(fetcher):
            return _error_response(
                server_action, request_id, 'broker_market_price_unavailable',
                'this backend cannot request a fresh TWS market price',
            )
        try:
            book = await asyncio.to_thread(
                store.get_book, _required_str(data, 'bookId'))
            result = await fetcher({
                'account': book['account'],
                'symbol': book['symbol'],
                'secType': book['secType'],
                'currency': book['currency'],
            })
        except CostBasisStoreError as exc:
            _log_result(action, request_id, data, started, error=exc.code)
            return _error_response(server_action, request_id, exc.code, str(exc))
        except Exception:
            logger.exception('fresh TWS market-price request failed')
            return _error_response(
                server_action, request_id, 'broker_market_price_failed',
                'failed to request a fresh TWS market price',
            )
        response = {'action': server_action, 'requestId': request_id, 'success': True}
        response.update(result)
        _log_result(action, request_id, data, started, result=result)
        return response

    if action == 'request_cost_basis_option_scenario_inputs':
        fetcher = store_env.get('fetch_option_scenario_inputs')
        if not callable(fetcher):
            return _error_response(
                server_action, request_id, 'broker_option_scenario_inputs_unavailable',
                'this backend cannot request TWS option scenario inputs',
            )
        raw_contracts = data.get('contracts')
        if not isinstance(raw_contracts, list) or len(raw_contracts) > 128:
            return _error_response(
                server_action, request_id, 'invalid_request',
                'contracts must be a list with at most 128 rows',
            )
        contracts = []
        for raw in raw_contracts:
            if not isinstance(raw, dict):
                return _error_response(
                    server_action, request_id, 'invalid_request',
                    'each contract request must be an object',
                )
            contracts.append({
                'conId': raw.get('conId'),
                'localSymbol': str(raw.get('localSymbol') or '').strip()[:96],
                'right': str(raw.get('right') or '').strip().upper()[:1],
                'strike': raw.get('strike'),
                'expiry': ''.join(
                    character for character in str(raw.get('expiry') or '')
                    if character.isdigit())[:8],
                # The deliverable size disambiguates same-terms contracts when
                # the ledger row carries no conId / localSymbol.
                'multiplier': _optional_positive_float(raw.get('multiplier')),
            })
        try:
            book = await asyncio.to_thread(
                store.get_book, _required_str(data, 'bookId'))
            result = await asyncio.wait_for(fetcher({
                    'account': book['account'],
                    'symbol': book['symbol'],
                    'secType': book['secType'],
                    'currency': book['currency'],
                    'throughExpiry': ''.join(
                        character for character in str(data.get('throughExpiry') or '')
                        if character.isdigit())[:8],
                    'contracts': contracts,
                }), timeout=OPTION_SCENARIO_INPUT_TIMEOUT_SECONDS)
        except CostBasisStoreError as exc:
            _log_result(action, request_id, data, started, error=exc.code)
            return _error_response(server_action, request_id, exc.code, str(exc))
        except asyncio.TimeoutError:
            _log_result(
                action, request_id, data, started,
                error='broker_option_scenario_inputs_timeout')
            return _error_response(
                server_action, request_id,
                'broker_option_scenario_inputs_timeout',
                'TWS option inputs exceeded the 15-second server deadline',
            )
        except ValueError as exc:
            return _error_response(
                server_action, request_id, 'invalid_request', str(exc),
            )
        except Exception:
            logger.exception('TWS option scenario-input request failed')
            return _error_response(
                server_action, request_id, 'broker_option_scenario_inputs_failed',
                'failed to request current TWS option IV or discount inputs',
            )
        response = {'action': server_action, 'requestId': request_id, 'success': True}
        response.update(result)
        _log_result(action, request_id, data, started, result=result)
        return response

    try:
        result = await _dispatch_store_call(store, action, data)
    except CostBasisStoreError as exc:
        _log_result(action, request_id, data, started, error=exc.code)
        return _error_response(server_action, request_id, exc.code, str(exc))
    except Exception:
        logger.exception('unexpected ledger failure for action %r', action)
        _log_result(action, request_id, data, started, error='internal_store_error')
        return _error_response(
            server_action, request_id, 'internal_store_error', 'internal store error'
        )

    response = {'action': server_action, 'requestId': request_id, 'success': True}
    response.update(result)
    _log_result(action, request_id, data, started, result=result)
    return response


async def _dispatch_store_call(store, action, data):
    if action == 'list_cost_basis_books':
        books = await asyncio.to_thread(
            lambda: store.list_books(
                include_archived=data.get('includeArchived') is True)
        )
        return {'books': books}

    if action == 'create_cost_basis_book':
        # The ledger type is stated, never assumed: defaulting to STK would
        # turn a CL request into a stock ledger for a futures root
        # (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §1.1). Only a stock
        # ledger keeps the conventional 100 shares per contract.
        sec_type = _required_str(data, 'secType').strip().upper()
        if 'fop' in data:
            # A FOP ledger: FUT with FOP metadata and no stock multiplier.
            _fop_message(data, 'FopBookCreateRequest')
            book = await asyncio.to_thread(lambda: store.create_fop_book(
                account=data['account'], symbol=data['symbol'], start_date=data['startDate'],
                currency=data['currency'], note=data['note'], fop=data['fop']))
            return {'book': book}
        shares_per_contract = data.get('defaultSharesPerContract')
        if shares_per_contract in (None, ''):
            if sec_type != 'STK':
                raise InvalidRequestError(
                    'defaultSharesPerContract is required unless secType is STK')
            shares_per_contract = 100
        book = await asyncio.to_thread(
            lambda: store.create_book(
                account=_required_str(data, 'account'),
                symbol=_required_str(data, 'symbol'),
                start_date=_required_str(data, 'startDate'),
                sec_type=sec_type,
                currency=data.get('currency') or 'USD',
                default_shares_per_contract=shares_per_contract,
                note=data.get('note') or '',
            )
        )
        return {'book': book}

    if action == 'archive_cost_basis_book':
        book = await asyncio.to_thread(
            store.archive_book, _required_str(data, 'bookId'))
        return {'book': book}

    if action == 'request_cost_basis_delete_plan':
        return await asyncio.to_thread(
            store.delete_confirmation, _required_str(data, 'bookId'))

    if action == 'delete_cost_basis_book':
        # A full deletion is intentionally separate from reset/rebuild: it
        # removes events, snapshots, reset archives and the book row itself.
        # The store rechecks the count-bearing phrase under the write lock.
        return await asyncio.to_thread(
            lambda: store.delete_book(
                _required_str(data, 'bookId'),
                confirmation=_required_str(data, 'confirmation'),
                client_token=_required_str(data, 'clientToken'),
            )
        )

    if action == 'list_cost_basis_events':
        return await asyncio.to_thread(
            lambda: store.list_events(
                _required_str(data, 'bookId'),
                account=data.get('account') or None,
                kinds=_optional_list(data, 'kinds'),
                start_date=data.get('startDate') or None,
                end_date=data.get('endDate') or None,
                include_voided=data.get('includeVoided') is True,
                limit=_optional_int(data, 'limit'),
                offset=_optional_int(data, 'offset') or 0,
            )
        )

    if action == 'append_cost_basis_event':
        if 'fopPackage' in data:
            _fop_message(data, 'AppendRequest')
            return await asyncio.to_thread(lambda: store.append_fop_event(
                data['bookId'], data['fopPackage'], client_token=data['clientToken'],
                expected_ledger_version=data['expectedLedgerVersion'],
                book_identity=data['bookIdentity']))
        return await asyncio.to_thread(
            lambda: store.append_event(
                _required_str(data, 'bookId'),
                _required_object(data, 'event'),
                client_token=_required_str(data, 'clientToken'),
                allow_overdraw=data.get('allowOverdraw') is True,
            )
        )

    if action == 'void_cost_basis_event':
        if await asyncio.to_thread(store._is_fop_book, _required_str(data, 'bookId')):
            _fop_message(data, 'VoidRequest')
            return await asyncio.to_thread(lambda: store.void_fop_event(
                data['bookId'], data['eventId'], reason=data['reason'],
                client_token=data['clientToken'],
                expected_ledger_version=data['expectedLedgerVersion'],
                book_identity=data['bookIdentity'], engine_version=data['engineVersion']))
        return await asyncio.to_thread(
            lambda: store.void_event(
                _required_str(data, 'bookId'),
                _required_str(data, 'eventId'),
                reason=_required_str(data, 'reason'),
                client_token=_required_str(data, 'clientToken'),
            )
        )

    if action == 'append_cost_basis_split_group':
        # One standard split and all of its option conversions, as a whole.
        events = data.get('events')
        if not isinstance(events, list):
            raise InvalidRequestError('events must be a list')
        return await asyncio.to_thread(
            lambda: store.append_split_group(
                _required_str(data, 'bookId'),
                events,
                client_token=_required_str(data, 'clientToken'),
                expected_ledger_version=data.get('expectedLedgerVersion'),
                book_identity=data.get('bookIdentity'),
            )
        )

    if action == 'void_cost_basis_split_group':
        return await asyncio.to_thread(
            lambda: store.void_split_group(
                _required_str(data, 'bookId'),
                _required_str(data, 'splitGroup'),
                reason=_required_str(data, 'reason'),
                client_token=_required_str(data, 'clientToken'),
            )
        )

    if action == 'import_cost_basis_events':
        if 'fopPackage' in data:
            _fop_message(data, 'ImportRequest')
            return await asyncio.to_thread(lambda: store.import_fop_events(
                data['bookId'], data['fopPackage'], statement=data['statement'],
                import_batch_id=data['importBatchId'], client_token_prefix=data['clientTokenPrefix'],
                supersede_tws_event_ids=data['supersedeTwsEventIds'],
                expected_ledger_version=data['expectedLedgerVersion'],
                book_identity=data['bookIdentity'],
                duplicate_decisions=data.get('duplicateDecisions') or []))
        events = data.get('events')
        supersede_tws_event_ids = data.get('supersedeTwsEventIds', [])
        supersede_prior_stub_event_ids = data.get('supersedePriorStubEventIds', [])
        tws_reconciliation = data.get('twsReconciliation')
        if not isinstance(events, list):
            raise InvalidRequestError('events must be a list')
        if not isinstance(supersede_tws_event_ids, list):
            raise InvalidRequestError('supersedeTwsEventIds must be a list')
        if not isinstance(supersede_prior_stub_event_ids, list):
            raise InvalidRequestError('supersedePriorStubEventIds must be a list')
        if len(events) > MAX_IMPORT_EVENTS:
            raise InvalidRequestError(
                f'an import batch is limited to {MAX_IMPORT_EVENTS} rows')
        return await asyncio.to_thread(
            lambda: store.import_events(
                _required_str(data, 'bookId'),
                events,
                import_batch_id=_required_str(data, 'importBatchId'),
                client_token_prefix=_required_str(data, 'clientTokenPrefix'),
                allow_overdraw=data.get('allowOverdraw') is True,
                supersede_tws_event_ids=supersede_tws_event_ids,
                tws_reconciliation=tws_reconciliation,
                # The browser states which ledger version and identity it
                # prepared the batch for; the store holds it to both.
                expected_ledger_version=data.get('expectedLedgerVersion'),
                book_identity=data.get('bookIdentity'),
                supersede_prior_stub_event_ids=supersede_prior_stub_event_ids,
                statement=data.get('statement'),
            )
        )

    if action == 'request_cost_basis_reset_plan':
        plan = await asyncio.to_thread(
            store.reset_confirmation, _required_str(data, 'bookId'))
        return plan

    if action == 'reset_cost_basis_book':
        if await asyncio.to_thread(store._is_fop_book, _required_str(data, 'bookId')):
            _fop_message(data, 'FopResetRequest')
        # The recoverable path that deletes active events. Whole-book
        # deletion is a separate, explicitly permanent operation. This
        # identity, version and phrase are rechecked in the write transaction;
        # a stale plan cannot remove a different history of the same size.
        return await asyncio.to_thread(
            lambda: store.reset_book(
                _required_str(data, 'bookId'),
                confirmation=_required_str(data, 'confirmation'),
                client_token=_required_str(data, 'clientToken'),
                reason=data.get('reason') or '',
                expected_ledger_version=data.get('expectedLedgerVersion'),
                book_identity=data.get('bookIdentity'),
                # A FOP request names its engine (FopResetRequest); a stock one
                # has none and the stock path does not read it.
                engine_version=data.get('engineVersion'),
            )
        )

    if action == 'rebuild_cost_basis_book':
        # Archive, wipe and refill in one transaction. Never expose this as
        # two calls: a failure between them would leave an empty ledger.
        if 'fopPackage' in data:
            _fop_message(data, 'FopRebuildRequest')
            return await asyncio.to_thread(lambda: store.rebuild_fop_book(
                data['bookId'], data['fopPackage'], confirmation=data['confirmation'],
                client_token=data['clientToken'], import_batch_id=data['importBatchId'],
                statement=data['statement'], revoke_boundaries=data['revokeBoundaries'],
                reason=data['reason'], expected_ledger_version=data['expectedLedgerVersion'],
                book_identity=data['bookIdentity']))
        events = data.get('events')
        if not isinstance(events, list):
            raise InvalidRequestError('events must be a list')
        if len(events) > MAX_IMPORT_EVENTS:
            raise InvalidRequestError(
                f'a rebuild is limited to {MAX_IMPORT_EVENTS} rows')
        return await asyncio.to_thread(
            lambda: store.rebuild_book(
                _required_str(data, 'bookId'),
                events,
                confirmation=_required_str(data, 'confirmation'),
                client_token=_required_str(data, 'clientToken'),
                import_batch_id=_required_str(data, 'importBatchId'),
                allow_overdraw=data.get('allowOverdraw') is True,
                reason=data.get('reason') or '',
                expected_ledger_version=data.get('expectedLedgerVersion'),
                book_identity=data.get('bookIdentity'),
                statement=data.get('statement'),
            )
        )

    if action == 'restore_cost_basis_reset':
        # Put an archived ledger back. Same phrase-and-digest gate as a
        # rebuild: the live rows are archived first inside one transaction.
        if await asyncio.to_thread(store._is_fop_book, _required_str(data, 'bookId')):
            _fop_message(data, 'FopRestoreResetRequest')
        return await asyncio.to_thread(
            lambda: store.restore_book_reset(
                _required_str(data, 'bookId'),
                _required_str(data, 'resetId'),
                confirmation=_required_str(data, 'confirmation'),
                client_token=_required_str(data, 'clientToken'),
                expected_ledger_version=data.get('expectedLedgerVersion'),
                book_identity=data.get('bookIdentity'),
                engine_version=data.get('engineVersion'),
            )
        )

    if action == 'export_cost_basis_backup':
        return await asyncio.to_thread(store.export_backup, _required_str(data, 'bookId'))

    if action == 'restore_cost_basis_backup':
        if await asyncio.to_thread(store._is_fop_book, _required_str(data, 'bookId')):
            _fop_message(data, 'FopRestoreBackupRequest')
        return await asyncio.to_thread(lambda: store.restore_backup(
            _required_str(data, 'bookId'), _required_object(data, 'backup'),
            confirmation=_required_str(data, 'confirmation'),
            client_token=_required_str(data, 'clientToken'),
            expected_ledger_version=data.get('expectedLedgerVersion'),
            book_identity=data.get('bookIdentity'), engine_version=data.get('engineVersion')))

    if action == 'list_cost_basis_import_batches':
        batches = await asyncio.to_thread(
            lambda: store.list_import_batches(
                _required_str(data, 'bookId'),
                limit=_optional_int(data, 'limit') or 60,
            )
        )
        return {'batches': batches}

    if action == 'list_cost_basis_resets':
        resets = await asyncio.to_thread(
            lambda: store.list_book_resets(
                _required_str(data, 'bookId'),
                limit=_optional_int(data, 'limit') or 20,
            )
        )
        return {'resets': resets}

    if action == 'save_cost_basis_snapshot' and 'expectedLedgerVersion' in data:
        # A FOP ledger's reconciliation snapshot (SnapshotRequest, plan §10.3).
        _fop_message(data, 'SnapshotRequest')
        snapshot = await asyncio.to_thread(lambda: store.save_fop_snapshot(
            data['bookId'], expected_ledger_version=data['expectedLedgerVersion'],
            book_identity=data['bookIdentity'], as_of_date=data['asOfDate'], summary=data['summary'],
            account_scope=data['accountScope'], tws_snapshot=data['twsSnapshot'],
            reconciled=data['reconciled'], note=data['note']))
        return {'snapshot': snapshot, 'idempotentReplay': snapshot.pop('idempotentReplay')}

    if action == 'save_cost_basis_snapshot':
        snapshot = await asyncio.to_thread(
            lambda: store.save_snapshot(
                _required_str(data, 'bookId'),
                as_of_date=_required_str(data, 'asOfDate'),
                summary=_required_object(data, 'summary'),
                account_scope=data.get('accountScope') or '',
                tws_snapshot=data.get('twsSnapshot'),
                reconciled=data.get('reconciled') is True,
                note=data.get('note') or '',
            )
        )
        return {'snapshot': snapshot}

    if action == 'list_cost_basis_snapshots':
        snapshots = await asyncio.to_thread(
            lambda: store.list_snapshots(
                _required_str(data, 'bookId'),
                limit=_optional_int(data, 'limit') or 50,
            )
        )
        return {'snapshots': snapshots}

    if action == 'commit_cost_basis_fop_metadata':
        _fop_message(data, 'MetadataCommitRequest')
        return await asyncio.to_thread(lambda: store.commit_fop_metadata(
            data['bookId'], data['operation'], client_token=data['clientToken'],
            expected_ledger_version=data['expectedLedgerVersion'],
            book_identity=data['bookIdentity'], engine_version=data['engineVersion']))

    raise InvalidRequestError(f'unhandled cost basis action {action}')


def _request_id(data):
    request_id = data.get('requestId') if isinstance(data, dict) else None
    return request_id if isinstance(request_id, str) else ''


def _required_str(data, field):
    value = data.get(field)
    if not isinstance(value, str) or not value:
        raise InvalidRequestError(f'{field} is required')
    return value


def _required_object(data, field):
    value = data.get(field)
    if not isinstance(value, dict):
        raise InvalidRequestError(f'{field} must be an object')
    return value


def _optional_list(data, field):
    value = data.get(field)
    if value is None:
        return None
    if not isinstance(value, list):
        raise InvalidRequestError(f'{field} must be a list')
    return value


def _optional_int(data, field):
    value = data.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise InvalidRequestError(f'{field} must be an integer')
    return value


def _optional_positive_float(value):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed != parsed or parsed <= 0:
        return None
    return parsed


def _error_response(server_action, request_id, code, message):
    return {
        'action': server_action,
        'requestId': request_id,
        'success': False,
        'code': code,
        'message': message,
    }


def _log_result(action, request_id, data, started, result=None, error=None):
    elapsed_ms = int((time.monotonic() - started) * 1000)
    book_id = data.get('bookId', '') if isinstance(data, dict) else ''
    if error is not None:
        logger.warning(
            'cost basis %s request=%s book=%s failed code=%s in %dms',
            action, request_id, book_id, error, elapsed_ms,
        )
        return
    detail = ''
    if isinstance(result, dict):
        if 'inserted' in result:
            detail = f"inserted={result.get('inserted')} skipped={result.get('skipped')}"
        elif isinstance(result.get('event'), dict):
            detail = f"seq={result['event'].get('seq', '')}"
        elif 'total' in result:
            detail = f"total={result.get('total')}"
    logger.info(
        'cost basis %s request=%s book=%s %s ok in %dms',
        action, request_id, book_id, detail, elapsed_ms,
    )
