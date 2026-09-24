// P0 guard: FUT/FOP ledgers are frozen until the standalone FOP ledger ships.
//
// CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §2 and §13.3 P0. The store
// refuses the writes (tests/cost_basis_fop_guard_test.py); these cases check
// that the page never sends them, that it says why, and that the P0 fixtures
// the later phases build on are well formed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));

const FUT_BOOK = {
    bookId: 'book-fut', account: 'U1111111', symbol: 'ES', secType: 'FUT',
    currency: 'USD', startDate: '2026-01-01', defaultSharesPerContract: 50,
};
const STK_BOOK = {
    bookId: 'book-stk', account: 'U1111111', symbol: 'TQQQ', secType: 'STK',
    currency: 'USD', startDate: '2026-01-01', defaultSharesPerContract: 100,
};

// Every allowed action that does not change the ledger. A new write added to
// ALLOWED_CLIENT_ACTIONS fails the classification case below until someone
// decides whether it must be frozen for FUT ledgers.
const READ_ONLY_ACTIONS = [
    'request_cost_basis_status', 'list_cost_basis_books', 'request_cost_basis_delete_plan',
    'list_cost_basis_events', 'request_cost_basis_reset_plan', 'list_cost_basis_resets',
    'export_cost_basis_backup', 'list_cost_basis_import_batches',
    'request_portfolio_positions_snapshot', 'request_portfolio_avg_cost_snapshot',
    'request_managed_accounts_snapshot', 'request_cost_basis_executions',
    'request_cost_basis_market_price', 'request_cost_basis_option_scenario_inputs',
];

function loadCore() {
    return loadBrowserScripts(['js/cost_basis_core.js']).OptionComboCostBasisCore;
}

function loadGuardHarness() {
    const context = loadBrowserScripts([
        'js/cost_basis_core.js',
        'js/american_binomial.js',
        'js/cost_basis_import_common.js', 'js/cost_basis_import.js',
        'js/cost_basis.js',
    ]);
    vm.runInContext(read('js/cost_basis.js').replace(
        'globalScope.OptionComboCostBasisPage = {', `
        globalScope.fopGuardHarness = {
            state, request, renderBookMeta: _renderBookMeta, message: _handleMessage,
        };
        globalScope.OptionComboCostBasisPage = {`), context);
    const nodes = new Map();
    context.document = {
        getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, { textContent: '' });
            return nodes.get(id);
        },
    };
    const sent = [];
    const h = context.fopGuardHarness;
    h.state.ws = { readyState: 1, send: (message) => sent.push(JSON.parse(message)) };
    h.state.books = [Object.assign({}, FUT_BOOK), Object.assign({}, STK_BOOK)];
    return { h, core: context.OptionComboCostBasisCore, nodes, sent };
}

// Answer the one outstanding request so its timeout timer is cleared.
async function answer(harness, sentMessage) {
    harness.message({ action: sentMessage.action, requestId: sentMessage.requestId, success: true });
}

