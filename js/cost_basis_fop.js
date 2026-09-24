/**
 * Standalone FOP ledger page — controller (routing and the read-only preview).
 *
 * CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §1.1, §7 and §13.3 P1/P4. It
 * reads the backend's ledger catalogue, sends a stock ledger to
 * cost_basis.html and shows a FUT ledger's identity. It also previews an IBKR
 * statement CSV without a ledger (P4 item 6): the file is read in the browser
 * by js/cost_basis_fop_import.js against the row-type list the backend's
 * status carries, and the result replayed by js/cost_basis_fop_core.js. The
 * preview creates no ledger and sends nothing; the only actions the page may
 * send are the common catalogue's 'fop' ones (status and ledger list). It
 * loads nothing from the stock page or the trading shell.
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

    const STAGE_NOTICE = '独立 FOP 账本正在分阶段实施，当前提供账本路由和 CSV 只读预览。旧版 FUT 账本已冻结'
        + '（现有引擎可能把不同期货月份合并计算）。预览只在浏览器里读取报表、演算结果，不建账，也不写入任何数据。';
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
        // The read-only preview: the backend's row-type list and the file.
        fopFeatures: null,
        preview: { text: null, fileName: '', reading: 0 },
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
    // Read-only CSV preview (plan §13.3 P4 item 6). Pure; no DOM.
    // ------------------------------------------------------------------

    const DISPOSITION_LABELS = Object.freeze({
        event: '新事件', duplicate: '已存在', problem: '问题', other_ledger: '属于其他账本',
        out_of_scope: '范围外（不导入）', unsupported: '首版不支持', detail: '明细（不重复计入）',
    });
    const STATUS_LABELS = Object.freeze({
        real_verified: '真实样本已验收', synthetic_only: '仅合成样本：只能预览或人工认领',
        out_of_scope: '范围外', unsupported: '不支持', unknown: '未知行类型',
    });
    const KIND_LABELS = Object.freeze({
        futures_trade: '期货成交', option_trade: '期权成交', option_expiry: '期权到期',
        option_assignment: '期权被指派', option_exercise: '期权行权', opening_balance: '期初持仓',
    });
    const FORMAT_LABELS = Object.freeze({ activity_csv: 'Activity Statement', flex_csv: 'Flex 成交导出' });
    const METRICS = Object.freeze([
        ['Rf', '期货已实现'], ['Co', '期权现金'], ['E', '费用'], ['J', '人工调整'],
        ['Uf', '期货浮动（需行情）'], ['Vo', '期权市值（需行情）'], ['economicPnl', '完整经济盈亏（需行情）'],
    ]);

    /** A UtcInstant (six fractional digits) for a Date. */
    function utcInstant(date) {
        return `${date.toISOString().slice(0, 23)}000Z`;
    }

    function timeText(time) {
        if (!time) return '';
        if (time.executedAtUtc) return time.executedAtUtc.replace('T', ' ').slice(0, 19) + ' UTC';
        if (time.timeRange) {
            return `${time.timeRange.startUtc.replace('T', ' ').slice(0, 16)} ~ `
                + `${time.timeRange.endUtc.replace('T', ' ').slice(0, 16)} UTC`;
        }
        return '';
    }

    function metricText(metric) {
        if (!metric) return '—';
        if (metric.value === null || metric.value === undefined) return `未知（${metric.reason || '缺数据'}）`;
        return String(Math.round(metric.value * 1e6) / 1e6);
    }

    /**
     * What the page shows for one statement previewed without a ledger:
     * its reading, every row's key, status and fate, the events it would
     * add, the problems that would block it, the quantity proof and, when
     * nothing blocks, the result the core replays from those events alone.
     * options: {capabilities (the backend's importCapabilities), fileName,
     * timeZone ('' = the statement's own), historyScope, engineVersion,
     * productRules, now (a Date)}. Nothing is sent or stored.
     */
    function previewStatement(text, options) {
        const importer = globalScope.OptionComboCostBasisFopImport;
        const core = globalScope.OptionComboCostBasisFopCore;
        if (!importer || !core) throw new Error('the FOP importer and core are not loaded');
        if (!options || !options.capabilities) throw new Error('the backend sent no statement row-type list');
        const productRules = options.productRules || 'NYMEX-CL-v1';
        const rules = importer.PRODUCT_RULES[productRules];
        if (!rules) throw new Error(`product rules ${productRules} are not supported`);
        const statement = importer.readStatement(text, { capabilities: options.capabilities,
            fileName: options.fileName || null });
        const book = { bookId: 'preview', account: '', symbol: rules.root, currency: rules.currency,
            fop: { productRules, historyScope: options.historyScope || 'full_history',
                engineVersion: options.engineVersion || core.ENGINE_VERSION } };
        const plan = importer.planImport(statement, { book, graph: null, timeZone: options.timeZone || null,
            observedAtUtc: utcInstant(options.now || new Date()), baselinePrices: {} });
        const counts = {};
        for (const row of plan.rows) counts[row.disposition] = (counts[row.disposition] || 0) + 1;
        const zone = plan.timeZone
            ? `${plan.timeZone.name}（${plan.timeZone.source === 'stated' ? '手动指定' : '取自报表'}）` : '未确定';
        const view = {
            blocking: plan.blocking,
            summary: [
                ['文件', options.fileName || '（未命名）'],
                ['格式', FORMAT_LABELS[plan.format] || '无法识别'],
                ['账户', plan.account || '—'],
                ['期间', plan.period.from ? `${plan.period.from} 至 ${plan.period.through}` : '—'],
                ['时区', zone],
                ['识别结果', Object.keys(counts).sort().map((key) => `${DISPOSITION_LABELS[key] || key} ${counts[key]}`)
                    .join('，') || '没有可识别的行'],
            ],
            problems: plan.problems.filter((item) => item.blocking)
                .map((item) => ({ line: item.line, code: item.code, message: item.message })),
            warnings: plan.warnings.concat(plan.problems.filter((item) => !item.blocking))
                .map((item) => ({ line: item.line, code: item.code, message: item.message })),
            rows: plan.rows.slice().sort((a, b) => (a.line || 0) - (b.line || 0)).map((row) => ({
                line: row.line, key: row.key || '', status: row.status ? (STATUS_LABELS[row.status] || row.status) : '',
                disposition: DISPOSITION_LABELS[row.disposition] || row.disposition, reason: row.reason || '',
            })),
            events: (plan.plannedEvents || []).map((event) => ({
                lines: (event.readings || []).map((reading) => reading.line).join('、') || '期初',
                kind: KIND_LABELS[event.kind] || event.kind,
                contract: event.contract.localSymbol || event.contract.contractId,
                quantity: event.kind === 'futures_trade' ? event.futureContracts
                    : (event.contracts === null || event.contracts === undefined ? event.futureContracts : event.contracts),
                price: event.price === null || event.price === undefined ? '—' : event.price,
                fees: event.fees === undefined ? 0 : event.fees,
                time: timeText(event.time),
            })),
            quantityProof: plan.quantityProof.map((item) => ({ contract: item.contract, opening: item.opening,
                periodNet: item.periodNet, closing: item.closing })),
            coverage: plan.coverage || null,
            results: null,
            resultsNote: '',
        };
        if (plan.blocking) {
            view.resultsNote = '有阻断问题，不演算结果。';
        } else if (!plan.events.length) {
            view.resultsNote = '这份报表没有会写入的事件。';
        } else {
            const output = core.computeLedger(importer.previewGraph(null, plan, book), {});
            view.results = {
                totals: METRICS.map(([name, label]) => [label, metricText(output.totals[name])]),
                futures: output.futures.map((row) => [row.localSymbol, metricText(row.contracts),
                    metricText(row.averagePrice)]),
                options: output.options.map((row) => [row.contractId, metricText(row.contracts),
                    metricText(row.remainingNetPremium)]),
                realized: output.realizedByContract.map((row) => [row.localSymbol || row.contractId,
                    metricText(row.realized)]),
            };
            view.resultsNote = '只按这份报表演算，没有行情；不是任何账本的结果。';
        }
        return view;
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

    function _cell(tag, text) {
        const node = globalScope.document.createElement(tag);
        node.textContent = text === null || text === undefined ? '' : String(text);
        return node;
    }

    /** A table of text cells; nothing from the file is ever read as markup. */
    function _table(node, headers, rows, emptyText) {
        _clear(node);
        if (!rows.length) {
            node.appendChild(_cell('p', emptyText));
            return;
        }
        const table = globalScope.document.createElement('table');
        table.className = 'fop-table';
        const head = globalScope.document.createElement('tr');
        headers.forEach((header) => head.appendChild(_cell('th', header)));
        table.appendChild(head);
        rows.forEach((row) => {
            const line = globalScope.document.createElement('tr');
            row.forEach((value) => line.appendChild(_cell('td', value)));
            table.appendChild(line);
        });
        node.appendChild(table);
    }

    function _issues(node, items, emptyText) {
        _clear(node);
        if (!items.length) {
            node.appendChild(_cell('li', emptyText));
            return;
        }
        items.forEach((item) => node.appendChild(_cell('li', `${item.line ? `第 ${item.line} 行：` : ''}`
            + `${item.line ? item.message.replace(/^line \d+: /, '') : item.message}（${item.code}）`)));
    }

    function _renderPreview(view) {
        const identity = $('preview-summary');
        _clear(identity);
        view.summary.forEach(([label, value]) => {
            identity.appendChild(_cell('dt', label));
            identity.appendChild(_cell('dd', value));
        });
        _issues($('preview-problems'), view.problems, '没有阻断问题。');
        _issues($('preview-warnings'), view.warnings, '没有提示。');
        _text($('preview-results-note'), view.resultsNote);
        const results = $('preview-results');
        _clear(results);
        if (view.results) {
            const totals = globalScope.document.createElement('div');
            _table(totals, ['指标', '数值'], view.results.totals, '');
            results.appendChild(totals);
            const futures = globalScope.document.createElement('div');
            _table(futures, ['期货', '持仓', '均价'], view.results.futures, '没有未平期货。');
            results.appendChild(futures);
            const options = globalScope.document.createElement('div');
            _table(options, ['期权', '持仓', '剩余净权利金'], view.results.options, '没有未平期权。');
            results.appendChild(options);
            const realized = globalScope.document.createElement('div');
            _table(realized, ['合约', '已实现'], view.results.realized, '没有已实现盈亏。');
            results.appendChild(realized);
        }
        _table($('preview-events'), ['行', '种类', '合约', '数量', '价格', '费用', '时间'],
            view.events.map((event) => [event.lines, event.kind, event.contract, event.quantity, event.price,
                event.fees, event.time]), '没有会写入的事件。');
        _table($('preview-proof'), ['合约', '期初', '期间净变动', '期末'],
            view.quantityProof.map((item) => [item.contract, item.opening, item.periodNet, item.closing]),
            '报表没有持仓段，期初数量未证明。');
        _table($('preview-rows'), ['行', '行类型', '能力状态', '处理', '说明'],
            view.rows.map((row) => [row.line, row.key, row.status, row.disposition, row.reason]),
            '没有可识别的行。');
        $('preview-result').hidden = false;
    }

    function _runPreview() {
        const preview = state.preview;
        if (preview.text === null) return;
        const features = state.fopFeatures;
        if (!features || !features.importCapabilities) {
            _text($('preview-status'), '后端没有提供报表行类型清单，无法预览。');
            return;
        }
        try {
            const view = previewStatement(preview.text, {
                capabilities: features.importCapabilities, fileName: preview.fileName,
                timeZone: String($('preview-zone').value || '').trim(), historyScope: $('preview-scope').value,
                engineVersion: features.engineVersion,
            });
            _renderPreview(view);
            _text($('preview-status'), view.blocking
                ? `已读取 ${preview.fileName}：有 ${view.problems.length} 个阻断问题。只读预览，未写入。`
                : `已读取 ${preview.fileName}：没有阻断问题。只读预览，未写入。`);
        } catch (error) {
            $('preview-result').hidden = true;
            _text($('preview-status'), `无法预览：${error.message}`);
        }
    }

    async function _readPreviewFile() {
        const input = $('preview-file');
        const file = input.files && input.files[0];
        if (!file) return;
        state.preview.reading += 1;
        const reading = state.preview.reading;
        _text($('preview-status'), `正在读取 ${file.name}…`);
        try {
            const text = await file.text();
            if (reading !== state.preview.reading) return;
            state.preview.text = text;
            state.preview.fileName = file.name;
            _runPreview();
        } catch (error) {
            if (reading !== state.preview.reading) return;
            _text($('preview-status'), `无法读取文件：${error.message}`);
        }
    }

    function _enablePreview(features) {
        state.fopFeatures = features || null;
        const ready = Boolean(features && features.importCapabilities);
        $('preview-file').disabled = !ready;
        if (state.preview.text !== null) _runPreview();
        else _text($('preview-status'), ready ? '选择一份 CSV 开始预览。' : '后端没有提供报表行类型清单，无法预览。');
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
            _enablePreview(status.features && status.features.fopLedger);
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
        $('preview-file').disabled = true;
        $('preview-file').addEventListener('change', () => { void _readPreviewFile(); });
        $('preview-zone').addEventListener('change', _runPreview);
        $('preview-scope').addEventListener('change', _runPreview);
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
        previewStatement,
    });

    if (globalScope.document
        && globalScope.document.readyState !== 'loading') {
        start();
    } else if (globalScope.document) {
        globalScope.document.addEventListener('DOMContentLoaded', start);
    }
})(typeof window !== 'undefined' ? window : globalThis);
