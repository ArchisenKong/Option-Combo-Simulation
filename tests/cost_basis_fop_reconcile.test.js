// P5-C3: TWS positions against the FOP ledger (js/cost_basis_fop_reconcile.js).
//
// CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §10.3 and §19 P5-C3: quantity,
// AvgCost, binding and cash are four states; a position is the ledger contract
// with its conId or local symbol, never by root or month; an unknown quantity is
// never matched and never 0; AvgCost is compared only on the same unit, one lot
// price and a trade cost; positions of another account, of an account TWS does
// not manage, unread or read against another version reconcile nothing.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const { createChecker } = require('./helpers/fop-contract-schema');
const statements = require('./helpers/cost_basis_fop_statements');

const ROOT = path.resolve(__dirname, '..');
const CAPABILITIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'cost_basis_fop_capabilities.json'), 'utf8'));
const PROTOCOL = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/cost_basis_fop/contract/protocol.json'),
    'utf8'));
const context = loadBrowserScripts(['js/cost_basis_import_common.js', 'js/cost_basis_fop_core.js',
    'js/cost_basis_fop_import.js', 'js/cost_basis_fop_quotes.js', 'js/cost_basis_fop_messages.js',
    'js/cost_basis_fop_view.js',
    'js/cost_basis_fop_reconcile.js', 'scripts/cost_basis_fop_browser_assertions.js'], { document: {} });
const Import = context.OptionComboCostBasisFopImport;
const Core = context.OptionComboCostBasisFopCore;
const View = context.OptionComboCostBasisFopView;
const Reconcile = context.OptionComboCostBasisFopReconcile;
const ACCOUNT = statements.ACCOUNT;
const OBSERVED = '2026-11-12T15:00:00.000000Z';
const V1 = { eventCount: 5, liveEventCount: 5, maxSeq: 5, digest: '1'.repeat(64) };

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function graphOf(text, historyScope = 'full_history', baselinePrices = {}) {
    const book = { bookId: 'fopbook0001', account: ACCOUNT, symbol: 'CL', currency: 'USD',
        fop: { productRules: 'NYMEX-CL-v1', historyScope, engineVersion: 1 } };
    const plan = Import.planImport(Import.readStatement(text, { capabilities: CAPABILITIES }),
        { book, graph: null, coverage: [], observedAtUtc: OBSERVED, timeZone: 'America/New_York', baselinePrices });
    assert.equal(plan.blocking, false, JSON.stringify(plan.problems));
    return Import.previewGraph(null, plan, book);
}

// The browser checks' statement: CLF7 +1 at 72.5 (fee 5), LOZ6 C7500 -1 at 1.2, LOZ6 P6500 +1 at 0.8.
const ROLLED = graphOf(context.OptionComboFopBrowserAssertions.statementText());

function position(localSymbol, conId, quantity, averageCost, fields = {}) {
    const option = / /.test(localSymbol);
    return Object.assign({ account: ACCOUNT, conId, secType: option ? 'FOP' : 'FUT', symbol: 'CL', localSymbol,
        tradingClass: option ? 'LO' : 'CL', lastTradeDateOrContractMonth: null, right: option ? localSymbol[5] : null,
        strike: option ? Number(localSymbol.slice(6)) / 100 : null, multiplier: 1000, currency: 'USD',
        position: quantity, averageCost }, fields);
}

function evidence(positions, fields = {}) {
    return Object.assign({ action: 'cost_basis_fop_positions', requestId: 'r', success: true, bookId: 'fopbook0001',
        account: ACCOUNT, observedAtUtc: OBSERVED, ledgerVersion: V1, accountConnected: true, positionsReady: true,
        positions, evidenceCredential: 'eyJ2IjoxfQ.c2lnbmF0dXJl' }, fields);
}

const HELD = [position('CLF7', 556, 1, 72505), position('LOZ6 C7500', 9001, -1, 1200),
    position('LOZ6 P6500', 9002, 1, 800)];

function reconcile(graph, positions, fields = {}, output = null) {
    return plain(Reconcile.reconcile({ output: output || Core.computeLedger(graph, { rolls: false }),
        trace: Core.computeLedger(graph, { trace: true, rolls: false }), graph,
        evidence: positions === null ? null : evidence(positions, fields), ledgerVersion: V1 }));
}

function rows(result) {
    return result.rows.map((row) => [row.localSymbol, row.ledgerQuantity, row.twsQuantity, row.quantityStatus,
        row.avgCostStatus]);
}

