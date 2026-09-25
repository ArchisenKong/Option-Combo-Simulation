// P4: the FOP page's read-only CSV preview (plan §13.3 P4 item 6).
//
// A statement previewed on cost_basis_fop.html without a ledger: the page
// reads it with js/cost_basis_fop_import.js against the row-type list the
// backend's status carries and replays it with js/cost_basis_fop_core.js. It
// creates no ledger and sends nothing but the status and ledger-list reads;
// the store side of "a preview writes nothing" is
// tests/cost_basis_fop_import_pipeline_test.py ReadOnlyPreviewTests.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const statements = require('./helpers/cost_basis_fop_statements');

const ROOT = path.resolve(__dirname, '..');
const CAPABILITIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'cost_basis_fop_capabilities.json'), 'utf8'));
const SCRIPTS = ['js/cost_basis_common.js', 'js/cost_basis_import_common.js', 'js/cost_basis_fop_core.js',
    'js/cost_basis_fop_import.js', 'js/cost_basis_fop_messages.js', 'js/cost_basis_fop.js'];
const NOW = new Date(Date.UTC(2027, 2, 1, 14, 15, 0));

// The plan §9.6 history (New York account time): three rolls and a short call
// that expired, in one Activity Statement.
const ROLLS = [
    { symbol: 'CLZ6', local: '2026-10-01T10:00:00', qty: 1, price: 70, codes: 'O' },
    { symbol: 'LOZ6 C7500', local: '2026-10-01T11:00:00', qty: -1, price: 1.2, codes: 'O' },
    { symbol: 'LOZ6 C7500', local: '2026-11-17T15:00:00', qty: 1, price: 0, codes: 'Ep' },
    { symbol: 'CLZ6', local: '2026-11-18T10:00:00', qty: -1, price: 68, commission: -5, codes: 'C' },
    { symbol: 'CLF7', local: '2026-11-18T10:00:01', qty: 1, price: 69, commission: -5, codes: 'O' },
    { symbol: 'CLF7', local: '2026-12-15T10:00:00', qty: -1, price: 72, commission: -5, codes: 'C' },
    { symbol: 'CLG7', local: '2026-12-15T10:00:01', qty: 1, price: 72.5, commission: -5, codes: 'O' },
    { symbol: 'CLG7', local: '2027-01-14T10:00:00', qty: -1, price: 71, commission: -5, codes: 'C' },
    { symbol: 'CLH7', local: '2027-01-14T10:00:01', qty: 1, price: 70.8, commission: -5, codes: 'O' },
];
const HISTORY = statements.activity({ period: { from: '2026-10-01', through: '2027-01-31' }, fills: ROLLS,
    openPositions: [{ symbol: 'CLH7', quantity: 1, costPrice: 70.8 }] });

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function fakeNode(tag) {
    return {
        tag, textContent: '', hidden: false, href: '', className: '', dataset: {}, children: [], value: '',
        disabled: false, listeners: {}, files: null,
        appendChild(child) { this.children.push(child); return child; },
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
        addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); },
        get firstChild() { return this.children[0]; },
    };
}

/** Every text under a fake node, depth first. */
function texts(node) {
    return [node.textContent].concat(...node.children.map(texts)).filter(Boolean);
}

/** The rows of the first table under a fake node, as text. */
function tableRows(node) {
    const table = node.tag === 'table' ? node : node.children.find((child) => child.tag === 'table');
    return table ? table.children.map((row) => row.children.map((cell) => cell.textContent)) : [];
}

/** The FOP page against a fake DOM and WebSocket, with every script the HTML loads. */
function loadPage() {
    const nodes = new Map();
    const sockets = [];
    class FakeWebSocket {
        constructor(url) {
            this.url = url;
            this.sent = [];
            sockets.push(this);
        }

        send(message) { this.sent.push(JSON.parse(message)); }
    }
    const context = loadBrowserScripts(SCRIPTS, {
        document: {
            readyState: 'complete',
            getElementById(id) {
                if (!nodes.has(id)) nodes.set(id, fakeNode(id));
                return nodes.get(id);
            },
            createElement: fakeNode,
        },
        localStorage: { getItem: (key) => (key === 'optionComboWsPort' ? '8799' : null) },
        WebSocket: FakeWebSocket,
        location: { search: '', replace() {} },
        setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    });
    const socket = sockets[0];
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    async function answer(fields) {
        const request = socket.sent[socket.sent.length - 1];
        socket.onmessage({ data: JSON.stringify(Object.assign({
            action: request.action, requestId: request.requestId, success: true }, fields)) });
        await settle();
    }
    async function open(fopLedger) {
        socket.readyState = 1;
        socket.onopen();
        await settle();
        await answer({ available: true, features: { fopLedger } });
        await answer({ books: [] });
    }
    async function choose(name, text) {
        const input = nodes.get('preview-file');
        input.files = [{ name, text: async () => text }];
        input.listeners.change.forEach((handler) => handler());
        await settle();
        await settle();
    }
    return { context, nodes, socket, open, choose, node: (id) => nodes.get(id) };
}

function preview(text, options = {}) {
    const context = loadBrowserScripts(SCRIPTS.slice(0, 4).concat(['js/cost_basis_fop.js']), {
        document: undefined,
    });
    return plain(context.OptionComboCostBasisFopPage.previewStatement(text, Object.assign({
        capabilities: CAPABILITIES, fileName: 'history.csv', now: NOW }, options)));
}

