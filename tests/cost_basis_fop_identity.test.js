// P1: ledger type, routing and the page boundary of the standalone FOP ledger.
//
// CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §1.1, §7 and §13.3 P1. The
// common layer (js/cost_basis_common.js) owns the action catalogue and the
// routing both ledger pages share; the FOP page skeleton (js/cost_basis_fop.js)
// only routes and never writes. The contract examples are read here with the
// JS reader; tests/cost_basis_fop_contract_test.py reads them in Python and
// checks that both readers agree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const { createChecker } = require('./helpers/fop-contract-schema');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const CONTRACT = 'tests/fixtures/cost_basis_fop/contract';

// The stock page's action list as P0 shipped it. Moving the catalogue into
// the common layer must not add, drop or reorder anything.
const EQUITY_ACTIONS_AT_P0 = [
    'request_cost_basis_status', 'list_cost_basis_books', 'create_cost_basis_book',
    'request_cost_basis_delete_plan', 'delete_cost_basis_book', 'list_cost_basis_events',
    'append_cost_basis_event', 'void_cost_basis_event', 'append_cost_basis_split_group',
    'void_cost_basis_split_group', 'import_cost_basis_events', 'save_cost_basis_snapshot',
    'request_cost_basis_reset_plan', 'rebuild_cost_basis_book', 'list_cost_basis_resets',
    'restore_cost_basis_reset', 'export_cost_basis_backup', 'restore_cost_basis_backup',
    'list_cost_basis_import_batches', 'request_portfolio_positions_snapshot',
    'request_portfolio_avg_cost_snapshot', 'request_managed_accounts_snapshot',
    'request_cost_basis_executions', 'request_cost_basis_market_price',
    'request_cost_basis_option_scenario_inputs',
];

const FUT_BOOK = {
    bookId: 'futbook0001', account: 'U1111111', symbol: 'ES', secType: 'FUT',
    currency: 'USD', startDate: '2026-01-01', eventCount: 1,
};
const STK_BOOK = {
    bookId: 'stkbook0001', account: 'U1111111', symbol: 'ES', secType: 'STK',
    currency: 'USD', startDate: '2026-01-01', eventCount: 4,
};

function loadCommon() {
    return loadBrowserScripts(['js/cost_basis_common.js']).OptionComboCostBasisCommon;
}

function fakeNode(id) {
    return {
        id, textContent: '', hidden: false, href: '', className: '', dataset: {}, children: [],
        appendChild(child) { this.children.push(child); return child; },
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
        get firstChild() { return this.children[0]; },
    };
}

/** Load the FOP page against a fake DOM and WebSocket, as a browser would. */
function loadFopPage(search) {
    const nodes = new Map();
    const sockets = [];
    const replaced = [];
    class FakeWebSocket {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.sent = [];
            sockets.push(this);
        }

        send(message) { this.sent.push(JSON.parse(message)); }
    }
    const context = loadBrowserScripts(['js/cost_basis_common.js', 'js/cost_basis_fop.js'], {
        document: {
            readyState: 'complete',
            getElementById(id) {
                if (!nodes.has(id)) nodes.set(id, fakeNode(id));
                return nodes.get(id);
            },
            createElement(tag) { return fakeNode(tag); },
        },
        localStorage: { getItem: (key) => (key === 'optionComboWsPort' ? '8799' : null) },
        WebSocket: FakeWebSocket,
        location: { search, replace: (url) => replaced.push(url) },
    });
    const socket = sockets[0];
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    async function answer(fields) {
        const request = socket.sent[socket.sent.length - 1];
        socket.onmessage({ data: JSON.stringify(Object.assign({
            action: request.action, requestId: request.requestId, success: true,
        }, fields)) });
        await settle();
    }
    async function openWith(books) {
        socket.readyState = 1;
        socket.onopen();
        await settle();
        await answer({ available: true });
        await answer({ books });
    }
    return { context, nodes, socket, replaced, openWith, answer, settle,
        node: (id) => nodes.get(id) };
}

