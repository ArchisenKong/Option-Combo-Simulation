/**
 * Browser assertions for the FOP ledger page (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md
 * §13.3 P5 items 4-5). Runs inside cost_basis_fop.html, served with
 * scripts/cost_basis_fop_synthetic_backend.py (127.0.0.1, a temporary
 * database, a simulated broker; never the live backend or TWS).
 *
 * It drives the page only through DOM events (values, files, clicks) and
 * reads what the page shows. Creating a ledger navigates, so the checks run in
 * phases; each resolves to JSON {phase, results: [{name, pass, actual,
 * expected}], failures, actions}:
 *
 *   create        (cost_basis_fop.html)  explicit type choice, then create a CL ledger
 *   import        (?bookId=…)            preview, server refusal without a claim, claimed import, figures
 *   quotes                               mid, wrong-side single prices, right-side single prices,
 *                                        valid zero bid, crossed book, a missing leg, stale quotes
 *   delivery                             in-memory delivery preview writes nothing; a path past a
 *                                        FUT's last trade date stops
 *   stress                               the stress curve in its worker: the anchor is the ledger,
 *                                        each point's month prices and option values, expiry
 *                                        deliveries, a stop past a last trade date, an early
 *                                        assignment only in the money, a dollar range, the rate's
 *                                        label, an out-of-date curve refused and the curve read for
 *                                        every run, an anchor that leaves the ledger's quotes alone
 *                                        but is not in sync for the stress view; no writes
 *   after-reload  (after location.reload) the same figures
 *   backup                               export, restore from it, the same figures
 *   actions                              every action the backend received was allowed; no writes
 *                                        outside the write phases
 *
 * Usage in a page: load this file, then
 *   await window.OptionComboFopBrowserAssertions.run('import')
 */
