// P4: the FOP statement importer on its own (js/cost_basis_fop_import.js).
//
// CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §4.1, §9.1-§9.4, §9.7. Reading a
// statement and planning it against an empty ledger, without a store: formats,
// row keys and statuses, localized headers, roots, delivery months, times,
// order and execution rows, masked accounts, repeated rows, evidence and claims.
// The chain through the real store is tests/cost_basis_fop_import_pipeline_test.py.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const statements = require('./helpers/cost_basis_fop_statements');

const ROOT = path.resolve(__dirname, '..');
const context = loadBrowserScripts(['js/cost_basis_import_common.js', 'js/cost_basis_fop_core.js',
    'js/cost_basis_fop_import.js']);
const Import = context.OptionComboCostBasisFopImport;
const CAPABILITIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'cost_basis_fop_capabilities.json'), 'utf8'));
const BOOK = { bookId: 'fopbook0001', account: statements.ACCOUNT, symbol: 'CL', currency: 'USD',
    fop: { productRules: 'NYMEX-CL-v1', historyScope: 'full_history', engineVersion: 1 } };
const OCTOBER = { from: '2026-10-01', through: '2026-10-31' };

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function plan(text, extra = {}) {
    const statement = Import.readStatement(text, { capabilities: CAPABILITIES, fileName: 'test.csv' });
    return Import.planImport(statement, Object.assign({ book: BOOK, graph: null,
        observedAtUtc: '2027-03-01T14:15:00.000000Z' }, extra));
}

function codes(result) {
    return plain(result.problems.map((item) => item.code));
}

function fill(symbol, local, qty, price, codes = 'O', extra = {}) {
    return Object.assign({ symbol, local, qty, price, codes }, extra);
}