/**
 * The stock page with its private bindings exposed and a fake DOM, no socket
 * and no browser storage. requests() records every request the page makes.
 */
function loadStockPage(books) {
    const context = loadBrowserScripts([
        'js/cost_basis_core.js', 'js/american_binomial.js', 'js/cost_basis_import.js',
        'js/cost_basis.js',
    ]);
    vm.runInContext(read('js/cost_basis.js').replace('globalScope.OptionComboCostBasisPage = {', `
        globalScope.stockPageHarness = {
            state, loadBooks: _loadBooks, selectBook: _selectBook, createBook: _createBook,
            refreshControls: _refreshControls,
            stub(requestHandler) {
                request = requestHandler;
                _loadEvents = async () => { globalScope.loadedBooks.push(state.bookId); };
            },
        };
        globalScope.OptionComboCostBasisPage = {`), context);
    const nodes = new Map();
    function node() {
        const classes = new Set();
        return {
            children: [], handlers: {}, textContent: '', value: '', dataset: {}, disabled: false,
            classList: {
                add(...names) { names.forEach((name) => classes.add(name)); },
                remove(...names) { names.forEach((name) => classes.delete(name)); },
                contains(name) { return classes.has(name); },
                toggle(name, force) {
                    const on = force === undefined ? !classes.has(name) : Boolean(force);
                    if (on) classes.add(name); else classes.delete(name);
                    return on;
                },
            },
            appendChild(child) { this.children.push(child); return child; },
            removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
            get firstChild() { return this.children[0]; },
            addEventListener(name, callback) { this.handlers[name] = callback; },
            setAttribute(name, value) { this[name] = String(value); },
            focus() {},
            scrollIntoView() {},
            querySelector() { return this.body || (this.body = node()); },
            querySelectorAll() { return []; },
        };
    }
    context.document = {
        createElement: node,
        getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, node());
            return nodes.get(id);
        },
        querySelector: () => node(),
        querySelectorAll: () => [],
        body: node(),
    };
    const alerts = [];
    const sent = [];
    context.alert = (message) => alerts.push(message);
    context.confirm = () => true;
    context.loadedBooks = [];
    const h = context.stockPageHarness;
    h.stub(async (action, fields) => {
        sent.push({ action, fields });
        if (action === 'list_cost_basis_books') return { books };
        if (action === 'create_cost_basis_book') {
            return { book: Object.assign({ bookId: 'newbook00001' }, fields) };
        }
        return {};
    });
    Object.assign(h.state, { connection: 'connected', status: { available: true } });
    return { h, alerts, sent, loaded: context.loadedBooks, node: (id) => context.document.getElementById(id) };
}

const OTHER_ACCOUNT_BOOK = {
    bookId: 'stkbook0002', account: 'U2222222', symbol: 'TQQQ', secType: 'STK',
    currency: 'USD', startDate: '2026-01-01', eventCount: 9,
};

function linkTexts(node) {
    return node.children.map((item) => item.children.map((child) => [child.href, child.textContent]))
        .reduce((all, pairs) => all.concat(pairs), []);
}