(function attachFopBrowserAssertions(globalScope) {
    'use strict';

    const doc = globalScope.document;
    const ACCOUNT = 'U1111111';
    const ZONE = 'America/New_York';
    const CLOCK = Date.parse('2026-11-12T15:00:00Z');
    // Everything a ledger page may send, and what must never appear (F27).
    const FORBIDDEN = /order|exercise|subscri|execution|portfolio|managed_accounts|market_price|scenario|split/;
    const WRITES = new Set(['create_cost_basis_book', 'append_cost_basis_event', 'void_cost_basis_event',
        'import_cost_basis_events', 'rebuild_cost_basis_book', 'restore_cost_basis_backup', 'delete_cost_basis_book',
        'commit_cost_basis_fop_metadata', 'reset_cost_basis_book', 'restore_cost_basis_reset',
        'save_cost_basis_snapshot']);

    // ------------------------------------------------------------------
    // The statement the checks import (account-local New York time)
    // ------------------------------------------------------------------

    const FILLS = [
        ['Futures', 'CLZ6', '2026-10-01, 10:00:00', 1, 70, -70000, -5, 'O'],
        ['Options On Futures', 'LOZ6 C7500', '2026-10-01, 11:00:00', -1, 1.2, 1200, 0, 'O'],
        ['Options On Futures', 'LOZ6 P6500', '2026-10-02, 11:30:00', 1, 0.8, -800, 0, 'O'],
        ['Futures', 'CLZ6', '2026-11-10, 10:00:00', -1, 72, 72000, -5, 'C'],
        ['Futures', 'CLF7', '2026-11-10, 10:00:01', 1, 72.5, -72500, -5, 'O'],
    ];

    function statementText(account = ACCOUNT) {
        const lines = [
            'Statement,Header,Field Name,Field Value',
            'Statement,Data,Title,Activity Statement',
            'Statement,Data,Period,"October 1, 2026 - November 10, 2026"',
            'Statement,Data,WhenGenerated,"2026-11-11, 09:15:00 EST"',
            'Account Information,Header,Field Name,Field Value',
            `Account Information,Data,Account,${account}`,
            'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Proceeds,'
                + 'Comm/Fee,Code',
        ];
        for (const [asset, symbol, time, quantity, price, proceeds, fee, code] of FILLS) {
            lines.push(`Trades,Data,Order,${asset},USD,${symbol},"${time}",${quantity},${price},${proceeds},${fee},${code}`);
        }
        const header = 'Financial Instrument Information,Header,Asset Category,Symbol,Description,Conid,Underlying,'
            + 'Listing Exch,Multiplier,Expiry,Delivery Month,Type,Strike,Settlement Type,Code';
        lines.push(header);
        lines.push('Financial Instrument Information,Data,Futures,CLZ6,CL 19NOV26,555,CL,NYMEX,1000,2026-11-19,2026-12,,,,');
        lines.push('Financial Instrument Information,Data,Futures,CLF7,CL 17DEC26,556,CL,NYMEX,1000,2026-12-17,2027-01,,,,');
        lines.push(header);
        lines.push('Financial Instrument Information,Data,Options On Futures,LOZ6 C7500,CL 17NOV26 75 C,9001,CLZ6,NYMEX,'
            + '1000,2026-11-17,,C,75,,');
        lines.push('Financial Instrument Information,Data,Options On Futures,LOZ6 P6500,CL 17NOV26 65 P,9002,CLZ6,NYMEX,'
            + '1000,2026-11-17,,P,65,,');
        lines.push('Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,'
            + 'Close Price');
        lines.push('Open Positions,Data,Summary,Futures,USD,CLF7,1,1000,72.5,');
        lines.push('Open Positions,Data,Summary,Options On Futures,USD,LOZ6 C7500,-1,1000,1.2,');
        lines.push('Open Positions,Data,Summary,Options On Futures,USD,LOZ6 P6500,1,1000,0.8,');
        return `${lines.join('\n')}\n`;
    }

    // A Flex trade export of synthetic fills (the terms of the statement above).
    const TERMS = {
        CLZ6: ['FUT', 'CL 19NOV26', 555, '', 'CL', '', '20261119', ''],
        CLF7: ['FUT', 'CL 17DEC26', 556, '', 'CL', '', '20261217', ''],
        'LOZ6 C7500': ['FOP', 'CL 17NOV26 75 C', 9001, 555, 'CL', 75, '20261117', 'C'],
        'LOZ6 P6500': ['FOP', 'CL 17NOV26 65 P', 9002, 555, 'CL', 65, '20261117', 'P'],
    };

    function flexText(fills, realizedColumn = false) {
        const header = ['ClientAccountID', 'CurrencyPrimary', 'AssetClass', 'Symbol', 'Description', 'Conid',
            'UnderlyingConid', 'UnderlyingSymbol', 'Multiplier', 'Strike', 'Expiry', 'Put/Call', 'TradeID', 'IBExecID',
            'IBOrderID', 'DateTime', 'TradeDate', 'Quantity', 'TradePrice', 'Proceeds', 'IBCommission', 'Notes/Codes',
            'ListingExchange'].concat(realizedColumn ? ['FifoPnlRealized'] : []);
        const lines = [header.join(',')];
        for (const fill of fills) {
            const [asset, description, conId, underlying, root, strike, expiry, right] = TERMS[fill.symbol];
            const day = fill.local.slice(0, 10).replace(/-/g, '');
            const values = [ACCOUNT, 'USD', asset, fill.symbol, description, conId, underlying, root, 1000, strike, expiry,
                right, fill.tradeId, '', '', `${day};${fill.local.slice(11, 19).replace(/:/g, '')}`, day, fill.qty,
                fill.price, Number((-fill.qty * fill.price * 1000).toFixed(6)), fill.commission || 0, fill.codes || '',
                'NYMEX'].concat(realizedColumn ? [fill.realized === undefined ? '' : fill.realized] : []);
            lines.push(values.map((value) => (/[,"]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"`
                : String(value))).join(','));
        }
        return `${lines.join('\n')}\n`;
    }

    // ------------------------------------------------------------------
    // Driving the page
    // ------------------------------------------------------------------

    const $ = (id) => doc.getElementById(id);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function waitFor(what, predicate, timeoutMs = 15000) {
        const until = Date.now() + timeoutMs;
        for (;;) {
            let value;
            try {
                value = predicate();
            } catch (_) {
                value = null;
            }
            if (value) return value;
            if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
            await sleep(100);
        }
    }

    function setValue(id, value) {
        const node = $(id);
        node.value = value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setChecked(id, checked) {
        const node = $(id);
        node.checked = checked;
        node.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setFile(id, name, text, type) {
        const transfer = new DataTransfer();
        transfer.items.add(new File([text], name, { type: type || 'text/csv' }));
        const node = $(id);
        node.files = transfer.files;
        node.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function click(id) {
        $(id).click();
    }

    function text(id) {
        return ($(id) && $(id).textContent || '').trim();
    }

    /** A table's body rows as trimmed text. */
    function rows(id) {
        const table = $(id) && $(id).querySelector('table');
        if (!table) return [];
        return Array.from(table.querySelectorAll('tr')).slice(1)
            .map((row) => Array.from(row.children).map((cell) => cell.textContent.trim()));
    }

    /** A table's header cells as trimmed text. */
    function header(id) {
        const table = $(id) && $(id).querySelector('table');
        const first = table && table.querySelector('tr');
        return first ? Array.from(first.children).map((cell) => cell.textContent.trim()) : [];
    }

    function row(id, first) {
        return rows(id).find((cells) => cells[0] === first) || null;
    }

    function overview() {
        return Object.fromEntries(rows('overview-table').map(([label, value]) => [label, value]));
    }

    function page() {
        return globalScope.OptionComboCostBasisFopPage;
    }

    async function quotes(table) {
        const response = await fetch('/__synthetic/quotes', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quotes: table }) });
        if (!response.ok) throw new Error(`the synthetic backend refused the quote table (${response.status})`);
    }

    /** Set a table of the simulated broker (contracts, positions). */
    async function synthetic(table, body) {
        const response = await fetch(`/__synthetic/${table}`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`the synthetic backend refused the ${table} table (${response.status})`);
    }

    async function backendActions() {
        const response = await fetch('/__synthetic/actions');
        return (await response.json()).actions;
    }

    function recorder() {
        const sent = [];
        const original = WebSocket.prototype.send;
        WebSocket.prototype.send = function send(message) {
            try {
                sent.push(JSON.parse(message).action);
            } catch (_) {
                sent.push('(unreadable)');
            }
            return original.call(this, message);
        };
        return { sent, stop() { WebSocket.prototype.send = original; } };
    }

    function checker(phase) {
        const results = [];
        return {
            results,
            expect(name, actual, expected) {
                const pass = JSON.stringify(actual) === JSON.stringify(expected);
                results.push({ name, pass, actual, expected });
                return pass;
            },
            ok(name, condition, actual) {
                results.push({ name, pass: Boolean(condition), actual, expected: true });
                return Boolean(condition);
            },
            done(extra) {
                return Object.assign({ phase, failures: results.filter((item) => !item.pass).length, results }, extra);
            },
        };
    }

    /** The old-month short call's record id (ids are scoped to their ledger). */
    function shortCall() {
        return page().inspect().model.output.options.find((row) => row.right === 'C').contractId;
    }

    async function loaded() {
        await waitFor('the ledger view', () => !$('ledger-view').hidden && page().inspect()
            && page().inspect().version && page().inspect().model);
    }

    async function reloadLedger() {
        const before = text('ledger-status');
        click('ledger-reload');
        await waitFor('a reload', () => text('ledger-status') !== before && /已读取/.test(text('ledger-status')));
    }

    function iso(offsetSeconds) {
        return new Date(CLOCK + offsetSeconds * 1000).toISOString().replace('Z', '000Z');
    }

    function quote(fields) {
        return Object.assign({ bid: null, bidSize: null, ask: null, askSize: null, last: null, lastSize: null,
            close: null, closeDate: null, settlement: null, settlementDate: null, observedAtUtc: iso(-10),
            marketDataType: 1 }, fields);
    }

    async function takeQuotes(table) {
        await quotes(table);
        const before = text('ledger-status');
        click('quote-refresh');
        await waitFor('a quote batch', () => text('ledger-status') !== before && /报价批次|取报价失败|已丢弃/
            .test(text('ledger-status')));
    }

    // ------------------------------------------------------------------
    // Phases
    // ------------------------------------------------------------------

    const phases = {
        async create() {
            const check = checker('create');
            await waitFor('the ledger list', () => !$('list-view').hidden);
            check.expect('the type range is not preselected', $('create-scope').value, '');
            check.expect('writes are released on the synthetic backend', $('create-submit').disabled, false);
            setValue('create-account', ACCOUNT);
            setValue('create-start', '2026-10-01');
            click('create-submit');
            await waitFor('a refusal without a type range', () => /账本范围/.test(text('create-status')));
            check.ok('creating without choosing full history or a baseline is refused',
                /请选择账本范围/.test(text('create-status')), text('create-status'));
            setValue('create-scope', 'full_history');
            click('create-submit');
            return check.done({ navigating: true, note: 'the page opens the new ledger; run the import phase there' });
        },

        async import() {
            const check = checker('import');
            const record = recorder();
            try {
                await loaded();
                check.ok('the page routed the new ledger by its backend type',
                    /FOP/.test(text('book-state')) && $('book-legacy-link').hidden, text('book-state'));
                const identity = Array.from($('book-identity').querySelectorAll('dd')).map((node) => node.textContent);
                check.ok('the ledger is CL, FUT, full history under NYMEX-CL-v1',
                    identity.includes('CL') && identity.includes('FUT') && identity.includes('完整历史')
                    && identity.some((value) => value.startsWith('NYMEX-CL-v1')), identity);
                setValue('ledger-zone', ZONE);
                setFile('import-file', 'synthetic-oct-nov.csv', statementText());
                await waitFor('the import preview', () => !$('import-result').hidden);
                check.ok('the preview names the synthetic row types', rows('import-rows').every((cells) =>
                    cells[2] === '仅合成样本：只能预览或人工认领'), rows('import-rows').map((cells) => cells[2]));
                check.ok('the preview says the rows need a manual claim', /人工认领/.test(text('import-status')),
                    text('import-status'));
                click('import-submit');
                await waitFor('the server refusal', () => /未导入/.test(text('import-status')));
                check.ok('without a claim the server refuses the synthetic rows, in words',
                    /能力未验收.*下一步：.*人工认领.*\[fop_capability_not_verified\]/.test(text('import-status')),
                    text('import-status'));
                setChecked('import-claim', true);
                setValue('import-attestation', 'checked row by row against the synthetic statement');
                click('import-submit');
                await waitFor('the import', () => /导入完成/.test(text('import-status')), 30000);
                await waitFor('the reloaded ledger', () => rows('events-table').length === 5);
                const figures = overview();
                check.expect('Rf', figures['期货已实现（Rf）'], '2000.00');
                check.expect('Co', figures['期权净现金（Co，含佣金）'], '400.00');
                check.expect('E', figures['费用（E，不含期权成交佣金）'], '15.00');
                check.ok('without quotes the full P&L is unknown, never 0', /^未知/.test(text('overview-value')),
                    text('overview-value'));
                check.expect('futures', rows('futures-table').map((cells) => cells.slice(0, 5)),
                    [['202701', 'CLF7', '2026-12-17', '1', '72.5']]);
                const call = row('options-table', '2026-11-17');
                check.ok('the old-month short call is flagged beside the new-month FUT',
                    rows('options-table').some((cells) => cells[1] === 'C' && cells[4] === '-1'
                        && /旧月期权/.test(cells[10])), rows('options-table'));
                check.ok('the options are bound through the statement', Boolean(call)
                    && rows('options-table').every((cells) => cells[6] === '报表验证'), rows('options-table'));
                check.ok('the new-month FUT does not cover the old-month short call (F08)',
                    rows('coverage-table').some((cells) => cells[0] === 'CLZ6' && cells[4] === '无同合约多头覆盖'
                        && /其他月份/.test(cells[6])), rows('coverage-table'));
                check.expect('the roll is derived, a candidate, with its spread',
                    rows('roll-table').map((cells) => cells.slice(0, 7)),
                    [['候选', 'CLZ6', 'CLF7', '1', '72', '72.5', '0.5']]);
                check.expect('break-even rows', rows('breakeven-table'),
                    [['实际开仓均价', '72.5'], ['卖方策略等效回本价（已结算结果）', '70.515'],
                        ['未平卖方期权全部归零假设价', '69.315']]);
                check.ok('every imported event shows as manually verified',
                    rows('events-table').every((cells) => cells[9] === '人工核实'), rows('events-table'));
                check.expect('integrity', rows('integrity-table').map((cells) => [cells[0], cells[1]]),
                    [['数量', '完整'], ['期初成本', '完整'], ['期权绑定', '完整'], ['行情', '未核对'], ['报表覆盖', '完整'],
                        ['现金', '未核对']]);
                check.ok('no quantity, share or per-share wording', !/股数|每股|股息|LETF/.test(doc.body.innerText),
                    null);
            } finally {
                record.stop();
            }
            check.ok('the page sent only allowed actions', record.sent.every((action) => !FORBIDDEN.test(action)),
                record.sent);
            return check.done({ sent: record.sent });
        },

        async quotes() {
            const check = checker('quotes');
            const record = recorder();
            try {
                await loaded();
                page().setClock(() => CLOCK);
                // A: everything real-time: mids, and a valid zero bid.
                await takeQuotes({
                    CLF7: quote({ bid: 72.4, bidSize: 3, ask: 72.5, askSize: 2 }),
                    'LOZ6 C7500': quote({ bid: 0.3, bidSize: 5, ask: 0.35, askSize: 5 }),
                    'LOZ6 P6500': quote({ bid: 0, bidSize: 4, ask: 0.05, askSize: 6 }),
                });
                check.expect('A: full P&L at mids, real-time', [text('overview-value'), text('overview-tag')],
                    ['2035.00', '实时']);
                check.ok('A: a zero bid with a size is a valid side',
                    /0\.025（实时中间价）/.test(row('options-table', '2026-11-17') ? rows('options-table')
                        .find((cells) => cells[1] === 'P')[8] : ''), rows('options-table'));
                // B: only the wrong side (long FUT ask, short call bid, long put ask).
                await takeQuotes({
                    CLF7: quote({ ask: 72.5, askSize: 2 }),
                    'LOZ6 C7500': quote({ bid: 0.3, bidSize: 5, settlement: 0.33, settlementDate: '2026-11-11' }),
                    'LOZ6 P6500': quote({ ask: 0.05, askSize: 6, close: 0.03, closeDate: '2026-11-11' }),
                });
                check.ok('B: a long FUT with only an ask has no price', /无可用报价/.test(rows('futures-table')[0][5]),
                    rows('futures-table')[0]);
                check.ok('B: a missing leg leaves the full P&L unknown', /^未知/.test(text('overview-value')),
                    text('overview-value'));
                check.ok('B: the short call uses its dated settlement, not the bid',
                    /0\.33（结算参考 2026-11-11）/.test(rows('options-table').find((cells) => cells[1] === 'C')[8]),
                    rows('options-table'));
                check.ok('B: the long put uses its dated close, not the ask',
                    /0\.03（收盘参考 2026-11-11）/.test(rows('options-table').find((cells) => cells[1] === 'P')[8]),
                    rows('options-table'));
                // C: only the side each position would close against.
                await takeQuotes({
                    CLF7: quote({ bid: 72.4, bidSize: 3 }),
                    'LOZ6 C7500': quote({ ask: 0.35, askSize: 5 }),
                    'LOZ6 P6500': quote({ bid: 0, bidSize: 4 }),
                });
                check.expect('C: one-sided conservative values, and the summary says so',
                    [text('overview-value'), text('overview-tag')], ['1935.00', '实时 · 含单边保守估值']);
                check.ok('C: labelled as one-sided', rows('futures-table')[0][5].includes('单边保守估值'),
                    rows('futures-table')[0]);
                // D: a crossed book gives no mid; a dated settlement is a reference.
                await takeQuotes({
                    CLF7: quote({ bid: 72.6, bidSize: 3, ask: 72.5, askSize: 2, settlement: 72.3,
                        settlementDate: '2026-11-11' }),
                    'LOZ6 C7500': quote({ bid: 0.3, bidSize: 5, ask: 0.35, askSize: 5 }),
                    'LOZ6 P6500': quote({ bid: 0, bidSize: 4, ask: 0.05, askSize: 6 }),
                });
                check.expect('D: crossed book, settlement reference', [text('overview-tag'),
                    rows('futures-table')[0][5]], ['参考值，非实时', '72.3（结算参考 2026-11-11）']);
                // E: the same mids 200 s later are no longer current.
                await takeQuotes({
                    CLF7: quote({ bid: 72.4, bidSize: 3, ask: 72.5, askSize: 2 }),
                    'LOZ6 C7500': quote({ bid: 0.3, bidSize: 5, ask: 0.35, askSize: 5 }),
                    'LOZ6 P6500': quote({ bid: 0, bidSize: 4, ask: 0.05, askSize: 6 }),
                });
                page().setClock(() => CLOCK + 200000);
                setValue('ledger-zone', ZONE);
                check.ok('E: quotes older than 120 s are not shown as current', /^未知/.test(text('overview-value'))
                    && /无可用报价：报价已超过 120 秒（stale）/.test(rows('futures-table')[0][5]), rows('futures-table')[0]);
                // F: delayed market data is never current.
                page().setClock(() => CLOCK);
                await takeQuotes({
                    CLF7: quote({ bid: 72.4, bidSize: 3, ask: 72.5, askSize: 2, marketDataType: 3 }),
                    'LOZ6 C7500': quote({ bid: 0.3, bidSize: 5, ask: 0.35, askSize: 5 }),
                    'LOZ6 P6500': quote({ bid: 0, bidSize: 4, ask: 0.05, askSize: 6 }),
                });
                check.ok('F: delayed data is not real-time', /market_data_type_3/.test(rows('futures-table')[0][5]),
                    rows('futures-table')[0]);
            } finally {
                record.stop();
            }
            check.ok('quote checks sent no write', record.sent.every((action) => !WRITES.has(action)), record.sent);
            check.ok('quote checks sent only allowed actions', record.sent.every((action) => !FORBIDDEN.test(action)),
                record.sent);
            return check.done({ sent: record.sent });
        },

        async delivery() {
            const check = checker('delivery');
            const record = recorder();
            try {
                await loaded();
                // The re-check at the 120 s limit redraws the figures only: what is typed stays.
                const started = Date.now();
                page().setClock(() => CLOCK + 108000 + (Date.now() - started));
                await takeQuotes({
                    CLF7: quote({ bid: 72.4, bidSize: 3, ask: 72.5, askSize: 2 }),
                    'LOZ6 C7500': quote({ bid: 0.3, bidSize: 5, ask: 0.35, askSize: 5 }),
                    'LOZ6 P6500': quote({ bid: 0, bidSize: 4, ask: 0.05, askSize: 6 }),
                });
                check.expect('mids 118 s old are still current', text('overview-tag'), '实时');
                const typed = $('delivery-choices').querySelector(`select[data-contract-id="${shortCall()}"]`);
                const typedPrice = $('delivery-prices').querySelector('input');
                typed.value = 'assign';
                typedPrice.value = '76';
                await waitFor('the freshness limit', () => /^未知/.test(text('overview-value')), 6000);
                check.ok('at the limit the figures stop being current, within 3 s of it',
                    Date.now() - started < 5000, Date.now() - started);
                check.ok('the re-check kept the delivery inputs', typed.isConnected && typedPrice.isConnected
                    && typed.value === 'assign' && typedPrice.value === '76', [typed.value, typedPrice.value]);
                page().setClock(() => CLOCK);
                const version = page().inspect().version.digest;
                const prices = { CLZ6: '76', CLF7: '73' };
                for (const input of $('delivery-prices').querySelectorAll('input')) {
                    const symbol = input.closest('tr').children[0].textContent.trim();
                    input.value = prices[symbol] || '';
                }
                click('delivery-suggest');
                const selects = Array.from($('delivery-choices').querySelectorAll('select'));
                check.expect('at CLZ6 76 the short 75 call is assigned and the 65 put expires',
                    selects.map((select) => select.value).sort(), ['assign', 'expire']);
                setValue('delivery-at', '2026-11-13T10:00:00');
                const count = $('delivery-choices').querySelector(`input[data-contract-id="${shortCall()}"]`);
                check.expect('the quantity defaults to what is open', count.value, '1');
                count.value = '2';
                click('delivery-run');
                check.ok('more than is open is refused', /1 到 1 之间的整数/.test(text('delivery-status')),
                    text('delivery-status'));
                count.value = '1';
                click('delivery-run');
                await waitFor('the delivery preview', () => /假设交割|预览停止/.test(text('delivery-status')));
                const result = Array.from($('delivery-result').querySelectorAll('table'));
                const positions = result[0] ? Array.from(result[0].querySelectorAll('tr')).slice(1)
                    .map((line) => Array.from(line.children).map((cell) => cell.textContent.trim())) : [];
                check.expect('positions before and after', positions.map((cells) => cells.join(' ')).sort(),
                    ['CLF7 1 1', 'CLZ6 0 -1', 'LOZ6 C7500 -1 0', 'LOZ6 P6500 1 0']);
                const totals = result[1] ? Array.from(result[1].querySelectorAll('tr')).slice(1)
                    .map((line) => Array.from(line.children).map((cell) => cell.textContent.trim())) : [];
                check.expect('the full P&L after the assumed deliveries', (totals.find((cells) => cells[0]
                    === '完整经济盈亏') || [])[2], '1885.00');
                setValue('delivery-at', '2026-11-20T10:00:00');
                click('delivery-run');
                await waitFor('a stopped preview', () => /预览停止/.test(text('delivery-status')));
                check.ok('a path past CLZ6\'s last trade date stops', /最后交易/.test(text('delivery-status')),
                    text('delivery-status'));
                await reloadLedger();
                check.expect('the ledger version is unchanged by the preview', page().inspect().version.digest, version);
            } finally {
                record.stop();
            }
            check.expect('the delivery preview sent no write', record.sent.filter((action) => WRITES.has(action)), []);
            return check.done({ sent: record.sent });
        },

        async stress() {
            const check = checker('stress');
            const record = recorder();
            // A run's status is set on the click ("正在准备…") and again by its answer, so a run whose answer
            // reads like the last one's is still waited for.
            const run = async (fields) => {
                for (const [id, value] of Object.entries(fields)) setValue(id, value);
                $('stress-status').textContent = '';
                click('stress-run');
                await waitFor('a stress result', () => /情景点|不能计算|没有未平持仓/.test(text('stress-status')), 20000);
                return rows('stress-table');
            };
            // Columns by their header: the per-contract columns come before the totals (contract §8, §11).
            const column = (name) => header('stress-table').indexOf(name);
            const cell = (cells, name) => (cells ? cells[column(name)] : undefined);
            const curveReads = () => record.sent.filter((action) => action === 'request_cost_basis_fop_discount_curve').length;
            const ledgerQuotes = {
                CLF7: quote({ bid: 72.4, bidSize: 3, ask: 72.5, askSize: 2 }),
                'LOZ6 C7500': quote({ bid: 0.3, bidSize: 5, ask: 0.35, askSize: 5 }),
                'LOZ6 P6500': quote({ bid: 0, bidSize: 4, ask: 0.05, askSize: 6 }),
            };
            try {
                await loaded();
                page().setClock(() => CLOCK);
                await synthetic('curve', { available: true });
                await takeQuotes(Object.assign({ CLZ6: quote({ bid: 71.9, bidSize: 3, ask: 72.1, askSize: 2 }) },
                    ledgerQuotes));
                const state = page().inspect().model.quoteState;
                check.expect('CLZ6, bound but not held, is quoted as an anchor only',
                    Object.values(state.anchors).map((anchor) => [anchor.level, anchor.mark]), [['mid', 72]]);
                check.expect('the ledger view is unchanged by the anchor', text('overview-tag'), '实时');
                const version = page().inspect().version.digest;
                let table = await run({ 'stress-rate': '', 'stress-range-usd': '', 'stress-points': '21',
                    'stress-range': '20', 'stress-horizon': '0', 'stress-slope': '0', 'stress-iv': '1', 'stress-band': '20' });
                check.ok('the curve is computed on CLZ6, the earliest month',
                    /^21 个情景点（参考月 CLZ6，经过 0 天/.test(text('stress-status')), text('stress-status'));
                check.expect('21 points', table.length, 21);
                check.expect('the anchor point changes nothing', cell(table[10], '经济盈亏变化'), '0.00');
                check.expect('the anchor total is the ledger total on screen', cell(table[10], '情景经济盈亏'),
                    text('overview-value'));
                check.expect('each point lists every month\'s price and every option\'s model value',
                    header('stress-table').slice(0, 5), ['参考月价格', 'CLZ6 情景价', 'CLF7 情景价', 'LOZ6 C7500 模型值',
                        'LOZ6 P6500 模型值']);
                check.expect('at the anchor each month is at its own quote', [cell(table[10], 'CLZ6 情景价'),
                    cell(table[10], 'CLF7 情景价')], ['72', '72.45']);
                const call = row('stress-anchor-options', 'LOZ6 C7500');
                check.ok('the anchors table gives the short call\'s mid, model value and implied volatility',
                    Boolean(call) && call[1] === '-1' && call[2] === 'CLZ6' && call[4] === '0.325'
                    && /^[0-9.]+%$/.test(call[6]) && call[6] === call[7], call);
                check.expect('and the anchor futures with their level',
                    rows('stress-anchor-futures').map((cells) => cells.slice(0, 4)),
                    [['CLZ6', '202612', '72', '实时中间价'], ['CLF7', '202701', '72.45', '实时中间价']]);
                check.ok('the chart is drawn', !$('stress-chart').hidden
                    && /^M [0-9.]+ [0-9.]+ L /.test($('stress-line').getAttribute('d')), $('stress-line').getAttribute('d'));
                check.ok('the assumptions name the cached curve and the expiry time inferred from the date',
                    /贴现曲线（2026-11-11）/.test(text('stress-assumptions'))
                    && /到期时刻按品种规则推定（LOZ6 C7500）/.test(text('stress-assumptions')), text('stress-assumptions'));
                table = await run({ 'stress-horizon': '6' });
                check.ok('six days on, below 65 the long put was exercised onto CLZ6 at its expiry',
                    table.some((cells) => /LOZ6 P6500 行权 → CLZ6 -1（按行权价）/.test(cell(cells, '情景交割'))),
                    table.map((cells) => cell(cells, '情景交割')));
                check.ok('and above 75 the short call was assigned onto CLZ6',
                    table.some((cells) => /LOZ6 C7500 被指派 → CLZ6 -1（按行权价）/.test(cell(cells, '情景交割'))),
                    table.map((cells) => cell(cells, '情景交割')));
                check.ok('where an option has settled its column says how',
                    table.some((cells) => cell(cells, 'LOZ6 C7500 模型值') === '到期被指派')
                    && table.some((cells) => cell(cells, 'LOZ6 P6500 模型值') === '到期行权'),
                    table.map((cells) => [cell(cells, 'LOZ6 C7500 模型值'), cell(cells, 'LOZ6 P6500 模型值')]));
                table = await run({ 'stress-horizon': '8' });
                check.ok('eight days on, a point that holds a delivered CLZ6 past its last trade date stops',
                    table.some((cells) => /\[future_past_last_trade\]/.test(cell(cells, '说明'))),
                    table.map((cells) => cell(cells, '说明')));
                check.ok('while the points where both options expire stay', cell(table[10], '经济盈亏变化') !== '—', table[10]);
                const early = $('stress-early').querySelector(`input[data-contract-id="${shortCall()}"]`);
                check.ok('the short call can be chosen for an early delivery', Boolean(early));
                if (early) {
                    early.checked = true;
                    early.dispatchEvent(new Event('change', { bubbles: true }));
                }
                table = await run({ 'stress-horizon': '2' });
                check.ok('two days on it is assigned where it is in the money',
                    table.some((cells) => /LOZ6 C7500 被指派/.test(cell(cells, '情景交割'))
                        && cell(cells, 'LOZ6 C7500 模型值') === '提前被指派'), table.map((cells) => cell(cells, '情景交割')));
                check.ok('and not delivered where it is out of the money',
                    table.some((cells) => /LOZ6 C7500：价外，未提前交割/.test(cell(cells, '说明'))),
                    table.map((cells) => cell(cells, '说明')));
                if (early) {
                    early.checked = false;
                    early.dispatchEvent(new Event('change', { bubbles: true }));
                }
                table = await run({ 'stress-horizon': '0', 'stress-range-usd': '5' });
                check.ok('a dollar range replaces the percentage', cell(table[0], '参考月价格') === '67'
                    && cell(table[20], '参考月价格') === '77'
                    && /扫描范围 ±5 美元\/桶（按美元输入）/.test(text('stress-assumptions')),
                [cell(table[0], '参考月价格'), text('stress-assumptions')]);
                setValue('stress-range-usd', '');
                await run({ 'stress-rate': '4' });
                check.ok('a typed rate is labelled an assumption', /假设利率 4%/.test(text('stress-assumptions'))
                    && /利率为手工假设/.test(text('stress-assumptions')), text('stress-assumptions'));
                setValue('stress-rate', '');
                // An out-of-date curve, answered as the yield-curve backend answers it, is refused; every
                // run reads the curve again, so the refusal ends when the backend has a current one.
                const reads = curveReads();
                await synthetic('curve', { available: true, status: 'cache_fallback',
                    curve: { schemaVersion: 2, curveAsOf: '2020-01-02', currency: 'USD', source: 'synthetic_old',
                        points: [7, 30, 90, 365].map((tenorDays) => ({ tenorDays, zeroRate: 0.04,
                            discountFactor: Math.exp(-0.04 * tenorDays / 365) })) },
                    error: 'Yield-curve snapshot 2020-01-02 is older than market date 2026-11-12.' });
                await run({});
                check.ok('an out-of-date curve is refused with its date and the next step',
                    /^不能计算：后端缓存的贴现曲线已过期.*（2020-01-02）.*填写“假设利率”.*\[rate_curve_stale\]/
                        .test(text('stress-status')) && $('stress-chart').hidden, text('stress-status'));
                await synthetic('curve', { available: true });
                table = await run({});
                check.ok('with a current curve again the next run computes', /^21 个情景点/.test(text('stress-status'))
                    && table.length === 21, text('stress-status'));
                check.expect('the curve was read for each of those runs', curveReads() - reads, 2);
                // An anchor observed a minute after the ledger's quotes: the ledger view keeps its mids, the
                // stress view is not synchronised and says so for every option.
                await takeQuotes(Object.assign({ CLZ6: quote({ bid: 71.9, bidSize: 3, ask: 72.1, askSize: 2,
                    observedAtUtc: iso(-5) }) }, Object.fromEntries(Object.entries(ledgerQuotes)
                    .map(([symbol, fields]) => [symbol, Object.assign({}, fields, { observedAtUtc: iso(-75) })]))));
                check.expect('a newer anchor leaves the ledger\'s quotes current', text('overview-tag'), '实时');
                await run({});
                check.ok('but the stress view needs the options in sync with their future',
                    /\[iv_needs_mid\].*\[iv_needs_mid\]/.test(text('stress-status')), text('stress-status'));
                check.expect('the ledger version is unchanged by the scenarios', page().inspect().version.digest, version);
            } finally {
                record.stop();
            }
            check.expect('the stress view sent no write', record.sent.filter((action) => WRITES.has(action)), []);
            check.ok('it read the curve through its own action',
                record.sent.includes('request_cost_basis_fop_discount_curve'), record.sent);
            return check.done({ sent: record.sent });
        },
        async 'after-reload'() {
            const check = checker('after-reload');
            await loaded();
            const figures = overview();
            check.expect('Rf after a page reload', figures['期货已实现（Rf）'], '2000.00');
            check.expect('Co after a page reload', figures['期权净现金（Co，含佣金）'], '400.00');
            check.expect('events after a page reload', rows('events-table').length, 5);
            return check.done();
        },

        async backup() {
            const check = checker('backup');
            const record = recorder();
            let captured = null;
            const createObjectURL = URL.createObjectURL;
            URL.createObjectURL = (blob) => {
                captured = blob;
                return createObjectURL.call(URL, blob);
            };
            try {
                await loaded();
                const before = overview();
                click('backup-export');
                await waitFor('the backup', () => captured && /备份已生成/.test(text('backup-status')));
                const backup = JSON.parse(await captured.text());
                check.expect('the backup is a FOP envelope', [backup.format, backup.version, backup.kind],
                    ['cost-basis-backup', 2, 'fop']);
                check.ok('the backup keeps contracts, bindings, sources and raw fields',
                    backup.payload.contracts.length === 4 && backup.payload.bindings.length === 2
                    && backup.payload.sources.every((source) => Object.keys(source.rawFields || {}).length),
                    { contracts: backup.payload.contracts.length, bindings: backup.payload.bindings.length });
                setFile('restore-file', 'backup.json', JSON.stringify(backup), 'application/json');
                setValue('restore-phrase', '');
                click('restore-submit');
                await waitFor('the confirmation phrase', () => /请在确认短语中输入/.test(text('backup-status')));
                const phrase = text('backup-status').replace(/^.*请在确认短语中输入：/, '');
                setValue('restore-phrase', phrase);
                click('restore-submit');
                await waitFor('the restore', () => /已从备份恢复/.test(text('backup-status')), 30000);
                await waitFor('the reloaded ledger', () => rows('events-table').length === 5);
                check.expect('the figures after a restore', overview(), before);
            } finally {
                URL.createObjectURL = createObjectURL;
                record.stop();
            }
            return check.done({ sent: record.sent });
        },

        // --------------------------------------------------------------
        // P5 closeout (plan §19): C1 duplicates, C4 realized P&L, C5 manual
        // entries, C2 binding evidence, C3 reconciliation, C6 messages.
        // They run after `backup`, on the ledger it restored, in this order.
        // --------------------------------------------------------------

        async duplicates() {
            const check = checker('duplicates');
            const record = recorder();
            try {
                await loaded();
                setValue('ledger-zone', ZONE);
                const before = rows('events-table').length;
                // The stored CLF7 buy (Activity, 10:00:01) and a Flex row of that day under another reference.
                const sameDay = flexText([{ symbol: 'CLF7', local: '2026-11-10T10:00:03', qty: 1, price: 72.5,
                    commission: -5, codes: 'O', tradeId: '9101' }]);
                setFile('import-file', 'flex-same-fill.csv', sameDay);
                await waitFor('the duplicate review', () => !$('import-duplicates-block').hidden
                    && $('import-duplicates').children.length === 1);
                check.ok('an undecided possible duplicate blocks, in words', /疑似重复/.test(text('import-status'))
                    && /可能与已记账的成交重复/.test(text('import-problems')), text('import-problems'));
                const review = () => $('import-duplicates').children[0];
                const candidates = Array.from(review().querySelectorAll('tr')).slice(1)
                    .map((line) => Array.from(line.children).map((cell) => cell.textContent.trim()));
                check.ok('its candidate is the stored CLF7 fill, with its quantity, price and fees',
                    candidates.length === 1 && candidates[0][1] === 'CLF7' && candidates[0][2] === '1'
                    && candidates[0][3] === '72.5', candidates);
                click('import-submit');
                await waitFor('a refusal', () => /未导入/.test(text('import-status')));
                check.ok('undecided, nothing is sent', !record.sent.includes('import_cost_basis_events'), record.sent);
                review().querySelector('select').value = review().querySelector('select').options[1].value;
                review().querySelector('input').value = 'the broker confirms one fill under two references';
                click('import-decide');
                await waitFor('the decided preview', () => /认定为同一笔/.test(review().textContent));
                check.expect('decided the same fill: nothing to write, not blocked',
                    [page().inspect().importPlan.blocking, page().inspect().importPlan.events], [false, 0]);
                click('import-submit');
                await waitFor('the import', () => /导入完成/.test(text('import-status')), 30000);
                await waitFor('the reloaded ledger', () => rows('import-decision-log').length === 1);
                check.expect('the same fill is not added', rows('events-table').length, before);
                check.ok('the decision and its check are kept', /flex_trade:9101/.test(rows('import-decision-log')[0][2])
                    && rows('import-decision-log')[0][3] === '同一笔'
                    && /one fill under two references/.test(rows('import-decision-log')[0][5]), rows('import-decision-log'));
                setFile('import-file', 'flex-same-fill-again.csv', sameDay);
                await waitFor('the preview again', () => /早先的导入已认定为同一笔/.test(text('import-duplicates')));
                check.expect('the recorded decision holds for the same row', page().inspect().importPlan.blocking, false);
                // Another fill of that day: decided another fill, claimed, written once with its check.
                const another = flexText([{ symbol: 'CLF7', local: '2026-11-10T12:00:00', qty: 1, price: 72.5,
                    commission: -5, codes: 'O', tradeId: '9102' }]);
                setFile('import-file', 'flex-another-fill.csv', another);
                await waitFor('the second review', () => $('import-duplicates').children.length === 1
                    && /待核实/.test(text('import-duplicates')));
                review().querySelector('select').value = 'distinct';
                review().querySelector('input').value = 'two confirmations: 10:00:01 and 12:00:00';
                click('import-decide');
                await waitFor('the decided preview', () => /认定为另一笔/.test(review().textContent));
                setChecked('import-claim', true);
                setValue('import-attestation', 'checked against the broker confirmation');
                click('import-submit');
                await waitFor('the import', () => /导入完成：新增 1 条/.test(text('import-status')), 30000);
                await waitFor('the reloaded ledger', () => rows('events-table').length === before + 1);
                check.expect('another fill is added once', rows('events-table').length, before + 1);
                const decided = rows('import-decision-log').map((cells) => cells[3]);
                check.ok('the decision log keeps both decisions', decided.length === 2 && decided.includes('同一笔')
                    && decided.includes('另一笔'), rows('import-decision-log'));
                setChecked('import-claim', false);
                setValue('import-attestation', '');
            } finally {
                record.stop();
            }
            check.expect('the writes of this phase', record.sent.filter((action) => WRITES.has(action)),
                ['import_cost_basis_events', 'import_cost_basis_events']);
            return check.done({ sent: record.sent });
        },

        async realized() {
            const check = checker('realized');
            const record = recorder();
            try {
                await loaded();
                check.expect("the buyer's options apart from the totals",
                    rows('overview-buyer').map((cells) => cells[1]).slice(0, 3), ['0.00', '0.00', '-800.00']);
                const ib = (fill) => Object.assign({ commission: 0, codes: 'O' }, fill);
                const fills = (closeRealized) => [
                    ib({ symbol: 'CLZ6', local: '2026-10-01T10:00:00', qty: 1, price: 70, commission: -5, tradeId: '9201',
                        realized: 0 }),
                    ib({ symbol: 'LOZ6 C7500', local: '2026-10-01T11:00:00', qty: -1, price: 1.2, tradeId: '9202',
                        realized: 5 }),
                    ib({ symbol: 'CLZ6', local: '2026-11-10T10:00:00', qty: -1, price: 72, commission: -5, codes: 'C',
                        tradeId: '9203', realized: closeRealized })];
                // IB's FIFO with commissions: (72 - 70) x 1000 - 5 - 5 = 1990.
                setFile('import-file', 'flex-realized.csv', flexText(fills(1990), true));
                await waitFor('the comparison', () => rows('import-realized').length === 2);
                const table = Object.fromEntries(rows('import-realized').map((cells) => [cells[0], cells]));
                check.expect('the same basis agrees', [table.CLZ6[1], table.CLZ6[2], table.CLZ6[3], table.CLZ6[5]],
                    ['1990', '1990', '2000', '相符']);
                check.expect('a value the ledger does not have is a difference', [table['LOZ6 C7500'][1],
                    table['LOZ6 C7500'][2], table['LOZ6 C7500'][5]], ['5', '0', '有差异']);
                check.ok('the comparison says it is evidence only',
                    /只作旁证，不覆盖 Rf/.test(text('import-realized-note')), text('import-realized-note'));
                setFile('import-file', 'flex-realized-missing.csv', flexText(fills(''), true));
                await waitFor('the second comparison', () => rows('import-realized').some((cells) => cells[5] === '不可比'));
                const missing = rows('import-realized').find((cells) => cells[0] === 'CLZ6');
                check.ok('a close without its value is missing, never 0', missing[1] === '缺值' && missing[5] === '不可比'
                    && /没有给出已实现值/.test(missing[6]), missing);
                check.expect('the figures are the ledger\'s', overview()['期货已实现（Rf）'], '2000.00');
            } finally {
                record.stop();
            }
            check.expect('comparing writes nothing', record.sent.filter((action) => WRITES.has(action)), []);
            return check.done({ sent: record.sent });
        },

        async manual() {
            const check = checker('manual');
            const record = recorder();
            try {
                await loaded();
                const before = rows('events-table').length;
                const future = Array.from($('manual-future').options).find((option) => option.textContent === 'CLF7');
                const fillForm = () => {
                    setValue('manual-kind', 'option_trade');
                    setValue('manual-contract', '');
                    setValue('manual-right', 'C');
                    setValue('manual-strike', '80');
                    setValue('manual-expiry', '2026-12-16');
                    setValue('manual-class', 'LO');
                    setValue('manual-symbol', 'LOF7 C8000');
                    setValue('manual-future', future.value);
                    setValue('manual-quantity', '-1');
                    setValue('manual-price', '1.5');
                    setValue('manual-fees', '2.5');
                    setValue('manual-local', '2026-11-12T10:00:00');
                    setValue('manual-note', 'sold by phone, confirmation 4711');
                };
                fillForm();
                click('manual-submit');
                check.ok('nothing is confirmed without a preview', /请先预览/.test(text('manual-status')), text('manual-status'));
                click('manual-preview');
                await waitFor('the preview', () => !$('manual-preview-result').hidden);
                const positions = Array.from($('manual-preview-positions').querySelectorAll('tr')).slice(1)
                    .map((line) => Array.from(line.children).map((cell) => cell.textContent.trim()));
                check.expect('the preview moves only the new option', positions, [['LOF7 C8000', '0', '-1']]);
                check.ok('the preview names the contract it adds', /将新增合约：LOF7 C8000/.test(text('manual-status')),
                    text('manual-status'));
                click('manual-cancel');
                check.ok('cancel writes nothing', $('manual-preview-result').hidden && /已取消，没有写入/.test(text('manual-status')),
                    text('manual-status'));
                click('manual-preview');
                setValue('manual-note', 'sold by phone, confirmation 4712');
                check.ok('an input changed after the preview retires it', $('manual-preview-result').hidden
                    && /旧的预览已作废/.test(text('manual-status')), text('manual-status'));
                click('manual-submit');
                check.ok('a retired preview cannot be confirmed', /请先预览/.test(text('manual-status')), text('manual-status'));
                click('manual-preview');
                await waitFor('the preview', () => !$('manual-preview-result').hidden);
                click('manual-submit');
                click('manual-submit');
                await waitFor('the entry', () => /已记入/.test(text('manual-status')), 30000);
                await waitFor('the reloaded ledger', () => rows('events-table').length === before + 1);
                await sleep(500);
                check.expect('two confirmations of one preview write one event', rows('events-table').length, before + 1);
                check.ok('the entry is shown as manually verified', rows('events-table').some((cells) =>
                    /LOF7 C8000/.test(cells[2]) && cells[9] === '人工核实'), rows('events-table'));
            } finally {
                record.stop();
            }
            const appends = record.sent.filter((action) => action === 'append_cost_basis_event');
            check.expect('one previewed request, sent at each confirmation', appends.length, 2);
            return check.done({ sent: record.sent });
        },

        async binding() {
            const check = checker('binding');
            const record = recorder();
            try {
                await loaded();
                const option = Array.from($('binding-option').options).find((item) => /LOF7 C8000/.test(item.textContent));
                check.ok('the manually attested option can be asked about', Boolean(option),
                    Array.from($('binding-option').options).map((item) => item.textContent));
                setValue('binding-option', option.value);
                const query = async (expect) => {
                    const before = text('binding-status');
                    click('binding-query');
                    await waitFor('the answer', () => text('binding-status') !== before && !/正在向券商查询/.test(text('binding-status'))
                        && expect.test(text('binding-status')));
                };
                await synthetic('contracts', { available: false, details: [] });
                await query(/不能向券商查询合约/);
                check.ok('without a resolver there is no evidence and no adoption', $('binding-confirm').hidden,
                    text('binding-status'));
                const lof7 = { conId: 9003, secType: 'FOP', symbol: 'CL', tradingClass: 'LO', localSymbol: 'LOF7 C8000',
                    exchange: 'NYMEX', currency: 'USD', right: 'C', strike: 80, lastTradeDateOrContractMonth: '20261216',
                    multiplier: '1000', underConId: 556 };
                const clf7 = { conId: 556, secType: 'FUT', symbol: 'CL', tradingClass: 'CL', localSymbol: 'CLF7',
                    exchange: 'NYMEX', currency: 'USD', lastTradeDateOrContractMonth: '20261217', contractMonth: '202701',
                    multiplier: '1000' };
                await synthetic('contracts', { available: true, details: [
                    { match: { tradingClass: 'LO', strike: 80 }, result: [lof7, Object.assign({}, lof7, { conId: 9004 })] }] });
                await query(/不能采纳/);
                check.ok('two candidates: nothing is chosen for the user', /多张候选合约/.test(text('binding-status'))
                    && $('binding-confirm').hidden, text('binding-status'));
                await synthetic('contracts', { available: true, details: [
                    { match: { tradingClass: 'LO', strike: 80 }, result: [lof7] }, { match: { conId: 556 }, result: [clf7] }] });
                await query(/券商已证明对应期货/);
                const changes = Array.from($('binding-result').querySelectorAll('table'))[1];
                const lines = Array.from(changes.querySelectorAll('tr')).slice(1).map((line) => line.textContent);
                check.ok('the preview lists the binding revision and the term it fills in',
                    lines.some((line) => /LOF7 C8000 → CLF7.*人工核实 → 券商验证/.test(line))
                    && lines.some((line) => /期权条款补全 conId/.test(line)), lines);
                check.expect('asking wrote nothing', record.sent.filter((action) => WRITES.has(action)), []);
                click('binding-adopt');
                await waitFor('the adoption', () => /已采纳/.test(text('binding-status')), 30000);
                await waitFor('the reloaded ledger', () => rows('options-table').some((cells) => cells[2] === '80'
                    && cells[6] === '券商验证'));
                check.ok('the option is now bound on broker evidence', rows('options-table').some((cells) =>
                    cells[2] === '80' && cells[5] === 'CLF7' && cells[6] === '券商验证'), rows('options-table'));
                check.expect('after the adoption no confirmation is offered (as rendered)',
                    getComputedStyle($('binding-confirm')).display, 'none');
            } finally {
                record.stop();
            }
            check.expect('one adoption was sent', record.sent.filter((action) => WRITES.has(action)),
                ['commit_cost_basis_fop_metadata']);
            return check.done({ sent: record.sent });
        },

        async reconcile() {
            const check = checker('reconcile');
            const record = recorder();
            try {
                await loaded();
                const item = (localSymbol, conId, position, averageCost) => ({ account: ACCOUNT, conId,
                    secType: / /.test(localSymbol) ? 'FOP' : 'FUT', symbol: 'CL', localSymbol, expDate: '',
                    right: / /.test(localSymbol) ? 'C' : '', strike: 0, multiplier: '1000', tradingClass: '',
                    position, averageCost });
                const held = [item('CLF7', 556, 2, 72505), item('LOZ6 C7500', 9001, -1, 1200),
                    item('LOZ6 P6500', 9002, 1, 800), item('LOF7 C8000', 9003, -1, 1497.5)];
                const read = async (expect) => {
                    const before = text('reconcile-status');
                    click('reconcile-read');
                    await waitFor('the positions', () => text('reconcile-status') !== before
                        && !/正在读取/.test(text('reconcile-status')) && expect.test(text('reconcile-status')));
                };
                await synthetic('positions', { available: false });
                await read(/没有 TWS 持仓.*不会声称已对账/);
                await synthetic('positions', { available: true, accounts: [], items: held });
                await read(/不在当前 TWS 中/);
                check.expect('an account TWS does not manage is not reconciled', rows('reconcile-summary')[0][1], '未核对');
                await synthetic('positions', { available: true, accounts: [ACCOUNT], items: held });
                await read(/数量全部一致/);
                check.expect('quantity, AvgCost, binding and cash apart', rows('reconcile-summary').map((cells) => cells[1]),
                    ['数量一致', '一致（旁证）', '完整', '未核对']);
                check.expect('every contract matched', rows('reconcile-table').map((cells) => [cells[0], cells[1], cells[2],
                    cells[3]]), [['CLF7', '2', '2', '数量一致'], ['LOF7 C8000', '-1', '-1', '数量一致'],
                    ['LOZ6 C7500', '-1', '-1', '数量一致'], ['LOZ6 P6500', '1', '1', '数量一致']]);
                const version = page().inspect().version.digest;
                setValue('snapshot-note', 'after the closeout checks');
                click('snapshot-save');
                click('snapshot-save');
                await waitFor('the snapshot', () => /已保存快照/.test(text('snapshot-status')), 30000);
                check.ok('reconciled on matching positions; no economic change', /数量已与 TWS 对上；经济流水未改变/
                    .test(text('snapshot-status')), text('snapshot-status'));
                check.expect('a snapshot changes no ledger version', page().inspect().version.digest, version);
                await waitFor('the snapshot list', () => rows('snapshot-list').length === 1);
                setValue('snapshot-pick', $('snapshot-pick').options[1].value);
                check.ok('the snapshot reads back with its version and comparisons',
                    /对应当前账本版本/.test(text('snapshot-detail')) && /数量一致/.test(text('snapshot-detail')),
                    text('snapshot-detail'));
                await synthetic('positions', { available: true, accounts: [ACCOUNT],
                    items: [item('CLF7', 556, 1, 72505)].concat(held.slice(1)) });
                await read(/数量不一致/);
                click('snapshot-save');
                await waitFor('the second snapshot', () => /未对账/.test(text('snapshot-status')), 30000);
                await waitFor('the snapshot list', () => rows('snapshot-list').length === 2);
                check.expect('a mismatch is kept, never reconciled', rows('snapshot-list')[0].slice(3, 6),
                    ['数量不一致', '一致（旁证）', '否']);
                // Review P5-C3: a conId that disagrees is another contract, whatever its local symbol.
                await synthetic('positions', { available: true, accounts: [ACCOUNT],
                    items: [item('CLF7', 999999, 2, 72505)].concat(held.slice(1)) });
                click('reconcile-read');
                await waitFor('the conflicting positions', () => rows('reconcile-table')
                    .some((cells) => /身份冲突/.test(cells.join(' '))));
                const conflict = rows('reconcile-table').filter((cells) => cells[0] === 'CLF7');
                check.expect('a conId conflict is two contracts, never one match', conflict.map((cells) => cells.slice(1, 4)),
                    [['2', '0', '数量不一致'], ['0', '2', '数量不一致']]);
                check.ok('the conflict names both conIds', /conId 999999.*conId 556/.test(conflict[1][7]), conflict[1][7]);
                check.expect('a conflict is never reconciled', rows('reconcile-summary')[0][1], '数量不一致');
                // Some AvgCost comparable and the rest not (the future's multiplier is missing): partial.
                await synthetic('positions', { available: true, accounts: [ACCOUNT],
                    items: [Object.assign(item('CLF7', 556, 2, 72505), { multiplier: '' })].concat(held.slice(1)) });
                await read(/数量全部一致/);
                check.expect('a partly comparable AvgCost is partial, the quantities still agree',
                    rows('reconcile-summary').slice(0, 2).map((cells) => cells[1]), ['数量一致', '部分一致、部分不可比']);
                click('snapshot-save');
                await waitFor('the third snapshot', () => rows('snapshot-list').length === 3, 30000);
                check.expect('the partial AvgCost is kept as it was shown', rows('snapshot-list')[0].slice(3, 6),
                    ['数量一致', '部分一致、部分不可比', '是']);
            } finally {
                record.stop();
            }
            check.expect('one save per confirmation', record.sent.filter((action) => action === 'save_cost_basis_snapshot').length, 3);
            return check.done({ sent: record.sent });
        },

        async messages() {
            const check = checker('messages');
            const record = recorder();
            try {
                await loaded();
                setChecked('import-confirm-account', false);
                setFile('import-file', 'masked.csv', statementText('U****1111'));
                await waitFor('the blocked preview', () => /账户号被遮罩/.test(text('import-problems')));
                const problem = $('import-problems').children[0];
                check.ok('the block says why, where and what to do, with its code',
                    /下一步：.*勾选“报表中的遮罩账户就是本账本的账户”后重新预览。\[account_confirmation_required\]/
                        .test(problem.firstChild.textContent), problem.textContent);
                check.ok('the original stays beside it', /原文：.*U\*\*\*\*1111/.test(problem.textContent), problem.textContent);
                setChecked('import-confirm-account', true);
                await waitFor('the preview again', () => /没有阻断问题/.test(text('import-problems')));
                check.expect('following the next step clears the block', page().inspect().importPlan.blocking, false);
                setChecked('import-confirm-account', false);
            } finally {
                record.stop();
            }
            check.expect('explaining writes nothing', record.sent.filter((action) => WRITES.has(action)), []);
            return check.done({ sent: record.sent });
        },

        async actions() {
            const check = checker('actions');
            const received = await backendActions();
            const allowed = new Set(globalScope.OptionComboCostBasisCommon.actionsForPage('fop'));
            check.expect('actions outside the FOP page catalogue', received.filter((action) => !allowed.has(action)), []);
            check.expect('forbidden actions', received.filter((action) => FORBIDDEN.test(action)), []);
            const writes = received.filter((action) => WRITES.has(action));
            // Every economic write and snapshot is an explicit confirmation: the
            // create, the refused and the claimed import, the restore; then the
            // closeout: a same-fill and an another-fill import, one manual entry
            // confirmed twice (one event), one binding adoption, three snapshots.
            check.expect('the writes the backend received', writes,
                ['create_cost_basis_book', 'import_cost_basis_events', 'import_cost_basis_events',
                    'restore_cost_basis_backup', 'import_cost_basis_events', 'import_cost_basis_events',
                    'append_cost_basis_event', 'append_cost_basis_event', 'commit_cost_basis_fop_metadata',
                    'save_cost_basis_snapshot', 'save_cost_basis_snapshot', 'save_cost_basis_snapshot']);
            return check.done({ received });
        },
    };

    async function run(phase) {
        const step = phases[phase];
        if (!step) throw new Error(`unknown phase ${phase}`);
        try {
            return await step();
        } catch (error) {
            return { phase, failures: 1, error: String(error && error.stack || error), results: [] };
        }
    }

    globalScope.OptionComboFopBrowserAssertions = Object.freeze({ run, phases: Object.keys(phases), statementText });
})(typeof window !== 'undefined' ? window : globalThis);
