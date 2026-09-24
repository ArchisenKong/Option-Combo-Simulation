/**
 * Cost-basis ledgers — shared, DOM-free protocol and routing layer.
 *
 * Loaded before each ledger page's own scripts, by cost_basis.html (stock /
 * ETF ledgers) and cost_basis_fop.html (the standalone FOP ledger). It holds
 * only what both pages must agree on (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md
 * §1.1 and §7): which ledger actions each page may send and which of them
 * write, how a ledger is routed to its page, and a small request/response
 * client. It knows nothing about positions or cost.
 */

(function attachCostBasisCommon(globalScope) {
    'use strict';

    // Every action a ledger page may send, in the order the stock page has
    // always listed them. `writes` marks actions that change stored state;
    // `pages` names the pages allowed to send the action. The backend keeps
    // its own allowlist (cost_basis_ws.SERVER_ACTIONS); these lists only stop
    // a page from sending what it has no business sending, so orders, market
    // data subscriptions and execution stay structurally out of reach.
    const PROTOCOL_ACTIONS = Object.freeze([
        { action: 'request_cost_basis_status', writes: false, pages: ['equity', 'fop'] },
        { action: 'list_cost_basis_books', writes: false, pages: ['equity', 'fop'] },
        { action: 'create_cost_basis_book', writes: true, pages: ['equity'] },
        { action: 'request_cost_basis_delete_plan', writes: false, pages: ['equity'] },
        { action: 'delete_cost_basis_book', writes: true, pages: ['equity'] },
        { action: 'list_cost_basis_events', writes: false, pages: ['equity'] },
        { action: 'append_cost_basis_event', writes: true, pages: ['equity'] },
        { action: 'void_cost_basis_event', writes: true, pages: ['equity'] },
        { action: 'append_cost_basis_split_group', writes: true, pages: ['equity'] },
        { action: 'void_cost_basis_split_group', writes: true, pages: ['equity'] },
        { action: 'import_cost_basis_events', writes: true, pages: ['equity'] },
        { action: 'save_cost_basis_snapshot', writes: true, pages: ['equity'] },
        { action: 'request_cost_basis_reset_plan', writes: false, pages: ['equity'] },
        { action: 'rebuild_cost_basis_book', writes: true, pages: ['equity'] },
        { action: 'list_cost_basis_resets', writes: false, pages: ['equity'] },
        { action: 'restore_cost_basis_reset', writes: true, pages: ['equity'] },
        { action: 'export_cost_basis_backup', writes: false, pages: ['equity'] },
        { action: 'restore_cost_basis_backup', writes: true, pages: ['equity'] },
        { action: 'list_cost_basis_import_batches', writes: false, pages: ['equity'] },
        // Read-only corroboration from the live backend. The market-price
        // action is a one-shot TWS snapshot and leaves no live subscription.
        { action: 'request_portfolio_positions_snapshot', writes: false, pages: ['equity'] },
        { action: 'request_portfolio_avg_cost_snapshot', writes: false, pages: ['equity'] },
        { action: 'request_managed_accounts_snapshot', writes: false, pages: ['equity'] },
        { action: 'request_cost_basis_executions', writes: false, pages: ['equity'] },
        { action: 'request_cost_basis_market_price', writes: false, pages: ['equity'] },
        { action: 'request_cost_basis_option_scenario_inputs', writes: false, pages: ['equity'] },
    ].map((entry) => Object.freeze(Object.assign({}, entry, {
        pages: Object.freeze(entry.pages.slice()),
    }))));

    const PAGE_FILES = Object.freeze({
        equity: 'cost_basis.html',
        fop: 'cost_basis_fop.html',
    });

    // The backend's token rule (cost_basis_store._TOKEN_RE). A bookId from a
    // URL that fails it is ignored, never sent.
    const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

    function _upper(value) {
        return String(value === null || value === undefined ? '' : value).trim().toUpperCase();
    }

    /** The actions one page may send, in catalogue order. */
    function actionsForPage(page) {
        return Object.freeze(PROTOCOL_ACTIONS
            .filter((entry) => entry.pages.indexOf(page) >= 0)
            .map((entry) => entry.action));
    }

    /** True when the action changes stored ledger state. */
    function isWriteAction(action) {
        const entry = PROTOCOL_ACTIONS.find((candidate) => candidate.action === action);
        return Boolean(entry && entry.writes);
    }

    /**
     * Which page a ledger belongs to: 'equity' for STK, 'fop' for FUT, '' for
     * anything else. The type comes from the backend's book record, never
     * from the URL (plan §1.1).
     */
    function bookKind(book) {
        const secType = _upper(book && book.secType);
        if (secType === 'STK') return 'equity';
        if (secType === 'FUT') return 'fop';
        return '';
    }

    function bookUrl(book) {
        const kind = bookKind(book);
        if (!kind || !book || !TOKEN_PATTERN.test(String(book.bookId || ''))) return '';
        return `${PAGE_FILES[kind]}?bookId=${encodeURIComponent(book.bookId)}`;
    }

    /** The bookId in a location.search string, or '' when absent or malformed. */
    function bookIdFromSearch(search) {
        const text = String(search || '').replace(/^\?/, '');
        let found = '';
        text.split('&').forEach((pair) => {
            if (found) return;
            const index = pair.indexOf('=');
            const key = index < 0 ? pair : pair.slice(0, index);
            if (key !== 'bookId') return;
            let value = index < 0 ? '' : pair.slice(index + 1);
            try {
                value = decodeURIComponent(value.replace(/\+/g, ' '));
            } catch (_) {
                value = '';
            }
            if (TOKEN_PATTERN.test(value)) found = value;
        });
        return found;
    }

    /**
     * Where a page must go once the ledger list is known.
     *
     * Returns { view: 'list' } with no ledger requested, { view: 'book', book }
     * when the ledger belongs on this page, { view: 'redirect', url } when it
     * belongs on the other page, { view: 'missing' } for an unknown id and
     * { view: 'unsupported', book } for a type neither page handles.
     */
    function routeForBook(page, books, bookId) {
        if (!bookId) return { view: 'list' };
        const book = (books || []).find((candidate) => candidate.bookId === bookId);
        if (!book) return { view: 'missing', bookId };
        const kind = bookKind(book);
        if (!kind) return { view: 'unsupported', book };
        if (kind === page) return { view: 'book', book };
        return { view: 'redirect', book, url: bookUrl(book) };
    }

    /**
     * A request/response client over one WebSocket.
     *
     * options.allowedActions  actions this page may send
     * options.socket()        the current socket (readyState 1 when open)
     * options.setTimeout / clearTimeout / now   injectable clock
     * options.timeoutMs       per-request timeout (default 20000)
     * options.prefix          requestId prefix
     */
    function createRequestClient(options) {
        const settings = options || {};
        const allowed = Array.from(settings.allowedActions || []);
        const setTimer = settings.setTimeout || ((callback, delay) => globalScope.setTimeout(callback, delay));
        const clearTimer = settings.clearTimeout || ((timer) => globalScope.clearTimeout(timer));
        const now = settings.now || (() => Date.now());
        const timeoutMs = Number(settings.timeoutMs) > 0 ? Number(settings.timeoutMs) : 20000;
        const prefix = settings.prefix || 'cb';
        const pending = new Map();
        let counter = 0;

        function request(action, fields) {
            return new Promise((resolve, reject) => {
                if (allowed.indexOf(action) < 0) {
                    reject(new Error(`action ${action} is not allowed from this page`));
                    return;
                }
                const socket = settings.socket ? settings.socket() : null;
                if (!socket || socket.readyState !== 1) {
                    reject(new Error('未连接到后端'));
                    return;
                }
                counter += 1;
                const requestId = `${prefix}-${counter}-${now()}`;
                const timer = setTimer(() => {
                    pending.delete(requestId);
                    reject(new Error('请求超时'));
                }, timeoutMs);
                pending.set(requestId, { resolve, reject, timer });
                try {
                    socket.send(JSON.stringify(Object.assign({ action, requestId }, fields || {})));
                } catch (error) {
                    clearTimer(timer);
                    pending.delete(requestId);
                    reject(error instanceof Error ? error : new Error('发送请求失败'));
                }
            });
        }

        /** Settle the request a response answers. Returns true when it did. */
        function handleMessage(data) {
            const requestId = data && typeof data.requestId === 'string' ? data.requestId : '';
            const entry = requestId ? pending.get(requestId) : null;
            if (!entry) return false;
            pending.delete(requestId);
            clearTimer(entry.timer);
            if (data.success === false) {
                const error = new Error(data.message || data.code || '请求失败');
                error.code = data.code || '';
                entry.reject(error);
            } else {
                entry.resolve(data);
            }
            return true;
        }

        function failPending(reason) {
            pending.forEach((entry) => {
                clearTimer(entry.timer);
                entry.reject(new Error(reason));
            });
            pending.clear();
        }

        return { request, handleMessage, failPending, pendingCount: () => pending.size };
    }

    globalScope.OptionComboCostBasisCommon = Object.freeze({
        PROTOCOL_ACTIONS,
        PAGE_FILES,
        actionsForPage,
        isWriteAction,
        bookKind,
        bookUrl,
        bookIdFromSearch,
        routeForBook,
        createRequestClient,
    });
})(typeof window !== 'undefined' ? window : globalThis);
