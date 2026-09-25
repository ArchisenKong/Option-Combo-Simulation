// P5: the FOP ledger page (cost_basis_fop.html, js/cost_basis_fop.js and its
// DOM-free views, forms and quotes).
//
// CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §5.3, §11, §12.1, §13.3 P5 and
// §14.1 F08, F13, F23, F36: every figure comes from the core over the ledger
// graph and names what it rests on; no single break-even price where the
// plan forbids one; the delivery preview writes nothing; answers for another
// ledger, an older reload or an older version are dropped; writes stay closed
// while the backend says so. The browser run of the same page is
// scripts/cost_basis_fop_browser_assertions.js.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const { createChecker } = require('./helpers/fop-contract-schema');
const statements = require('./helpers/cost_basis_fop_statements');

const ROOT = path.resolve(__dirname, '..');
const CAPABILITIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'cost_basis_fop_capabilities.json'), 'utf8'));
const PROTOCOL = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/cost_basis_fop/contract/protocol.json'),
    'utf8'));
const SCRIPTS = ['js/cost_basis_common.js', 'js/cost_basis_import_common.js', 'js/cost_basis_fop_core.js',
    'js/cost_basis_fop_import.js', 'js/cost_basis_fop_quotes.js', 'js/cost_basis_fop_messages.js',
    'js/cost_basis_fop_view.js',
    'js/cost_basis_fop_forms.js', 'js/cost_basis_fop_reconcile.js'];
const pure = loadBrowserScripts(SCRIPTS.concat(['scripts/cost_basis_fop_browser_assertions.js']), { document: {} });
const Import = pure.OptionComboCostBasisFopImport;
const Core = pure.OptionComboCostBasisFopCore;
const View = pure.OptionComboCostBasisFopView;
const Forms = pure.OptionComboCostBasisFopForms;
const BOOK = { bookId: 'fopbook0001', account: statements.ACCOUNT, symbol: 'CL', secType: 'FUT', currency: 'USD',
    fop: { productRules: 'NYMEX-CL-v1', historyScope: 'full_history', engineVersion: 1 } };
const OBSERVED = '2026-11-12T15:00:00.000000Z';

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

/** A ledger graph from a statement, as the server would export it (BackupPayloadV2 shape). */
function graphOf(text) {
    const plan = Import.planImport(Import.readStatement(text, { capabilities: CAPABILITIES }),
        { book: BOOK, graph: null, coverage: [], observedAtUtc: OBSERVED, timeZone: 'America/New_York' });
    assert.equal(plan.blocking, false, JSON.stringify(plan.problems));
    return Import.previewGraph(null, plan, BOOK);
}

// The browser checks' statement: an old-month short call and long put on
// CLZ6, rolled CLZ6 -> CLF7.
const ROLLED = graphOf(pure.OptionComboFopBrowserAssertions.statementText());
// Record ids are scoped to their ledger; the tests name contracts by local symbol.
function idOf(graph, localSymbol) {
    return graph.contracts.find((stored) => stored.record.localSymbol === localSymbol).record.contractId;
}
const CLZ6 = idOf(ROLLED, 'CLZ6');
const CLF7 = idOf(ROLLED, 'CLF7');
const C75 = idOf(ROLLED, 'LOZ6 C7500');
const P65 = idOf(ROLLED, 'LOZ6 P6500');

function fill(symbol, local, qty, price, codes = 'O') {
    return { symbol, local, qty, price, codes };
}

// ------------------------------------------------------------------
// The page against a fake DOM and a scripted backend
// ------------------------------------------------------------------

function fakeNode(tag) {
    return {
        tag, textContent: '', hidden: false, href: '', className: '', dataset: {}, children: [], value: '',
        disabled: false, checked: false, listeners: {}, files: null,
        appendChild(child) { this.children.push(child); return child; },
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
        addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); },
        get firstChild() { return this.children[0]; },
        fire(type) { (this.listeners[type] || []).forEach((handler) => handler()); },
    };
}

/** The first node under root (depth first) that matches. */
function findNode(root, match) {
    for (const child of (root && root.children) || []) {
        if (match(child)) return child;
        const found = findNode(child, match);
        if (found) return found;
    }
    return null;
}