module.exports = {
    name: 'cost_basis_fop_identity',
    tests: [
        {
            name: 'the common catalogue keeps the stock page action list exactly',
            run() {
                const common = loadCommon();
                assert.deepEqual(Array.from(common.actionsForPage('equity')), EQUITY_ACTIONS_AT_P0);
                const core = loadBrowserScripts(['js/cost_basis_core.js']).OptionComboCostBasisCore;
                assert.deepEqual(Array.from(core.ALLOWED_CLIENT_ACTIONS), EQUITY_ACTIONS_AT_P0);
                // Without the common layer the core refuses to load at all.
                const bare = vm.createContext({ console });
                bare.window = bare;
                bare.globalThis = bare;
                assert.throws(() => new vm.Script(read('js/cost_basis_core.js')).runInContext(bare),
                    /cost_basis_common\.js must load before/);
            },
        },
        {
            name: 'the FOP page may only read the status and the ledger list',
            run() {
                const common = loadCommon();
                const fopActions = Array.from(common.actionsForPage('fop'));
                assert.deepEqual(fopActions, ['request_cost_basis_status', 'list_cost_basis_books']);
                fopActions.forEach((action) => assert.equal(common.isWriteAction(action), false));
            },
        },
        {
            name: 'write flags agree with the P0 freeze and with the server coverage file',
            run() {
                const common = loadCommon();
                const core = loadBrowserScripts(['js/cost_basis_core.js']).OptionComboCostBasisCore;
                // The writes a page may send are the stock page's; the FOP-only
                // actions are listed for the backend but no page sends them yet.
                const writes = Array.from(common.PROTOCOL_ACTIONS
                    .filter((entry) => entry.writes && entry.pages.length)
                    .map((entry) => entry.action)).sort();
                assert.deepEqual(writes, Array.from(core.FUTURES_FROZEN_WRITE_ACTIONS)
                    .concat(['create_cost_basis_book', 'delete_cost_basis_book']).sort());
                assert.deepEqual(Array.from(common.PROTOCOL_ACTIONS
                    .filter((entry) => !entry.pages.length).map((entry) => entry.action)).sort(),
                ['commit_cost_basis_fop_metadata', 'request_cost_basis_fop_contract_details']);
                const coverage = readJson(`${CONTRACT}/write_coverage.json`);
                const serverWrites = new Set(coverage.writes.map((entry) => entry.wsAction));
                const serverReads = new Set(coverage.reads);
                common.PROTOCOL_ACTIONS.forEach((entry) => {
                    if (entry.action.startsWith('request_portfolio_')
                        || entry.action === 'request_managed_accounts_snapshot') {
                        // Served by the live bridge, not by the ledger protocol.
                        assert.equal(entry.writes, false, entry.action);
                        return;
                    }
                    assert.ok(entry.writes ? serverWrites.has(entry.action) : serverReads.has(entry.action),
                        `${entry.action} is classified differently from write_coverage.json`);
                });
            },
        },
        {
            name: 'a ledger routes by the type the backend reports, never by the URL',
            run() {
                const common = loadCommon();
                assert.equal(common.bookKind(FUT_BOOK), 'fop');
                assert.equal(common.bookKind(STK_BOOK), 'equity');
                assert.equal(common.bookKind({ secType: ' fut ' }), 'fop');
                assert.equal(common.bookKind({ secType: 'IND' }), '');
                assert.equal(common.bookKind(null), '');
                assert.equal(common.bookUrl(FUT_BOOK), 'cost_basis_fop.html?bookId=futbook0001');
                assert.equal(common.bookUrl(STK_BOOK), 'cost_basis.html?bookId=stkbook0001');
                assert.equal(common.bookUrl(Object.assign({}, FUT_BOOK, { bookId: 'x/../y' })), '');
                const books = [FUT_BOOK, STK_BOOK];
                assert.deepEqual(JSON.parse(JSON.stringify(common.routeForBook('fop', books, ''))),
                    { view: 'list' });
                assert.equal(common.routeForBook('fop', books, 'futbook0001').view, 'book');
                const redirect = common.routeForBook('fop', books, 'stkbook0001');
                assert.equal(redirect.view, 'redirect');
                assert.equal(redirect.url, 'cost_basis.html?bookId=stkbook0001');
                assert.equal(common.routeForBook('equity', books, 'futbook0001').url,
                    'cost_basis_fop.html?bookId=futbook0001');
                assert.equal(common.routeForBook('fop', books, 'missing0001').view, 'missing');
                assert.equal(common.routeForBook('fop',
                    [{ bookId: 'indbook0001', secType: 'IND' }], 'indbook0001').view, 'unsupported');
            },
        },
        {
            name: 'a bookId is read from the URL only when it is a well-formed token',
            run() {
                const common = loadCommon();
                assert.equal(common.bookIdFromSearch('?bookId=futbook0001'), 'futbook0001');
                assert.equal(common.bookIdFromSearch('?view=x&bookId=futbook0001&bookId=other0001'),
                    'futbook0001');
                assert.equal(common.bookIdFromSearch('?bookId=fut%62ook0001'), 'futbook0001');
                assert.equal(common.bookIdFromSearch(''), '');
                assert.equal(common.bookIdFromSearch(undefined), '');
                assert.equal(common.bookIdFromSearch('?bookId=short'), '');
                assert.equal(common.bookIdFromSearch('?bookId=../../etc0001'), '');
                assert.equal(common.bookIdFromSearch('?bookId=%E0%A4%A'), '');
                assert.equal(common.bookIdFromSearch('?bookid=futbook0001'), '');
            },
        },
        {
            name: 'the request client enforces its allowlist and settles every request once',
            async run() {
                const common = loadCommon();
                const timers = [];
                const socket = { readyState: 1, sent: [], send(message) { this.sent.push(JSON.parse(message)); } };
                const client = common.createRequestClient({
                    allowedActions: ['list_cost_basis_books'],
                    socket: () => socket,
                    setTimeout: (callback) => { timers.push(callback); return timers.length; },
                    clearTimeout: (id) => { timers[id - 1] = null; },
                    now: () => 1000,
                    prefix: 'unit',
                });
                await assert.rejects(client.request('append_cost_basis_event', {}),
                    /not allowed from this page/);
                assert.equal(socket.sent.length, 0);

                const ok = client.request('list_cost_basis_books', { limit: 5 });
                assert.deepEqual(socket.sent[0], { action: 'list_cost_basis_books',
                    requestId: 'unit-1-1000', limit: 5 });
                assert.equal(client.handleMessage({ requestId: 'unit-1-1000', success: true, books: [] }), true);
                assert.deepEqual((await ok).books, []);
                assert.equal(client.handleMessage({ requestId: 'unit-1-1000', success: true }), false,
                    'a second answer to the same request is ignored');

                const refused = client.request('list_cost_basis_books');
                client.handleMessage({ requestId: 'unit-2-1000', success: false,
                    code: 'futures_book_frozen', message: 'frozen' });
                await assert.rejects(refused, (error) => error.code === 'futures_book_frozen');

                const slow = client.request('list_cost_basis_books');
                timers[2]();
                await assert.rejects(slow, /请求超时/);
                assert.equal(client.pendingCount(), 0);

                const cut = client.request('list_cost_basis_books');
                client.failPending('连接已断开');
                await assert.rejects(cut, /连接已断开/);

                socket.readyState = 3;
                await assert.rejects(client.request('list_cost_basis_books'), /未连接到后端/);
            },
        },
        {
            name: 'the FOP page loads only the common layer and its own controller',
            run() {
                const html = read('cost_basis_fop.html');
                const scripts = Array.from(html.matchAll(/<script src="([^"?]+)/g)).map((match) => match[1]);
                assert.deepEqual(scripts, ['js/cost_basis_common.js', 'js/cost_basis_fop.js']);
                const styles = Array.from(html.matchAll(/<link rel="stylesheet" href="([^"?]+)/g))
                    .map((match) => match[1]);
                assert.deepEqual(styles, ['cost_basis_fop.css']);
                const source = read('js/cost_basis_fop.js');
                assert.doesNotMatch(source, /OptionComboCostBasisCore|OptionComboWsClient|placeOrder/);
                const sent = Array.from(source.matchAll(/client\.request\('([a-z_]+)'/g)).map((match) => match[1]);
                assert.ok(sent.length >= 2);
                const allowed = Array.from(loadCommon().actionsForPage('fop'));
                sent.forEach((action) => assert.ok(allowed.includes(action), action));
            },
        },
        {
            name: 'a stock ledger opened on the FOP page is sent back before anything renders',
            async run() {
                const page = loadFopPage('?bookId=stkbook0001');
                assert.equal(page.socket.url, 'ws://127.0.0.1:8799');
                await page.openWith([FUT_BOOK, STK_BOOK]);
                assert.deepEqual(page.replaced, ['cost_basis.html?bookId=stkbook0001']);
                assert.equal(page.node('book-view').hidden, true, 'the book view is never shown');
                assert.equal(page.nodes.has('book-title'), false, 'the ledger was never rendered');
                assert.equal(page.node('loading-view').hidden, false);
                assert.deepEqual(page.socket.sent.map((message) => message.action),
                    ['request_cost_basis_status', 'list_cost_basis_books']);
            },
        },
        {
            name: 'a FUT ledger shows only its identity and the way to the legacy view',
            async run() {
                const page = loadFopPage('?bookId=futbook0001');
                await page.openWith([FUT_BOOK, STK_BOOK]);
                assert.deepEqual(page.replaced, []);
                assert.equal(page.node('book-view').hidden, false);
                assert.equal(page.node('list-view').hidden, true);
                assert.equal(page.node('book-title').textContent, 'U1111111 / ES');
                const identity = page.node('book-identity').children.map((child) => child.textContent);
                assert.ok(identity.includes('FUT') && identity.includes('USD') && identity.includes('1'));
                assert.equal(page.node('book-state').textContent,
                    page.context.OptionComboCostBasisFopPage.LEGACY_STATE);
                assert.equal(page.node('book-legacy-link').href, 'cost_basis.html?bookId=futbook0001');
                assert.deepEqual(page.socket.sent.map((message) => message.action),
                    ['request_cost_basis_status', 'list_cost_basis_books']);
            },
        },
        {
            name: 'a FOP ledger is not described as a legacy ledger',
            async run() {
                const fopBook = Object.assign({}, FUT_BOOK, {
                    symbol: 'CL', defaultSharesPerContract: null,
                    fop: { engineVersion: 1, productRules: 'NYMEX-CL-v1', historyScope: 'full_history' },
                });
                const page = loadFopPage('?bookId=futbook0001');
                await page.openWith([fopBook]);
                assert.equal(page.node('book-state').textContent,
                    page.context.OptionComboCostBasisFopPage.FOP_STATE);
                assert.equal(page.node('book-legacy-link').hidden, true,
                    'the stock page cannot show a FOP ledger');
                const identity = page.node('book-identity').children.map((child) => child.textContent);
                assert.ok(identity.includes('NYMEX-CL-v1 · 引擎 v1'));
                const stock = read('js/cost_basis.js');
                assert.match(stock, /'见合约记录' : book\.defaultSharesPerContract/);
            },
        },
        {
            name: 'without a ledger the page lists both kinds with links to their own pages',
            async run() {
                const page = loadFopPage('');
                await page.openWith([FUT_BOOK, STK_BOOK]);
                assert.equal(page.node('list-view').hidden, false);
                assert.deepEqual(linkTexts(page.node('fop-book-list')),
                    [['cost_basis_fop.html?bookId=futbook0001', 'U1111111 · ES · FUT（1 条）']]);
                assert.deepEqual(linkTexts(page.node('equity-book-list')),
                    [['cost_basis.html?bookId=stkbook0001', 'U1111111 · ES · STK（4 条）']]);
                const malformed = loadFopPage('?bookId=../../x');
                await malformed.openWith([FUT_BOOK]);
                assert.equal(malformed.node('list-view').hidden, false);
            },
        },
        {
            name: 'a stale bookmark or an unavailable backend is reported, not guessed',
            async run() {
                const stale = loadFopPage('?bookId=deletedbook01');
                await stale.openWith([FUT_BOOK]);
                assert.equal(stale.node('message-view').hidden, false);
                assert.match(stale.node('message-text').textContent, /找不到账本 deletedbook01/);
                assert.deepEqual(stale.replaced, []);

                const down = loadFopPage('?bookId=futbook0001');
                down.socket.readyState = 1;
                down.socket.onopen();
                await down.settle();
                await down.answer({ available: false, reason: 'store_unavailable' });
                assert.match(down.node('message-text').textContent, /store_unavailable/);
                assert.equal(down.socket.sent.length, 1, 'no ledger list after an unavailable status');
            },
        },
        {
            name: 'the stock page opens the ledger a link names',
            async run() {
                const source = read('js/cost_basis.js');
                assert.match(source, /function start\(\) \{[\s\S]{0,400}state\.bookId = globalScope\.OptionComboCostBasisCommon\.bookIdFromSearch\([\s\S]{0,120}state\.linkedBookId = state\.bookId;/);
                // The named ledger, not the first one listed.
                const page = loadStockPage([STK_BOOK, OTHER_ACCOUNT_BOOK]);
                Object.assign(page.h.state, { bookId: 'stkbook0002', linkedBookId: 'stkbook0002' });
                await page.h.loadBooks();
                assert.equal(page.h.state.bookId, 'stkbook0002');
                assert.deepEqual(Array.from(page.loaded), ['stkbook0002']);
                assert.equal(page.h.state.linkedBookId, '');
                // Without a link the page keeps opening the first ledger.
                const plain = loadStockPage([STK_BOOK, OTHER_ACCOUNT_BOOK]);
                await plain.h.loadBooks();
                assert.deepEqual(Array.from(plain.loaded), ['stkbook0001']);
            },
        },
        {
            name: 'a stock-page link to a missing ledger opens nothing and says so',
            async run() {
                const page = loadStockPage([STK_BOOK, OTHER_ACCOUNT_BOOK]);
                Object.assign(page.h.state, { bookId: 'deletedbook01', linkedBookId: 'deletedbook01' });
                await page.h.loadBooks();
                assert.equal(page.h.state.bookId, '');
                assert.deepEqual(Array.from(page.loaded), [], 'no ledger is loaded in its place');
                assert.deepEqual(page.sent.map((entry) => entry.action), ['list_cost_basis_books']);
                assert.match(page.node('book-meta').textContent, /找不到链接指定的账本（deletedbook01）/);
                assert.equal(page.node('page-title').textContent, '找不到账本');
                const select = page.node('book-select');
                assert.equal(select.value, '');
                assert.deepEqual(select.children.map((option) => option.value),
                    ['', 'stkbook0001', 'stkbook0002']);
                // A reconnect lists the books again and still waits.
                await page.h.loadBooks();
                assert.equal(page.h.state.bookId, '');
                assert.deepEqual(Array.from(page.loaded), []);
                // An explicit choice ends the wait.
                await page.h.selectBook('stkbook0002');
                assert.equal(page.h.state.linkedBookId, '');
                assert.deepEqual(Array.from(page.loaded), ['stkbook0002']);
                await page.h.loadBooks();
                assert.equal(page.h.state.bookId, 'stkbook0002');
            },
        },
        {
            name: 'a stock-page link survives a list without its ledger and opens it once listed',
            async run() {
                // An empty first list (a store still starting) must not drop
                // the link: the refresh that lists the ledger opens it, not
                // the first one listed.
                const books = [];
                const page = loadStockPage(books);
                Object.assign(page.h.state, { bookId: 'stkbook0002', linkedBookId: 'stkbook0002' });
                await page.h.loadBooks();
                assert.equal(page.h.state.bookId, '');
                assert.equal(page.h.state.activeView, 'ledger');
                assert.equal(page.node('page-title').textContent, '找不到账本');
                assert.match(page.node('book-meta').textContent, /找不到链接指定的账本（stkbook0002）/);
                assert.deepEqual(Array.from(page.loaded), []);
                books.push(STK_BOOK, OTHER_ACCOUNT_BOOK);
                await page.h.loadBooks();
                assert.equal(page.h.state.bookId, 'stkbook0002');
                assert.equal(page.node('book-select').value, 'stkbook0002');
                assert.deepEqual(Array.from(page.loaded), ['stkbook0002']);
                assert.equal(page.h.state.linkedBookId, '', 'the link is settled once opened');

                // A list that lacks it, then one that has it again, likewise.
                const later = [STK_BOOK];
                const restored = loadStockPage(later);
                Object.assign(restored.h.state, { bookId: 'stkbook0002', linkedBookId: 'stkbook0002' });
                await restored.h.loadBooks();
                assert.deepEqual(Array.from(restored.loaded), []);
                later.push(OTHER_ACCOUNT_BOOK);
                await restored.h.loadBooks();
                assert.deepEqual(Array.from(restored.loaded), ['stkbook0002']);

                // A ledger the user chooses while the link is pending wins.
                const chosen = [STK_BOOK];
                const choice = loadStockPage(chosen);
                Object.assign(choice.h.state, { bookId: 'stkbook0002', linkedBookId: 'stkbook0002' });
                await choice.h.loadBooks();
                await choice.h.selectBook('stkbook0001');
                chosen.push(OTHER_ACCOUNT_BOOK);
                await choice.h.loadBooks();
                assert.equal(choice.h.state.bookId, 'stkbook0001');
                assert.deepEqual(Array.from(choice.loaded), ['stkbook0001', 'stkbook0001']);
            },
        },
        {
            name: 'the create form has no default type and creates nothing without one',
            async run() {
                const html = read('cost_basis.html');
                assert.match(html, /<select id="new-book-type" required><option value="" selected disabled>请选择账本类型<\/option><option value="STK">/);
                assert.doesNotMatch(html, /<option value="STK" selected/);
                assert.match(html, /<input id="new-book-spc" type="number" min="1" step="1" value="" /);

                const page = loadStockPage([STK_BOOK]);
                page.node('new-book-account').value = 'U1111111';
                page.node('new-book-symbol').value = 'cl';
                page.node('new-book-start').value = '2026-01-01';
                page.node('new-book-spc').value = '100';
                page.node('new-book-type').value = '';
                page.h.refreshControls();
                assert.equal(page.node('btn-create-book').disabled, true);
                await page.h.createBook({ preventDefault() {} });
                assert.deepEqual(page.sent, [], 'nothing is created without a type');
                assert.match(page.alerts[0], /请先选择账本类型/);

                page.node('new-book-type').value = 'FUT';
                await page.h.createBook({ preventDefault() {} });
                assert.deepEqual(page.sent, [], 'a FUT ledger is still frozen');

                page.node('new-book-type').value = 'STK';
                page.h.refreshControls();
                assert.equal(page.node('btn-create-book').disabled, false);
                await page.h.createBook({ preventDefault() {} });
                const create = page.sent.find((entry) => entry.action === 'create_cost_basis_book');
                assert.equal(create.fields.secType, 'STK');
                assert.equal(create.fields.defaultSharesPerContract, 100);
                assert.equal(page.node('new-book-type').value, '', 'the next ledger starts untyped');
                assert.equal(page.node('new-book-spc').value, '');
            },
        },
        {
            name: 'the contract examples pass and fail as stated in the JS reader',
            run() {
                ['protocol.json', 'core_output.json'].forEach((name) => {
                    const document = readJson(`${CONTRACT}/${name}`);
                    const checker = createChecker(document.types);
                    document.examples.valid.forEach((example) => {
                        assert.deepEqual(checker.check(example.type, example.value), [],
                            `${name}: ${example.name}`);
                    });
                    // Exactly the one stated error, as in the Python reader.
                    document.examples.invalid.forEach((example) => {
                        const errors = checker.check(example.type, example.value);
                        assert.deepEqual(errors.map((error) => ({ ...error })),
                            [{ path: example.expect.path, code: example.expect.code }],
                            `${name}: ${example.name}`);
                    });
                });
            },
        },
    ],
};
