/**
 * Standalone FOP ledger page — controller (P1 skeleton).
 *
 * CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §1.1, §7 and §13.3 P1. This
 * stage only routes: it reads the backend's ledger catalogue, sends a stock
 * ledger to cost_basis.html and shows a FUT ledger's identity. It computes
 * nothing and writes nothing; the only actions it may send are the common
 * catalogue's 'fop' ones. It loads js/cost_basis_common.js and nothing from
 * the stock page or the trading shell.
 */

(function attachCostBasisFopPage(globalScope) {
    'use strict';

    const common = globalScope.OptionComboCostBasisCommon;
    const PAGE = 'fop';
    const DEFAULT_WS_HOST = '127.0.0.1';
    const DEFAULT_WS_PORT = 8765;
    // Shared with the stock page, so both pages talk to the same backend.
    const WS_HOST_STORAGE_KEY = 'optionComboWsHost';
    const WS_PORT_STORAGE_KEY = 'optionComboWsPort';
    const RECONNECT_BASE_DELAY_MS = 5000;
    const RECONNECT_MAX_DELAY_MS = 60000;

    const STAGE_NOTICE = '独立 FOP 账本正在分阶段实施，当前只有账本路由。旧版 FUT 账本已冻结'
        + '（现有引擎可能把不同期货月份合并计算），这里不计算成本或盈亏，也不写入任何数据。';
    const LEGACY_STATE = '这是旧版 FUT 账本，已冻结为只读。独立 FOP 引擎完成前，这里只显示账本身份；'
        + '需要查看流水、导出或删除时，请在旧页面打开。';
    // A FUT ledger with FOP metadata belongs to the new engine; the stock page
    // cannot show its rows, so it gets no link there.
    const FOP_STATE = '这是独立 FOP 账本。写入尚未发布，这里暂时只显示账本身份；'
        + '流水、导出和删除在后续阶段提供。';

    const state = {
        ws: null,
        connection: 'idle',
        generation: 0,
        books: [],
        bookId: '',
        reconnectDelay: RECONNECT_BASE_DELAY_MS,
        reconnectTimer: null,
    };

    const client = common.createRequestClient({
        allowedActions: common.actionsForPage(PAGE),
        socket: () => state.ws,
        prefix: 'fop',
    });

    /**
     * What the page shows for a ledger catalogue and a requested id: the
     * common route plus the catalogue split by page. Pure; no DOM.
     */
    function describeView(books, bookId) {
        const list = Array.isArray(books) ? books : [];
        return Object.assign({
            fopBooks: list.filter((book) => common.bookKind(book) === 'fop'),
            equityBooks: list.filter((book) => common.bookKind(book) === 'equity'),
        }, common.routeForBook(PAGE, list, bookId));
    }

    /** The identity rows shown for one ledger. */
    function bookIdentity(book) {
        const rows = [
            ['账户', book.account || '旧版未限定账户'],
            ['根代码', book.symbol || ''],
            ['类型', book.secType || ''],
            ['币种', book.currency || ''],
            ['起算日', book.startDate || ''],
            ['事件数', String(book.eventCount === undefined ? '' : book.eventCount)],
        ];
        if (book.fop) {
            rows.push(['规则', `${book.fop.productRules} · 引擎 v${book.fop.engineVersion}`]);
        }
        return rows;
    }

    function bookLabel(book) {
        return `${book.account || '旧版未限定账户'} · ${book.symbol} · ${book.secType}`
            + (book.eventCount === undefined ? '' : `（${book.eventCount} 条）`);
    }

    // ------------------------------------------------------------------
    // DOM
    // ------------------------------------------------------------------

    function $(id) {
        return globalScope.document.getElementById(id);
    }

    function _text(node, value) {
        if (node) node.textContent = value;
    }

    function _clear(node) {
        while (node && node.firstChild) node.removeChild(node.firstChild);
    }

    function _readStorage(key, fallback) {
        try {
            const value = globalScope.localStorage.getItem(key);
            return value || fallback;
        } catch (_) {
            return fallback;
        }
    }

    function _show(view) {
        ['loading-view', 'message-view', 'book-view', 'list-view'].forEach((id) => {
            $(id).hidden = id !== view;
        });
    }

    function _message(text) {
        _text($('message-text'), text);
        _show('message-view');
    }

    function _setConnection(connection, text) {
        state.connection = connection;
        $('connection').dataset.state = connection;
        _text($('connection-text'), text);
    }

    function _renderList(node, books, emptyText) {
        _clear(node);
        if (!books.length) {
            const item = globalScope.document.createElement('li');
            item.className = 'fop-empty';
            item.textContent = emptyText;
            node.appendChild(item);
            return;
        }
        books.forEach((book) => {
            const item = globalScope.document.createElement('li');
            const link = globalScope.document.createElement('a');
            link.href = common.bookUrl(book);
            link.textContent = bookLabel(book);
            item.appendChild(link);
            node.appendChild(item);
        });
    }

    function _render(view) {
        if (view.view === 'redirect') {
            // The ledger belongs on the other page. Leave before rendering
            // anything of it here.
            globalScope.location.replace(view.url);
            return;
        }
        if (view.view === 'missing') {
            _message(`找不到账本 ${view.bookId}。它可能已被删除，或书签来自另一个数据库。`);
            return;
        }
        if (view.view === 'unsupported') {
            _message(`账本类型 ${view.book.secType || '（空）'} 不属于任何成本账本页面。`);
            return;
        }
        if (view.view === 'book') {
            _text($('book-title'), `${view.book.account || '旧版账户'} / ${view.book.symbol}`);
            const identity = $('book-identity');
            _clear(identity);
            bookIdentity(view.book).forEach(([label, value]) => {
                const term = globalScope.document.createElement('dt');
                term.textContent = label;
                const detail = globalScope.document.createElement('dd');
                detail.textContent = value;
                identity.appendChild(term);
                identity.appendChild(detail);
            });
            const fopLedger = Boolean(view.book.fop);
            _text($('book-state'), fopLedger ? FOP_STATE : LEGACY_STATE);
            const legacyLink = $('book-legacy-link');
            legacyLink.hidden = fopLedger;
            legacyLink.href = `cost_basis.html?bookId=${encodeURIComponent(view.book.bookId)}`;
            _show('book-view');
            return;
        }
        _renderList($('fop-book-list'), view.fopBooks, '没有 FOP / FUT 账本。');
        _renderList($('equity-book-list'), view.equityBooks, '没有股票 / ETF 账本。');
        _show('list-view');
    }

    // ------------------------------------------------------------------
    // Connection
    // ------------------------------------------------------------------

    function connect() {
        const host = _readStorage(WS_HOST_STORAGE_KEY, DEFAULT_WS_HOST);
        const port = _readStorage(WS_PORT_STORAGE_KEY, String(DEFAULT_WS_PORT));
        _text($('server-address'), `${host}:${port}`);
        state.generation += 1;
        const generation = state.generation;
        let socket;
        try {
            socket = new globalScope.WebSocket(`ws://${host}:${port}`);
        } catch (_) {
            _setConnection('unavailable', '无法连接');
            _scheduleReconnect();
            return;
        }
        state.ws = socket;
        _setConnection('connecting', '连接中…');
        socket.onopen = () => {
            if (state.ws !== socket) return;
            state.reconnectDelay = RECONNECT_BASE_DELAY_MS;
            _setConnection('connected', '已连接');
            void _bootstrap(generation);
        };
        socket.onclose = () => {
            if (state.ws !== socket) return;
            state.ws = null;
            client.failPending('连接已断开');
            _setConnection('unavailable', '连接已断开，稍后重试');
            _scheduleReconnect();
        };
        socket.onerror = () => {};
        socket.onmessage = (message) => {
            if (state.ws !== socket) return;
            let data;
            try {
                data = JSON.parse(message.data);
            } catch (_) {
                return;
            }
            client.handleMessage(data);
        };
    }

    function _scheduleReconnect() {
        if (state.reconnectTimer) return;
        const delay = state.reconnectDelay;
        state.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS);
        state.reconnectTimer = globalScope.setTimeout(() => {
            state.reconnectTimer = null;
            connect();
        }, delay);
    }

    async function _bootstrap(generation) {
        try {
            const status = await client.request('request_cost_basis_status');
            if (generation !== state.generation) return;
            if (!status.available) {
                _message(`账本后端不可用（${status.reason || '未知原因'}）。`);
                return;
            }
            const listed = await client.request('list_cost_basis_books');
            if (generation !== state.generation) return;
            state.books = Array.isArray(listed.books) ? listed.books : [];
            _render(describeView(state.books, state.bookId));
        } catch (error) {
            if (generation !== state.generation) return;
            _message(`读取账本目录失败：${error.message}`);
        }
    }

    function start() {
        state.bookId = common.bookIdFromSearch(globalScope.location && globalScope.location.search);
        _text($('stage-text'), STAGE_NOTICE);
        _show('loading-view');
        connect();
    }

    globalScope.OptionComboCostBasisFopPage = Object.freeze({
        PAGE,
        STAGE_NOTICE,
        LEGACY_STATE,
        FOP_STATE,
        describeView,
        bookIdentity,
        bookLabel,
    });

    if (globalScope.document
        && globalScope.document.readyState !== 'loading') {
        start();
    } else if (globalScope.document) {
        globalScope.document.addEventListener('DOMContentLoaded', start);
    }
})(typeof window !== 'undefined' ? window : globalThis);