function loadLedgerPage(options) {
    const nodes = new Map();
    const sockets = [];
    // Timers run only when a test fires them; the request client's 45 s
    // timeouts are recorded like any other.
    const timers = [];
    const schedule = (fn, delay) => {
        timers.push({ fn, delay, cleared: false });
        return timers.length;
    };
    const cancel = (id) => {
        if (timers[id - 1]) timers[id - 1].cleared = true;
    };
    class FakeWebSocket {
        constructor(url) {
            this.url = url;
            this.sent = [];
            sockets.push(this);
        }

        send(message) { this.sent.push(JSON.parse(message)); }
    }
    const context = loadBrowserScripts(SCRIPTS.concat(['js/cost_basis_fop.js']), {
        document: {
            readyState: 'complete',
            getElementById(id) {
                if (!nodes.has(id)) nodes.set(id, fakeNode(id));
                return nodes.get(id);
            },
            createElement: fakeNode,
        },
        localStorage: { getItem: (key) => (key === 'optionComboWsPort' ? '8799'
            : (key === `optionComboFopZone:${BOOK.bookId}` ? 'America/New_York' : null)), setItem() {} },
        WebSocket: FakeWebSocket,
        location: { search: `?bookId=${BOOK.bookId}`, replace() {}, assign() {} },
        setTimeout: schedule, clearTimeout: cancel, setInterval: schedule, clearInterval: cancel,
        TextEncoder,
        crypto: { subtle: { digest: (algorithm, bytes) => (options.digest ? options.digest(bytes)
            : webcrypto.subtle.digest(algorithm, bytes)) } },
    });
    // The page's socket now: a reconnection opens a new one.
    const current = () => sockets[sockets.length - 1];
    const settle = async () => {
        for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    const answered = new Set();
    const server = { version: options.version, graph: options.graph };
    const handlers = {
        request_cost_basis_status: () => ({ available: true, features: { fopLedger: { engineVersion: 1,
            productRules: ['NYMEX-CL-v1'], writesReleased: options.writesReleased, importCapabilities: CAPABILITIES,
            marketSnapshot: true } } }),
        list_cost_basis_books: () => ({ books: [Object.assign({ eventCount: 5 }, BOOK)] }),
        list_cost_basis_events: () => ({ events: [], total: 0, offset: 0, limit: 1, ledgerVersion: server.version }),
        export_cost_basis_backup: () => ({ format: 'cost-basis-backup', version: 2, kind: 'fop', sha256: 'x',
            payload: server.graph }),
        list_cost_basis_import_batches: () => ({ batches: [] }),
        list_cost_basis_snapshots: () => ({ snapshots: server.snapshots || [] }),
    };
    function pending(action) {
        return current().sent.filter((item) => !answered.has(item.requestId) && (!action || item.action === action));
    }
    async function reply(request, fields) {
        answered.add(request.requestId);
        const body = fields || (handlers[request.action] ? handlers[request.action](request) : {});
        current().onmessage({ data: JSON.stringify(Object.assign({ action: request.action,
            requestId: request.requestId, success: true }, body)) });
        await settle();
        return request;
    }
    /** Answer the oldest pending request of an action. */
    async function answer(action, fields) {
        const [request] = pending(action);
        if (!request) throw new Error(`no pending ${action}`);
        return reply(request, fields);
    }
    /** Answer the newest pending request of an action. */
    async function answerLatest(action, fields) {
        const all = pending(action);
        if (!all.length) throw new Error(`no pending ${action}`);
        return reply(all[all.length - 1], fields);
    }
    async function drain() {
        for (let [request] = pending(); request; [request] = pending()) await reply(request);
    }
    async function open() {
        current().readyState = 1;
        current().onopen();
        await settle();
        await answer('request_cost_basis_status');
        await answer('list_cost_basis_books');
    }
    /** The newest live timer that is not a request timeout: the page's quote re-check. */
    function quoteTimer() {
        return timers.filter((timer) => !timer.cleared && timer.delay !== 45000).pop() || null;
    }
    return { context, get socket() { return current(); }, sockets, server, answer, answerLatest, drain, pending,
        open, settle, timers, quoteTimer,
        node: (id) => { if (!nodes.has(id)) nodes.set(id, fakeNode(id)); return nodes.get(id); },
        page: () => context.OptionComboCostBasisFopPage };
}

// Contracts of the browser checks' statement and the quote evidence the server reports.
const CLOCK = Date.parse('2026-11-12T15:00:00Z');

function evidence(contractId, fields, observedAt = CLOCK - 10000) {
    return Object.assign({ contractId, status: 'ok', reason: null, bid: null, bidSize: null, ask: null, askSize: null,
        last: null, lastSize: null, close: null, closeDate: null, settlement: null, settlementDate: null,
        observedAtUtc: new Date(observedAt).toISOString().replace('Z', '000Z'), marketDataType: 1 }, fields);
}

const MIDS = [evidence(CLF7, { bid: 72.4, bidSize: 3, ask: 72.5, askSize: 2 }),
    evidence(C75, { bid: 0.3, bidSize: 5, ask: 0.35, askSize: 5 }),
    evidence(P65, { bid: 0, bidSize: 4, ask: 0.05, askSize: 6 })];

function snapshot(version, quotes, quoteBatchId = 'quotes-1') {
    return { bookId: BOOK.bookId, quoteBatchId, requestedAtUtc: OBSERVED, ledgerVersion: version, quotes };
}

/** Open the page on ROLLED at V1 and take one quote batch at CLOCK. */
async function pageWithQuotes(quotes = MIDS) {
    const page = loadLedgerPage({ writesReleased: false, version: V1, graph: ROLLED });
    await page.open();
    await page.drain();
    let clock = CLOCK;
    page.page().setClock(() => clock);
    page.node('quote-refresh').fire('click');
    await page.settle();
    await page.answer('request_cost_basis_fop_market_snapshot', snapshot(V1, quotes));
    return Object.assign(page, { advance(ms) { clock += ms; return clock; } });
}

function deliveryControl(page, tag, contractId, root = 'delivery-choices') {
    return findNode(page.node(root), (node) => node.tag === tag && node.dataset.contractId === contractId);
}

const V1 = { eventCount: 5, liveEventCount: 5, maxSeq: 5, digest: '1'.repeat(64) };
const V2 = { eventCount: 6, liveEventCount: 6, maxSeq: 6, digest: '2'.repeat(64) };
const V3 = { eventCount: 7, liveEventCount: 7, maxSeq: 7, digest: '3'.repeat(64) };

module.exports = {
    name: 'cost_basis_fop_page',
    tests: [
        {
            name: 'the ledger view traces every figure to the core and names the contracts',
            run() {
                const output = Core.computeLedger(ROLLED, {});
                const overview = plain(View.overview(output, null, ROLLED));
                assert.deepEqual(overview.rows.slice(0, 3), [['期货已实现（Rf）', '2000.00'],
                    ['期货浮动（Uf）', '未知：缺报价（CLF7）'], ['期权净现金（Co，含佣金）', '400.00']]);
                assert.equal(overview.headline.value, '未知：缺报价（CLF7）', 'an unknown is never 0');
                assert.equal(overview.headline.tag, '不可用');
                assert.equal(overview.identity, 'Rf + Uf + Co + Vo − E + J');
                const futures = plain(View.futuresTable(output, ROLLED, null));
                assert.deepEqual(futures.rows.map((row) => [row.month, row.localSymbol, row.lastTradeDate, row.contracts,
                    row.average]), [['202701', 'CLF7', '2026-12-17', '1', '72.5']]);
                assert.deepEqual([futures.long, futures.short, futures.net], [1, 0, 1]);
                const rolls = plain(View.rollHistory(output, ROLLED));
                assert.deepEqual(rolls.map((row) => [row.evidence, row.from, row.to, row.contracts, row.spread, row.fees]),
                    [['候选', 'CLZ6', 'CLF7', 1, '0.5', '10.00']]);
                assert.equal(rolls[0].events.length, 2, 'a roll names the trades it pairs');
                const events = plain(View.eventsTable(ROLLED.events.map((stored) => stored.row), ROLLED));
                assert.deepEqual(events.map((row) => [row.kind, row.contract, row.quantity]), [
                    ['期货成交', 'CLZ6', '1'], ['期权成交', 'LOZ6 C7500', '-1'], ['期权成交', 'LOZ6 P6500', '1'],
                    ['期货成交', 'CLZ6', '-1'], ['期货成交', 'CLF7', '1']]);
            },
        },
        {
            name: 'an old-month option beside a new-month FUT is flagged and never covered by it (F08)',
            run() {
                const output = Core.computeLedger(ROLLED, {});
                const options = plain(View.optionsTable(output, ROLLED, null, '2026-11-12'));
                assert.deepEqual(options.map((row) => [row.right, row.contracts, row.future, row.binding, row.flags]), [
                    ['C', '-1', 'CLZ6', '报表验证', ['旧月期权：对应期货未持有']],
                    ['P', '1', 'CLZ6', '报表验证', ['旧月期权：对应期货未持有']]]);
                const coverage = plain(View.deliveryCoverage(output, ROLLED));
                assert.deepEqual(coverage.rows.map((row) => [row.future, row.position, row.ifShortsAssigned,
                    row.ifLongsExercised, row.calls, row.notes]),
                [['CLZ6', 0, -1, -1, '无同合约多头覆盖', ['持有的是其他月份期货，不构成同合约覆盖']]]);
                const expired = plain(View.optionsTable(output, ROLLED, null, '2026-11-18'));
                assert.ok(expired.every((row) => row.flags.includes('已过到期日仍未平：缺到期或交割记录')));
            },
        },
        {
            name: 'no single break-even where the plan forbids one, and no division by zero (F13)',
            run() {
                const rolled = plain(View.breakEvenCard(Core.computeLedger(ROLLED, {}), ROLLED));
                assert.equal(rolled.shown, true);
                assert.deepEqual(rolled.rows[1], ['卖方策略等效回本价（已结算结果）', '70.515']);
                const period = { from: '2026-10-01', through: '2026-10-31' };
                const two = graphOf(statements.activity({ period, fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70),
                    fill('CLF7', '2026-10-02T10:00:00', 1, 69)] }));
                assert.deepEqual(plain(View.breakEvenCard(Core.computeLedger(two, {}), two)),
                    { shown: false, reason: '持有多个期货合约：只显示逐合约均价与总盈亏，不给单一回本价', rows: [], hint: '' });
                const spread = graphOf(statements.activity({ period, fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70),
                    fill('CLF7', '2026-10-02T10:00:00', -1, 69)] }));
                const spreadTable = plain(View.futuresTable(Core.computeLedger(spread, {}), spread, null));
                assert.deepEqual([spreadTable.net, spreadTable.note], [0, '持有跨月多空：净张数不代表已平仓。']);
                assert.equal(plain(View.breakEvenCard(Core.computeLedger(spread, {}), spread)).shown, false);
                const optionsOnly = graphOf(statements.activity({ period, fills: [
                    fill('LOZ6 C7500', '2026-10-01T11:00:00', -1, 1.2)] }));
                assert.match(plain(View.breakEvenCard(Core.computeLedger(optionsOnly, {}), optionsOnly)).reason,
                    /当前没有期货持仓/);
                const flat = graphOf(statements.activity({ period, fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70),
                    fill('CLZ6', '2026-10-02T10:00:00', -1, 71, 'C')] }));
                const flatOutput = Core.computeLedger(flat, {});
                assert.equal(plain(View.breakEvenCard(flatOutput, flat)).shown, false);
                assert.equal(plain(View.overview(flatOutput, null, flat)).headline.value, '1000.00',
                    'closed out: the realized result stands without any quote');
            },
        },
        {
            name: 'a late fee stays in its trade\'s closed cycle and the book total counts it once (F36)',
            run() {
                const period = { from: '2026-10-01', through: '2026-11-30' };
                const graph = graphOf(statements.activity({ period, fills: [
                    fill('CLZ6', '2026-10-01T10:00:00', 1, 70), fill('CLZ6', '2026-10-02T10:00:00', -1, 70.1, 'C'),
                    fill('CLF7', '2026-11-03T10:00:00', 1, 69), fill('CLF7', '2026-11-04T10:00:00', -1, 69.2, 'C')] }));
                const [opened, closed] = graph.events.map((stored) => stored.row);
                graph.cycles.push({ boundaryId: 'cycle-000000001', revision: 1, state: 'closed',
                    anchorEventId: closed.eventId, label: '第一轮', supersededByRevision: null });
                const fee = JSON.parse(JSON.stringify(graph.events[0]));
                Object.assign(fee.row, { eventId: 'late-fee-0001', seq: 99, kind: 'fee', contracts: null,
                    futureContracts: null, price: null, cashAmount: -10, fees: 0, source: 'manual' });
                Object.assign(fee.row.fop, { contractRef: null, feeCategory: 'futures', feeSourceEventId: opened.eventId,
                    time: Object.assign({}, fee.row.fop.time, { executedAtUtc: '2026-11-20T15:00:00.000000Z' }) });
                graph.events.push(fee);
                const cycles = plain(View.cyclesTable(Core.computeLedger(graph, {}), graph));
                assert.deepEqual(cycles.rows.map((row) => [row.index, row.state, row.label, row.Rf, row.E, row.economicPnl]),
                    [[1, '已结束', '第一轮', '100.00', '10.00', '90.00'], [2, '当前', '', '200.00', '0.00', '200.00']]);
                const overview = plain(View.overview(Core.computeLedger(graph, {}), null, graph));
                assert.equal(overview.headline.value, '290.00');
                // The anchors a new boundary may use are only after the last one.
                assert.deepEqual(plain(Forms.cycleAnchors(graph)), [graph.events[3].row.eventId]);
            },
        },
        {
            name: 'manual entries build requests the frozen contract accepts, and refuse what it cannot',
            run() {
                const checker = createChecker(PROTOCOL.types);
                const context = { book: BOOK, graph: ROLLED, timeZone: 'America/New_York', observedAtUtc: OBSERVED };
                const request = { requestId: 'r-1', clientToken: 'manual-0000001', expectedLedgerVersion: V1,
                    bookIdentity: { account: BOOK.account, symbol: 'CL', secType: 'FUT', currency: 'USD' } };
                const packages = [
                    Forms.futuresTrade({ contract: { contractId: CLF7 }, quantity: -1, price: -2.5, fees: 2,
                        time: { local: '2026-11-13T10:00' } }, context),
                    Forms.futuresTrade({ contract: { month: '202702', localSymbol: 'CLG7' }, quantity: 1, price: 71,
                        time: { date: '2026-11-13' } }, context),
                    Forms.optionTrade({ contract: { right: 'P', strike: 65, expiry: '2026-12-16', tradingClass: 'LO',
                        localSymbol: 'LOF7 P6500', future: { contractId: CLF7 } }, quantity: -2, price: 0.8,
                    fees: 3, time: { local: '2026-11-13T11:00' } }, context),
                    Forms.delivery({ optionContractId: C75, kind: 'assignment', contracts: 1,
                        fees: 1.5, time: { local: '2026-11-13T16:00' } }, context),
                    Forms.delivery({ optionContractId: P65, kind: 'exercise', contracts: 1,
                        time: { local: '2026-11-13T16:10' } }, context),
                    Forms.expiry({ optionContractId: P65, contracts: -1,
                        time: { date: '2026-11-17' } }, context),
                    Forms.fee({ category: 'futures', amount: 10, feeSourceEventId: 'evt-0000000001',
                        time: { date: '2026-11-20' }, note: 'late fee' }, context),
                ];
                for (const fopPackage of packages) {
                    assert.deepEqual(checker.check('AppendRequest', plain(Forms.appendRequest(fopPackage, context, request))),
                        [], fopPackage.events[0].kind);
                }
                const [negative, newFuture, newOption, assigned, exercised] = packages.map((item) => item.events[0]);
                assert.equal(negative.price, -2.5, 'a negative FUT price is kept, never abs()');
                assert.equal(newFuture.time.timeRange.startUtc, '2026-11-13T05:00:00.000000Z');
                assert.equal(packages[1].contracts[0].evidenceStatus, 'manual_attested');
                assert.equal(packages[2].bindings[0].status, 'manual_attested');
                assert.equal(newOption.cashAmount, 2 * 1000 * 0.8 - 3);
                assert.deepEqual([assigned.contracts, assigned.futureContracts, assigned.price, assigned.cashAmount],
                    [1, -1, 75, -1.5]);
                assert.deepEqual([exercised.contracts, exercised.futureContracts, exercised.price], [-1, -1, 65]);
                assert.deepEqual(checker.check('VoidRequest', plain(Forms.voidRequest('evt-0000000001', 'typo', context,
                    request))), []);
                assert.deepEqual(checker.check('MetadataCommitRequest', plain(Forms.metadataRequest({ kind: 'revoke_cycle',
                    boundaryId: 'cycle-000000001' }, context, request))), []);
                for (const [build, message] of [
                    [() => Forms.futuresTrade({ contract: { month: '20261219' }, quantity: 1, price: 70,
                        time: { date: '2026-11-13' } }, context), /交割月必须是 YYYYMM/],
                    [() => Forms.optionTrade({ contract: { right: 'C', strike: 0, expiry: '2026-12-16', tradingClass: 'LO',
                        future: { contractId: CLF7 } }, quantity: 1, price: 1, time: { date: '2026-11-13' } },
                    context), /零或负行权价/],
                    [() => Forms.futuresTrade({ contract: { contractId: CLF7 }, quantity: 0, price: 70,
                        time: { date: '2026-11-13' } }, context), /非零整数/],
                    [() => Forms.voidRequest('evt-0000000001', ' ', context, request), /写明原因/],
                    [() => Forms.futuresTrade({ contract: { contractId: CLF7 }, quantity: 1, price: 70,
                        time: { local: '2026-11-13T10:00' } }, Object.assign({}, context, { timeZone: '' })), /账户时区/],
                ]) {
                    assert.throws(build, message);
                }
            },
        },
        {
            name: 'the delivery preview replays a copy in memory and stops where the plan stops it',
            run() {
                const before = JSON.stringify(ROLLED);
                const prices = { [CLZ6]: 76, [CLF7]: 73 };
                const output = Core.computeLedger(ROLLED, {});
                const choices = plain(Forms.atExpiry(output, ROLLED, prices));
                assert.deepEqual(choices, [{ optionContractId: C75, action: 'assign' },
                    { optionContractId: P65, action: 'expire' }]);
                const result = Forms.deliveryPreview(ROLLED, BOOK, choices, prices, '2026-11-13T15:00:00.000000Z');
                assert.equal(result.stopped, false, result.reason);
                assert.deepEqual(plain(result.rows).map((row) => [row.localSymbol, row.before, row.after]).sort(), [
                    ['CLF7', 1, 1], ['CLZ6', 0, -1], ['LOZ6 C7500', -1, 0], ['LOZ6 P6500', 1, 0]]);
                assert.equal(result.after.totals.economicPnl.value, 1885);
                assert.equal(JSON.stringify(ROLLED), before, 'the ledger graph is untouched');
                const past = Forms.deliveryPreview(ROLLED, BOOK, choices, prices, '2026-11-20T15:00:00.000000Z');
                assert.match(past.reason, /已最后交易/);
                const early = Forms.deliveryPreview(ROLLED, BOOK, choices, prices, '2026-11-01T15:00:00.000000Z');
                assert.match(early.reason, /晚于账本最后一笔事件/);
                const wrongSide = Forms.deliveryPreview(ROLLED, BOOK, [{ optionContractId: P65,
                    action: 'assign' }], prices, '2026-11-13T15:00:00.000000Z');
                assert.match(wrongSide.reason, /只有空头会被指派/);
            },
        },
        {
            name: 'a late answer for an older reload, or a quote batch for an older version, is dropped (F23)',
            async run() {
                const page = loadLedgerPage({ writesReleased: true, version: V1, graph: ROLLED });
                await page.open();
                // The first read is still out when the user reloads.
                assert.equal(page.pending('list_cost_basis_events').length, 1);
                page.node('ledger-reload').fire('click');
                await page.settle();
                assert.equal(page.pending('list_cost_basis_events').length, 2);
                // The reload is answered first, at version 2 ...
                page.server.version = V2;
                await page.answerLatest('list_cost_basis_events');
                await page.answer('export_cost_basis_backup');
                await page.answerLatest('list_cost_basis_events');
                await page.answer('list_cost_basis_import_batches');
                assert.equal(page.page().inspect().version.digest, V2.digest);
                // ... then the first read comes back late, at version 1: dropped.
                page.server.version = V1;
                await page.drain();
                assert.equal(page.page().inspect().version.digest, V2.digest);
                // A quote batch taken against version 1 is not shown for version 2.
                page.node('quote-refresh').fire('click');
                await page.settle();
                await page.answer('request_cost_basis_fop_market_snapshot', { bookId: BOOK.bookId,
                    quoteBatchId: 'quotes-old', requestedAtUtc: OBSERVED, ledgerVersion: V1, quotes: [] });
                assert.equal(page.page().inspect().quoteBatchId, null);
                assert.match(page.node('ledger-status').textContent, /已丢弃/);
                // An answer to an older quote request is not shown either.
                page.node('quote-refresh').fire('click');
                await page.settle();
                page.node('quote-refresh').fire('click');
                await page.settle();
                await page.answer('request_cost_basis_fop_market_snapshot', { bookId: BOOK.bookId,
                    quoteBatchId: 'quotes-older-request', requestedAtUtc: OBSERVED, ledgerVersion: V2, quotes: [] });
                assert.equal(page.page().inspect().quoteBatchId, null);
                await page.answer('request_cost_basis_fop_market_snapshot', { bookId: BOOK.bookId,
                    quoteBatchId: 'quotes-new', requestedAtUtc: OBSERVED, ledgerVersion: V2, quotes: [] });
                assert.equal(page.page().inspect().quoteBatchId, 'quotes-new');
            },
        },
        {
            name: 'an import previewed against an older version is not sent, and closed writes send nothing',
            async run() {
                const page = loadLedgerPage({ writesReleased: true, version: V1, graph: ROLLED });
                await page.open();
                await page.drain();
                const text = statements.activity({ period: { from: '2026-11-11', through: '2026-11-30' }, fills: [
                    fill('CLF7', '2026-11-20T10:00:00', -1, 73, 'C')], openPositions: [
                    { symbol: 'LOZ6 C7500', quantity: -1 }, { symbol: 'LOZ6 P6500', quantity: 1 }] });
                page.node('import-file').files = [{ name: 'late-november.csv', text: async () => text }];
                page.node('import-file').fire('change');
                await page.settle();
                assert.ok(page.page().inspect().importPlan, page.node('import-status').textContent);
                // Someone writes: the ledger moves to version 3 and the page reloads.
                page.server.version = V3;
                page.node('ledger-reload').fire('click');
                await page.drain();
                assert.equal(page.page().inspect().importPlan, null);
                assert.match(page.node('import-status').textContent, /已作废/);
                page.node('import-submit').fire('click');
                await page.settle();
                assert.equal(page.pending('import_cost_basis_events').length, 0);
                assert.match(page.node('import-status').textContent, /请先选择报表并预览/);
                // With writes closed nothing is sent, whatever is clicked.
                const closed = loadLedgerPage({ writesReleased: false, version: V1, graph: ROLLED });
                await closed.open();
                await closed.drain();
                closed.node('manual-kind').value = 'fee';
                closed.node('manual-fee-category').value = 'futures';
                closed.node('manual-fee-amount').value = '10';
                closed.node('manual-date').value = '2026-11-20';
                closed.node('manual-submit').fire('click');
                closed.node('void-event').value = 'x';
                closed.node('void-submit').fire('click');
                await closed.settle();
                const writes = closed.socket.sent.filter((message) => pure.OptionComboCostBasisCommon
                    .isWriteAction(message.action));
                assert.deepEqual(writes, []);
                assert.match(closed.node('manual-status').textContent, /FOP 写入尚未发布/);
            },
        },
        {
            name: 'an import is sent against the version it was previewed on, even if the page reloads meanwhile (F23)',
            async run() {
                const text = statements.activity({ period: { from: '2026-11-11', through: '2026-11-30' }, fills: [
                    fill('CLF7', '2026-11-20T10:00:00', -1, 73, 'C')], openPositions: [
                    { symbol: 'LOZ6 C7500', quantity: -1 }, { symbol: 'LOZ6 P6500', quantity: 1 }] });
                async function previewed(digest) {
                    const page = loadLedgerPage({ writesReleased: true, version: V1, graph: ROLLED, digest });
                    await page.open();
                    await page.drain();
                    page.node('import-file').files = [{ name: 'late-november.csv', text: async () => text }];
                    page.node('import-file').value = 'C:\\fakepath\\late-november.csv';
                    page.node('import-file').fire('change');
                    await page.settle();
                    page.node('import-claim').checked = true;
                    page.node('import-attestation').value = 'checked against the broker statement';
                    return page;
                }
                // Undisturbed, the request names the version the preview was planned on.
                const steady = await previewed(async () => new Uint8Array(32).buffer);
                // A new account zone previews the statement again in that zone.
                const zoneOf = () => findNode(steady.node('import-summary'), (node) => /（/.test(node.textContent)
                    && node.tag === 'dd' && /\//.test(node.textContent)).textContent;
                assert.match(zoneOf(), /America\/New_York/);
                steady.node('ledger-zone').value = 'America/Chicago';
                steady.node('ledger-zone').fire('change');
                assert.match(zoneOf(), /America\/Chicago/);
                steady.node('import-submit').fire('click');
                await steady.settle();
                const [sent] = steady.pending('import_cost_basis_events');
                assert.ok(sent, steady.node('import-status').textContent);
                assert.equal(sent.expectedLedgerVersion.digest, V1.digest);
                // The ledger moves while the file digest is being taken: nothing is sent.
                let release;
                const page = await previewed(() => new Promise((resolve) => {
                    release = () => resolve(new Uint8Array(32).buffer);
                }));
                page.node('import-submit').fire('click');
                await page.settle();
                page.server.version = V3;
                page.node('ledger-reload').fire('click');
                await page.drain();
                assert.match(page.node('import-status').textContent, /已作废/);
                release();
                await page.settle();
                assert.deepEqual(page.pending('import_cost_basis_events'), []);
                assert.match(page.node('import-status').textContent, /未导入：账本已在预览后变化/);
                assert.equal(page.node('import-file').value, '', 'the same file can be chosen again');
            },
        },
        {
            name: 'a lost connection retires the quotes at once, and a quote stops being current at 120 s',
            async run() {
                const page = await pageWithQuotes();
                assert.deepEqual([page.node('overview-value').textContent, page.node('overview-tag').textContent],
                    ['2035.00', '实时']);
                page.socket.onclose();
                assert.equal(page.page().inspect().quoteBatchId, null);
                assert.match(page.node('overview-value').textContent, /^未知/);
                assert.notEqual(page.node('overview-tag').textContent, '实时');
                assert.match(page.node('ledger-status').textContent, /连接已断开.*报价已作废/);
                // Connected, the re-check lands on the freshness limit, not up to 15 s after it.
                const aged = await pageWithQuotes();
                const observed = CLOCK - 10000;
                let now = CLOCK;
                for (let turn = 0; turn < 20 && aged.node('overview-tag').textContent === '实时'; turn += 1) {
                    const timer = aged.quoteTimer();
                    assert.ok(timer, 'a quote re-check is scheduled');
                    now = aged.advance(timer.delay);
                    timer.fn();
                }
                assert.match(aged.node('overview-value').textContent, /^未知/);
                assert.ok(now - observed > 120000 && now - observed <= 120001, `stale after ${now - observed} ms`);
            },
        },
        {
            name: 'the quote re-check leaves the delivery inputs alone, and a reload keeps what was typed',
            async run() {
                const page = await pageWithQuotes();
                const select = deliveryControl(page, 'select', C75);
                const count = deliveryControl(page, 'input', C75);
                const price = deliveryControl(page, 'input', CLZ6, 'delivery-prices');
                select.value = 'assign';
                price.value = '76';
                page.page().setClock(() => CLOCK + 20000);
                page.quoteTimer().fn();
                assert.equal(deliveryControl(page, 'select', C75), select, 'the re-check rebuilt the choices');
                assert.equal(deliveryControl(page, 'input', CLZ6, 'delivery-prices'), price);
                assert.deepEqual([select.value, count.value, price.value], ['assign', '1', '76']);
                page.node('ledger-reload').fire('click');
                await page.drain();
                assert.deepEqual([deliveryControl(page, 'select', C75).value, deliveryControl(page, 'input', CLZ6,
                    'delivery-prices').value], ['assign', '76']);
                // A result worked out on an older version is retired with it.
                page.node('delivery-at').value = '2026-11-13T10:00';
                page.node('delivery-run').fire('click');
                assert.ok(page.page().inspect().delivery, page.node('delivery-status').textContent);
                page.server.version = V2;
                page.node('ledger-reload').fire('click');
                await page.drain();
                assert.equal(page.page().inspect().delivery, null);
                assert.match(page.node('delivery-status').textContent, /旧的交割预览已作废/);
                assert.deepEqual(page.node('delivery-result').children, []);
            },
        },
        {
            name: 'a delivery preview takes a quantity per option, within what is open (plan §12.1)',
            async run() {
                const period = { from: '2026-10-01', through: '2026-10-31' };
                const two = graphOf(statements.activity({ period, fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70),
                    fill('LOZ6 C7500', '2026-10-01T11:00:00', -2, 1.2)] }));
                const at = '2026-11-13T15:00:00.000000Z';
                const prices = { [CLZ6]: 76 };
                const moved = (result) => plain(result.rows).map((row) => [row.localSymbol, row.before, row.after]).sort();
                const one = Forms.deliveryPreview(two, BOOK, [{ optionContractId: C75, action: 'assign', contracts: 1 }],
                    prices, at);
                assert.equal(one.stopped, false, one.reason);
                assert.deepEqual(moved(one), [['CLZ6', 1, 0], ['LOZ6 C7500', -2, -1]]);
                const expired = Forms.deliveryPreview(two, BOOK, [{ optionContractId: C75, action: 'expire',
                    contracts: 1 }], prices, at);
                assert.deepEqual(moved(expired), [['CLZ6', 1, 1], ['LOZ6 C7500', -2, -1]]);
                const whole = Forms.deliveryPreview(two, BOOK, [{ optionContractId: C75, action: 'assign' }], prices, at);
                assert.deepEqual(moved(whole), [['CLZ6', 1, -1], ['LOZ6 C7500', -2, 0]], 'no quantity: all that is open');
                for (const contracts of [0, 3, 1.5, -1]) {
                    const refused = Forms.deliveryPreview(two, BOOK, [{ optionContractId: C75, action: 'assign',
                        contracts }], prices, at);
                    assert.match(refused.reason || '', /1 到 2 之间的整数/, String(contracts));
                }
                const twice = Forms.deliveryPreview(two, BOOK, [{ optionContractId: C75, action: 'assign', contracts: 1 },
                    { optionContractId: C75, action: 'expire', contracts: 1 }], prices, at);
                assert.match(twice.reason, /只能选择一次/);
                // The page offers the quantity and sends it to the preview.
                const page = await pageWithQuotes();
                assert.equal(deliveryControl(page, 'input', C75).value, '1', 'defaults to the whole open quantity');
                deliveryControl(page, 'select', C75).value = 'assign';
                deliveryControl(page, 'input', CLZ6, 'delivery-prices').value = '76';
                page.node('delivery-at').value = '2026-11-13T10:00';
                page.node('delivery-run').fire('click');
                assert.match(page.node('delivery-status').textContent, /假设交割/);
                deliveryControl(page, 'input', C75).value = '2';
                page.node('delivery-run').fire('click');
                assert.match(page.node('delivery-status').textContent, /1 到 1 之间的整数/);
            },
        },
        {
            name: 'a delivery path stops at the last trade date of every FUT it holds, and at an option left open past expiry',
            run() {
                const period = { from: '2026-11-01', through: '2026-11-30' };
                // CLF7 traded flat, so the statement names the FUT LOF7 delivers.
                const held = graphOf(statements.activity({ period, fills: [fill('CLZ6', '2026-11-02T10:00:00', 1, 70),
                    fill('CLF7', '2026-11-02T11:00:00', 1, 70.5), fill('CLF7', '2026-11-02T12:00:00', -1, 70.6, 'C'),
                    fill('LOF7 C8000', '2026-11-03T10:00:00', -1, 1.5)] }));
                const lof7 = held.contracts.find((stored) => stored.record.localSymbol === 'LOF7 C8000').record.contractId;
                const prices = { [CLZ6]: 70, [CLF7]: 81 };
                const stopped = Forms.deliveryPreview(held, BOOK, [{ optionContractId: lof7, action: 'assign' }], prices,
                    '2026-12-16T20:00:00.000000Z');
                assert.equal(stopped.stopped, true, 'CLZ6 is still held after its last trade date');
                assert.match(stopped.reason, /CLZ6 在 2026-11-19 已最后交易/);
                const before = Forms.deliveryPreview(held, BOOK, [{ optionContractId: lof7, action: 'assign' }], prices,
                    '2026-11-18T20:00:00.000000Z');
                assert.equal(before.stopped, false, before.reason);
                // The last trade date is an exchange date: 19:00 in Chicago on the 19th is still the 19th.
                const evening = Forms.deliveryPreview(held, BOOK, [{ optionContractId: lof7, action: 'assign' }], prices,
                    '2026-11-20T01:00:00.000000Z');
                assert.equal(evening.stopped, false, evening.reason);
                const three = graphOf(statements.activity({ period, fills: [fill('CLF7', '2026-11-02T10:00:00', 1, 70),
                    fill('LOZ6 C7500', '2026-11-02T11:00:00', -1, 1.2), fill('LOF7 C8000', '2026-11-03T10:00:00', -1, 1.5)] }));
                const left = Forms.deliveryPreview(three, BOOK, [{ optionContractId: lof7, action: 'assign' }], prices,
                    '2026-11-18T20:00:00.000000Z');
                assert.match(left.reason || '', /LOZ6 C7500 已于 2026-11-17 到期/);
            },
        },
        {
            name: 'the summary carries the lowest quote level: a one-sided value is never a plain real-time one (§10.3)',
            run() {
                const Quotes = pure.OptionComboCostBasisFopQuotes;
                const valued = (quotes) => {
                    const targets = Quotes.quoteTargets(Core.computeLedger(ROLLED, { rolls: false }));
                    const quoteState = Quotes.evaluateBatch(snapshot(V1, quotes), { targets, ledgerVersion: V1,
                        now: CLOCK });
                    return plain(View.overview(Core.computeLedger(ROLLED, { marks: quoteState.marks }), quoteState,
                        ROLLED));
                };
                const mids = valued(MIDS);
                assert.deepEqual([mids.headline.tag, mids.quality.label], ['实时', '实时（批内同步）']);
                assert.deepEqual(mids.rows.map((row) => row[0]).filter((label) => /单边|参考/.test(label)), []);
                const oneSided = valued([evidence(CLF7, { bid: 72.4, bidSize: 3 }), MIDS[1], MIDS[2]]);
                assert.equal(oneSided.headline.value, '1985.00');
                assert.equal(oneSided.headline.tag, '实时 · 含单边保守估值');
                assert.match(oneSided.quality.label, /最低一级：单边保守估值/);
                assert.deepEqual(oneSided.rows.slice(1, 4).map((row) => row[0]), ['期货浮动（Uf）（含单边保守估值）',
                    '期权净现金（Co，含佣金）', '未平期权市值（Vo）']);
                const integrity = plain(View.integrity(Core.computeLedger(ROLLED, {}), { graph: ROLLED,
                    coverage: null, quoteState: Quotes.evaluateBatch(snapshot(V1, [evidence(CLF7, { bid: 72.4,
                        bidSize: 3 }), MIDS[1], MIDS[2]]), { targets: Quotes.quoteTargets(Core.computeLedger(ROLLED, {})),
                        ledgerVersion: V1, now: CLOCK }) }));
                assert.match(integrity.find((item) => item.name === '行情').detail, /单边保守估值/);
            },
        },
        {
            name: 'a possible duplicate is decided row by row with its check, and the decision travels (P5-C1)',
            async run() {
                // One stored order of 3 CLZ6 (an Activity order row), then its two
                // executions from a Flex export: nothing proves either way.
                const period = { from: '2026-10-01', through: '2026-10-31' };
                const order = graphOf(statements.activity({ period, fills: [{ symbol: 'CLZ6',
                    local: '2026-10-01T10:00:00', qty: 3, price: 212 / 3, commission: -3, codes: 'O' }],
                openPositions: [{ symbol: 'CLZ6', quantity: 3, costPrice: 212 / 3 }] }));
                const [stored] = order.events.map((item) => item.row.eventId);
                order.requests = [{ clientToken: 'batch-earlier01', action: 'import', requestDigest: 'd'.repeat(64),
                    createdAtUtc: '2026-11-02T10:00:00Z', resultJson: JSON.stringify({ importBatchId: 'batch-earlier01',
                        duplicateDecisions: [{ decision: 'distinct_fill', namespace: 'flex_trade', sourceRef: '777',
                            eventIds: [stored], attestation: 'two confirmations', source: null }] }) }];
                const page = loadLedgerPage({ writesReleased: true, version: V1, graph: order,
                    digest: async () => new Uint8Array(32).buffer });
                await page.open();
                await page.drain();
                const log = findNode(page.node('import-decision-log'), (node) => node.tag === 'table');
                assert.ok(log, 'the recorded decisions are listed');
                assert.match(JSON.stringify(log.children.map((row) => row.children.map((cell) => cell.textContent))),
                    /flex_trade:777.*另一笔.*two confirmations/);
                const text = statements.flex({ fills: [
                    { symbol: 'CLZ6', local: '2026-10-01T10:00:00', qty: 1, price: 70, commission: -1, codes: 'O',
                        tradeId: '900' },
                    { symbol: 'CLZ6', local: '2026-10-01T10:00:05', qty: 2, price: 71, commission: -2, codes: 'O',
                        tradeId: '901' }] });
                page.node('import-file').files = [{ name: 'flex-october.csv', text: async () => text }];
                page.node('import-file').fire('change');
                await page.settle();
                assert.equal(page.node('import-duplicates-block').hidden, false);
                const reviews = page.node('import-duplicates').children;
                assert.equal(reviews.length, 2);
                assert.match(reviews[0].children[0].textContent, /CLZ6 · 数量 1 · 价格 70 · 费用 1.*待核实/);
                assert.match(page.node('import-status').textContent, /2 行疑似重复/);
                // Undecided: nothing can be sent.
                page.node('import-submit').fire('click');
                await page.settle();
                assert.equal(page.pending('import_cost_basis_events').length, 0);
                // Both rows are the stored order, with the check they rest on.
                for (const review of reviews) {
                    const select = findNode(review, (node) => node.tag === 'select');
                    const attestation = findNode(review, (node) => node.tag === 'input');
                    assert.deepEqual(select.children.map((option) => option.value),
                        ['', `same:${stored}`, 'distinct']);
                    select.value = `same:${stored}`;
                    attestation.value = 'the broker confirms one order of 3';
                }
                page.node('import-decide').fire('click');
                assert.equal(page.page().inspect().importPlan.blocking, false, page.node('import-status').textContent);
                assert.equal(page.page().inspect().importPlan.events, 0);
                assert.match(page.node('import-duplicates').children[0].children[0].textContent, /认定为同一笔/);
                page.node('import-submit').fire('click');
                await page.settle();
                const [sent] = page.pending('import_cost_basis_events');
                assert.ok(sent, page.node('import-status').textContent);
                assert.equal(sent.fopPackage, null);
                assert.deepEqual(sent.duplicateDecisions.map((item) => [item.decision, item.eventIds, item.sourceRef,
                    item.attestation]), [['same_fill', [stored], '900', 'the broker confirms one order of 3'],
                    ['same_fill', [stored], '901', 'the broker confirms one order of 3']]);
                assert.deepEqual(createChecker(PROTOCOL.types).check('ImportRequest', plain(sent)), []);
            },
        },
        {
            name: 'a binding is adopted only from broker evidence, previewed first and sent once (P5-C2)',
            async run() {
                // LOF7 sold without its future in the statement: the binding waits for evidence.
                const period = { from: '2026-11-01', through: '2026-11-30' };
                const graph = graphOf(statements.activity({ period, fills: [
                    fill('CLZ6', '2026-11-02T10:00:00', 1, 70), fill('LOF7 C8000', '2026-11-03T10:00:00', -1, 1.5)] }));
                const lof7 = graph.contracts.find((item) => item.record.localSymbol === 'LOF7 C8000').record;
                assert.equal(graph.bindings[0].status, 'unresolved');
                const future = { contractId: null, revision: null, secType: 'FUT', conId: 556, root: 'CL',
                    tradingClass: 'CL', localSymbol: 'CLF7', exchange: 'NYMEX', currency: 'USD',
                    futureContractMonth: '202701', futureLastTradeDate: '2026-12-17', futureLastTradeAsOf: null,
                    futurePointValue: 1000, ruleVersion: 'NYMEX-CL-v1', evidenceStatus: 'verified_broker',
                    evidenceSummary: 'IB contract details via underConId', observedAtUtc: OBSERVED };
                const proved = { contractId: lof7.contractId, status: 'verified_broker',
                    option: Object.assign({}, lof7, { evidenceStatus: 'verified_broker', evidenceSummary: 'IB contract details',
                        observedAtUtc: OBSERVED }),
                    future, evidenceSummary: 'IB: LOF7 C8000 -> underConId 556 CLF7 contractMonth 202701',
                    evidenceCredential: 'eyJ2IjoxfQ.c2lnbmF0dXJl', problems: [] };
                // Pure: what the adoption changes, and where it stops.
                const plan = Forms.bindingAdoption(graph, BOOK, proved);
                assert.equal(plan.stopped, false, plan.reason);
                assert.deepEqual(plain(plan.operation.contracts).map((record) => [record.localSymbol, record.revision,
                    record.evidenceStatus]), [['CLF7', 1, 'verified_broker']]);
                assert.equal(plan.operation.binding.futureContractId, plan.operation.contracts[0].contractId);
                assert.deepEqual(plain(plan.operation.affected), []);
                assert.match(plan.changes.map((row) => row.join(' ')).join('\n'), /新增期货 CLF7，交割月 202701/);
                const unproved = Forms.bindingAdoption(graph, BOOK, Object.assign({}, proved, { status: 'unresolved',
                    future: null, evidenceCredential: null, problems: ['contract_month_missing: the FUT details carry no contractMonth'] }));
                assert.match(unproved.reason, /不猜交割月/);
                const other = Forms.bindingAdoption(graph, BOOK, Object.assign({}, proved, {
                    option: Object.assign({}, proved.option, { optionStrike: 85 }) }));
                assert.match(other.reason, /optionStrike（账本 80，券商 85）.*经济更正/);
                const bare = JSON.parse(JSON.stringify(graph));
                bare.contracts.find((item) => item.record.contractId === lof7.contractId).record.conId = null;
                const filled = Forms.bindingAdoption(bare, BOOK, proved);
                assert.deepEqual(plain(filled.operation.contracts).map((record) => [record.contractId, record.revision,
                    record.conId]), [[lof7.contractId, 2, 9003], [filled.operation.binding.futureContractId, 1, 556]]);
                assert.deepEqual(plain(filled.operation.affected).map((item) => [item.reference, item.before.revision,
                    item.after.revision]), [['contract', 1, 2]]);

                // The page: query, preview, confirm; nothing is written before the confirmation.
                const page = loadLedgerPage({ writesReleased: true, version: V1, graph });
                await page.open();
                await page.drain();
                assert.deepEqual(page.node('binding-option').children.map((option) => option.value), ['', lof7.contractId]);
                page.node('binding-option').value = lof7.contractId;
                page.node('binding-query').fire('click');
                await page.settle();
                const [query] = page.pending('request_cost_basis_fop_contract_details');
                assert.deepEqual(query.contracts.map((record) => record.contractId), [lof7.contractId]);
                await page.answer('request_cost_basis_fop_contract_details', { bookId: BOOK.bookId, results: [proved] });
                assert.equal(page.node('binding-confirm').hidden, false, page.node('binding-status').textContent);
                assert.deepEqual(page.socket.sent.filter((item) => pure.OptionComboCostBasisCommon.isWriteAction(item.action)), []);
                page.node('binding-adopt').fire('click');
                page.node('binding-adopt').fire('click');
                await page.settle();
                const commits = page.pending('commit_cost_basis_fop_metadata');
                assert.equal(commits.length, 2);
                assert.equal(commits[0].clientToken, commits[1].clientToken, 'a repeated confirmation is the same request');
                assert.deepEqual(commits[0].expectedLedgerVersion, V1);
                assert.deepEqual(createChecker(PROTOCOL.types).check('MetadataCommitRequest', plain(commits[0])), []);
                assert.equal(commits[0].operation.contracts[0].localSymbol, 'CLF7');
                // The server answers the repeat with the first answer; the page reloads the new version.
                const adopted = { bookId: BOOK.bookId, operation: { operationId: 'op-0001', kind: 'adopt_binding' },
                    ledgerVersion: V2 };
                page.server.version = V2;
                await page.answer('commit_cost_basis_fop_metadata', Object.assign({ idempotentReplay: false }, adopted));
                await page.answer('commit_cost_basis_fop_metadata', Object.assign({ idempotentReplay: true }, adopted));
                await page.drain();
                assert.equal(page.page().inspect().version.digest, V2.digest);
                assert.match(page.node('binding-status').textContent, /已采纳/);

                // A backend without a resolver says so and proposes nothing.
                page.node('binding-query').fire('click');
                await page.settle();
                await page.answer('request_cost_basis_fop_contract_details', { success: false,
                    code: 'fop_contract_details_unavailable', message: 'this backend cannot resolve FOP contracts' });
                assert.match(page.node('binding-status').textContent, /不能向券商查询合约.*不会生成证据/);
                assert.equal(page.node('binding-confirm').hidden, true);
                // Evidence taken before the ledger moved is dropped with it.
                page.node('binding-query').fire('click');
                await page.settle();
                await page.answer('request_cost_basis_fop_contract_details', { bookId: BOOK.bookId, results: [proved] });
                assert.equal(page.node('binding-confirm').hidden, false);
                page.server.version = V3;
                page.node('ledger-reload').fire('click');
                await page.drain();
                assert.match(page.node('binding-status').textContent, /旧的绑定查询与预览已作废/);
                assert.equal(page.node('binding-confirm').hidden, true);
                page.node('binding-adopt').fire('click');
                await page.settle();
                assert.equal(page.pending('commit_cost_basis_fop_metadata').length, 0);
            },
        },
        {
            name: 'a manual entry is previewed in memory, and only the previewed request is confirmed (P5-C5)',
            async run() {
                const context = { book: BOOK, graph: ROLLED, timeZone: 'America/New_York', observedAtUtc: OBSERVED };
                const before = JSON.stringify(ROLLED);
                // Pure: each kind, its positions and totals before and after; nothing is stored.
                const negative = Forms.manualPreview(ROLLED, Forms.futuresTrade({ contract: { contractId: CLF7 },
                    quantity: 1, price: -2.5, fees: 2, time: { local: '2026-11-13T10:00' } }, context), {});
                assert.equal(negative.stopped, false, negative.reason);
                assert.deepEqual(plain(negative.rows), [{ contractId: CLF7, localSymbol: 'CLF7', before: 1, after: 2 }]);
                assert.equal(negative.events[0].price, -2.5, 'a negative FUT price is previewed as it is');
                assert.equal(negative.after.totals.E.value - negative.before.totals.E.value, 2);
                const opened = Forms.manualPreview(ROLLED, Forms.optionTrade({ contract: { right: 'P', strike: 65,
                    expiry: '2026-12-16', tradingClass: 'LO', localSymbol: 'LOF7 P6500', future: { contractId: CLF7 } },
                quantity: -2, price: 0.8, fees: 3, time: { local: '2026-11-13T11:00' } }, context), {});
                assert.deepEqual(plain(opened.created), ['LOF7 P6500']);
                assert.equal(opened.after.totals.Co.value - opened.before.totals.Co.value, 2 * 1000 * 0.8 - 3);
                const assigned = Forms.manualPreview(ROLLED, Forms.delivery({ optionContractId: C75, kind: 'assignment',
                    contracts: 1, fees: 1.5, time: { local: '2026-11-13T16:00' } }, context), {});
                assert.deepEqual(plain(assigned.rows).map((row) => [row.localSymbol, row.before, row.after]),
                    [['LOZ6 C7500', -1, 0], ['CLZ6', 0, -1]]);
                const exercised = Forms.manualPreview(ROLLED, Forms.delivery({ optionContractId: P65, kind: 'exercise',
                    contracts: 1, time: { local: '2026-11-13T16:10' } }, context), {});
                assert.deepEqual(plain(exercised.rows).map((row) => [row.localSymbol, row.before, row.after]),
                    [['LOZ6 P6500', 1, 0], ['CLZ6', 0, -1]]);
                const expired = Forms.manualPreview(ROLLED, Forms.expiry({ optionContractId: P65, contracts: -1,
                    time: { date: '2026-11-17' } }, context), {});
                assert.deepEqual(plain(expired.rows).map((row) => [row.localSymbol, row.after]), [['LOZ6 P6500', 0]]);
                const fee = Forms.manualPreview(ROLLED, Forms.fee({ category: 'futures', amount: 10,
                    time: { date: '2026-11-20' } }, context), {});
                assert.equal(fee.after.totals.E.value - fee.before.totals.E.value, 10);
                const overdraw = Forms.manualPreview(ROLLED, Forms.expiry({ optionContractId: P65, contracts: -3,
                    time: { date: '2026-11-17' } }, context), {});
                assert.match(overdraw.reason, /平仓超过当时持仓/);
                // A partial assignment of a two-lot short call.
                const period = { from: '2026-10-01', through: '2026-10-31' };
                const two = graphOf(statements.activity({ period, fills: [fill('CLZ6', '2026-10-01T10:00:00', 1, 70),
                    fill('LOZ6 C7500', '2026-10-01T11:00:00', -2, 1.2)] }));
                const partial = Forms.manualPreview(two, Forms.delivery({ optionContractId: C75, kind: 'assignment',
                    contracts: 1, time: { local: '2026-11-13T16:00' } }, Object.assign({}, context, { graph: two })), {});
                assert.deepEqual(plain(partial.rows).map((row) => [row.localSymbol, row.before, row.after]),
                    [['LOZ6 C7500', -2, -1], ['CLZ6', 1, 0]]);
                assert.equal(JSON.stringify(ROLLED), before, 'the ledger graph is untouched');

                // The page: preview and cancel write nothing; the confirmation sends the previewed request.
                const page = loadLedgerPage({ writesReleased: true, version: V1, graph: ROLLED });
                await page.open();
                await page.drain();
                const writes = () => page.socket.sent.filter((item) => pure.OptionComboCostBasisCommon
                    .isWriteAction(item.action));
                const fillForm = () => {
                    page.node('manual-kind').value = 'futures_trade';
                    page.node('manual-contract').value = CLF7;
                    page.node('manual-quantity').value = '1';
                    page.node('manual-price').value = '-2.5';
                    page.node('manual-fees').value = '2';
                    page.node('manual-local').value = '2026-11-13T10:00';
                };
                fillForm();
                page.node('manual-submit').fire('click');
                await page.settle();
                assert.match(page.node('manual-status').textContent, /请先预览/);
                page.node('manual-preview').fire('click');
                assert.equal(page.node('manual-preview-result').hidden, false, page.node('manual-status').textContent);
                assert.match(page.node('manual-status').textContent, /已预览，尚未写入/);
                page.node('manual-cancel').fire('click');
                assert.equal(page.node('manual-preview-result').hidden, true);
                assert.match(page.node('manual-status').textContent, /已取消，没有写入/);
                assert.deepEqual(writes(), []);
                // An input changed after the preview retires it.
                page.node('manual-preview').fire('click');
                page.node('manual-quantity').value = '2';
                page.node('manual-quantity').fire('input');
                assert.match(page.node('manual-status').textContent, /旧的预览已作废/);
                page.node('manual-submit').fire('click');
                await page.settle();
                assert.deepEqual(writes(), []);
                // A value changed without any event (a script, an extension) is caught at the confirmation.
                page.node('manual-preview').fire('click');
                page.node('manual-price').value = '-3';
                page.node('manual-submit').fire('click');
                await page.settle();
                assert.match(page.node('manual-status').textContent, /输入已在预览后改变/);
                assert.deepEqual(writes(), []);
                page.node('manual-price').value = '-2.5';
                // Previewed, then confirmed twice: one request, sent with the previewed token and version.
                page.node('manual-preview').fire('click');
                const previewed = page.page().inspect();
                page.node('manual-submit').fire('click');
                page.node('manual-submit').fire('click');
                await page.settle();
                const sent = page.pending('append_cost_basis_event');
                assert.equal(sent.length, 2);
                assert.equal(sent[0].clientToken, sent[1].clientToken, 'a repeated confirmation is the same request');
                assert.deepEqual(sent[0].expectedLedgerVersion, V1);
                assert.equal(sent[0].fopPackage.events[0].futureContracts, 2);
                assert.equal(sent[0].fopPackage.events[0].price, -2.5);
                assert.ok(previewed.bookId);
                // A preview made before the ledger moved is retired with it.
                await page.answer('append_cost_basis_event', { event: { eventId: 'evt-manual-1' }, idempotentReplay: false,
                    ledgerVersion: V2 });
                await page.answer('append_cost_basis_event', { event: { eventId: 'evt-manual-1' }, idempotentReplay: true,
                    ledgerVersion: V2 });
                page.server.version = V2;
                await page.drain();
                fillForm();
                page.node('manual-preview').fire('click');
                page.server.version = V3;
                page.node('ledger-reload').fire('click');
                await page.drain();
                assert.match(page.node('manual-status').textContent, /旧的手工记账预览已作废/);
                const count = page.socket.sent.length;
                page.node('manual-submit').fire('click');
                await page.settle();
                assert.equal(page.socket.sent.length, count, 'nothing is sent after the ledger moved');
                // After a lost connection and a reconnection the old preview is gone too.
                page.node('manual-preview').fire('click');
                page.socket.onclose();
                page.node('manual-submit').fire('click');
                await page.settle();
                assert.match(page.node('manual-status').textContent, /未记入/);
                page.timers.filter((timer) => timer.delay === 5000 && !timer.cleared).pop().fn();
                assert.equal(page.sockets.length, 2, 'the page reconnects on a new socket');
                await page.open();
                await page.drain();
                page.node('manual-submit').fire('click');
                await page.settle();
                assert.match(page.node('manual-status').textContent, /请先预览/);
                assert.deepEqual(page.socket.sent.filter((item) => pure.OptionComboCostBasisCommon
                    .isWriteAction(item.action)), []);
            },
        },
        {
            name: 'positions are read, reconciled and kept in a snapshot of their version (P5-C3)',
            async run() {
                const page = loadLedgerPage({ writesReleased: true, version: V1, graph: ROLLED });
                await page.open();
                await page.drain();
                const conIds = { CLF7: 556, 'LOZ6 C7500': 9001, 'LOZ6 P6500': 9002 };
                const positions = [['CLF7', 1, 72505], ['LOZ6 C7500', -1, 1200], ['LOZ6 P6500', 1, 800]]
                    .map(([localSymbol, quantity, averageCost]) => ({ account: BOOK.account, conId: conIds[localSymbol],
                        secType: / /.test(localSymbol) ? 'FOP' : 'FUT', symbol: 'CL', localSymbol, tradingClass: null,
                        lastTradeDateOrContractMonth: null, right: null, strike: null, multiplier: 1000,
                        currency: 'USD', position: quantity, averageCost }));
                const read = { bookId: BOOK.bookId, account: BOOK.account, observedAtUtc: OBSERVED, ledgerVersion: V1,
                    accountConnected: true, positionsReady: true, positions, evidenceCredential: 'eyJ2IjoxfQ.c2lnbmF0dXJl' };
                const cells = (id) => findNode(page.node(id), (node) => node.tag === 'table').children.slice(1)
                    .map((row) => row.children.map((cell) => String(cell.textContent)));
                page.node('reconcile-read').fire('click');
                await page.settle();
                await page.answer('request_cost_basis_fop_positions', read);
                assert.deepEqual(cells('reconcile-summary').map((row) => row.slice(0, 2)), [['数量（Qty）', '数量一致'],
                    ['AvgCost', '一致（旁证）'], ['期权绑定', '完整'], ['现金', '未核对']]);
                assert.deepEqual(cells('reconcile-table').map((row) => row.slice(0, 4)), [
                    ['CLF7', '1', '1', '数量一致'], ['LOZ6 C7500', '-1', '-1', '数量一致'], ['LOZ6 P6500', '1', '1', '数量一致']]);
                // Saved once, as the frozen request, with the positions it rests on.
                page.node('snapshot-note').value = 'end of day';
                page.node('snapshot-save').fire('click');
                page.node('snapshot-save').fire('click');
                await page.settle();
                const saves = page.pending('save_cost_basis_snapshot');
                assert.equal(saves.length, 1, 'a second click while saving sends nothing');
                assert.deepEqual(createChecker(PROTOCOL.types).check('SnapshotRequest', plain(saves[0])), []);
                assert.deepEqual([saves[0].reconciled, saves[0].twsSnapshot.quantityStatus, saves[0].note,
                    saves[0].summary.ledgerVersion.digest], [true, 'matched', 'end of day', V1.digest]);
                const snapshot = { snapshotId: 'f'.repeat(32), bookId: BOOK.bookId, takenAtUtc: '2026-11-12T15:01:00Z',
                    asOfDate: '2026-11-12', accountScope: BOOK.account, throughSeq: 5, eventCount: 5,
                    eventsSha256: V1.digest, summary: saves[0].summary, twsSnapshot: saves[0].twsSnapshot,
                    reconciled: true, note: 'end of day' };
                await page.answer('save_cost_basis_snapshot', { snapshot, idempotentReplay: false });
                await page.answer('list_cost_basis_snapshots', { snapshots: [snapshot] });
                assert.match(page.node('snapshot-status').textContent, /已保存快照.*数量已与 TWS 对上；经济流水未改变/);
                assert.deepEqual(cells('snapshot-list')[0].slice(3, 7), ['数量一致', '一致（旁证）', '是', 'end of day']);
                page.node('snapshot-pick').value = snapshot.snapshotId;
                page.node('snapshot-pick').fire('change');
                assert.match(page.node('snapshot-detail').children[0].textContent, /对应当前账本版本/);
                // The ledger moves: the positions belong to the old version, and so does the snapshot.
                page.server.snapshots = [snapshot];
                page.server.version = V2;
                page.node('ledger-reload').fire('click');
                await page.drain();
                assert.match(cells('reconcile-summary')[0][2], /另一账本版本/);
                page.node('snapshot-pick').value = snapshot.snapshotId;
                page.node('snapshot-pick').fire('change');
                assert.match(page.node('snapshot-detail').children[0].textContent, /旧版本的历史记录.*不代表现在/);
                page.node('snapshot-save').fire('click');
                await page.settle();
                const [stale] = page.pending('save_cost_basis_snapshot');
                assert.deepEqual([stale.twsSnapshot, stale.reconciled, stale.expectedLedgerVersion.digest],
                    [null, false, V2.digest]);
                await page.drain();
                // A backend without positions says so; a lost connection retires the evidence.
                page.node('reconcile-read').fire('click');
                await page.settle();
                await page.answer('request_cost_basis_fop_positions', { success: false, code: 'fop_positions_unavailable',
                    message: 'this backend has no TWS positions to reconcile against' });
                assert.match(page.node('reconcile-status').textContent, /没有 TWS 持仓.*不会声称已对账/);
                page.node('reconcile-read').fire('click');
                await page.settle();
                await page.answer('request_cost_basis_fop_positions', Object.assign({}, read, { ledgerVersion: V2 }));
                assert.match(cells('reconcile-summary')[0][1], /数量一致/);
                page.socket.onclose();
                assert.match(page.node('reconcile-status').textContent, /持仓证据已作废/);
                assert.match(cells('reconcile-summary')[0][1], /未核对/);
            },
        },
        {
            name: "the buyer's options stand apart, and a statement's realized P&L is compared, never written (P5-C4)",
            async run() {
                // The overview: the long put of the browser checks' ledger, apart from the totals.
                const overview = plain(View.overview(Core.computeLedger(ROLLED, { marks: { [P65]: 0.5 } }), null, ROLLED));
                assert.deepEqual(overview.buyer.map((row) => row[1]), ['0.00', '0.00', '-800.00', '500.00', '-300.00']);
                // A later statement closes October's fill; its FifoPnlRealized is compared on its own basis.
                // Stored: its events carry ledger ids, not a preview's.
                const october = JSON.parse(JSON.stringify(graphOf(statements.flex({ fills: [{ symbol: 'CLZ6',
                    local: '2026-10-01T10:00:00', qty: 1, price: 70, commission: -2.5, codes: 'O', tradeId: '1' }] })))
                    .replace(/preview-(\d+)/g, 'evt-00000$1'));
                const page = loadLedgerPage({ writesReleased: true, version: V1, graph: october });
                await page.open();
                await page.drain();
                const text = statements.flex({ realizedColumn: true, fills: [{ symbol: 'CLZ6', local: '2026-11-02T10:00:00',
                    qty: -1, price: 71, commission: -2.5, codes: 'C', tradeId: '2', realized: 995 }] });
                page.node('import-file').files = [{ name: 'november.csv', text: async () => text }];
                page.node('import-file').fire('change');
                await page.settle();
                const [row] = page.page().inspect().importPlan.realized;
                assert.deepEqual([row.localSymbol, row.statementRealized, row.ledgerFifo, row.ledgerOwn, row.status],
                    ['CLZ6', 995, 995, 1000, 'matched']);
                assert.match(page.node('import-realized-note').textContent, /只作旁证，不覆盖 Rf/);
                // The comparison sends nothing and changes no figure.
                assert.deepEqual(page.socket.sent.filter((item) => pure.OptionComboCostBasisCommon
                    .isWriteAction(item.action)), []);
            },
        },
        {
            name: 'a blocked import says why and what to do in Chinese, and following it clears the block (P5-C6)',
            async run() {
                const page = loadLedgerPage({ writesReleased: true, version: V1, graph: ROLLED,
                    digest: async () => new Uint8Array(32).buffer });
                await page.open();
                await page.drain();
                const text = statements.activity({ account: 'U****1111', period: { from: '2026-11-11', through: '2026-11-30' },
                    fills: [fill('CLF7', '2026-11-20T10:00:00', -1, 73, 'C')], openPositions: [
                        { symbol: 'LOZ6 C7500', quantity: -1 }, { symbol: 'LOZ6 P6500', quantity: 1 }] });
                page.node('import-file').files = [{ name: 'masked.csv', text: async () => text }];
                page.node('import-file').fire('change');
                await page.settle();
                const problems = () => page.node('import-problems').children.map((item) => item.textContent);
                assert.deepEqual(problems().length, 1);
                assert.match(problems()[0], /^报表里的账户号被遮罩，不能自动确认就是本账户。下一步：.*勾选“报表中的遮罩账户就是本账本的账户”后重新预览。\[account_confirmation_required\]$/);
                assert.match(page.node('import-problems').children[0].children[0].textContent, /原文：.*U\*\*\*\*1111/);
                // Following the next step: confirm the masked account, preview again.
                page.node('import-confirm-account').checked = true;
                page.node('import-confirm-account').fire('change');
                assert.deepEqual(problems(), ['没有阻断问题。']);
                assert.equal(page.page().inspect().importPlan.blocking, false);
                // A refusal the server answers with is in words too, with its code and original.
                page.node('import-claim').checked = true;
                page.node('import-attestation').value = 'checked against the statement';
                page.node('import-submit').fire('click');
                await page.settle();
                await page.answer('import_cost_basis_events', { success: false, code: 'ledger_changed',
                    message: 'the ledger changed since it was reviewed' });
                assert.match(page.node('import-status').textContent,
                    /^未导入：版本冲突：账本已在预览后变化。下一步：重新读取账本、重新预览后再确认。\[ledger_changed\] 原文：the ledger changed/);
            },
        },
    ],
};