module.exports = {
    name: 'cost_basis_fop_reconcile',
    tests: [
        {
            name: 'matching positions reconcile contract by contract, AvgCost as corroboration only (P5-C3)',
            run() {
                const result = reconcile(ROLLED, HELD);
                assert.deepEqual(rows(result), [['CLF7', 1, 1, 'matched', 'matched'],
                    ['LOZ6 C7500', -1, -1, 'matched', 'matched'], ['LOZ6 P6500', 1, 1, 'matched', 'matched']]);
                assert.deepEqual([result.quantityStatus, result.avgCostStatus, result.binding, result.cash,
                    result.reconciled], ['matched', 'matched', 'complete', 'not_checked', true]);
                // IB's FUT AvgCost carries the 5 commission; the ledger's average does not.
                assert.deepEqual([result.rows[0].ledgerAverage, result.rows[0].twsAverage], [72.5, 72.505]);
                // Another AvgCost is a difference to look at, never a quantity mismatch.
                const dearer = reconcile(ROLLED, [position('CLF7', 556, 1, 73000)].concat(HELD.slice(1)));
                assert.deepEqual([dearer.rows[0].avgCostStatus, dearer.avgCostStatus, dearer.reconciled],
                    ['differs', 'differs', true]);
            },
        },
        {
            name: 'no month is guessed: an old-month option and a new-month future stay two contracts (P5-C3)',
            run() {
                // TWS says CLZ6, the ledger holds CLF7: two mismatches, never one match on the root.
                const result = reconcile(ROLLED, [position('CLZ6', 555, 1, 70000)].concat(HELD.slice(1)));
                assert.deepEqual(rows(result).filter((row) => row[0].startsWith('CL')),
                    [['CLF7', 1, 0, 'mismatch', 'not_comparable'], ['CLZ6', 0, 1, 'mismatch', 'not_comparable']]);
                assert.deepEqual([result.quantityStatus, result.reconciled], ['mismatch', false]);
                // A position the ledger cannot place by conId or local symbol is listed apart.
                const unknown = reconcile(ROLLED, HELD.concat([position('CLG7', 557, 2, 69000)]));
                const row = unknown.rows.find((item) => item.localSymbol === 'CLG7');
                assert.deepEqual([row.contractId, row.ledgerQuantity, row.twsQuantity, row.quantityStatus],
                    [null, 0, 2, 'mismatch']);
                assert.match(row.note, /不按根代码或月份猜测/);
                // Another account's position never counts for this ledger.
                const other = reconcile(ROLLED, HELD.concat([position('CLF7', 556, 3, 72000, { account: 'U2222222' })]));
                assert.equal(other.reconciled, true);
            },
        },
        {
            name: 'a conId that disagrees is an identity conflict, never matched by the local symbol (review P5-C3)',
            run() {
                // TWS names CLF7 with another conId than the ledger's 556: two contracts, and the page says why.
                const result = reconcile(ROLLED, [position('CLF7', 999999, 1, 72505)].concat(HELD.slice(1)));
                assert.deepEqual(rows(result).filter((row) => row[0] === 'CLF7'),
                    [['CLF7', 1, 0, 'mismatch', 'not_comparable'], ['CLF7', 0, 1, 'mismatch', 'not_comparable']]);
                const conflict = result.rows.find((row) => row.contractId === null);
                assert.match(conflict.note, /身份冲突.*conId 999999.*conId 556/);
                assert.deepEqual([result.quantityStatus, result.reconciled], ['mismatch', false]);
                // Only a conId on both sides can disagree: without one, the local symbol still places it.
                const unnamed = reconcile(ROLLED, [position('CLF7', null, 1, 72505)].concat(HELD.slice(1)));
                assert.deepEqual([unnamed.rows[0].quantityStatus, unnamed.reconciled], ['matched', true]);
                const graph = plain(ROLLED);
                graph.contracts.find((stored) => stored.record.localSymbol === 'CLF7').record.conId = null;
                const records = new Map(graph.contracts.map((stored) => [stored.record.contractId, stored.record]));
                const placed = Reconcile.placePosition(position('CLF7', 999999, 1, 72505), records);
                assert.deepEqual([placed.record && placed.record.localSymbol, placed.conflict], ['CLF7', null]);
                // The conId decides: the same conId under another spelling of the symbol is the same contract.
                const spelled = Reconcile.placePosition(position('CLF7', 556, 1, 72505, { localSymbol: 'CL F7' }),
                    new Map(ROLLED.contracts.map((stored) => [stored.record.contractId, stored.record])));
                assert.equal(spelled.record.localSymbol, 'CLF7');
            },
        },
        {
            name: 'AvgCost that is only partly comparable is never summed up as agreeing (review P5-C3)',
            run() {
                const summary = (positions) => {
                    const result = reconcile(ROLLED, positions);
                    return [result.rows.map((row) => row.avgCostStatus).join(','), result.avgCostStatus,
                        Reconcile.AVG_COST_LABELS[result.avgCostStatus], result.reconciled];
                };
                // The future's multiplier is missing: its row is not comparable, the two options agree.
                const noUnit = [position('CLF7', 556, 1, 72505, { multiplier: null })].concat(HELD.slice(1));
                assert.deepEqual(summary(noUnit),
                    ['not_comparable,matched,matched', 'partial', '部分一致、部分不可比', true]);
                assert.deepEqual(summary(HELD), ['matched,matched,matched', 'matched', '一致（旁证）', true]);
                const none = HELD.map((item) => Object.assign({}, item, { multiplier: null }));
                assert.deepEqual(summary(none).slice(0, 2), ['not_comparable,not_comparable,not_comparable',
                    'not_comparable']);
                const dearer = [position('CLF7', 556, 1, 73000)].concat(HELD.slice(1, 2),
                    [Object.assign({}, HELD[2], { multiplier: null })]);
                assert.deepEqual(summary(dearer).slice(0, 2), ['differs,matched,not_comparable', 'differs']);
                assert.deepEqual([Reconcile.avgCostSummary([]), Reconcile.quantitySummary([])],
                    ['not_comparable', 'matched']);
            },
        },
        {
            name: 'an unknown ledger quantity is never matched, and AvgCost needs its unit, one lot price and a cost',
            run() {
                const output = plain(Core.computeLedger(ROLLED, { rolls: false }));
                output.futures[0].contracts = { value: null, reason: 'order_ambiguous:evt-x' };
                const unknown = reconcile(ROLLED, HELD, {}, output);
                assert.deepEqual([unknown.rows[0].ledgerQuantity, unknown.rows[0].quantityStatus, unknown.quantityStatus,
                    unknown.reconciled], [null, 'unknown', 'unknown', false]);
                const noUnit = reconcile(ROLLED, [position('CLF7', 556, 1, 72505, { multiplier: null })]
                    .concat(HELD.slice(1)));
                assert.equal(noUnit.rows[0].avgCostStatus, 'not_comparable');
                assert.match(noUnit.rows[0].note, /单位不明：TWS 乘数 缺失，账本 1000/);
                const period = { from: '2026-10-01', through: '2026-10-31' };
                const lots = graphOf(statements.activity({ period, fills: [
                    { symbol: 'CLF7', local: '2026-10-01T10:00:00', qty: 1, price: 70, codes: 'O' },
                    { symbol: 'CLF7', local: '2026-10-02T10:00:00', qty: 1, price: 72, codes: 'O' }] }));
                const twoLots = reconcile(lots, [position('CLF7', 556, 2, 71500)]);
                assert.deepEqual([twoLots.rows[0].quantityStatus, twoLots.rows[0].avgCostStatus],
                    ['matched', 'not_comparable']);
                assert.match(twoLots.rows[0].note, /多笔不同价格开仓/);
                const baseline = graphOf(statements.activity({ period, fills: [],
                    openPositions: [{ symbol: 'CLF7', quantity: 1 }] }), 'since_baseline',
                { CLF7: { kind: 'reference_price', price: 71 } });
                const atReference = reconcile(baseline, [position('CLF7', 556, 1, 69000)]);
                assert.equal(atReference.rows[0].avgCostStatus, 'not_comparable');
                assert.match(atReference.rows[0].note, /参考价，不是成交成本/);
            },
        },
        {
            name: 'positions of an unmanaged account, unread or read for another version reconcile nothing',
            run() {
                const none = reconcile(ROLLED, null);
                assert.deepEqual([none.state, none.quantityStatus, none.reconciled], ['none', 'not_checked', false]);
                const offline = reconcile(ROLLED, [], { accountConnected: false, positionsReady: false,
                    evidenceCredential: null });
                assert.deepEqual([offline.state, offline.quantityStatus, offline.reconciled], ['offline', 'not_checked',
                    false]);
                assert.match(offline.reason, /不在当前 TWS 中.*仍可离线/);
                const waiting = reconcile(ROLLED, [], { positionsReady: false, evidenceCredential: null });
                assert.equal(waiting.state, 'not_ready');
                const stale = reconcile(ROLLED, HELD, { ledgerVersion: Object.assign({}, V1, { digest: '2'.repeat(64) }) });
                assert.deepEqual([stale.state, stale.quantityStatus, stale.reconciled], ['stale', 'not_checked', false]);
            },
        },
        {
            name: 'a snapshot keeps the version, quotes, completeness and every comparison in the frozen shape',
            run() {
                const checker = createChecker(PROTOCOL.types);
                const output = Core.computeLedger(ROLLED, { rolls: false });
                const integrity = plain(View.integrity(output, { graph: ROLLED, coverage: null, quoteState: null }));
                const reconciliation = Reconcile.reconcile({ output, trace: Core.computeLedger(ROLLED, { trace: true,
                    rolls: false }), graph: ROLLED, evidence: evidence(HELD), ledgerVersion: V1 });
                const parts = plain(Reconcile.snapshotParts({ ledgerVersion: V1, quoteState: null, integrity,
                    evidence: evidence(HELD), reconciliation }));
                const request = Object.assign({ action: 'save_cost_basis_snapshot', requestId: 'r-1',
                    bookId: 'fopbook0001', expectedLedgerVersion: V1,
                    bookIdentity: { account: ACCOUNT, symbol: 'CL', secType: 'FUT', currency: 'USD' },
                    asOfDate: '2026-11-12', accountScope: ACCOUNT, note: '' }, parts);
                assert.deepEqual(checker.check('SnapshotRequest', request), []);
                assert.equal(parts.reconciled, true);
                assert.deepEqual(parts.summary.completeness, { quantity: 'complete', openingCost: 'complete',
                    binding: 'complete', marketData: 'not_checked', coverage: 'not_checked', cash: 'not_checked' });
                assert.equal(parts.twsSnapshot.rows.length, 3);
                // A partly comparable AvgCost is kept as partial, in the frozen shape.
                const noUnit = [Object.assign({}, HELD[0], { multiplier: null })].concat(HELD.slice(1));
                const partial = plain(Reconcile.snapshotParts({ ledgerVersion: V1, quoteState: null, integrity,
                    evidence: evidence(noUnit), reconciliation: Reconcile.reconcile({ output, trace: Core.computeLedger(
                        ROLLED, { trace: true, rolls: false }), graph: ROLLED, evidence: evidence(noUnit),
                    ledgerVersion: V1 }) }));
                assert.deepEqual([partial.twsSnapshot.avgCostStatus, partial.twsSnapshot.quantityStatus,
                    partial.reconciled], ['partial', 'matched', true]);
                assert.deepEqual(checker.check('SnapshotRequest', Object.assign({}, request, partial)), []);
                // Positions read for another version are not kept, and nothing is claimed.
                const stale = Reconcile.reconcile({ output, trace: null, graph: ROLLED, evidence: evidence(HELD, {
                    ledgerVersion: Object.assign({}, V1, { digest: '2'.repeat(64) }) }), ledgerVersion: V1 });
                const staleParts = plain(Reconcile.snapshotParts({ ledgerVersion: V1, quoteState: null, integrity,
                    evidence: evidence(HELD), reconciliation: stale }));
                assert.deepEqual([staleParts.twsSnapshot, staleParts.reconciled], [null, false]);
            },
        },
        {
            name: "a statement's realized P&L is compared on its own basis, and only where that basis is certain (P5-C4)",
            run() {
                const compare = (text, historyScope = 'full_history', baselinePrices = {}) => {
                    const book = { bookId: 'fopbook0001', account: ACCOUNT, symbol: 'CL', currency: 'USD',
                        fop: { productRules: 'NYMEX-CL-v1', historyScope, engineVersion: 1 } };
                    const plan = Import.planImport(Import.readStatement(text, { capabilities: CAPABILITIES }),
                        { book, graph: null, coverage: [], observedAtUtc: OBSERVED, timeZone: 'America/New_York',
                            baselinePrices });
                    assert.equal(plan.blocking, false, JSON.stringify(plan.problems));
                    const graph = Import.previewGraph(null, plan, book);
                    return plain(Reconcile.realizedComparison({ graph,
                        order: Core.computeLedger(graph, { trace: true, rolls: false }).order,
                        evidence: plan.realizedEvidence, period: plan.period, zone: plan.timeZone.name,
                        localDay: Import.localDay }));
                };
                const open = { symbol: 'CLZ6', local: '2026-10-01T10:00:00', qty: 1, price: 70, commission: -2.5,
                    codes: 'O', tradeId: '1', realized: 0 };
                const close = { symbol: 'CLZ6', local: '2026-10-02T10:00:00', qty: -1, price: 71, commission: -2.5,
                    codes: 'C', tradeId: '2' };
                // IB's FIFO with commissions: (71 - 70) x 1000 - 2.5 - 2.5 = 995; the ledger's own figure is gross.
                const [same] = compare(statements.flex({ realizedColumn: true, fills: [open, Object.assign({}, close,
                    { realized: 995 })] }));
                assert.deepEqual([same.status, same.statementRealized, same.ledgerFifo, same.ledgerOwn, same.difference,
                    same.method], ['matched', 995, 995, 1000, 0, 'fifo']);
                assert.equal(same.events.length, 1, 'the close it rests on is named');
                const [different] = compare(statements.flex({ realizedColumn: true, fills: [open, Object.assign({}, close,
                    { realized: 990 })] }));
                assert.deepEqual([different.status, different.difference], ['different', -5]);
                assert.match(different.reason, /相差 -5/);
                // A close that states no value is missing, never 0.
                const period = { from: '2026-10-01', through: '2026-10-31' };
                const [missing] = compare(statements.activity({ period, realizedColumn: true, fills: [open, close] }));
                assert.deepEqual([missing.status, missing.statementRealized], ['not_comparable', null]);
                assert.match(missing.reason, /1 行平仓没有给出已实现值/);
                const [absent] = compare(statements.activity({ period, fills: [open, close] }));
                assert.equal(absent, undefined, 'a file without the column has nothing to compare');
                // Two lots at different prices: only a FIFO statement is comparable.
                const lots = [Object.assign({}, open, { realized: 0 }),
                    Object.assign({}, open, { local: '2026-10-01T11:00:00', price: 72, tradeId: '3', realized: 0 })];
                const lifo = Object.assign({}, close, { local: '2026-10-03T10:00:00', price: 73, realized: 995 });
                const [unspecified] = compare(statements.activity({ period, realizedColumn: true, fills: lots.concat([lifo]) }));
                assert.equal(unspecified.status, 'not_comparable');
                assert.match(unspecified.reason, /不同价格的批次.*没有说明批次方法/);
                const [fifo] = compare(statements.flex({ realizedColumn: true, fills: lots.concat([Object.assign({}, lifo,
                    { realized: 2995 })]) }));
                assert.deepEqual([fifo.status, fifo.ledgerFifo, fifo.ledgerOwn], ['matched', 2995, 2000]);
                // An option: both sides carry the commissions. 1197.5 received, 502.5 paid back: 695.
                const [option] = compare(statements.flex({ realizedColumn: true, fills: [
                    { symbol: 'LOZ6 C7500', local: '2026-10-01T11:00:00', qty: -1, price: 1.2, commission: -2.5,
                        codes: 'O', tradeId: '10', realized: 0 },
                    { symbol: 'LOZ6 C7500', local: '2026-10-05T11:00:00', qty: 1, price: 0.5, commission: -2.5,
                        codes: 'C', tradeId: '11', realized: 695 }] }));
                assert.deepEqual([option.status, option.ledgerFifo, option.ledgerOwn], ['matched', 695, 695]);
                // A lot opened at a baseline reference price: its trade cost is not in the ledger.
                const [baseline] = compare(statements.activity({ period, realizedColumn: true,
                    fills: [Object.assign({}, close, { realized: 1000 })],
                    openPositions: [{ symbol: 'CLZ6', quantity: 0 }] }), 'since_baseline',
                { CLZ6: { kind: 'reference_price', price: 70 } });
                assert.equal(baseline.status, 'not_comparable');
                assert.match(baseline.reason, /期初持仓/);
                // An assignment in the period: the statement may carry the premium into the future.
                const [...delivered] = compare(statements.activity({ period: { from: '2026-10-01', through: '2026-11-30' },
                    realizedColumn: true, openPositions: [{ symbol: 'CLZ6', quantity: 0 }], fills: [
                        Object.assign({}, open, { realized: 0 }),
                        { symbol: 'LOZ6 C7500', local: '2026-10-01T11:00:00', qty: -1, price: 1.2, codes: 'O', realized: 0 },
                        { symbol: 'LOZ6 C7500', local: '2026-11-17T16:20:00', qty: 1, price: 0, codes: 'A', realized: 1200 },
                        { symbol: 'CLZ6', local: '2026-11-17T16:20:00', qty: -1, price: 75, codes: 'A', realized: 4995 }] }));
                assert.deepEqual(delivered.map((item) => [item.localSymbol, item.status]),
                    [['CLZ6', 'not_comparable'], ['LOZ6 C7500', 'not_comparable']]);
                assert.ok(delivered.every((item) => /行权、指派或由交割建立/.test(item.reason)));
            },
        },
    ],
};