module.exports = {
    name: 'cost_basis_fop_import',
    tests: [
        {
            name: 'an Activity Statement gives its account, period, timezone and a key per row',
            run() {
                const text = statements.activity({ period: OCTOBER, cashReport: true, markToMarket: true,
                    unknownSection: true, generated: '2026-11-01, 09:15:00 EDT',
                    fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70),
                        fill('LOZ6 C7500', '2026-10-01T11:00:00', -1, 1.2)] });
                const statement = Import.readStatement(text, { capabilities: CAPABILITIES });
                assert.equal(statement.format, 'activity_csv');
                assert.equal(statement.account, 'U1111111');
                assert.deepEqual(plain(statement.period), { from: '2026-10-01', through: '2026-10-31' });
                assert.equal(statement.timeZoneEvidence.zone, 'America/New_York');
                assert.deepEqual(plain(statement.otherSections), [{ name: 'Deposits & Withdrawals', rows: 1 }]);
                const result = plan(text);
                assert.deepEqual(codes(result), []);
                assert.deepEqual(plain(result.rows.map((row) => [row.key, row.status, row.disposition])), [
                    ['activity/cash_report/ALL/cash', 'out_of_scope', 'out_of_scope'],
                    ['activity/cash_report/ALL/cash', 'out_of_scope', 'out_of_scope'],
                    ['activity/mark_to_market/ALL/summary', 'out_of_scope', 'out_of_scope'],
                    ['activity/trades/FUT/trade', 'synthetic_only', 'event'],
                    ['activity/trades/FOP/trade', 'synthetic_only', 'event'],
                ]);
                assert.equal(result.events[0].time.executedAtUtc, '2026-10-01T14:00:00.000000Z');
                assert.equal(result.events[0].time.sourceTimeText, '2026-10-01, 10:00:00');
                assert.equal(result.events[0].time.sourceTimezone, 'America/New_York');
                assert.equal(result.events[0].time.exchangeTradeDate, null, 'Activity prints no exchange date');
            },
        },
        {
            name: 'a Flex export is one flat table whose period is what its rows span',
            run() {
                const text = statements.flex({ fills: [
                    fill('CLZ6', '2026-10-01T10:00:00', 1, 70, 'O', { tradeId: '101', execId: '0000e0d5.1.01.01' }),
                    fill('CLZ6', '2026-10-09T10:00:00', -1, 71, 'C', { tradeId: '102' })] });
                const result = plan(text, { timeZone: 'America/New_York' });
                assert.deepEqual(codes(result), []);
                assert.equal(result.format, 'flex_csv');
                assert.deepEqual(plain(result.period), { from: '2026-10-01', through: '2026-10-09', fromRows: true });
                assert.ok(result.warnings.some((item) => item.code === 'period_from_rows'));
                assert.deepEqual(plain(result.sourceRecords.map((record) => [record.namespace, record.sourceRef,
                    record.capabilityKey])), [['flex_trade', '101', 'flex/trades/FUT/trade'],
                    ['flex_trade', '102', 'flex/trades/FUT/trade']]);
                assert.equal(result.events[0].time.exchangeTradeDate, '2026-10-01');
            },
        },
        {
            name: 'Chinese headers, a byte order mark and the two 代码 columns read like English',
            run() {
                const fills = [fill('CLZ6', '2026-10-01T10:00:00', 1, 70),
                    fill('LOZ6 C7500', '2026-10-01T11:00:00', -1, 1.2, 'O')];
                const english = plan(statements.activity({ period: OCTOBER, fills }));
                const chinese = plan(statements.activity({ period: OCTOBER, fills, chinese: true, bom: true }));
                assert.deepEqual(codes(chinese), []);
                const economic = (result) => plain(result.events.map((event) => [event.kind, event.contractRef,
                    event.futureContracts, event.contracts, event.price, event.cashAmount, event.openClose]));
                assert.deepEqual(economic(chinese), economic(english));
                // The raw row keeps both 代码 columns.
                const raw = chinese.sourceRecords[1].rawFields;
                assert.equal(raw['代码'], 'LOZ6 C7500');
                assert.equal(raw['代码#2'], 'O');
            },
        },
        {
            name: 'rows of another root or asset class belong to another ledger',
            run() {
                const result = plan(statements.activity({ period: OCTOBER, fills: [
                    fill('MCLZ6', '2026-10-01T10:00:00', 1, 70), fill('CLZ6', '2026-10-01T10:05:00', 1, 70)] }));
                assert.deepEqual(codes(result), []);
                assert.deepEqual(plain(result.rows.map((row) => [row.disposition, row.reason || row.key])), [
                    ['other_ledger', 'root MCL'], ['event', 'activity/trades/FUT/trade']]);
                assert.equal(result.events.length, 1);
            },
        },
        {
            name: 'a delivery month comes from a delivery-month field or the local symbol, never an expiry',
            run() {
                const internal = Import._internal;
                assert.equal(internal.monthFromCode('Z', '6', '2026-10-01'), '202612');
                assert.equal(internal.monthFromCode('F', '7', '2026-12-20'), '202701');
                assert.equal(internal.monthFromCode('Z', '5', '2026-10-01'), '203512', 'never a past decade');
                assert.equal(internal.monthFromCode('Z', '26', '2026-10-01'), '202612');
                const stated = plan(statements.activity({ period: OCTOBER,
                    fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70)] }));
                assert.match(stated.contracts[0].evidenceSummary, /delivery month 202612 from instrument line/);
                assert.equal(stated.contracts[0].futureLastTradeDate, '2026-11-19');
                const symbolOnly = plan(statements.activity({ period: OCTOBER, noDeliveryMonth: true,
                    fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70)] }));
                assert.match(symbolOnly.contracts[0].evidenceSummary, /from local symbol CLZ6/);
                assert.equal(symbolOnly.contracts[0].futureContractMonth, '202612');
                // A field that disagrees with the symbol is a conflict, not a choice.
                const text = statements.activity({ period: OCTOBER, fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70)] })
                    .replace(',2026-12,', ',2027-01,');
                assert.ok(codes(plan(text)).includes('contract_conflict'));
            },
        },
        {
            name: 'account-local times become instants or ranges in one named zone',
            run() {
                assert.deepEqual(plain(Import.localToUtc('2026-10-01T10:00:00', 'America/New_York')),
                    { instant: '2026-10-01T14:00:00.000000Z' });
                assert.deepEqual(plain(Import.localToUtc('2026-11-01T01:30:00', 'America/New_York')),
                    { range: ['2026-11-01T05:30:00.000000Z', '2026-11-01T06:30:00.000000Z'] });
                assert.match(Import.localToUtc('2027-03-14T02:30:00', 'America/New_York').error, /does not exist/);
                assert.match(Import.localToUtc('2026-10-01T10:00:00', 'Mars/Olympus').error, /unknown timezone/);
                const unnamed = plan(statements.activity({ period: OCTOBER, generated: '2026-11-01, 09:15:00 CST',
                    fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70)] }));
                assert.ok(codes(unnamed).includes('timezone_missing'), 'CST names two zones');
                const stated = plan(statements.activity({ period: OCTOBER, generated: '2026-11-01, 09:15:00 CST',
                    fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70)] }), { timeZone: 'America/Chicago' });
                assert.equal(stated.events[0].time.executedAtUtc, '2026-10-01T15:00:00.000000Z');
            },
        },
        {
            name: 'an order row is read through its executions, which must add up to it',
            run() {
                const fills = [fill('CLZ6', '2026-10-01T10:00:00', 1, 70, 'O', { commission: -1 }),
                    fill('CLZ6', '2026-10-01T10:00:05', 2, 71, 'O', { commission: -2 })];
                const good = plan(statements.activity({ period: OCTOBER, fills, orders: [{ fills: [0, 1] }] }));
                assert.deepEqual(codes(good), []);
                assert.deepEqual(plain(good.events.map((event) => [event.futureContracts, event.price, event.fees])),
                    [[1, 70, 1], [2, 71, 2]]);
                const bad = plan(statements.activity({ period: OCTOBER, fills,
                    orders: [{ fills: [0, 1], commission: -4 }] }));
                assert.ok(codes(bad).includes('order_fills_differ'));
            },
        },
        {
            name: 'a masked account needs a confirmation for this file',
            run() {
                const text = statements.activity({ period: OCTOBER, account: 'U****1111',
                    fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70)] });
                assert.ok(codes(plan(text)).includes('account_confirmation_required'));
                const confirmed = plan(text, { accountConfirmation: { sourceAccount: 'U****1111',
                    targetAccount: 'U1111111' } });
                assert.deepEqual(codes(confirmed), []);
                assert.equal(confirmed.sourceRecords[0].account, 'U1111111');
                assert.ok(codes(plan(statements.activity({ period: OCTOBER, account: 'U2222222',
                    fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70)] }))).includes('account_mismatch'));
            },
        },
        {
            name: 'identical statement rows stay two fills with stable references',
            run() {
                const twice = [fill('CLZ6', '2026-10-01T10:00:00', 1, 70), fill('CLZ6', '2026-10-01T10:00:00', 1, 70)];
                const result = plan(statements.activity({ period: OCTOBER, fills: twice }));
                const refs = result.sourceRecords.map((record) => record.sourceRef);
                assert.equal(new Set(refs).size, 2);
                assert.equal(refs[1], `${refs[0]}-2`);
                const again = plan(statements.activity({ period: { from: '2026-10-01', through: '2026-11-30' },
                    fills: twice }));
                assert.deepEqual(again.sourceRecords.map((record) => record.sourceRef), refs,
                    'the same rows keep their references in a longer statement');
            },
        },
        {
            name: 'rows of one second carry no order: an order that changes the result blocks',
            run() {
                // The file's row order is not evidence (plan §9.2): swapping
                // the two rows gives the same plan, and both are refused.
                const first = fill('CLZ6', '2026-10-01T10:00:00', 1, 70);
                const buy = fill('CLZ6', '2026-10-02T10:00:00', 1, 72);
                const sell = fill('CLZ6', '2026-10-02T10:00:00', -1, 75, 'C');
                const listed = plan(statements.activity({ period: OCTOBER, fills: [first, buy, sell] }));
                const swapped = plan(statements.activity({ period: OCTOBER, fills: [first, sell, buy] }));
                for (const result of [listed, swapped]) {
                    assert.deepEqual(plain(result.events.map((event) => event.time.orderEvidence)), [null, null, null]);
                    assert.deepEqual(codes(result), ['order_ambiguous']);
                    assert.throws(() => Import.buildImportRequest(result, {}), /cannot be committed/);
                }
                // Adds of one second need no order.
                const adds = plan(statements.activity({ period: OCTOBER, fills: [first,
                    fill('CLZ6', '2026-10-02T10:00:00', 2, 71), fill('CLZ6', '2026-10-02T10:00:00', 1, 72)] }));
                assert.deepEqual(codes(adds), []);
                // Opposite sides with only a trade date: no order either.
                const dated = plan(statements.flex({ fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70, 'O', { tradeId: '1' }),
                    fill('CLZ6', '2026-10-02T10:00:00', 1, 72, 'O', { tradeId: '2', dateOnly: true }),
                    fill('CLZ6', '2026-10-02T10:00:00', -1, 75, 'C', { tradeId: '3', dateOnly: true })] }),
                { timeZone: 'America/New_York' });
                assert.ok(codes(dated).includes('order_ambiguous'));
            },
        },
        {
            name: 'a Trades row of an unknown kind blocks; a closed lot is listed and left out',
            run() {
                const fills = [fill('CLZ6', '2026-10-01T10:00:00', 1, 70), fill('CLZ6', '2026-10-02T10:00:00', 1, 71)];
                const text = statements.activity({ period: OCTOBER, fills });
                const [header, ...rest] = text.split('\n');
                const lines = [header, ...rest];
                const second = lines.findIndex((line, index) => line.startsWith('Trades,Data,Order,')
                    && index > lines.findIndex((other) => other.startsWith('Trades,Data,Order,')));
                const renamed = (kind) => lines.map((line, index) => (index === second
                    ? line.replace('Trades,Data,Order,', `Trades,Data,${kind},`) : line)).join('\n');
                for (const kind of ['Adjustment', '']) {
                    const result = plan(renamed(kind));
                    assert.deepEqual(codes(result), ['row_kind_unknown'], kind);
                    assert.equal(result.blocking, true, kind);
                    assert.equal(result.rows.find((row) => row.line === second + 1).disposition, 'problem', kind);
                }
                // A closed lot repeats its trade: listed, never read or blocking.
                const lot = lines.slice(0, second + 1).concat([lines[second].replace('Trades,Data,Order,',
                    'Trades,Data,ClosedLot,')], lines.slice(second + 1)).join('\n');
                const withLot = plan(lot);
                assert.deepEqual(codes(withLot), []);
                assert.equal(withLot.events.length, 2);
                assert.deepEqual(plain(withLot.rows.filter((row) => row.disposition === 'detail').map((row) => row.line)),
                    [second + 2]);
                // A row of another asset class belongs to another ledger, whatever its kind.
                const stock = lines.slice(0, second + 1).concat(['Trades,Data,Adjustment,Stocks,USD,QQQ,'
                    + '"2026-10-02, 10:00:00",1,500,-500,0,O'], lines.slice(second + 1)).join('\n');
                assert.deepEqual(codes(plan(stock)), []);
            },
        },
        {
            name: 'a stored contract is held to every term a row states',
            run() {
                // The ledger holds CLZ6 with another last trade date than the
                // statement's instrument row: the visible name is not enough.
                const stored = { secType: 'FUT', contractId: 'fut-cl-202612', revision: 1, conId: 555, root: 'CL',
                    tradingClass: 'CL', localSymbol: 'CLZ6', exchange: 'NYMEX', currency: 'USD',
                    futureContractMonth: '202612', futureLastTradeDate: '2026-11-20', futureLastTradeAsOf: null,
                    futurePointValue: 1000, ruleVersion: 'NYMEX-CL-v1', evidenceStatus: 'verified_broker',
                    evidenceSummary: '', observedAtUtc: '2027-03-01T14:15:00.000000Z' };
                const graph = { contracts: [{ record: stored, supersededByRevision: null }], bindings: [], events: [],
                    sources: [], allocations: [], cycles: [] };
                const text = statements.activity({ period: OCTOBER, fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70)] });
                assert.ok(codes(plan(text, { graph })).includes('contract_conflict'));
                assert.deepEqual(codes(plan(text, { graph: Object.assign({}, graph, { contracts: [{
                    record: Object.assign({}, stored, { futureLastTradeDate: '2026-11-19' }),
                    supersededByRevision: null }] }) })), []);
                // An option row whose multiplier is not the product's.
                const option = statements.activity({ period: OCTOBER,
                    fills: [fill('LOZ6 C7500', '2026-10-01T11:00:00', -1, 1.2)] }).replace(',9001,CLZ6,NYMEX,1000,',
                    ',9001,CLZ6,NYMEX,100,');
                assert.ok(codes(plan(option)).includes('contract_conflict'));
            },
        },
        {
            name: 'a preview without a ledger reads the statement account and builds no request',
            run() {
                const text = statements.activity({ period: OCTOBER, account: 'U****1111',
                    fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70)], openPositions: [{ symbol: 'CLZ6', quantity: 1 }] });
                const result = plan(text, { book: Object.assign({}, BOOK, { account: '' }) });
                assert.deepEqual(codes(result), []);
                assert.deepEqual(plain(result.warnings.map((item) => item.code)), ['account_unchecked']);
                assert.equal(result.account, 'U****1111');
                assert.throws(() => Import.buildImportRequest(result, {}), /read-only/);
            },
        },
        {
            name: 'a product outside the first release is keyed as unsupported and blocks',
            run() {
                for (const symbol of ['LCZ6 C7500', 'LOZ6 C0']) {
                    const result = plan(statements.activity({ period: OCTOBER,
                        fills: [fill(symbol, '2026-10-01T11:00:00', -1, 1.2)] }));
                    assert.ok(codes(result).includes('row_unsupported'), symbol);
                    assert.equal(result.rows[0].status, 'unsupported', symbol);
                    assert.equal(result.events.length, 0, symbol);
                }
            },
        },
        {
            name: 'a claimed row becomes a manual event that still names its row',
            run() {
                const result = plan(statements.activity({ period: OCTOBER,
                    fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70), fill('CLZ6', '2026-10-02T10:00:00', -1, 71, 'C')] }));
                const claimed = Import.claimRows(result, [result.rows[0].line], 'checked by hand');
                assert.deepEqual(plain(claimed.events.map((event) => [event.source, event.note])),
                    [['manual', 'checked by hand'], ['csv_import', '']]);
                assert.deepEqual(plain(claimed.events[0].sources), plain(result.events[0].sources));
            },
        },
    ],
};