module.exports = {
    name: 'cost_basis_fop_guard',
    tests: [
        {
            name: 'every allowed page action is classified as read-only, frozen for FUT, create or delete',
            run() {
                const core = loadCore();
                const frozen = Array.from(core.FUTURES_FROZEN_WRITE_ACTIONS);
                frozen.forEach((action) => assert.ok(
                    core.ALLOWED_CLIENT_ACTIONS.includes(action), action));
                const classified = new Set(READ_ONLY_ACTIONS.concat(
                    frozen, ['create_cost_basis_book', 'delete_cost_basis_book']));
                Array.from(core.ALLOWED_CLIENT_ACTIONS).forEach((action) => assert.ok(
                    classified.has(action), `${action} is neither read-only nor frozen`));
                READ_ONLY_ACTIONS.forEach((action) => assert.ok(!frozen.includes(action), action));
            },
        },
        {
            name: 'the core names a reason for every FUT write and none for reads, export or deletion',
            run() {
                const core = loadCore();
                const reason = core.frozenFuturesWriteReason;
                core.FUTURES_FROZEN_WRITE_ACTIONS.forEach((action) => {
                    assert.equal(reason(action, { bookId: 'book-fut' }, FUT_BOOK),
                        core.FUTURES_FROZEN_MESSAGE, action);
                    assert.equal(reason(action, { bookId: 'book-stk' }, STK_BOOK), '', action);
                    assert.equal(reason(action, { bookId: 'unknown' }, null), '', action);
                });
                READ_ONLY_ACTIONS.concat(['delete_cost_basis_book']).forEach((action) => {
                    assert.equal(reason(action, { bookId: 'book-fut' }, FUT_BOOK), '', action);
                });
                assert.equal(reason('create_cost_basis_book', { secType: 'FUT' }, null),
                    core.FUTURES_FROZEN_MESSAGE);
                assert.equal(reason('create_cost_basis_book', { secType: ' fut ' }, null),
                    core.FUTURES_FROZEN_MESSAGE);
                assert.equal(reason('create_cost_basis_book', { secType: 'STK' }, null), '');
                assert.equal(reason('append_cost_basis_event', { bookId: 'book-fut' },
                    Object.assign({}, FUT_BOOK, { secType: 'fut' })), core.FUTURES_FROZEN_MESSAGE);
            },
        },
        {
            name: 'the page stops frozen FUT writes before they reach the socket',
            async run() {
                const { h, core, sent } = loadGuardHarness();
                for (const action of core.FUTURES_FROZEN_WRITE_ACTIONS) {
                    await assert.rejects(
                        h.request(action, { bookId: 'book-fut' }),
                        (error) => error.message === core.FUTURES_FROZEN_MESSAGE, action);
                }
                await assert.rejects(
                    h.request('create_cost_basis_book', { secType: 'FUT', symbol: 'CL' }),
                    (error) => error.message === core.FUTURES_FROZEN_MESSAGE);
                assert.equal(sent.length, 0, 'no frozen write may reach the socket');

                const stockWrite = h.request('append_cost_basis_event', { bookId: 'book-stk' });
                assert.equal(sent.length, 1);
                assert.equal(sent[0].action, 'append_cost_basis_event');
                await answer(h, sent[0]);
                await stockWrite;

                const futExport = h.request('export_cost_basis_backup', { bookId: 'book-fut' });
                assert.equal(sent.length, 2);
                await answer(h, sent[1]);
                await futExport;
                const futDeletePlan = h.request('request_cost_basis_delete_plan', { bookId: 'book-fut' });
                assert.equal(sent.length, 3);
                await answer(h, sent[2]);
                await futDeletePlan;
            },
        },
        {
            name: 'a FUT ledger explains that it is read-only and a stock ledger does not',
            run() {
                const { h, core, nodes } = loadGuardHarness();
                h.state.eventsTotal = 1;
                h.state.bookId = 'book-fut';
                h.renderBookMeta();
                assert.ok(nodes.get('book-meta').textContent.includes(core.FUTURES_FROZEN_MESSAGE));
                h.state.bookId = 'book-stk';
                h.renderBookMeta();
                assert.ok(!nodes.get('book-meta').textContent.includes(core.FUTURES_FROZEN_MESSAGE));
            },
        },
        {
            name: 'the create form keeps FOP / FUT visible but disabled',
            run() {
                const html = read('cost_basis.html');
                assert.match(html, /<option value="FUT" disabled>FOP \/ FUT（已停用）<\/option>/);
                assert.doesNotMatch(html, /<option value="FUT">/);
                assert.match(html, /<option value="STK">股票 \/ ETF 期权<\/option>/);
                assert.match(html, /FOP \/ FUT 账本暂停新建/);
            },
        },
        {
            name: 'the capability draft is well formed and marks no row type real_verified',
            run() {
                const document = readJson('cost_basis_fop_capabilities.json');
                const statuses = ['real_verified', 'synthetic_only', 'out_of_scope', 'unsupported'];
                assert.equal(document.format, 'cost-basis-fop-capabilities');
                assert.deepEqual(Object.keys(document.statusDefinitions).sort(), statuses.slice().sort());
                const keyPattern = /^(activity|flex)\/[a-z_]+\/[A-Z]+(\.[a-z_]+)?\/[a-z_]+$/;
                const keys = document.keys.map((entry) => entry.key);
                assert.equal(new Set(keys).size, keys.length, 'duplicate capability key');
                document.keys.forEach((entry) => {
                    assert.match(entry.key, keyPattern);
                    assert.ok(statuses.includes(entry.status), entry.key);
                    assert.notEqual(entry.status, 'real_verified', entry.key);
                    assert.ok(Array.isArray(entry.evidence), entry.key);
                    assert.ok(entry.evidence.every((item) => item.kind !== 'deidentified_real'),
                        entry.key);
                });
                assert.deepEqual(Array.from(new Set(document.keys.map((entry) => entry.status))).sort(),
                    ['out_of_scope', 'synthetic_only', 'unsupported']);
            },
        },
        {
            name: 'the month collision gold standard is internally consistent',
            run() {
                const vector = readJson('tests/fixtures/cost_basis_fop/month_collision.json');
                assert.equal(vector.source, 'synthetic');
                // Independent replay by true contract: weighted average, gross
                // realized on closes. Deliberately not the production core.
                const positions = new Map();
                let realized = 0;
                vector.events.forEach((event) => {
                    const terms = vector.contracts[event.localSymbol];
                    const recorded = event.recordedDate.replace(/[^0-9]/g, '');
                    assert.equal(recorded, event.recordedDateMeaning === 'delivery_month'
                        ? terms.deliveryMonth : terms.lastTradeDate, event.ref);
                    const held = positions.get(event.localSymbol) || { contracts: 0, basis: 0 };
                    if (held.contracts !== 0 && Math.sign(event.contracts) !== Math.sign(held.contracts)) {
                        const closing = Math.min(Math.abs(event.contracts), Math.abs(held.contracts));
                        const average = held.basis / held.contracts;
                        realized += Math.sign(held.contracts) * closing * vector.pointValue
                            * (event.price - average);
                        held.basis -= Math.sign(held.contracts) * closing * average;
                        held.contracts -= Math.sign(held.contracts) * closing;
                        const rest = event.contracts + Math.sign(event.contracts) * -closing;
                        held.contracts += rest;
                        held.basis += rest * event.price;
                    } else {
                        held.contracts += event.contracts;
                        held.basis += event.contracts * event.price;
                    }
                    positions.set(event.localSymbol, held);
                });
                assert.equal(realized, vector.expected.futuresRealizedPnl);
                vector.expected.positions.forEach((expected) => {
                    const held = positions.get(expected.localSymbol);
                    assert.equal(held.contracts, expected.contracts, expected.localSymbol);
                    assert.equal(held.basis / held.contracts, expected.averagePrice, expected.localSymbol);
                    assert.equal(vector.contracts[expected.localSymbol].deliveryMonth,
                        expected.deliveryMonth);
                });
                // The defect, stated on the data rather than on the engine: a
                // six-digit prefix gives the hand-entered CLZ6 and the CSV
                // CLF7 the same "month".
                const prefix = (ref) => vector.events.find((event) => event.ref === ref)
                    .recordedDate.replace(/[^0-9]/g, '').slice(0, 6);
                assert.equal(prefix('manual-z6'), prefix('csv-f7'));
                assert.notEqual(vector.contracts.CLZ6.deliveryMonth, vector.contracts.CLF7.deliveryMonth);
            },
        },
        {
            name: 'the legacy FUT migration list keeps every converted test',
            run() {
                const list = readJson('tests/fixtures/cost_basis_fop/legacy_fut_migration_list.json');
                assert.ok(list.entries.length >= 13);
                list.entries.forEach((entry) => {
                    assert.ok(entry.source && entry.p0 && entry.newEngine && entry.vector, entry.source);
                    const file = entry.source.split('::')[0];
                    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
                });
                const storeTests = read('tests/cost_basis_store_test.py');
                assert.doesNotMatch(storeTests, /class FuturesLedgerStoreTests/);
                [
                    'test_future_trade_and_roll_round_trip_all_contract_fields',
                    'test_negative_futures_prices_are_valid_and_round_trip',
                    'test_month_and_last_trade_date_share_one_futures_timeline',
                    'test_book_type_boundary_rejects_cross_asset_events',
                    'test_roll_cannot_transfer_a_month_the_ledger_does_not_hold',
                    'test_fop_assignment_opens_one_future_at_strike_with_fees_only_cash',
                    'test_complete_csv_history_supersedes_an_adopted_future_baseline',
                    'test_incremental_csv_after_snapshot_keeps_the_adopted_baseline',
                    'test_roll_target_identity_can_reconstruct_an_adopted_new_month',
                ].forEach((name) => assert.ok(
                    list.entries.some((entry) => entry.source.endsWith(`::${name}`)), name));
            },
        },
    ],
};