module.exports = {
    name: 'cost_basis_fop_preview',
    tests: [
        {
            name: 'a statement previews without a ledger: rows, events, proof and the replayed result',
            run() {
                const view = preview(HISTORY);
                assert.equal(view.blocking, false, JSON.stringify(view.problems));
                assert.deepEqual(view.problems, []);
                assert.deepEqual(view.warnings.map((item) => item.code), ['account_unchecked']);
                assert.deepEqual(view.summary.slice(1, 5), [['格式', 'Activity Statement'], ['账户', 'U1111111'],
                    ['期间', '2026-10-01 至 2027-01-31'], ['时区', 'America/New_York（取自报表）']]);
                assert.equal(view.events.length, 9);
                assert.deepEqual(view.events[0], { lines: String(view.events[0].lines), kind: '期货成交',
                    contract: 'CLZ6', quantity: 1, price: 70, fees: 0, time: '2026-10-01 14:00:00 UTC' });
                assert.ok(view.rows.every((row) => row.status === '仅合成样本：只能预览或人工认领'));
                assert.deepEqual(view.quantityProof.find((item) => item.contract === 'CLH7'),
                    { contract: 'CLH7', opening: 0, periodNet: 1, closing: 1 });
                // Plan §9.6 without a mark: Rf -500, seller cash 1200, fees 30.
                const totals = Object.fromEntries(view.results.totals);
                assert.equal(totals['期货已实现'], '-500');
                assert.equal(totals['期权现金'], '1200');
                assert.equal(totals['费用'], '30');
                assert.match(totals['完整经济盈亏（需行情）'], /^未知/);
                assert.deepEqual(view.results.futures, [['CLH7', '1', '70.8']]);
                assert.deepEqual(view.results.realized.map((row) => row[0]).sort(), ['CLF7', 'CLG7', 'CLZ6']);
            },
        },
        {
            name: 'a blocked statement lists its problems and replays nothing',
            run() {
                const unknownKind = HISTORY.replace('Trades,Data,Order,Futures,USD,CLZ6,"2026-10-01, 10:00:00"',
                    'Trades,Data,Adjustment,Futures,USD,CLZ6,"2026-10-01, 10:00:00"');
                assert.notEqual(unknownKind, HISTORY);
                const view = preview(unknownKind);
                assert.equal(view.blocking, true);
                assert.ok(view.problems.some((item) => item.code === 'row_kind_unknown'));
                assert.equal(view.results, null);
                assert.equal(view.resultsNote, '有阻断问题，不演算结果。');
                // A masked account is read, not held to a ledger.
                const masked = preview(HISTORY.replace(',U1111111', ',U****1111'));
                assert.equal(masked.blocking, false, JSON.stringify(masked.problems));
                assert.deepEqual(masked.summary[2], ['账户', 'U****1111']);
                // A statement without a zone it names is refused until one is stated.
                const cst = HISTORY.replace('09:15:00 EST', '09:15:00 CST');
                assert.ok(preview(cst).problems.some((item) => item.code === 'timezone_missing'));
                assert.equal(preview(cst, { timeZone: 'America/New_York' }).blocking, false);
            },
        },
        {
            name: 'the page previews a chosen file and sends nothing but its two reads',
            async run() {
                const page = loadPage();
                assert.equal(page.node('preview-file').disabled, true, 'enabled only once the status arrives');
                await page.open({ engineVersion: 1, productRules: ['NYMEX-CL-v1'], importCapabilities: CAPABILITIES });
                assert.equal(page.node('preview-file').disabled, false);
                await page.choose('history.csv', HISTORY);
                assert.equal(page.node('preview-result').hidden, false);
                assert.match(page.node('preview-status').textContent, /没有阻断问题。只读预览，未写入。/);
                assert.deepEqual(tableRows(page.node('preview-events')).length, 10, 'a header and nine events');
                assert.ok(texts(page.node('preview-results')).includes('-500'));
                assert.ok(tableRows(page.node('preview-rows')).slice(1).every((row) => row[3] === '新事件'));
                // A blocked file: each problem once, under its line.
                await page.choose('blocked.csv', HISTORY.replace(
                    'Trades,Data,Order,Futures,USD,CLZ6,"2026-10-01, 10:00:00"',
                    'Trades,Data,Adjustment,Futures,USD,CLZ6,"2026-10-01, 10:00:00"'));
                const [problem] = texts(page.node('preview-problems'));
                // In words, with its next step and code (plan §19 P5-C6); the original stays beside it.
                assert.match(problem, /^第 \d+ 行：无法判断这一行是订单、成交还是明细。下一步：.*\[row_kind_unknown\]$/);
                assert.match(page.node('preview-problems').children[0].children[0].textContent,
                    /原文：the CLZ6 row has DataDiscriminator "Adjustment"/);
                assert.equal(page.node('preview-results').children.length, 0);
                assert.deepEqual(page.socket.sent.map((message) => message.action),
                    ['request_cost_basis_status', 'list_cost_basis_books']);
                // Statement text is shown as text, never read as markup.
                await page.choose('evil.csv', HISTORY.replace('Synthetic Account', '<img src=x onerror=alert(1)>'));
                assert.ok(page.node('preview-summary').children.every((child) => child.tag === 'dt' || child.tag === 'dd'));
                // A stated zone re-reads the same file.
                page.node('preview-zone').value = 'America/Chicago';
                page.node('preview-zone').listeners.change.forEach((handler) => handler());
                assert.ok(texts(page.node('preview-summary')).includes('America/Chicago（手动指定）'));
                assert.deepEqual(page.socket.sent.map((message) => message.action),
                    ['request_cost_basis_status', 'list_cost_basis_books']);
            },
        },
        {
            name: 'without the backend row-type list the preview stays off',
            async run() {
                const page = loadPage();
                await page.open({ engineVersion: 1, productRules: ['NYMEX-CL-v1'] });
                assert.equal(page.node('preview-file').disabled, true);
                assert.equal(page.node('preview-status').textContent, '后端没有提供报表行类型清单，无法预览。');
            },
        },
    ],
};
