/**
 * Standalone FOP ledger page — controller.
 *
 * CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §1.1, §7, §10.3, §11, §12.1 and
 * §13.3 P1/P4/P5. It reads the backend's ledger catalogue, sends a stock
 * ledger to cost_basis.html and a legacy FUT ledger to its identity, and shows
 * a FOP ledger in full: the exported graph replayed by
 * js/cost_basis_fop_core.js and laid out by js/cost_basis_fop_view.js, one
 * quote batch at a time valued by js/cost_basis_fop_quotes.js, statement
 * imports planned by js/cost_basis_fop_import.js, manual entries, voids and
 * cycle boundaries built by js/cost_basis_fop_forms.js, an in-memory delivery
 * preview, backups, restores and deletion. It also previews a statement
 * without a ledger.
 *
 * It sends only the common catalogue's 'fop' actions: reads, one-shot quote
 * batches and FOP packages. There is no order, exercise or subscription
 * action to send. Writes stay behind the backend's fop_writes_enabled gate;
 * the page disables them while the status says they are not released.
 *
 * Every answer is checked against the ledger and generation it was asked for:
 * a late answer for another ledger, an older reload or an older quote request
 * is dropped, and an import planned against an older ledger version must be
 * previewed again before it is sent (F23).
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
    const ZONE_STORAGE_PREFIX = 'optionComboFopZone:';
    const RECONNECT_BASE_DELAY_MS = 5000;
    const RECONNECT_MAX_DELAY_MS = 60000;
    const REQUEST_TIMEOUT_MS = 45000;
    const QUOTE_RECHECK_MS = 15000;
    const IMPORT_BATCH_EVENTS = 5000;

    const STAGE_NOTICE = '独立 FOP 账本正在分阶段实施：已提供账本、报表导入、手工记账、一次性报价与交割预览。'
        + '旧版 FUT 账本已冻结（旧引擎可能把不同期货月份合并计算）。正式写入在发布阶段开放；'
        + '报表的经济行在真实样本验收前只能预览或逐行人工认领。';
    const LEGACY_STATE = '这是旧版 FUT 账本，已冻结为只读。这里只显示账本身份；'
        + '需要查看流水、导出或删除时，请在旧页面打开。';
    // A FUT ledger with FOP metadata belongs to the new engine; the stock page
    // cannot show its rows, so it gets no link there.
    const FOP_STATE = '独立 FOP 账本：数字由账本流水逐合约回放得到，每个金额都能追到事件与合约。';
    const WRITES_CLOSED = '本后端已关闭 FOP 写入（config.ini 的 [cost_basis] fop_writes_enabled = false）：'
        + '本页只读，记账、导入、冲销、周期和恢复按钮已停用。';

    const state = {
        ws: null,
        connection: 'idle',
        generation: 0,
        books: [],
        bookId: '',
        reconnectDelay: RECONNECT_BASE_DELAY_MS,
        reconnectTimer: null,
        // The backend's FOP features: engine, row-type list, release state.
        fopFeatures: null,
        preview: { text: null, fileName: '', reading: 0 },
        // The FOP ledger on screen and the counters that retire stale answers.
        ledger: null,
        ledgerGeneration: 0,
        quoteGeneration: 0,
        bindingGeneration: 0,
        positionsGeneration: 0,
        quoteTimer: null,
        clock: () => Date.now(),
    };

    const client = common.createRequestClient({
        allowedActions: common.actionsForPage(PAGE),
        socket: () => state.ws,
        prefix: 'fop',
        timeoutMs: REQUEST_TIMEOUT_MS,
    });

    function modules() {
        return {
            Import: globalScope.OptionComboCostBasisFopImport,
            Core: globalScope.OptionComboCostBasisFopCore,
            Quotes: globalScope.OptionComboCostBasisFopQuotes,
            View: globalScope.OptionComboCostBasisFopView,
            Forms: globalScope.OptionComboCostBasisFopForms,
            Reconcile: globalScope.OptionComboCostBasisFopReconcile,
            Messages: globalScope.OptionComboCostBasisFopMessages,
        };
    }

    // ------------------------------------------------------------------
    // Routing and identity (pure)
    // ------------------------------------------------------------------

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
            rows.push(['账本范围', book.fop.historyScope === 'since_baseline' ? '自基线起' : '完整历史']);
        }
        return rows;
    }

    function bookLabel(book) {
        return `${book.account || '旧版未限定账户'} · ${book.symbol} · ${book.secType}`
            + (book.eventCount === undefined ? '' : `（${book.eventCount} 条）`);
    }

    /** The BookIdentity every FOP write carries (protocol.json). */
    function identityOf(book) {
        return { account: book.account, symbol: book.symbol, secType: book.secType, currency: book.currency };
    }

    /** A request's own fields: the request client adds the action and the request id. */
    function fieldsOf(message) {
        const fields = Object.assign({}, message);
        delete fields.action;
        delete fields.requestId;
        return fields;
    }

    function token(prefix) {
        const random = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
        return `${prefix}-${state.clock().toString(36)}${random}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    }

    /** A new CL ledger (FopBookCreateRequest), from what the user states; never a default type. */
    function createBookRequest(input, features) {
        const account = String(input.account || '').trim().toUpperCase();
        if (!/^[A-Z0-9_-]{2,32}$/.test(account)) throw new Error('请填写账户（不含遮罩）');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate || '')) throw new Error('请填写起算日');
        if (input.historyScope !== 'full_history' && input.historyScope !== 'since_baseline') {
            throw new Error('请选择账本范围：完整历史或自基线起');
        }
        return {
            account, symbol: 'CL', startDate: input.startDate, secType: 'FUT', currency: 'USD',
            note: String(input.note || '').trim(),
            fop: { engineVersion: (features && features.engineVersion) || 1, productRules: 'NYMEX-CL-v1',
                historyScope: input.historyScope },
        };
    }

    /** "CLZ6=70.5" lines as the importer's baselinePrices (reference prices at B). */
    function parseBaselinePrices(text) {
        const prices = {};
        for (const line of String(text || '').split(/\n+/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const match = /^(.+?)\s*=\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed);
            if (!match) throw new Error(`期初参考价写法应为 合约=价格：${trimmed}`);
            prices[match[1].trim().toUpperCase()] = { kind: 'reference_price', price: Number(match[2]) };
        }
        return prices;
    }

    // ------------------------------------------------------------------
    // Statement plans as the page shows them (pure)
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

    /** One plan's reading, rows, events, problems and quantity proof, as the page lists them. */
    function planView(plan, fileName) {
        const counts = {};
        for (const row of plan.rows) counts[row.disposition] = (counts[row.disposition] || 0) + 1;
        const zone = plan.timeZone
            ? `${plan.timeZone.name}（${plan.timeZone.source === 'stated' ? '手动指定' : '取自报表'}）` : '未确定';
        return {
            blocking: plan.blocking,
            summary: [
                ['文件', fileName || '（未命名）'],
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
            synthetic: plan.rows.some((row) => row.disposition === 'event' && row.status === 'synthetic_only'),
            // The contract of each statement row, for the problems that name a line.
            lineContracts: Object.fromEntries((plan.readings || []).filter((reading) => reading.contract || reading.symbol)
                .map((reading) => [reading.line, (reading.contract && reading.contract.localSymbol) || reading.symbol])),
        };
    }

    const REVIEW_STATUS = Object.freeze({
        undecided: '待核实', incomplete: '决定不完整', conflict: '与所选成交不符，仍然阻断',
        same: '认定为同一笔（不写入）', distinct: '认定为另一笔（写入一次）',
    });
    const DECISION_LABELS = Object.freeze({ same_fill: '同一笔', distinct_fill: '另一笔' });

    function timeOfDay(time) {
        return timeText(time) || '—';
    }

    /**
     * One possible duplicate as the page lists it (plan §19 P5-C1): the row,
     * every stored fill it may repeat, what may be decided and what was.
     * options: [value, label]; a same-fill value names its fill.
     */
    function duplicateReviewView(review) {
        const decision = review.decision;
        const current = !decision ? ''
            : (decision.decision === 'same_fill' ? `same:${decision.eventIds[0]}` : 'distinct');
        return {
            line: review.line, sourceKey: review.sourceKey, namespace: review.namespace, sourceRef: review.sourceRef,
            row: `第 ${review.line} 行 · ${KIND_LABELS[review.kind] || review.kind} · ${review.localSymbol} · `
                + `数量 ${review.quantity} · 价格 ${review.price === null ? '—' : review.price} · 费用 ${review.fees} · `
                + `${timeOfDay(review.time)}`,
            status: decision && decision.recorded ? '早先的导入已认定为同一笔（不写入）'
                : (REVIEW_STATUS[review.status] || review.status),
            candidates: review.candidates.map((item) => [item.eventId, item.localSymbol || item.contractId,
                item.quantity, item.price === null || item.price === undefined ? '—' : item.price, item.fees,
                item.cashAmount, timeOfDay(item.time), item.sources.join('、') || '—']),
            candidateIds: review.candidates.map((item) => item.eventId),
            decidable: review.decidable && !(decision && decision.recorded),
            options: [['', '未处理（保持阻断）']].concat(review.candidates.map((item) => [`same:${item.eventId}`,
                `同一笔：就是 ${item.eventId}`]), [['distinct', '另一笔：不同于以上全部候选']]),
            current, attestation: decision ? decision.attestation : '',
        };
    }

    /** The same-fill and distinct-fill decisions earlier imports recorded (their answers in the request log). */
    function decisionLog(graph) {
        const rows = [];
        for (const request of (graph && graph.requests) || []) {
            if (request.action !== 'import') continue;
            let answer;
            try {
                answer = JSON.parse(request.resultJson);
            } catch (_) {
                continue;
            }
            for (const item of (answer && answer.duplicateDecisions) || []) {
                rows.push([request.createdAtUtc.replace('T', ' ').replace('Z', ' UTC'), answer.importBatchId || '',
                    `${item.namespace}:${item.sourceRef}`, DECISION_LABELS[item.decision] || item.decision,
                    item.eventIds.join('、'), item.attestation]);
            }
        }
        return rows;
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
        const { Import: importer, Core: core } = modules();
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
        const view = Object.assign(planView(plan, options.fileName), { results: null, resultsNote: '' });
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
    // A FOP ledger as the page shows it (pure)
    // ------------------------------------------------------------------

    function liveEventDays(graph, zone) {
        const { Import } = modules();
        return (graph.events || []).filter((stored) => !stored.row.voidedAtUtc
            && stored.row.kind !== 'opening_balance').map((stored) => Import.localDay(stored.row.fop.time, zone));
    }

    function eventOrder(stored) {
        const time = stored.row.fop.time;
        return time.executedAtUtc || (time.timeRange ? time.timeRange.startUtc : '');
    }

    /**
     * Everything the ledger view shows, from one loaded ledger: {graph,
     * version, batches, quoteBatch, zone}. now is the page clock (epoch ms),
     * used only to age quotes and to date "today".
     */
    function ledgerModel(ledger, now) {
        const { Import, Core, Quotes, View } = modules();
        const graph = ledger.graph;
        const unpriced = Core.computeLedger(graph, { rolls: false });
        const targets = Quotes.quoteTargets(unpriced);
        const quoteState = ledger.quoteBatch
            ? Quotes.evaluateBatch(ledger.quoteBatch, { targets, ledgerVersion: ledger.version, now }) : null;
        const output = Core.computeLedger(graph, { marks: quoteState && quoteState.usable ? quoteState.marks : {} });
        const zone = ledger.zone || 'Etc/UTC';
        const coverage = Import.coverageOf(ledger.batches || [], liveEventDays(graph, zone));
        const today = Import.localDay({ executedAtUtc: utcInstant(new Date(now)) }, zone);
        const events = (graph.events || []).slice().sort((a, b) => (eventOrder(a) < eventOrder(b) ? -1
            : (eventOrder(a) > eventOrder(b) ? 1 : a.row.seq - b.row.seq)));
        return {
            output, targets, quoteState, coverage, today,
            overview: View.overview(output, quoteState, graph),
            breakEven: View.breakEvenCard(output, graph),
            integrity: View.integrity(output, { quoteState, coverage, graph }),
            futures: View.futuresTable(output, graph, quoteState),
            options: View.optionsTable(output, graph, quoteState, today),
            coverageTable: View.deliveryCoverage(output, graph),
            rolls: View.rollHistory(output, graph),
            cycles: View.cyclesTable(output, graph),
            events: View.eventsTable(events.map((stored) => stored.row), graph),
        };
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

    function _writeStorage(key, value) {
        try {
            globalScope.localStorage.setItem(key, value);
        } catch (_) {
            // Per-viewer convenience only.
        }
    }

    function _value(id) {
        const node = $(id);
        return node ? String(node.value === undefined || node.value === null ? '' : node.value).trim() : '';
    }

    function _cell(tag, text) {
        const node = globalScope.document.createElement(tag);
        node.textContent = text === null || text === undefined ? '' : String(text);
        return node;
    }

    function _option(value, label) {
        const node = _cell('option', label);
        node.value = value;
        return node;
    }

    function _fillSelect(node, options, emptyLabel) {
        if (!node) return;
        const previous = node.value;
        _clear(node);
        node.appendChild(_option('', emptyLabel));
        for (const [value, label] of options) node.appendChild(_option(value, label));
        node.value = options.some(([value]) => value === previous) ? previous : '';
    }

    /** A table of text cells; nothing from a file or the ledger is ever read as markup. */
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

    /** Problems in words (plan §19 P5-C6): reason, row and contract, next step; the code and original kept. */
    function _issues(node, items, emptyText, lineContracts) {
        const { Messages } = modules();
        _clear(node);
        if (!items.length) {
            node.appendChild(_cell('li', emptyText));
            return;
        }
        const contractOf = (line) => (lineContracts && lineContracts[line]) || null;
        items.forEach((item) => {
            const explained = Messages.explain(item, { contractOf });
            const line = _cell('li', explained.text);
            line.appendChild(_cell('small', ` 原文：${explained.original}`));
            node.appendChild(line);
        });
    }

    function _definitions(node, rows) {
        _clear(node);
        rows.forEach(([label, value]) => {
            node.appendChild(_cell('dt', label));
            node.appendChild(_cell('dd', value));
        });
    }

    /** A plan's view into the elements named prefix-summary, -problems, -warnings, -events, -proof, -rows. */
    function _renderPlan(prefix, view) {
        _definitions($(`${prefix}-summary`), view.summary);
        _issues($(`${prefix}-problems`), view.problems, '没有阻断问题。', view.lineContracts);
        _issues($(`${prefix}-warnings`), view.warnings, '没有提示。', view.lineContracts);
        _table($(`${prefix}-events`), ['行', '种类', '合约', '数量', '价格', '费用', '时间'],
            view.events.map((event) => [event.lines, event.kind, event.contract, event.quantity, event.price,
                event.fees, event.time]), '没有会写入的事件。');
        _table($(`${prefix}-proof`), ['合约', '期初', '期间净变动', '期末'],
            view.quantityProof.map((item) => [item.contract, item.opening, item.periodNet, item.closing]),
            '报表没有持仓段，期初数量未证明。');
        _table($(`${prefix}-rows`), ['行', '行类型', '能力状态', '处理', '说明'],
            view.rows.map((row) => [row.line, row.key, row.status, row.disposition, row.reason]),
            '没有可识别的行。');
        $(`${prefix}-result`).hidden = false;
    }

    function _renderPreview(view) {
        _renderPlan('preview', view);
        _text($('preview-results-note'), view.resultsNote);
        const results = $('preview-results');
        _clear(results);
        if (view.results) {
            for (const [headers, rows, empty] of [
                [['指标', '数值'], view.results.totals, ''],
                [['期货', '持仓', '均价'], view.results.futures, '没有未平期货。'],
                [['期权', '持仓', '剩余净权利金'], view.results.options, '没有未平期权。'],
                [['合约', '已实现'], view.results.realized, '没有已实现盈亏。'],
            ]) {
                const block = globalScope.document.createElement('div');
                _table(block, headers, rows, empty);
                results.appendChild(block);
            }
        }
    }

    // ------------------------------------------------------------------
    // Read-only preview without a ledger
    // ------------------------------------------------------------------

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
                timeZone: _value('preview-zone'), historyScope: $('preview-scope').value,
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

    async function _readFile(input) {
        const file = input && input.files && input.files[0];
        if (!file) return null;
        return { name: file.name, text: await file.text() };
    }

    async function _readPreviewFile() {
        state.preview.reading += 1;
        const reading = state.preview.reading;
        _text($('preview-status'), '正在读取文件…');
        try {
            const file = await _readFile($('preview-file'));
            if (!file || reading !== state.preview.reading) return;
            state.preview.text = file.text;
            state.preview.fileName = file.name;
            _runPreview();
        } catch (error) {
            if (reading !== state.preview.reading) return;
            _text($('preview-status'), `无法读取文件：${error.message}`);
        }
    }

    /** A refusal in words: a server code gets its reason and next step; a page error is already Chinese. */
    function _refusal(error) {
        const { Messages } = modules();
        return error && error.code ? Messages.serverError(error) : String((error && error.message) || error);
    }

    function _writesReleased() {
        return Boolean(state.fopFeatures && state.fopFeatures.writesReleased);
    }

    function _applyWriteGate() {
        const open = _writesReleased();
        const nodes = globalScope.document.querySelectorAll ? globalScope.document.querySelectorAll('[data-writes]') : [];
        for (const node of nodes) node.disabled = !open;
        const note = $('writes-note');
        if (note) {
            note.hidden = open;
            _text(note, open ? '' : WRITES_CLOSED);
        }
        const create = $('create-status');
        if (create && !open) _text(create, WRITES_CLOSED);
    }

    function _enableFeatures(features) {
        state.fopFeatures = features || null;
        const ready = Boolean(features && features.importCapabilities);
        $('preview-file').disabled = !ready;
        if (state.preview.text !== null) _runPreview();
        else _text($('preview-status'), ready ? '选择一份 CSV 开始预览。' : '后端没有提供报表行类型清单，无法预览。');
        _applyWriteGate();
    }

    function _show(view) {
        ['loading-view', 'message-view', 'book-view', 'list-view'].forEach((id) => {
            $(id).hidden = id !== view;
        });
        // The ledger-less preview belongs to the list; a ledger imports in its own card.
        const preview = $('preview-view');
        if (preview) preview.hidden = view === 'book-view';
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

    function _renderIdentity(book) {
        const identity = $('book-identity');
        _clear(identity);
        bookIdentity(book).forEach(([label, value]) => {
            identity.appendChild(_cell('dt', label));
            identity.appendChild(_cell('dd', value));
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
            _renderIdentity(view.book);
            const fopLedger = Boolean(view.book.fop);
            _text($('book-state'), fopLedger ? FOP_STATE : LEGACY_STATE);
            const legacyLink = $('book-legacy-link');
            legacyLink.hidden = fopLedger;
            legacyLink.href = `cost_basis.html?bookId=${encodeURIComponent(view.book.bookId)}`;
            $('ledger-actions').hidden = !fopLedger;
            _show('book-view');
            if (fopLedger) void _openLedger(view.book);
            return;
        }
        _renderList($('fop-book-list'), view.fopBooks, '没有 FOP / FUT 账本。');
        _renderList($('equity-book-list'), view.equityBooks, '没有股票 / ETF 账本。');
        _show('list-view');
    }

    // ------------------------------------------------------------------
    // A FOP ledger: load, render, quotes
    // ------------------------------------------------------------------

    function _status(id, text) {
        _text($(id), text);
    }

    function _stopQuoteTimer() {
        if (state.quoteTimer) {
            globalScope.clearTimeout(state.quoteTimer);
            state.quoteTimer = null;
        }
    }

    /**
     * Re-age the batch on screen: at the moment its first current quote
     * stops being fresh, and at least every QUOTE_RECHECK_MS while any quote
     * is current. Only the figures are redrawn; the forms keep what the user
     * is typing.
     */
    function _scheduleQuoteRecheck(ledger, batch) {
        _stopQuoteTimer();
        const { Quotes } = modules();
        const until = Quotes.currentUntil(ledger.model && ledger.model.quoteState);
        if (until === null) return;
        const delay = Math.max(0, Math.min(QUOTE_RECHECK_MS, until - state.clock() + 1));
        state.quoteTimer = globalScope.setTimeout(() => {
            state.quoteTimer = null;
            if (state.ledger !== ledger || ledger.quoteBatch !== batch) return;
            _renderLedger({ forms: false });
            _scheduleQuoteRecheck(ledger, batch);
        }, delay);
    }

    /** Retire the quotes on screen at once and redraw the figures without them. */
    function _dropQuotes(text) {
        _stopQuoteTimer();
        const ledger = state.ledger;
        if (!ledger || !ledger.quoteBatch) return;
        ledger.quoteBatch = null;
        _renderLedger({ forms: false });
        _status('ledger-status', text);
    }

    async function _openLedger(book) {
        _stopQuoteTimer();
        const zone = _readStorage(`${ZONE_STORAGE_PREFIX}${book.bookId}`, '');
        state.ledger = { bookId: book.bookId, book, graph: null, version: null, batches: [], quoteBatch: null,
            zone, importPlan: null, importFile: null, importDecisions: new Map(), duplicateControls: new Map(),
            adoptingUpgrades: false,
            delivery: null, deliveryControls: null, binding: null, manual: null, positions: null, trace: null,
            snapshots: [], savingSnapshot: false };
        const zoneInput = $('ledger-zone');
        if (zoneInput) zoneInput.value = zone;
        await _loadLedger();
    }

    /**
     * Read the ledger: its version, its graph and its version again (the
     * export carries none; equal versions on both sides mean the graph is
     * that version), then its registered statement periods. A reload for
     * another ledger or a newer reload retires this one.
     */
    async function _loadLedger() {
        const ledger = state.ledger;
        if (!ledger) return;
        state.ledgerGeneration += 1;
        const generation = state.ledgerGeneration;
        const bookId = ledger.bookId;
        const current = () => state.ledger === ledger && generation === state.ledgerGeneration;
        _status('ledger-status', '正在读取账本…');
        try {
            let graph = null;
            let version = null;
            for (let attempt = 0; attempt < 3 && !graph; attempt += 1) {
                const before = await client.request('list_cost_basis_events', { bookId, limit: 1 });
                const backup = await client.request('export_cost_basis_backup', { bookId });
                const after = await client.request('list_cost_basis_events', { bookId, limit: 1 });
                if (!current()) return;
                if (before.ledgerVersion.digest === after.ledgerVersion.digest) {
                    graph = backup.payload;
                    version = after.ledgerVersion;
                }
            }
            if (!graph) throw new Error('账本在读取时持续变化，请稍后重试');
            const listed = await client.request('list_cost_basis_import_batches', { bookId, limit: 500 });
            if (!current()) return;
            const moved = Boolean(ledger.version) && ledger.version.digest !== version.digest;
            ledger.graph = graph;
            ledger.book = Object.assign({}, ledger.book, graph.book, { fop: Object.assign({}, ledger.book.fop,
                { historyScope: graph.fopBook.historyScope, engineVersion: graph.fopBook.engineVersion,
                    productRules: graph.fopBook.productRules }) });
            ledger.version = version;
            ledger.batches = (listed.batches || []).map((batch) => ({ periodFrom: batch.periodFrom,
                periodThrough: batch.periodThrough }));
            _renderIdentity(Object.assign({}, ledger.book, { eventCount: version.liveEventCount }));
            if (ledger.quoteBatch && ledger.quoteBatch.ledgerVersion.digest !== version.digest) {
                // Quotes are shown only for the version they were asked for.
                ledger.quoteBatch = null;
                _stopQuoteTimer();
            }
            if (ledger.importPlan && ledger.importPlan.version.digest !== version.digest) {
                ledger.importPlan = null;
                ledger.importFile = null;
                ledger.importDecisions = new Map();
                $('import-result').hidden = true;
                // Cleared, so choosing the same file again is a change.
                $('import-file').value = '';
                _status('import-status', '账本已变化，旧的导入预览已作废；请重新选择文件预览。');
            }
            if (moved && ledger.manual) {
                _clearManualPreview('账本已变化，旧的手工记账预览已作废；请重新预览。');
            }
            if (moved && ledger.binding) {
                ledger.binding = null;
                _renderBinding();
                _status('binding-status', '账本已变化，旧的绑定查询与预览已作废；请重新查询。');
            }
            if (moved && ledger.delivery) {
                ledger.delivery = null;
                _clear($('delivery-result'));
                _status('delivery-status', '账本已变化，旧的交割预览已作废；请重新演算。');
            }
            _renderLedger();
            _status('ledger-status', `已读取：${graph.events.length} 条流水，版本 ${version.digest.slice(0, 12)}。`);
            void _loadSnapshots(ledger);
        } catch (error) {
            if (!current()) return;
            _status('ledger-status', `读取账本失败：${error.message}`);
        }
    }

    /** Redraw the ledger's figures, and its forms unless options.forms is false (a quote re-check). */
    function _renderLedger(options = {}) {
        const ledger = state.ledger;
        if (!ledger || !ledger.graph) return;
        const model = ledgerModel(ledger, state.clock());
        ledger.model = model;
        $('ledger-view').hidden = false;
        _text($('overview-label'), model.overview.headline.label);
        _text($('overview-value'), model.overview.headline.value);
        _text($('overview-tag'), model.overview.headline.tag);
        _text($('overview-scope'), `账本范围：${model.overview.scope}；价格：${model.overview.quality.label}`);
        _table($('overview-table'), ['分项', '金额'], model.overview.rows.concat(model.overview.unattributed),
            '');
        _text($('overview-identity'), `完整经济盈亏 = ${model.overview.identity}`);
        _table($('overview-buyer'), ['买方期权', '金额'], model.overview.buyer, '');

        const card = model.breakEven;
        _table($('breakeven-table'), ['项目', `价格${card.shown ? `（${card.contract}）` : ''}`],
            card.shown ? card.rows : [], '');
        _text($('breakeven-note'), card.shown ? card.note : `不显示单一回本价：${card.reason}`);
        $('breakeven-hint').hidden = !card.hint;
        _text($('breakeven-hint'), card.hint);

        _table($('integrity-table'), ['项目', '状态', '说明'],
            model.integrity.map((item) => [item.name, item.label, item.detail]), '');
        _table($('futures-table'), ['交割月', '合约', '最后交易日', '张数', '实际均价', '报价', '经济浮盈亏'],
            model.futures.rows.map((row) => [row.month, row.localSymbol, row.lastTradeDate, row.contracts, row.average,
                row.quote, row.unrealized]), '没有未平期货。');
        _text($('futures-note'), `多头 ${model.futures.long} 张，空头 ${model.futures.short} 张，净 ${model.futures.net} 张。`
            + (model.futures.note ? ` ${model.futures.note}` : ''));
        _table($('options-table'), ['到期', '类型', '行权价', '交易类', '张数', '对应期货', '绑定', '剩余净权利金', '报价',
            '市值', '提示'], model.options.map((row) => [row.expiry, row.right, row.strike, row.tradingClass, row.contracts,
            row.future, row.binding, row.premium, row.quote, row.value, row.flags.join('；')]), '没有未平期权。');
        _table($('coverage-table'), ['期货', '持仓', '空头全部被指派', '多头全部行权', '空头 Call', '空头 Put', '提示'],
            model.coverageTable.rows.map((row) => [row.future, row.position, row.ifShortsAssigned, row.ifLongsExercised,
                row.calls, row.puts, row.notes.join('；')])
                .concat(model.coverageTable.unbound.map((item) => [item.localSymbol, '—', '—', '—', '—', '—', item.reason])),
            '没有未平期权需要交割覆盖。');
        _text($('coverage-note'), model.coverageTable.note);
        _table($('roll-table'), ['证据', '旧合约', '新合约', '张数', '平旧均价', '开新均价', '价差', '费用', '事件'],
            model.rolls.map((row) => [row.evidence, row.from, row.to, row.contracts, row.closePrice, row.openPrice,
                row.spread, row.fees, row.events.join('、')]), '没有推导出的换月。');
        _table($('cycles-table'), ['周期', '状态', '边界', '说明', '期货已实现', '费用', '经济盈亏'],
            model.cycles.rows.map((row) => [row.index, row.state, row.boundary, row.label, row.Rf, row.E,
                row.economicPnl]), '');
        _text($('cycles-note'), model.cycles.note + (model.cycles.unattributed
            ? ` 待归属费用：${model.cycles.unattributed}。` : ''));
        _table($('events-table'), ['事件', '种类', '合约', '数量', '价格', '费用', '现金', '经济时刻', '交易日', '来源', '状态'],
            model.events.map((row) => [row.eventId, row.kind, row.contract, row.quantity, row.price, row.fees, row.cash,
                row.time, row.tradeDate, row.source, row.voided ? '已冲销' : '']), '账本还没有流水。');
        _table($('import-decision-log'), ['记录时间', '导入批次', '报表行', '决定', '账本事件', '核对依据'],
            decisionLog(ledger.graph), '还没有人工核实过疑似重复。');
        _renderReconcile();
        if (options.forms !== false) _renderLedgerForms(model);
        _applyWriteGate();
    }

    function _renderLedgerForms(model) {
        const { Forms, View } = modules();
        const ledger = state.ledger;
        const records = View.currentRecords(ledger.graph);
        const live = ledger.graph.events.filter((stored) => !stored.row.voidedAtUtc);
        const describe = (row) => `${row.eventId} · ${View.KIND_LABELS[row.kind] || row.kind} · `
            + `${(row.display && row.display.localSymbol) || ''}`;
        _fillSelect($('void-event'), live.map((stored) => [stored.row.eventId, describe(stored.row)]), '选择事件');
        _fillSelect($('manual-fee-source'), live.filter((stored) => ['futures_trade', 'option_trade', 'option_assignment',
            'option_exercise', 'option_expiry'].includes(stored.row.kind))
            .map((stored) => [stored.row.eventId, describe(stored.row)]), '无（当期独立费用）');
        let anchors = [];
        try {
            anchors = Forms.cycleAnchors(ledger.graph);
        } catch (_) {
            anchors = [];
        }
        const byId = new Map(ledger.graph.events.map((stored) => [stored.row.eventId, stored.row]));
        _fillSelect($('cycle-anchor'), anchors.map((id) => [id, byId.has(id) ? describe(byId.get(id)) : id]),
            anchors.length ? '选择使全部仓位归零的事件' : '当前没有全部归零的边界');
        _fillSelect($('cycle-revoke-id'), (ledger.graph.cycles || []).filter((cycle) => cycle.state === 'closed'
            && (cycle.supersededByRevision === null || cycle.supersededByRevision === undefined))
            .map((cycle) => [cycle.boundaryId, `${cycle.boundaryId}${cycle.label ? ` · ${cycle.label}` : ''}`]),
        '选择已结束的周期边界');
        const contracts = [...records.values()];
        _fillSelect($('manual-contract'), contracts.map((record) => [record.contractId,
            `${record.localSymbol || record.contractId}（${record.secType}）`]), '新合约（在下方填写条款）');
        _fillSelect($('manual-future'), contracts.filter((record) => record.secType === 'FUT')
            .map((record) => [record.contractId, record.localSymbol || record.contractId]), '选择对应期货');
        const bindable = model.output.options.filter((row) => QUERYABLE_BINDINGS.has(row.bindingStatus));
        _fillSelect($('binding-option'), bindable.map((row) => [row.contractId,
            `${(records.get(row.contractId) || {}).localSymbol || row.contractId} · `
            + `${View.BINDING_LABELS[row.bindingStatus] || row.bindingStatus}`]),
        bindable.length ? '选择期权' : '没有待补全或人工核实的期权绑定');
        _renderDeliveryInputs(model);
    }

    function _setZone() {
        const ledger = state.ledger;
        if (!ledger) return;
        ledger.zone = _value('ledger-zone');
        _writeStorage(`${ZONE_STORAGE_PREFIX}${ledger.bookId}`, ledger.zone);
        _renderLedger();
        // A previewed statement was read in the old zone: preview it again.
        if (ledger.importPlan) _planImport();
        _clearManualPreview('账户时区已改变，旧的手工记账预览已作废；请重新预览。');
    }

    /**
     * One quote batch for the open contracts of the ledger on screen. The
     * answer is shown only if it is still for that ledger, that version and
     * this request; the page then re-ages it on a single timer, so a quote
     * stops counting as current FRESH_SECONDS after the broker observed it.
     * A lost connection retires it at once.
     */
    async function _refreshQuotes() {
        const ledger = state.ledger;
        if (!ledger || !ledger.model) return;
        const { Quotes } = modules();
        const targets = ledger.model.targets;
        if (!targets.length) {
            _status('ledger-status', '没有未平合约，无需报价；已实现结果照常显示。');
            return;
        }
        state.quoteGeneration += 1;
        const request = { bookId: ledger.bookId, generation: state.quoteGeneration };
        _status('ledger-status', `正在为 ${targets.length} 个合约取一次报价…`);
        try {
            const batch = await client.request('request_cost_basis_fop_market_snapshot', {
                bookId: ledger.bookId, contractIds: targets.map((target) => target.contractId) });
            const now = state.ledger;
            if (!Quotes.acceptsBatch(request, batch, now ? { bookId: now.bookId, generation: state.quoteGeneration,
                ledgerVersion: now.version } : null)) {
                if (now && now.bookId === request.bookId && request.generation === state.quoteGeneration) {
                    _status('ledger-status', '报价批次与当前账本版本不符，已丢弃；请重新读取后再取报价。');
                }
                return;
            }
            now.quoteBatch = batch;
            _renderLedger({ forms: false });
            _scheduleQuoteRecheck(now, batch);
            _status('ledger-status', `报价批次 ${batch.quoteBatchId.slice(0, 18)}：${now.model.overview.quality.label}。`);
        } catch (error) {
            if (state.ledger === ledger && request.generation === state.quoteGeneration) {
                _status('ledger-status', `取报价失败：${_refusal(error)}`);
            }
        }
    }

    // ------------------------------------------------------------------
    // Writes: every one names the ledger version it was prepared against
    // ------------------------------------------------------------------

    function _writeContext() {
        const ledger = state.ledger;
        if (!ledger || !ledger.graph) throw new Error('请先读取账本');
        if (!_writesReleased()) throw new Error(WRITES_CLOSED);
        return ledger;
    }

    function _requestBase(ledger, clientToken) {
        return { requestId: token('req'), clientToken, expectedLedgerVersion: ledger.version,
            bookIdentity: identityOf(ledger.book) };
    }

    async function _send(action, message) {
        return client.request(action, fieldsOf(message));
    }

    async function _afterWrite(statusId, text) {
        _status(statusId, text);
        await _loadLedger();
    }

    function _formsContext(ledger) {
        if (!ledger.zone) throw new Error('请先在上方填写账户时区');
        return { book: ledger.book, graph: ledger.graph, timeZone: ledger.zone,
            observedAtUtc: utcInstant(new Date(state.clock())) };
    }

    function _manualTime() {
        const local = _value('manual-local');
        const date = _value('manual-date');
        if (local) return { local };
        if (date) return { date };
        throw new Error('请填写成交时刻或日期');
    }

    function _manualPackage(ledger) {
        const { Forms } = modules();
        const context = _formsContext(ledger);
        const kind = _value('manual-kind');
        const contractId = _value('manual-contract');
        const base = { time: _manualTime(), note: _value('manual-note') };
        switch (kind) {
        case 'futures_trade':
            return Forms.futuresTrade(Object.assign(base, {
                contract: contractId ? { contractId } : { month: _value('manual-month'), localSymbol: _value('manual-symbol') },
                quantity: _value('manual-quantity'), price: _value('manual-price'), fees: _value('manual-fees') || 0,
                openClose: _value('manual-open-close') || null }), context);
        case 'option_trade':
            return Forms.optionTrade(Object.assign(base, {
                contract: contractId ? { contractId } : { right: _value('manual-right'), strike: _value('manual-strike'),
                    expiry: _value('manual-expiry'), tradingClass: _value('manual-class'),
                    localSymbol: _value('manual-symbol'), future: { contractId: _value('manual-future') } },
                quantity: _value('manual-quantity'), price: _value('manual-price'), fees: _value('manual-fees') || 0,
                openClose: _value('manual-open-close') || null }), context);
        case 'assignment':
        case 'exercise':
            return Forms.delivery(Object.assign(base, { optionContractId: contractId, kind,
                contracts: _value('manual-quantity'), fees: _value('manual-fees') || 0 }), context);
        case 'expiry':
            return Forms.expiry(Object.assign(base, { optionContractId: contractId,
                contracts: _value('manual-quantity'), fees: _value('manual-fees') || 0 }), context);
        case 'fee':
            return Forms.fee(Object.assign(base, { category: _value('manual-fee-category'),
                amount: _value('manual-fee-amount'), refund: Boolean($('manual-fee-refund').checked),
                feeSourceEventId: _value('manual-fee-source') || null }), context);
        default:
            throw new Error('请选择记账种类');
        }
    }

    // Every input of the manual form: a change retires the preview (plan §19 P5-C5).
    const MANUAL_FIELDS = Object.freeze(['manual-kind', 'manual-contract', 'manual-month', 'manual-symbol',
        'manual-right', 'manual-strike', 'manual-expiry', 'manual-class', 'manual-future', 'manual-quantity',
        'manual-price', 'manual-fees', 'manual-fee-category', 'manual-fee-amount', 'manual-fee-refund',
        'manual-fee-source', 'manual-local', 'manual-date', 'manual-open-close', 'manual-note']);

    function _manualFingerprint(ledger) {
        return JSON.stringify([ledger.zone].concat(MANUAL_FIELDS.map((id) => {
            const node = $(id);
            if (!node) return '';
            return node.type === 'checkbox' ? Boolean(node.checked) : String(node.value || '');
        })));
    }

    function _clearManualPreview(text) {
        const ledger = state.ledger;
        const had = Boolean(ledger && ledger.manual);
        if (ledger) ledger.manual = null;
        const node = $('manual-preview-result');
        if (node) node.hidden = true;
        if (text && had) _status('manual-status', text);
    }

    /**
     * The manual package as it would be recorded, replayed in memory: the
     * events, the positions they move and the totals before and after. The
     * request is built here, once, with its token and version; only this
     * request is sent on confirmation, and only while nothing changed.
     */
    function _previewManual() {
        const ledger = state.ledger;
        try {
            if (!ledger || !ledger.graph) throw new Error('请先读取账本');
            const { Forms, View } = modules();
            const fopPackage = _manualPackage(ledger);
            const context = _formsContext(ledger);
            const quoteState = ledger.model && ledger.model.quoteState;
            const preview = Forms.manualPreview(ledger.graph, fopPackage, quoteState && quoteState.usable
                ? quoteState.marks : {});
            if (preview.stopped) {
                _clearManualPreview();
                _status('manual-status', `预览停止：${preview.reason}`);
                return;
            }
            ledger.manual = {
                message: Forms.appendRequest(fopPackage, context, { requestId: token('req'),
                    clientToken: token('manual'), expectedLedgerVersion: ledger.version,
                    bookIdentity: identityOf(ledger.book) }),
                version: ledger.version, fingerprint: _manualFingerprint(ledger), preview,
            };
            _table($('manual-preview-events'), ['种类', '合约', '数量', '交割期货', '价格', '费用', '现金', '时间'],
                preview.events.map((event) => [View.KIND_LABELS[event.kind] || event.kind, event.contract, event.quantity,
                    event.delivered ? `${event.delivered} ${event.futureContracts > 0 ? '+' : ''}${event.futureContracts}` : '—',
                    event.price === null ? '—' : event.price, event.fees, event.cash, timeText(event.time)]), '');
            _table($('manual-preview-positions'), ['合约', '之前', '之后'],
                preview.rows.map((row) => [row.localSymbol, row.before, row.after]), '不改变任何持仓。');
            const pair = (name, label) => [label, View.metricText(preview.before.totals[name]),
                View.metricText(preview.after.totals[name])];
            _table($('manual-preview-totals'), ['项目', '之前', '之后'], [pair('Rf', '期货已实现（Rf）'),
                pair('Co', '期权净现金（Co）'), pair('E', '费用（E）'), pair('J', '经济调整（J）'),
                pair('economicPnl', '完整经济盈亏')], '');
            $('manual-preview-result').hidden = false;
            _status('manual-status', `已预览，尚未写入。${preview.created.length ? `将新增合约：${preview.created.join('、')}。` : ''}`
                + '核对后点“确认记入”；改动任何输入、账户时区或账本变化都会作废这次预览。');
        } catch (error) {
            _clearManualPreview();
            _status('manual-status', `不能预览：${error.message}`);
        }
    }

    async function _submitManual() {
        try {
            const ledger = _writeContext();
            const manual = ledger.manual;
            if (!manual) throw new Error('请先预览');
            if (manual.version.digest !== ledger.version.digest) throw new Error('账本已在预览后变化；请重新预览');
            if (manual.fingerprint !== _manualFingerprint(ledger)) throw new Error('输入已在预览后改变；请重新预览');
            _status('manual-status', '正在记入账本…');
            const result = await _send('append_cost_basis_event', manual.message);
            if (ledger.manual === manual) _clearManualPreview();
            await _afterWrite('manual-status', `已记入 ${result.event ? result.event.eventId : ''}（人工核实）`
                + `${result.idempotentReplay ? '（重复确认，按第一次的结果）' : ''}。`);
        } catch (error) {
            _status('manual-status', `未记入：${_refusal(error)}`);
        }
    }

    function _toggleManualFields() {
        const kind = _value('manual-kind');
        const nodes = globalScope.document.querySelectorAll ? globalScope.document.querySelectorAll('[data-kinds]') : [];
        for (const node of nodes) {
            node.hidden = String(node.getAttribute('data-kinds') || '').split(/\s+/).indexOf(kind) < 0;
        }
    }

    async function _submitVoid() {
        try {
            const ledger = _writeContext();
            const { Forms } = modules();
            const eventId = _value('void-event');
            if (!eventId) throw new Error('请选择要冲销的事件');
            const message = Forms.voidRequest(eventId, _value('void-reason'), _formsContext(ledger),
                _requestBase(ledger, token('void')));
            await _send('void_cost_basis_event', message);
            await _afterWrite('ledger-status', `已冲销 ${eventId}。`);
        } catch (error) {
            _status('ledger-status', `未冲销：${_refusal(error)}`);
        }
    }

    async function _submitCycle(kind) {
        try {
            const ledger = _writeContext();
            const { Forms } = modules();
            let operation;
            if (kind === 'close') {
                const anchorEventId = _value('cycle-anchor');
                if (!anchorEventId) throw new Error('请选择使全部仓位归零的事件');
                operation = { kind: 'close_cycle', boundaryId: token('cycle'), anchorEventId,
                    label: _value('cycle-label') };
            } else {
                const boundaryId = _value('cycle-revoke-id');
                if (!boundaryId) throw new Error('请选择要撤销的周期边界');
                operation = { kind: 'revoke_cycle', boundaryId };
            }
            await _send('commit_cost_basis_fop_metadata', Forms.metadataRequest(operation, _formsContext(ledger),
                _requestBase(ledger, token('meta'))));
            await _afterWrite('ledger-status', kind === 'close' ? '已结束当前周期。' : '已撤销周期边界。');
        } catch (error) {
            _status('ledger-status', `周期未改变：${_refusal(error)}`);
        }
    }

    // ------------------------------------------------------------------
    // Statement import into the ledger
    // ------------------------------------------------------------------

    function _planImport() {
        const ledger = state.ledger;
        const { Import } = modules();
        const file = ledger && ledger.importFile;
        if (!ledger || !ledger.graph || !file) return;
        const features = state.fopFeatures;
        if (!features || !features.importCapabilities) {
            _status('import-status', '后端没有提供报表行类型清单，无法导入。');
            return;
        }
        try {
            const statement = Import.readStatement(file.text, { capabilities: features.importCapabilities,
                fileName: file.name });
            const confirm = $('import-confirm-account').checked && statement.account
                ? { sourceAccount: statement.account, targetAccount: ledger.book.account } : null;
            const plan = Import.planImport(statement, {
                book: ledger.book, graph: ledger.graph, coverage: ledger.batches, timeZone: ledger.zone || null,
                observedAtUtc: utcInstant(new Date(state.clock())), accountConfirmation: confirm,
                baselinePrices: parseBaselinePrices($('import-baseline').value),
                duplicateDecisions: [...ledger.importDecisions.values()],
            });
            ledger.importPlan = { plan, version: ledger.version, file };
            const view = planView(plan, file.name);
            _renderPlan('import', view);
            _renderDuplicateReviews(plan);
            _renderBindingUpgrades(plan);
            _renderRealizedComparison(plan);
            const undecided = plan.duplicateReviews.filter((review) => review.status !== 'same'
                && review.status !== 'distinct').length;
            _status('import-status', plan.blocking
                ? `有 ${view.problems.length} 个阻断问题，不能导入。`
                    + (undecided ? `其中 ${undecided} 行疑似重复，需逐行核实后重新预览。` : '')
                : (view.synthetic ? '没有阻断问题。报表经济行的格式尚未经真实样本验收：需逐行人工认领后才能写入。'
                    : '没有阻断问题，可以确认导入。'));
        } catch (error) {
            ledger.importPlan = null;
            $('import-result').hidden = true;
            _status('import-status', `无法预览：${error.message}`);
        }
    }

    /**
     * The statement's realized P&L beside the ledger's (plan §19 P5-C4): the
     * ledger with this statement's new events, rebuilt on the statement's
     * basis, contract by contract, for its account and period.
     */
    function _renderRealizedComparison(plan) {
        const ledger = state.ledger;
        const { Import, Core, Reconcile, View } = modules();
        const node = $('import-realized');
        const evidence = plan.realizedEvidence || [];
        if (!evidence.length || !plan.timeZone || !plan.period.from) {
            _table(node, [], [], '报表没有逐行的已实现盈亏列：没有可对照的值。');
            _text($('import-realized-note'), '');
            return;
        }
        const graph = Import.previewGraph(ledger.graph, plan, ledger.book);
        const rows = Reconcile.realizedComparison({ graph,
            order: Core.computeLedger(graph, { trace: true, rolls: false }).order, evidence,
            period: plan.period, zone: plan.timeZone.name, localDay: Import.localDay });
        _text($('import-realized-note'), `账户 ${plan.account}，期间 ${plan.period.from} 至 ${plan.period.through}，`
            + '逐合约对照。账本按报表口径（FIFO 批次、含佣金）重算，账本自身口径（加权平均，期货不含费用）并列；'
            + '报表值只作旁证，不覆盖 Rf，也不生成收益事件。');
        _table(node, ['合约', '报表已实现', '账本（报表口径）', '账本（自身口径）', '差额', '对照', '说明', '报表行', '账本事件'],
            rows.map((row) => [row.localSymbol,
                row.statementRealized === null ? '缺值' : View.priceText(row.statementRealized),
                View.priceText(row.ledgerFifo), View.priceText(row.ledgerOwn),
                row.difference === null ? '—' : View.priceText(row.difference),
                Reconcile.COMPARISON_LABELS[row.status], row.reason, row.lines.join('、') || '—',
                row.events.join('、') || '—']), '');
        ledger.importPlan.realized = rows;
    }

    /** The possible duplicates of the plan on screen, each with its decision and check. */
    const EVIDENCE_ROLES = Object.freeze({ option: '期权行', option_instrument: '期权合约信息', future: '期货行',
        future_instrument: '期货合约信息' });

    /**
     * The stored unresolved bindings this file proves (plan §4.3): which
     * future each option delivers and the rows that show it. Adopted only
     * by an explicit confirmation (_adoptStatementBindings).
     */
    function _renderBindingUpgrades(plan) {
        const upgrades = plan.bindingUpgrades || [];
        $('import-upgrades-block').hidden = !upgrades.length;
        _table($('import-upgrades'), ['期权', '本文件证明的期货', '账本中的绑定', '依据'], upgrades.map((item) => [
            item.option.localSymbol || item.option.contractId,
            `${item.future.localSymbol || item.future.contractId}（交割月 ${item.future.futureContractMonth}）`,
            '待补全', item.evidence.rows.map((row) => EVIDENCE_ROLES[row.role] || row.role).join('、'),
        ]), '');
    }

    /**
     * Adopt the bindings this file proves, then preview it again. The server
     * reads the rows itself and signs each pair it proves; each adoption is
     * one versioned metadata commit (no economic row changes); the same file
     * is then previewed against the version they leave. Nothing is adopted
     * from a preview of another version, and a repeated click asks once.
     * The commits land one by one: a refusal part way keeps the ones before
     * it, so the page reads the ledger again either way and says how many
     * were adopted and which one was not.
     */
    async function _adoptStatementBindings() {
        let ledger = null;
        try {
            ledger = _writeContext();
            const planned = ledger.importPlan;
            if (!planned || !(planned.plan.bindingUpgrades || []).length) throw new Error('这份报表没有可采纳的绑定');
            if (ledger.adoptingUpgrades) return;
            if (planned.version.digest !== ledger.version.digest) throw new Error('账本已在预览后变化；请重新预览');
            ledger.adoptingUpgrades = true;
            const { Import, Forms } = modules();
            const upgrades = planned.plan.bindingUpgrades;
            _status('import-status', '正在请求报表绑定凭据…');
            const answer = await client.request('request_cost_basis_fop_statement_bindings', { bookId: ledger.bookId,
                bindings: upgrades.map((item) => ({ bindingId: item.bindingId, option: item.option, future: item.future,
                    evidence: item.evidence })) });
            if (state.ledger !== ledger || ledger.importPlan !== planned) return;
            const { operations, refused } = Import.bindingUpgradeAdoptions(planned.plan, ledger.graph, ledger.book,
                answer.results);
            if (refused.length) {
                throw new Error(`服务器没有确认报表证明了这些绑定：${refused.map((item) => (item.problems || [])
                    .join('；')).join('；')}`);
            }
            let version = ledger.version;
            let adopted = 0;
            let stopped = null;
            for (const operation of operations) {
                try {
                    const message = Forms.metadataRequest(operation, _formsContext(ledger), { requestId: token('req'),
                        clientToken: token('adopt'), expectedLedgerVersion: version,
                        bookIdentity: identityOf(ledger.book) });
                    const result = await _send('commit_cost_basis_fop_metadata', message);
                    version = result.ledgerVersion;
                    adopted += 1;
                } catch (error) {
                    const upgrade = upgrades.find((item) => item.bindingId === operation.binding.bindingId);
                    stopped = { error, option: upgrade.option.localSymbol || upgrade.option.contractId };
                    break;
                }
            }
            const { file } = planned;
            const decisions = ledger.importDecisions;
            await _afterWrite('import-status', stopped
                ? `已采纳 ${adopted} 个报表证明的绑定（共 ${operations.length} 个），正在重新读取账本…`
                : `已采纳 ${operations.length} 个报表证明的绑定，正在按新版本重新预览…`);
            if (state.ledger === ledger) {
                ledger.importFile = file;
                ledger.importDecisions = decisions;
                _planImport();
                if (stopped) {
                    _status('import-status', `已采纳 ${adopted} 个报表证明的绑定（共 ${operations.length} 个）；`
                        + `${stopped.option} 未采纳：${_refusal(stopped.error)}。已按账本的当前版本重新预览。`);
                }
            }
        } catch (error) {
            _status('import-status', `未采纳：${_refusal(error)}`);
        } finally {
            if (ledger) ledger.adoptingUpgrades = false;
        }
    }

    function _renderDuplicateReviews(plan) {
        const ledger = state.ledger;
        const block = $('import-duplicates-block');
        const node = $('import-duplicates');
        _clear(node);
        ledger.duplicateControls = new Map();
        const reviews = (plan.duplicateReviews || []).map(duplicateReviewView);
        if (block) block.hidden = !reviews.length;
        for (const review of reviews) {
            const item = globalScope.document.createElement('div');
            item.className = 'fop-review';
            item.appendChild(_cell('p', `${review.row} — ${review.status}`));
            const table = globalScope.document.createElement('div');
            _table(table, ['候选事件', '合约', '数量', '价格', '费用', '现金', '时间', '来源'], review.candidates, '');
            item.appendChild(table);
            if (review.decidable) {
                const form = globalScope.document.createElement('div');
                form.className = 'fop-inline';
                const select = globalScope.document.createElement('select');
                select.dataset.sourceKey = review.sourceKey;
                for (const [value, label] of review.options) select.appendChild(_option(value, label));
                select.value = review.current;
                const attestation = globalScope.document.createElement('input');
                attestation.type = 'text';
                attestation.dataset.sourceKey = review.sourceKey;
                attestation.placeholder = '核对依据（必填），如：券商成交确认单显示两笔';
                attestation.value = review.attestation;
                form.appendChild(select);
                form.appendChild(attestation);
                item.appendChild(form);
                ledger.duplicateControls.set(review.sourceKey, { review, select, attestation });
            }
            node.appendChild(item);
        }
    }

    /** Preview again with the decisions the user chose (nothing is sent). */
    function _decideDuplicates() {
        const ledger = state.ledger;
        if (!ledger || !ledger.importPlan) return;
        const decisions = new Map();
        for (const [key, control] of ledger.duplicateControls) {
            const value = control.select.value;
            if (!value) continue;
            const review = control.review;
            decisions.set(key, {
                namespace: review.namespace, sourceRef: review.sourceRef,
                decision: value === 'distinct' ? 'distinct_fill' : 'same_fill',
                eventIds: value === 'distinct' ? review.candidateIds.slice() : [value.slice('same:'.length)],
                attestation: String(control.attestation.value || '').trim(),
            });
        }
        ledger.importDecisions = decisions;
        _planImport();
    }

    async function _readImportFile() {
        const ledger = state.ledger;
        if (!ledger) return;
        try {
            const file = await _readFile($('import-file'));
            if (!file || state.ledger !== ledger) return;
            ledger.importFile = file;
            ledger.importDecisions = new Map();
            _planImport();
        } catch (error) {
            _status('import-status', `无法读取文件：${error.message}`);
        }
    }

    async function _sha256(text) {
        const subtle = globalScope.crypto && globalScope.crypto.subtle;
        if (!subtle || !globalScope.TextEncoder) throw new Error('浏览器不支持 SHA-256，无法登记文件摘要');
        const digest = await subtle.digest('SHA-256', new globalScope.TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Send the previewed statement: statement binding credentials first, the
     * user's claims, then one request per batch, the first against the
     * version the preview was planned on and each later one against the
     * version the previous one left. A preview the page has retired, or one
     * planned against another version, is never sent: it is checked again
     * after the last wait, right before the first request (F23).
     */
    async function _submitImport() {
        const { Import } = modules();
        let ledger;
        try {
            ledger = _writeContext();
            const planned = ledger.importPlan;
            if (!planned) throw new Error('请先选择报表并预览');
            const stillPlanned = () => {
                if (state.ledger !== ledger || ledger.importPlan !== planned
                    || ledger.version.digest !== planned.version.digest) {
                    throw new Error('账本已在预览后变化；请重新预览');
                }
            };
            stillPlanned();
            let plan = planned.plan;
            if (plan.blocking) throw new Error('预览有阻断问题');
            if (plan.bindingRequests.length) {
                _status('import-status', '正在请求报表绑定凭据…');
                const answer = await client.request('request_cost_basis_fop_statement_bindings', {
                    bookId: ledger.bookId, bindings: plan.bindingRequests.map((item) => ({ bindingId: item.bindingId,
                        option: item.option, future: item.future, evidence: item.evidence })) });
                const credentials = {};
                for (const result of answer.results || []) {
                    if (result.status !== 'verified_statement') {
                        throw new Error(`绑定 ${result.bindingId} 未获报表验证：${(result.problems || []).join('；')}`);
                    }
                    credentials[result.bindingId] = result.evidenceCredential;
                }
                plan = Import.withCredentials(plan, credentials);
            }
            if ($('import-claim').checked) {
                const attestation = _value('import-attestation');
                if (!attestation) throw new Error('认领需要写明核对说明');
                const lines = plan.rows.filter((row) => row.disposition === 'event' && row.status === 'synthetic_only')
                    .map((row) => row.line);
                plan = Import.claimRows(plan, lines, attestation);
            }
            const fileSha256 = await _sha256(planned.file.text);
            stillPlanned();
            const batches = plan.events.length > IMPORT_BATCH_EVENTS ? Import.splitPlan(plan, IMPORT_BATCH_EVENTS)
                : [{ from: plan.period.from, through: plan.period.through, plan }];
            let version = planned.version;
            let inserted = 0;
            for (const [index, batch] of batches.entries()) {
                _status('import-status', `正在导入第 ${index + 1}/${batches.length} 批…`);
                const message = Import.buildImportRequest(batch.plan, {
                    requestId: token('req'), bookId: ledger.bookId, expectedLedgerVersion: version,
                    bookIdentity: identityOf(ledger.book), importBatchId: token('batch'),
                    clientTokenPrefix: token('import'), fileSha256, fileName: planned.file.name,
                    periodFrom: batch.from, periodThrough: batch.through, engineVersion: ledger.book.fop.engineVersion,
                });
                const result = await _send('import_cost_basis_events', message);
                version = result.ledgerVersion;
                inserted += result.inserted || 0;
            }
            ledger.importPlan = null;
            $('import-result').hidden = true;
            await _afterWrite('import-status', `导入完成：新增 ${inserted} 条流水，登记报表期间 `
                + `${plan.period.from} 至 ${plan.period.through}。`);
        } catch (error) {
            _status('import-status', `未导入：${_refusal(error)}`);
        }
    }

    // ------------------------------------------------------------------
    // TWS positions and reconciliation snapshots (plan §10.3, §19 P5-C3)
    // ------------------------------------------------------------------

    function _trace(ledger) {
        const { Core } = modules();
        if (!ledger.trace || ledger.trace.digest !== ledger.version.digest) {
            ledger.trace = { digest: ledger.version.digest,
                value: Core.computeLedger(ledger.graph, { trace: true, rolls: false }) };
        }
        return ledger.trace.value;
    }

    function _reconciliation(ledger) {
        const { Reconcile } = modules();
        return Reconcile.reconcile({ output: ledger.model.output, trace: _trace(ledger), graph: ledger.graph,
            evidence: ledger.positions, ledgerVersion: ledger.version });
    }

    /** The comparison on screen: four states apart, and one row per contract. */
    function _renderReconcile() {
        const ledger = state.ledger;
        if (!ledger || !ledger.model) return;
        const { Reconcile, View } = modules();
        const result = _reconciliation(ledger);
        const coverage = ledger.model.integrity;
        _table($('reconcile-summary'), ['项目', '状态', '说明'], [
            ['数量（Qty）', Reconcile.QUANTITY_LABELS[result.quantityStatus], result.reason
                || (result.reconciled ? '每张合约的账本数量与 TWS 一致' : '')],
            ['AvgCost', Reconcile.AVG_COST_LABELS[result.avgCostStatus], '只是旁证，不决定是否已对账'],
            ['期权绑定', result.binding === 'complete' ? '完整' : '不完整',
                (coverage.find((item) => item.name === '期权绑定') || {}).detail || ''],
            ['现金', '未核对', '首版不做资金对账'],
        ], '');
        _table($('reconcile-table'), ['合约', '账本数量', 'TWS 数量', '数量', '账本均价', 'TWS AvgCost（换算）', 'AvgCost',
            '说明'], result.rows.map((row) => [row.localSymbol,
            row.ledgerQuantity === null ? '未知' : row.ledgerQuantity, row.twsQuantity,
            Reconcile.QUANTITY_LABELS[row.quantityStatus], View.priceText(row.ledgerAverage),
            View.priceText(row.twsAverage), Reconcile.AVG_COST_LABELS[row.avgCostStatus], row.note]),
        result.state === 'fresh' ? '账本与 TWS 都没有持仓。' : '');
        return result;
    }

    async function _readPositions() {
        const ledger = state.ledger;
        if (!ledger || !ledger.graph) return;
        state.positionsGeneration += 1;
        const generation = state.positionsGeneration;
        _status('reconcile-status', '正在读取 TWS 持仓（只读）…');
        try {
            const answer = await client.request('request_cost_basis_fop_positions', { bookId: ledger.bookId });
            if (state.ledger !== ledger || generation !== state.positionsGeneration) return;
            ledger.positions = answer;
            const result = _renderReconcile();
            _status('reconcile-status', result.state === 'fresh'
                ? `已读取 ${answer.positions.length} 条持仓（${answer.observedAtUtc.replace('T', ' ').slice(0, 19)} UTC，`
                    + `账本版本 ${answer.ledgerVersion.digest.slice(0, 12)}）：${result.reconciled ? '数量全部一致'
                        : modules().Reconcile.QUANTITY_LABELS[result.quantityStatus]}。`
                : result.reason);
        } catch (error) {
            if (state.ledger !== ledger || generation !== state.positionsGeneration) return;
            _status('reconcile-status', error.code === 'fop_positions_unavailable'
                ? '这个后端没有 TWS 持仓（例如历史回放后端）：不能实时对账，也不会声称已对账。'
                : `读取持仓失败：${_refusal(error)}`);
        }
    }

    /**
     * Save what the page shows as a snapshot of this version: the version,
     * the quote batch and quotes, the completeness states and, when positions
     * were read for this version, them with every comparison. It changes no
     * economic row; the server holds a "reconciled" claim to the positions.
     */
    async function _saveSnapshot() {
        let ledger;
        try {
            ledger = _writeContext();
            if (ledger.savingSnapshot) return;
            const { Reconcile } = modules();
            const reconciliation = _reconciliation(ledger);
            const parts = Reconcile.snapshotParts({ ledgerVersion: ledger.version, quoteState: ledger.model.quoteState,
                integrity: ledger.model.integrity, evidence: ledger.positions, reconciliation });
            ledger.savingSnapshot = true;
            _status('snapshot-status', '正在保存快照…');
            const answer = await client.request('save_cost_basis_snapshot', {
                bookId: ledger.bookId, expectedLedgerVersion: ledger.version, bookIdentity: identityOf(ledger.book),
                asOfDate: ledger.model.today, summary: parts.summary, accountScope: ledger.book.account,
                twsSnapshot: parts.twsSnapshot, reconciled: parts.reconciled, note: _value('snapshot-note') });
            _status('snapshot-status', `已保存快照 ${answer.snapshot.snapshotId.slice(0, 12)}`
                + `${answer.idempotentReplay ? '（与上一份相同，未重复保存）' : ''}：`
                + `${answer.snapshot.reconciled ? '数量已与 TWS 对上' : '未对账（没有一致的持仓证据）'}；经济流水未改变。`);
            await _loadSnapshots(ledger);
        } catch (error) {
            _status('snapshot-status', `未保存：${_refusal(error)}`);
        } finally {
            if (ledger) ledger.savingSnapshot = false;
        }
    }

    async function _loadSnapshots(ledger) {
        try {
            const answer = await client.request('list_cost_basis_snapshots', { bookId: ledger.bookId, limit: 20 });
            if (state.ledger !== ledger) return;
            ledger.snapshots = answer.snapshots || [];
            _renderSnapshots();
        } catch (_) {
            // The list is a convenience; the ledger view stands without it.
        }
    }

    function _renderSnapshots() {
        const ledger = state.ledger;
        if (!ledger) return;
        const { Reconcile } = modules();
        const rows = ledger.snapshots.map((item) => {
            const positions = item.twsSnapshot;
            return [item.takenAtUtc.replace('T', ' ').replace('Z', ' UTC'), item.eventsSha256.slice(0, 12),
                item.summary && item.summary.quoteBatchId ? item.summary.quoteBatchId.slice(0, 18) : '无报价',
                positions ? Reconcile.QUANTITY_LABELS[positions.quantityStatus] : '未读取持仓',
                positions ? Reconcile.AVG_COST_LABELS[positions.avgCostStatus] : '—',
                item.reconciled ? '是' : '否', item.note || ''];
        });
        _table($('snapshot-list'), ['保存时间', '账本版本', '报价批次', '数量', 'AvgCost', '已对账', '备注'], rows,
            '还没有保存的快照。');
        _fillSelect($('snapshot-pick'), ledger.snapshots.map((item) => [item.snapshotId,
            `${item.takenAtUtc.replace('T', ' ').replace('Z', '')} · ${item.eventsSha256.slice(0, 8)}`]), '选择一份快照');
        _renderSnapshotDetail();
    }

    /** One saved snapshot as it was: its version against today's, quotes, completeness and every comparison. */
    function _renderSnapshotDetail() {
        const ledger = state.ledger;
        const node = $('snapshot-detail');
        _clear(node);
        if (!ledger) return;
        const snapshot = ledger.snapshots.find((item) => item.snapshotId === _value('snapshot-pick'));
        if (!snapshot) return;
        const { Reconcile, View } = modules();
        const current = ledger.version && snapshot.eventsSha256 === ledger.version.digest;
        node.appendChild(_cell('p', current ? '这份快照对应当前账本版本。'
            : `这份快照是旧版本的历史记录（快照版本 ${snapshot.eventsSha256.slice(0, 12)}，当前 `
                + `${ledger.version ? ledger.version.digest.slice(0, 12) : '—'}）：它当时的匹配结论不代表现在。`));
        const completeness = snapshot.summary.completeness;
        const states = { complete: '完整', incomplete: '不完整', not_checked: '未核对' };
        const facts = globalScope.document.createElement('div');
        _table(facts, ['项目', '状态'], [['数量', states[completeness.quantity]], ['期初成本', states[completeness.openingCost]],
            ['期权绑定', states[completeness.binding]], ['行情', states[completeness.marketData]],
            ['报表覆盖', states[completeness.coverage]], ['现金', states[completeness.cash]],
            ['报价批次', snapshot.summary.quoteBatchId || '无'], ['已对账', snapshot.reconciled ? '是' : '否']], '');
        node.appendChild(facts);
        const quotes = globalScope.document.createElement('div');
        _table(quotes, ['合约', 'bid', 'ask', '估值价', '来源', '日期'], snapshot.summary.quotes.map((quote) => [
            quote.contractId, View.priceText(quote.bid), View.priceText(quote.ask), View.priceText(quote.mark),
            quote.markSource, quote.referenceDate || '']), '快照没有报价。');
        node.appendChild(quotes);
        const rows = globalScope.document.createElement('div');
        const positions = snapshot.twsSnapshot;
        _table(rows, ['合约', '账本数量', 'TWS 数量', '数量', 'AvgCost', '说明'], positions ? positions.rows.map((row) => [
            row.localSymbol, row.ledgerQuantity === null ? '未知' : row.ledgerQuantity, row.twsQuantity,
            Reconcile.QUANTITY_LABELS[row.quantityStatus], Reconcile.AVG_COST_LABELS[row.avgCostStatus], row.note])
            : [], positions ? '没有持仓。' : '保存时没有读取 TWS 持仓。');
        node.appendChild(rows);
    }

    // ------------------------------------------------------------------
    // Binding evidence (plan §4.3, §19 P5-C2): query, preview, adopt
    // ------------------------------------------------------------------

    // Bindings the broker may be asked about: not yet proven by it or a statement.
    const QUERYABLE_BINDINGS = Object.freeze(new Set(['unresolved', 'conflict', 'manual_attested']));

    /** The broker's answer and the adoption it allows, as the page lists them before a confirmation. */
    function _renderBinding() {
        const ledger = state.ledger;
        const node = $('binding-result');
        _clear(node);
        const confirm = $('binding-confirm');
        if (confirm) confirm.hidden = true;
        const binding = ledger && ledger.binding;
        if (!binding) return;
        const result = binding.result;
        const terms = (record) => (record ? [record.localSymbol || '—', record.conId || '—',
            record.secType === 'FUT' ? `交割月 ${record.futureContractMonth}，最后交易日 ${record.futureLastTradeDate || '未知'}`
                : `${record.optionRight} ${record.optionStrike} 到期 ${record.optionExpiry}`] : ['—', '—', '—']);
        const block = globalScope.document.createElement('div');
        _table(block, ['', '本地代码', 'conId', '条款'], [['期权（券商）'].concat(terms(result && result.option)),
            ['对应期货（券商）'].concat(terms(result && result.future))], '');
        node.appendChild(block);
        if (binding.plan.stopped) {
            _status('binding-status', `不能采纳：${binding.plan.reason}`);
            return;
        }
        const changes = globalScope.document.createElement('div');
        _table(changes, ['变更', '内容'], binding.plan.changes, '');
        node.appendChild(changes);
        const affected = globalScope.document.createElement('div');
        _table(affected, ['事件', '引用', '修订前', '修订后'], binding.plan.affected.map((item) => [item.eventId,
            { contract: '合约', delivered_contract: '交割期货', binding: '绑定' }[item.reference] || item.reference,
            `${item.before.id} r${item.before.revision}`, `${item.after.id} r${item.after.revision}`]),
        '没有已记账事件引用会被改动（只新增修订，不改经济流水）。');
        node.appendChild(affected);
        if (confirm) confirm.hidden = false;
        _status('binding-status', '券商已证明对应期货。核对以上变更后确认采纳；采纳只写合约与绑定修订，不改经济流水。');
    }

    async function _queryBinding() {
        const ledger = state.ledger;
        if (!ledger || !ledger.graph) return;
        const { Forms, View } = modules();
        const contractId = _value('binding-option');
        if (!contractId) {
            _status('binding-status', '请选择期权');
            return;
        }
        const record = View.currentRecords(ledger.graph).get(contractId);
        state.bindingGeneration += 1;
        const generation = state.bindingGeneration;
        ledger.binding = null;
        _renderBinding();
        _status('binding-status', '正在向券商查询（只读，不写入）…');
        try {
            const answer = await client.request('request_cost_basis_fop_contract_details',
                { bookId: ledger.bookId, contracts: [record] });
            if (state.ledger !== ledger || generation !== state.bindingGeneration) return;
            const result = (answer.results || [])[0] || null;
            ledger.binding = { result, plan: Forms.bindingAdoption(ledger.graph, ledger.book, result),
                version: ledger.version, clientToken: token('adopt'), sending: false };
            _renderBinding();
        } catch (error) {
            if (state.ledger !== ledger || generation !== state.bindingGeneration) return;
            _status('binding-status', error.code === 'fop_contract_details_unavailable'
                ? '这个后端不能向券商查询合约（例如历史回放后端）；没有证据，也不会生成证据。'
                : `查询失败：${_refusal(error)}`);
        }
    }

    /**
     * Send the previewed adoption: the same operation, against the version
     * it was previewed on, with the token fixed at the preview so a repeated
     * confirmation is the same request (the server answers it once).
     */
    async function _adoptBinding() {
        let ledger;
        try {
            ledger = _writeContext();
            const binding = ledger.binding;
            if (!binding || binding.plan.stopped) throw new Error('请先向券商查询并核对预览');
            if (binding.version.digest !== ledger.version.digest) throw new Error('账本已在查询后变化；请重新查询');
            const { Forms } = modules();
            const message = Forms.metadataRequest(binding.plan.operation, _formsContext(ledger), {
                requestId: token('req'), clientToken: binding.clientToken, expectedLedgerVersion: binding.version,
                bookIdentity: identityOf(ledger.book) });
            _status('binding-status', '正在采纳…');
            const result = await _send('commit_cost_basis_fop_metadata', message);
            ledger.binding = null;
            _renderBinding();
            await _afterWrite('binding-status', `已采纳：${result.operation ? result.operation.operationId : ''}`
                + `${result.idempotentReplay ? '（重复确认，按第一次的结果）' : ''}。报价与预览已按新版本作废。`);
        } catch (error) {
            _status('binding-status', `未采纳：${_refusal(error)}`);
        }
    }

    // ------------------------------------------------------------------
    // Delivery preview (plan §12.1): in memory only, nothing is sent
    // ------------------------------------------------------------------

    function _input(id, contractId, value, placeholder) {
        const input = globalScope.document.createElement('input');
        input.type = 'text';
        input.id = id;
        input.dataset.contractId = contractId;
        input.value = value;
        input.placeholder = placeholder;
        return input;
    }

    /**
     * The delivery inputs: per open option a result and a quantity, per FUT
     * an assumed price. Rebuilt only when the ledger is read again; what the
     * user chose or typed stays for the options and FUTs still there (a
     * quantity only while the option's open quantity is the same).
     */
    function _renderDeliveryInputs(model) {
        const ledger = state.ledger;
        const { View } = modules();
        const records = View.currentRecords(ledger.graph);
        const symbol = (id) => (records.has(id) ? records.get(id).localSymbol || id : id);
        const previous = ledger.deliveryControls || { choices: new Map(), prices: new Map() };
        const controls = { choices: new Map(), prices: new Map() };
        ledger.deliveryControls = controls;
        const choices = $('delivery-choices');
        _clear(choices);
        const open = model.output.options.filter((row) => row.contracts.value);
        if (!open.length) {
            choices.appendChild(_cell('p', '没有未平期权。'));
        } else {
            const table = globalScope.document.createElement('table');
            table.className = 'fop-table';
            const head = globalScope.document.createElement('tr');
            ['期权', '持仓张数', '对应期货', '假设结果', '张数'].forEach((label) => head.appendChild(_cell('th', label)));
            table.appendChild(head);
            for (const row of open) {
                const quantity = row.contracts.value;
                const line = globalScope.document.createElement('tr');
                line.appendChild(_cell('td', symbol(row.contractId)));
                line.appendChild(_cell('td', quantity));
                line.appendChild(_cell('td', row.boundFutureContractId ? symbol(row.boundFutureContractId) : '未绑定'));
                const select = globalScope.document.createElement('select');
                select.id = `delivery-choice-${row.contractId}`;
                select.dataset.contractId = row.contractId;
                select.appendChild(_option('', '不变'));
                select.appendChild(_option(quantity < 0 ? 'assign' : 'exercise', quantity < 0 ? '被指派' : '行权'));
                select.appendChild(_option('expire', '到期作废'));
                const count = _input(`delivery-count-${row.contractId}`, row.contractId, String(Math.abs(quantity)),
                    `1–${Math.abs(quantity)}`);
                Object.assign(count, { type: 'number', min: '1', max: String(Math.abs(quantity)), step: '1' });
                const kept = previous.choices.get(row.contractId);
                if (kept) {
                    if (Array.from(select.children).some((option) => option.value === kept.select.value)) {
                        select.value = kept.select.value;
                    }
                    if (kept.quantity === quantity) count.value = kept.count.value;
                }
                controls.choices.set(row.contractId, { select, count, quantity });
                for (const control of [select, count]) {
                    const cell = globalScope.document.createElement('td');
                    cell.appendChild(control);
                    line.appendChild(cell);
                }
                table.appendChild(line);
            }
            choices.appendChild(table);
        }
        const prices = $('delivery-prices');
        _clear(prices);
        const futures = new Set(model.output.futures.map((row) => row.contractId));
        for (const row of open) if (row.boundFutureContractId) futures.add(row.boundFutureContractId);
        if (futures.size) {
            const table = globalScope.document.createElement('table');
            table.className = 'fop-table';
            const head = globalScope.document.createElement('tr');
            ['期货', '假设价格'].forEach((label) => head.appendChild(_cell('th', label)));
            table.appendChild(head);
            for (const id of futures) {
                const line = globalScope.document.createElement('tr');
                line.appendChild(_cell('td', symbol(id)));
                const cell = globalScope.document.createElement('td');
                const kept = previous.prices.get(id);
                const input = _input(`delivery-price-${id}`, id, kept ? kept.value : '', '逐合约给价');
                controls.prices.set(id, input);
                cell.appendChild(input);
                line.appendChild(cell);
                table.appendChild(line);
            }
            prices.appendChild(table);
        }
    }

    function _deliveryInputs() {
        const controls = (state.ledger && state.ledger.deliveryControls) || { choices: new Map(), prices: new Map() };
        const prices = {};
        for (const [contractId, input] of controls.prices) {
            const text = String(input.value || '').trim();
            if (text === '') continue;
            const value = Number(text);
            if (!Number.isFinite(value)) throw new Error(`期货假设价格不是数字：${text}`);
            prices[contractId] = value;
        }
        // The quantity goes as typed; the preview says when it is not 1 to the open quantity.
        const choices = [...controls.choices].filter(([, control]) => control.select.value)
            .map(([contractId, control]) => ({ optionContractId: contractId, action: control.select.value,
                contracts: Number(String(control.count.value || '').trim()) }));
        return { prices, choices };
    }

    function _suggestDeliveries() {
        const ledger = state.ledger;
        if (!ledger || !ledger.model) return;
        try {
            const { Forms } = modules();
            const { prices } = _deliveryInputs();
            const controls = ledger.deliveryControls || { choices: new Map() };
            for (const suggestion of Forms.atExpiry(ledger.model.output, ledger.graph, prices)) {
                const control = controls.choices.get(suggestion.optionContractId);
                if (control && suggestion.action) control.select.value = suggestion.action;
            }
            _status('delivery-status', '已按假设价格给出到期结果（假设，不是券商实录）。');
        } catch (error) {
            _status('delivery-status', error.message);
        }
    }

    function _runDelivery() {
        const ledger = state.ledger;
        if (!ledger || !ledger.graph) return;
        const { Forms, Import, View } = modules();
        try {
            if (!ledger.zone) throw new Error('请先在上方填写账户时区');
            const { prices, choices } = _deliveryInputs();
            const local = _value('delivery-at');
            if (!local) throw new Error('请填写假设交割时刻');
            const converted = Import.localToUtc(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ? `${local}:00` : local,
                ledger.zone);
            if (converted.error) throw new Error(converted.error);
            const at = converted.instant || converted.range[1];
            const result = Forms.deliveryPreview(ledger.graph, ledger.book, choices, prices, at);
            ledger.delivery = result;
            const node = $('delivery-result');
            if (result.stopped) {
                _clear(node);
                _status('delivery-status', `预览停止：${result.reason}`);
                return;
            }
            _clear(node);
            const positions = globalScope.document.createElement('div');
            _table(positions, ['合约', '交割前', '交割后'], result.rows.map((row) => [row.localSymbol, row.before, row.after]),
                '');
            node.appendChild(positions);
            const totals = globalScope.document.createElement('div');
            const pair = (name, label, digits) => [label, View.metricText(result.before.totals[name], digits),
                View.metricText(result.after.totals[name], digits)];
            _table(totals, ['项目', '交割前', '交割后'], [
                pair('Rf', '期货已实现'), pair('Uf', '期货浮动'), pair('Vo', '期权市值'), pair('E', '费用'),
                pair('economicPnl', '完整经济盈亏'),
                ['卖方等效回本价', View.metricText(result.before.sellerLens.breakEven, 6),
                    View.metricText(result.after.sellerLens.breakEven, 6)],
            ], '');
            node.appendChild(totals);
            _status('delivery-status', `${result.label}。`);
        } catch (error) {
            _status('delivery-status', `预览停止：${error.message}`);
        }
    }

    // ------------------------------------------------------------------
    // Backup, restore, delete, create
    // ------------------------------------------------------------------

    async function _exportBackup() {
        const ledger = state.ledger;
        if (!ledger) return;
        try {
            const backup = await client.request('export_cost_basis_backup', { bookId: ledger.bookId });
            const envelope = { format: backup.format, version: backup.version, kind: backup.kind,
                sha256: backup.sha256, payload: backup.payload };
            const blob = new globalScope.Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
            const url = globalScope.URL.createObjectURL(blob);
            const link = globalScope.document.createElement('a');
            link.href = url;
            link.download = `cost-basis-fop-${ledger.book.symbol}-${ledger.bookId}.json`;
            globalScope.document.body.appendChild(link);
            link.click();
            link.remove();
            globalScope.setTimeout(() => globalScope.URL.revokeObjectURL(url), 1000);
            _status('backup-status', '备份已生成：含合约、绑定、原始来源、周期边界与请求记录。');
        } catch (error) {
            _status('backup-status', `导出失败：${error.message}`);
        }
    }

    async function _restoreBackup() {
        try {
            const ledger = _writeContext();
            const file = await _readFile($('restore-file'));
            if (!file) throw new Error('请选择备份文件');
            let backup;
            try {
                backup = JSON.parse(file.text);
            } catch (_) {
                throw new Error('备份文件不是 JSON');
            }
            const plan = await client.request('request_cost_basis_reset_plan', { bookId: ledger.bookId });
            const phrase = _value('restore-phrase');
            if (phrase !== plan.phrase) {
                _status('backup-status', `请在确认短语中输入：${plan.phrase}`);
                return;
            }
            await client.request('restore_cost_basis_backup', { bookId: ledger.bookId,
                expectedLedgerVersion: plan.ledgerVersion, bookIdentity: identityOf(ledger.book),
                engineVersion: ledger.book.fop.engineVersion, backup, confirmation: phrase,
                clientToken: token('restore') });
            $('restore-phrase').value = '';
            await _afterWrite('backup-status', '已从备份恢复；原历史已存档。原报表覆盖记录随原历史存档，需要时重新导入报表登记期间。');
        } catch (error) {
            _status('backup-status', `未恢复：${_refusal(error)}`);
        }
    }

    async function _deleteBook() {
        const ledger = state.ledger;
        if (!ledger) return;
        try {
            const plan = await client.request('request_cost_basis_delete_plan', { bookId: ledger.bookId });
            const phrase = _value('delete-phrase');
            if (phrase !== plan.phrase) {
                _status('backup-status', `永久删除前请在删除框中输入：${plan.phrase}`);
                return;
            }
            await client.request('delete_cost_basis_book', { bookId: ledger.bookId, confirmation: phrase,
                clientToken: token('delete') });
            state.ledger = null;
            _stopQuoteTimer();
            globalScope.location.replace('cost_basis_fop.html');
        } catch (error) {
            _status('backup-status', `未删除：${_refusal(error)}`);
        }
    }

    async function _createBook() {
        try {
            if (!_writesReleased()) throw new Error(WRITES_CLOSED);
            const fields = createBookRequest({ account: _value('create-account'), startDate: _value('create-start'),
                historyScope: _value('create-scope'), note: _value('create-note') }, state.fopFeatures);
            const result = await client.request('create_cost_basis_book', fields);
            globalScope.location.assign(common.bookUrl(result.book));
        } catch (error) {
            _status('create-status', `未建账：${_refusal(error)}`);
        }
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
            // Quotes of a lost connection are retired at once, never left on
            // screen as current nor re-aged into the next one.
            _dropQuotes('连接已断开：报价已作废，重连后请重新取报价。');
            if (state.ledger && state.ledger.positions) {
                state.ledger.positions = null;
                _renderReconcile();
                _status('reconcile-status', '连接已断开：持仓证据已作废，重连后请重新读取。');
            }
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
            _enableFeatures(status.features && status.features.fopLedger);
            const listed = await client.request('list_cost_basis_books');
            if (generation !== state.generation) return;
            state.books = Array.isArray(listed.books) ? listed.books : [];
            _render(describeView(state.books, state.bookId));
        } catch (error) {
            if (generation !== state.generation) return;
            _message(`读取账本目录失败：${error.message}`);
        }
    }

    function _on(id, type, handler) {
        const node = $(id);
        if (node && typeof node.addEventListener === 'function') node.addEventListener(type, handler);
    }

    function start() {
        state.bookId = common.bookIdFromSearch(globalScope.location && globalScope.location.search);
        _text($('stage-text'), STAGE_NOTICE);
        _show('loading-view');
        $('preview-file').disabled = true;
        _on('preview-file', 'change', () => { void _readPreviewFile(); });
        _on('preview-zone', 'change', _runPreview);
        _on('preview-scope', 'change', _runPreview);
        _on('ledger-reload', 'click', () => { void _loadLedger(); });
        _on('quote-refresh', 'click', () => { void _refreshQuotes(); });
        _on('ledger-zone', 'change', _setZone);
        _on('import-file', 'change', () => { void _readImportFile(); });
        _on('import-baseline', 'change', _planImport);
        _on('import-confirm-account', 'change', _planImport);
        _on('import-submit', 'click', () => { void _submitImport(); });
        _on('import-decide', 'click', _decideDuplicates);
        _on('import-adopt-upgrades', 'click', _adoptStatementBindings);
        _on('manual-kind', 'change', _toggleManualFields);
        for (const id of MANUAL_FIELDS) {
            const retire = () => _clearManualPreview('输入已改变，旧的预览已作废；请重新预览。');
            _on(id, 'input', retire);
            _on(id, 'change', retire);
        }
        _on('manual-preview', 'click', _previewManual);
        _on('manual-cancel', 'click', () => {
            _clearManualPreview('已取消，没有写入。');
        });
        _on('manual-submit', 'click', () => { void _submitManual(); });
        _on('void-submit', 'click', () => { void _submitVoid(); });
        _on('cycle-close', 'click', () => { void _submitCycle('close'); });
        _on('cycle-revoke', 'click', () => { void _submitCycle('revoke'); });
        _on('reconcile-read', 'click', () => { void _readPositions(); });
        _on('snapshot-save', 'click', () => { void _saveSnapshot(); });
        _on('snapshot-pick', 'change', _renderSnapshotDetail);
        _on('binding-query', 'click', () => { void _queryBinding(); });
        _on('binding-adopt', 'click', () => { void _adoptBinding(); });
        _on('delivery-suggest', 'click', _suggestDeliveries);
        _on('delivery-run', 'click', _runDelivery);
        _on('backup-export', 'click', () => { void _exportBackup(); });
        _on('restore-submit', 'click', () => { void _restoreBackup(); });
        _on('delete-submit', 'click', () => { void _deleteBook(); });
        _on('create-submit', 'click', () => { void _createBook(); });
        _toggleManualFields();
        connect();
    }

    globalScope.OptionComboCostBasisFopPage = Object.freeze({
        PAGE,
        STAGE_NOTICE,
        LEGACY_STATE,
        FOP_STATE,
        WRITES_CLOSED,
        describeView,
        bookIdentity,
        bookLabel,
        identityOf,
        fieldsOf,
        createBookRequest,
        parseBaselinePrices,
        planView,
        duplicateReviewView,
        decisionLog,
        previewStatement,
        ledgerModel,
        // Test hook: the page clock that ages quotes (a controllable clock, P5 item 2).
        setClock(clock) {
            state.clock = typeof clock === 'function' ? clock : () => Date.now();
        },
        // Read-only view of what the page holds, for the browser assertion script.
        inspect() {
            const ledger = state.ledger;
            return ledger ? { bookId: ledger.bookId, version: ledger.version, quoteBatchId: ledger.quoteBatch
                ? ledger.quoteBatch.quoteBatchId : null, model: ledger.model || null,
            importPlan: ledger.importPlan ? { blocking: ledger.importPlan.plan.blocking,
                events: ledger.importPlan.plan.events.length, realized: ledger.importPlan.realized || [] } : null,
            delivery: ledger.delivery || null } : null;
        },
    });

    if (globalScope.document
        && globalScope.document.readyState !== 'loading') {
        start();
    } else if (globalScope.document) {
        globalScope.document.addEventListener('DOMContentLoaded', start);
    }
})(typeof window !== 'undefined' ? window : globalThis);
