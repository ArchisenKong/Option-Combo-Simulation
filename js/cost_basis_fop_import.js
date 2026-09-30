/**
 * IBKR statement CSV -> FOP ledger import plan (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md
 * §9, §13.3 P4). DOM-free and Node-testable; the FOP page loads it after
 * js/cost_basis_import_common.js and js/cost_basis_fop_core.js.
 *
 * Three steps, all pure:
 *
 * - readStatement(text, {capabilities}) reads a file: its format, account,
 *   period and timezone evidence, every row's capability key and status
 *   (plan §9.7), and the evidence sections (instruments, open positions).
 * - planImport(statement, context) turns it into what this ledger would
 *   receive: contracts, bindings, source records and events, the rows that
 *   duplicate stored history, the TWS executions the statement supersedes,
 *   the quantity proof, and every problem. It never writes.
 * - buildImportRequest / buildRebuildRequest turn a plan without blocking
 *   problems into the exact request the page sends (ImportRequest,
 *   FopRebuildRequest in tests/fixtures/cost_basis_fop/contract/protocol.json).
 *
 * Rules this importer will not bend:
 *
 * - A row it cannot place is a problem, never silently dropped: an economic
 *   row of this ledger that cannot be read blocks the batch (plan §9.4).
 *   Sections outside the first release (cash, daily settlement) are listed as
 *   out of scope and neither block nor write (plan §6.3).
 * - Contracts are real contracts: a FUT's delivery month comes from a
 *   delivery-month field or its exchange local symbol, never from a last-trade
 *   or expiry date (plan §4.1); rows of another root (MCL is not CL) belong to
 *   another ledger.
 * - Times keep what the statement says: an account-local time becomes a UTC
 *   instant only in a known timezone, a local time the clock repeats becomes
 *   the range of both readings, and a date without a time becomes a range
 *   (plan §9.2). Nothing is guessed from the machine's timezone. Where rows
 *   share a second, the file's row order is not evidence of which came
 *   first: a statement sorts its rows, and another contract's row in the
 *   same second would renumber them. Such rows carry no order evidence, and
 *   the core refuses them when their order changes the result (plan §9.2).
 * - The same fill never counts twice: a repeated reference is left to the
 *   server's revision check; the same fill in another format is matched one
 *   to one by its content, also across order and execution granularity; a
 *   TWS execution the statement repeats is superseded, never kept beside it.
 *   A possible duplicate that cannot be proven blocks the batch until the
 *   user decides it is a stored fill or another one, stating the check; the
 *   request carries the decision and the server checks it again.
 */
(function attachCostBasisFopImport(globalScope) {
    'use strict';

    const Common = globalScope.OptionComboCostBasisImportCommon;
    if (!Common) {
        throw new Error('js/cost_basis_import_common.js must load before js/cost_basis_fop_import.js');
    }

    const PACKAGE_VERSION = 1;
    const EPSILON = 1e-9;
    const PRICE_TOLERANCE = 1e-6;
    const FEE_TOLERANCE = 0.005;
    const MONTH_CODES = Object.freeze({
        F: '01', G: '02', H: '03', J: '04', K: '05', M: '06',
        N: '07', Q: '08', U: '09', V: '10', X: '11', Z: '12',
    });
    const MONTH_WORDS = Object.freeze({
        JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
        JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
    });
    // What a product rule version fixes about its contracts (plan §4.2).
    // The server checks root, exchange, currency and rule version; the rest
    // are the terms a statement does not print.
    const PRODUCT_RULES = Object.freeze({
        'NYMEX-CL-v1': Object.freeze({
            root: 'CL', exchange: 'NYMEX', currency: 'USD', exchangeTimeZone: 'America/Chicago',
            futurePointValue: 1000, premiumMultiplier: 1000, deliverableFuturesPerOption: 1,
            settlementType: 'physical_future', exerciseStyle: 'american', futureClass: 'CL',
            // An option known only by its expiry date expires at this exchange-local
            // time (stress contract §3.4); an exact optionExpiryAsOf always wins.
            optionExpiryLocalTime: '13:30:00',
        }),
    });
    // Timezone abbreviations a statement's WhenGenerated line may carry. Only
    // unambiguous ones: CST is also China Standard Time and names nothing.
    const ZONE_ABBREVIATIONS = Object.freeze({
        EST: 'America/New_York', EDT: 'America/New_York',
        CDT: 'America/Chicago',
        MST: 'America/Denver', MDT: 'America/Denver',
        PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
        GMT: 'Etc/UTC', UTC: 'Etc/UTC',
        BST: 'Europe/London', CET: 'Europe/Berlin', CEST: 'Europe/Berlin',
        HKT: 'Asia/Hong_Kong', JST: 'Asia/Tokyo',
    });

    const upper = Common.upper;
    const number = Common.number;
    const normalizeHeader = Common.normalizeHeader;

    // ------------------------------------------------------------------
    // Time (plan §9.2): account-local wall clock -> UTC instants or ranges
    // ------------------------------------------------------------------

    const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

    function pad(value, width) {
        return String(value).padStart(width, '0');
    }

    /** A UtcInstant (six fractional digits) from epoch milliseconds. */
    function instantOf(millis) {
        const stamp = new Date(millis);
        return `${stamp.getUTCFullYear()}-${pad(stamp.getUTCMonth() + 1, 2)}-${pad(stamp.getUTCDate(), 2)}`
            + `T${pad(stamp.getUTCHours(), 2)}:${pad(stamp.getUTCMinutes(), 2)}:${pad(stamp.getUTCSeconds(), 2)}`
            + `.${pad(stamp.getUTCMilliseconds(), 3)}000Z`;
    }

    const formatters = new Map();
    function wallClock(millis, timeZone) {
        if (!formatters.has(timeZone)) {
            formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
                timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
            }));
        }
        const parts = {};
        for (const part of formatters.get(timeZone).formatToParts(new Date(millis))) {
            parts[part.type] = part.value;
        }
        return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
            Number(parts.hour), Number(parts.minute), Number(parts.second));
    }

    function knownZone(timeZone) {
        try {
            wallClock(0, timeZone);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * An account-local 'YYYY-MM-DDTHH:MM:SS' in an IANA zone as UTC:
     * {instant}, {range: [first, last]} when the clock shows that time twice
     * (the end of daylight saving time), or {error} when it never shows it.
     */
    function localToUtc(local, timeZone) {
        const match = LOCAL_RE.exec(String(local || ''));
        if (!match) return { error: `${local} is not a local date and time` };
        if (!timeZone || !knownZone(timeZone)) return { error: `unknown timezone ${timeZone}` };
        const naive = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
            Number(match[4]), Number(match[5]), Number(match[6]));
        const offsets = new Set();
        for (const probe of [-36, -12, 0, 12, 36]) {
            const at = naive + probe * 3600000;
            offsets.add(wallClock(at, timeZone) - at);
        }
        const candidates = [...offsets].map((offset) => naive - offset)
            .filter((utc) => wallClock(utc, timeZone) === naive).sort((a, b) => a - b);
        const unique = [...new Set(candidates)];
        if (!unique.length) return { error: `${local} does not exist in ${timeZone} (a clock change skips it)` };
        if (unique.length === 1) return { instant: instantOf(unique[0]) };
        return { range: [instantOf(unique[0]), instantOf(unique[unique.length - 1])] };
    }

    /** The UTC range of a whole local day, [00:00, next 00:00], in a zone. */
    function dayRange(isoDate, timeZone, daysBefore) {
        const start = new Date(Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1,
            Number(isoDate.slice(8, 10)) - (daysBefore || 0)));
        const end = new Date(Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1,
            Number(isoDate.slice(8, 10)) + 1));
        const local = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-`
            + `${pad(date.getUTCDate(), 2)}T00:00:00`;
        const first = localToUtc(local(start), timeZone);
        const last = localToUtc(local(end), timeZone);
        if (first.error || last.error) return { error: first.error || last.error };
        return { range: [first.instant || first.range[0], last.instant || last.range[1]] };
    }

    // ------------------------------------------------------------------
    // Capabilities (plan §9.7)
    // ------------------------------------------------------------------

    function capabilityIndex(document) {
        if (!document || document.format !== 'cost-basis-fop-capabilities' || !document.mapping) {
            throw new Error('the FOP importer needs cost_basis_fop_capabilities.json');
        }
        return {
            document,
            mapping: document.mapping,
            mappingVersion: document.importMappingVersion,
            status: new Map(document.keys.map((entry) => [entry.key, entry.status])),
        };
    }

    function statusOf(capabilities, key) {
        return capabilities.status.get(key) || 'unknown';
    }

    // ------------------------------------------------------------------
    // Reading a statement
    // ------------------------------------------------------------------

    function assetOf(mapping, value) {
        const text = normalizeHeader(value);
        for (const [asset, aliases] of Object.entries(mapping.assetClasses)) {
            if (aliases.includes(text)) return asset;
        }
        return text ? 'other' : '';
    }

    /**
     * The row as the statement prints it (plan §8.1): every named column in
     * header order, empty cells included, so the server maps the columns the
     * way the importer did; a repeated header keeps each value (#2, #3).
     */
    function rawFieldsOf(headers, values) {
        const raw = {};
        const seen = new Map();
        headers.forEach((header, index) => {
            const name = String(header || '').trim();
            if (!name) return;
            const count = (seen.get(name) || 0) + 1;
            seen.set(name, count);
            const value = values[index];
            raw[count === 1 ? name : `${name}#${count}`] = value === undefined || value === null ? '' : String(value);
        });
        return raw;
    }

    function recordOf(built, values) {
        const fields = {};
        for (const [field, index] of Object.entries(built.mapping)) fields[field] = values[index];
        return fields;
    }

    function sectionKeyOf(mapping, name) {
        for (const [key, aliases] of Object.entries(mapping.sections)) {
            if (Common.sectionMatches(name, aliases)) return key;
        }
        return null;
    }

    function codesOf(value) {
        return upper(value).split(/[;,\s|]+/).filter(Boolean);
    }

    function detectFormat(rows, mapping) {
        if (!rows.length) return null;
        const sectioned = rows.some((row) => ['header', 'data'].includes(normalizeHeader(row[1])));
        const known = rows.some((row) => {
            const key = sectionKeyOf(mapping, row[0]);
            return key === 'trades' || key === 'accountInformation' || key === 'statement';
        });
        if (sectioned && known) return 'activity_csv';
        const built = Common.buildMapping(rows[0], mapping.columns);
        const mapped = Object.keys(built.mapping);
        if (mapped.includes('symbol') && mapped.includes('quantity') && mapped.length >= 4) return 'flex_csv';
        return null;
    }

    /**
     * The file as rows with capability keys, before any ledger is involved.
     * options.capabilities is the parsed cost_basis_fop_capabilities.json.
     */
    function readStatement(text, options = {}) {
        const capabilities = capabilityIndex(options.capabilities);
        const mapping = capabilities.mapping;
        const rows = Common.parseCsv(text);
        const statement = {
            fileName: options.fileName || null, format: null, account: '', period: { from: '', through: '' },
            timeZoneEvidence: null, trades: [], details: [], instruments: [], openPositions: [], outOfScope: [],
            otherSections: [], problems: [], capabilities, rowsRead: rows.length, sections: new Set(),
        };
        if (rows.error) {
            statement.problems.push(problem('file_damaged', rows.error, null, true));
            return statement;
        }
        statement.format = detectFormat(rows, mapping);
        if (!statement.format) {
            statement.problems.push(problem('format_unknown',
                'this file is neither an Activity Statement nor a Flex trades export', null, true));
            return statement;
        }
        if (statement.format === 'activity_csv') readActivity(rows, statement, mapping);
        else readFlex(rows, statement, mapping);
        return statement;
    }

    function readActivity(rows, statement, mapping) {
        statement.account = Common.extractAccount(rows, mapping.sections.accountInformation);
        statement.period = Common.extractStatementPeriod(rows);
        for (const row of rows) {
            if (sectionKeyOf(mapping, row[0]) !== 'statement' || normalizeHeader(row[1]) !== 'data') continue;
            if (normalizeHeader(row[2]) === 'whengenerated') {
                const abbreviation = /\b([A-Z]{2,5})\s*$/.exec(String(row[3] || '').trim());
                statement.timeZoneEvidence = {
                    text: String(row[3] || '').trim(),
                    zone: abbreviation ? ZONE_ABBREVIATIONS[abbreviation[1]] || null : null,
                    abbreviation: abbreviation ? abbreviation[1] : null,
                };
            }
        }
        // Group rows by section and the header in force when they were read.
        const names = new Map();
        let current = null;
        rows.forEach((row, index) => {
            const type = normalizeHeader(row[1]);
            if (type !== 'header' && type !== 'data') return;
            const key = sectionKeyOf(mapping, row[0]);
            if (type === 'header') {
                current = { name: String(row[0]).trim(), key, headers: row.slice(2),
                    built: Common.buildMapping(row.slice(2), mapping.columns) };
                if (key) statement.sections.add(key);
                return;
            }
            if (!current || normalizeHeader(current.name) !== normalizeHeader(row[0])) {
                statement.problems.push(problem('row_without_header',
                    `line ${index + 1}: a ${row[0]} data row comes before its header`, index + 1, false));
                return;
            }
            const line = index + 1;
            const values = row.slice(2);
            const entry = { line, section: current.name, headers: current.headers, values,
                raw: rawFieldsOf(current.headers, values), fields: recordOf(current.built, values) };
            if (key === 'trades') statement.trades.push(entry);
            else if (key === 'instruments') statement.instruments.push(entry);
            else if (key === 'openPositions') statement.openPositions.push(entry);
            else if (key === 'cashReport' || key === 'markToMarket' || key === 'statementOfFunds') {
                const asset = key === 'markToMarket' ? 'summary' : 'cash';
                statement.outOfScope.push({ line, section: current.name,
                    key: `activity/${mapping.sectionSlugs[key]}/ALL/${asset}` });
            } else if (key === null) {
                names.set(current.name, (names.get(current.name) || 0) + 1);
            }
        });
        statement.otherSections = [...names].map(([name, count]) => ({ name, rows: count }));
        // Order rows summarize their executions (Trade rows). The finest
        // evidence wins; an order is kept only when it lists no executions,
        // and the executions of an order must add up to it. Only the detail
        // rows the mapping names (closed lots) repeat a trade and are left
        // out; a row of any other kind stays, marked, so that it blocks if it
        // belongs to this ledger (plan §9.4).
        const trades = statement.trades;
        const discriminated = trades.filter((entry) => entry.fields.discriminator !== undefined);
        if (discriminated.length) {
            const kinds = mapping.discriminators;
            const kept = [];
            let order = null;
            for (const entry of trades) {
                const kind = normalizeHeader(entry.fields.discriminator);
                if (entry.fields.discriminator === undefined) {
                    kept.push({ entry, fills: [] });
                    order = null;
                } else if (kinds.order.includes(kind)) {
                    order = { entry, fills: [] };
                    kept.push(order);
                } else if (kinds.execution.includes(kind)) {
                    if (order && upper(order.entry.fields.symbol) === upper(entry.fields.symbol)) {
                        order.fills.push(entry);
                    } else {
                        kept.push({ entry: null, fills: [entry] });
                    }
                } else if (kinds.detail.includes(kind)) {
                    statement.details.push(entry);
                } else {
                    kept.push({ entry: Object.assign(entry, {
                        unknownKind: String(entry.fields.discriminator || '').trim() }), fills: [] });
                }
            }
            statement.trades = [];
            for (const group of kept) {
                if (group.entry && group.fills.length) {
                    const problemText = reconcileOrder(group.entry, group.fills);
                    if (problemText) {
                        statement.problems.push(problem('order_fills_differ',
                            `line ${group.entry.line}: ${problemText}`, group.entry.line, true));
                    }
                    for (const fill of group.fills) statement.trades.push(Object.assign(fill, { orderLine: group.entry.line }));
                } else if (group.entry) {
                    statement.trades.push(group.entry);
                } else {
                    statement.trades.push(...group.fills);
                }
            }
        }
    }

    function reconcileOrder(order, fills) {
        const quantity = number(order.fields.quantity);
        const price = number(order.fields.price);
        const commission = number(order.fields.commission) || 0;
        let total = 0;
        let notional = 0;
        let fees = 0;
        for (const fill of fills) {
            const q = number(fill.fields.quantity);
            total += q;
            notional += q * number(fill.fields.price);
            fees += number(fill.fields.commission) || 0;
        }
        if (Math.abs(total - quantity) > EPSILON) {
            return `the order is ${quantity} but its executions add up to ${total}`;
        }
        if (Math.abs(notional / total - price) > PRICE_TOLERANCE) {
            return `the order price ${price} is not the average of its executions (${notional / total})`;
        }
        if (Math.abs(fees - commission) > FEE_TOLERANCE) {
            return `the order commission ${commission} is not the sum of its executions (${fees})`;
        }
        return '';
    }

    function readFlex(rows, statement, mapping) {
        const headers = rows[0];
        const built = Common.buildMapping(headers, mapping.columns);
        rows.slice(1).forEach((values, index) => {
            const entry = { line: index + 2, section: 'Trades', headers, values,
                raw: rawFieldsOf(headers, values), fields: recordOf(built, values) };
            // A Flex export repeats its header when it holds several accounts.
            if (normalizeHeader(values[built.mapping.symbol]) === normalizeHeader(headers[built.mapping.symbol])) return;
            statement.trades.push(entry);
        });
        const accounts = new Set(statement.trades.map((entry) => String(entry.fields.account || '').trim()).filter(Boolean));
        if (accounts.size > 1) {
            statement.problems.push(problem('several_accounts',
                `this export holds ${accounts.size} accounts; export one account per file`, null, true));
        }
        statement.account = [...accounts][0] || '';
        const dates = statement.trades.map((entry) => Common.isoDate(entry.fields.tradeDate || entry.fields.dateTime))
            .filter(Boolean).sort();
        // A Flex trades export prints no period: coverage is what its rows span.
        statement.period = { from: dates[0] || '', through: dates[dates.length - 1] || '', fromRows: true };
    }

    function problem(code, message, line, blocking) {
        return { code, message, line: line || null, blocking: Boolean(blocking) };
    }

    // ------------------------------------------------------------------
    // Contracts (plan §4.1, §4.2)
    // ------------------------------------------------------------------

    const FUT_SYMBOL = /^([A-Z0-9]{1,4}?)([FGHJKMNQUVXZ])(\d{1,2})$/;
    const FOP_SYMBOL = /^([A-Z][A-Z0-9]{0,3}?)\s?([FGHJKMNQUVXZ])(\d{1,2})\s+([CP])\s?(\d+(?:\.\d+)?)$/;
    const OPTION_DESCRIPTION = /^([A-Z0-9]+)\s+(\d{1,2})([A-Z]{3})(\d{2}|\d{4})\s+([0-9.]+)\s+([CP])$/;

    /** 'YYYYMM' from a month code and a year digit, not before the trade year. */
    function monthFromCode(code, yearText, tradeDate) {
        const month = MONTH_CODES[code];
        if (!month) return null;
        if (yearText.length === 2) return `20${yearText}${month}`;
        const tradeYear = Number((tradeDate || '').slice(0, 4));
        if (!tradeYear) return null;
        const digit = Number(yearText);
        const year = tradeYear + ((digit - (tradeYear % 10) + 10) % 10);
        return `${year}${month}`;
    }

    function monthField(value) {
        const digits = String(value || '').replace(/[^0-9]/g, '');
        if (digits.length === 6) return digits;
        if (digits.length === 8) return null;   // a date, never a delivery month (plan §4.1)
        return null;
    }

    function isoDateOrNull(value) {
        const date = Common.isoDate(value);
        return date || null;
    }

    function tokenPart(text) {
        return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    }

    function strikeText(strike) {
        return String(strike).replace('.', 'p');
    }

    /**
     * Instrument evidence keyed by local symbol and conId: what the
     * Financial Instrument Information rows say about each contract.
     */
    function instrumentEvidence(statement, mapping) {
        const bySymbol = new Map();
        const byConId = new Map();
        for (const entry of statement.instruments) {
            const fields = entry.fields;
            const asset = assetOf(mapping, fields.assetClass);
            if (asset !== 'FUT' && asset !== 'FOP') continue;
            const item = { asset, line: entry.line, raw: entry.raw, fields,
                symbol: upper(fields.symbol), conId: number(fields.conId) };
            if (item.symbol) bySymbol.set(item.symbol, item);
            if (item.conId) byConId.set(item.conId, item);
        }
        return { bySymbol, byConId };
    }

    // ------------------------------------------------------------------
    // Planning an import
    // ------------------------------------------------------------------

    /**
     * What the statement would add to one ledger. context:
     * - book: {bookId, account, symbol, currency, fop: {productRules, historyScope, engineVersion}}
     * - graph: the ledger's exported graph (BackupPayloadV2 payload), or null
     *   before a ledger exists (a read-only preview);
     * - timeZone: the account's statement timezone (IANA) when the user states
     *   it; otherwise the statement's own WhenGenerated evidence is used;
     * - observedAtUtc: when this preview reads the statement (a UtcInstant);
     * - accountConfirmation: {sourceAccount, targetAccount} for a masked account;
     * - baselinePrices: {localSymbol: {kind: 'trade_cost'|'reference_price', price}}.
     */
    function planImport(statement, context) {
        const capabilities = statement.capabilities;
        const mapping = capabilities.mapping;
        const book = context.book;
        const rules = PRODUCT_RULES[book.fop.productRules];
        const plan = {
            statement, format: statement.format, mappingVersion: capabilities.mappingVersion,
            account: book.account, rows: [], contracts: [], bindings: [], bindingRequests: [],
            // Stored unresolved bindings this file proves, for an explicit adoption (plan §4.3).
            bindingUpgrades: [],
            sourceRecords: [], events: [], duplicates: [], supersede: [], quantityProof: [],
            openings: [], problems: statement.problems.slice(), warnings: [], timeZone: null,
            period: statement.period, checks: {}, rules,
            // Possible duplicates, what the user decided about them, and the
            // decisions the request carries (plan §19 P5-C1).
            duplicateReviews: [], decisions: [],
            decisionsGiven: new Map((context.duplicateDecisions || []).map((decision) => [
                `${decision.namespace}|${decision.sourceRef}`, decision])),
        };
        const fail = (code, message, line) => plan.problems.push(problem(code, message, line, true));
        const warn = (code, message, line) => plan.warnings.push(problem(code, message, line, false));
        if (!rules) {
            fail('product_rules_unknown', `product rules ${book.fop.productRules} are not supported`);
            return finish(plan);
        }
        if (!statement.format) return finish(plan);
        for (const entry of statement.outOfScope) {
            plan.rows.push({ line: entry.line, key: entry.key, status: statusOf(capabilities, entry.key),
                disposition: 'out_of_scope', section: entry.section });
        }
        for (const entry of statement.details) {
            plan.rows.push({ line: entry.line, section: entry.section, disposition: 'detail',
                reason: `a ${String(entry.fields.discriminator).trim()} row repeats its trade` });
        }

        // The account (plan §9.1): exact, or masked and confirmed for this file.
        // A preview without a ledger has no account to hold it to: it reads
        // the statement's own and says so (nothing it plans can be sent).
        const unchecked = !context.graph && !book.account;
        const accountMatch = unchecked
            ? { sourceAccount: upper(statement.account), targetAccount: '', status: 'unchecked' }
            : Common.matchStatementAccount(statement.account, book.account, context.accountConfirmation || null);
        plan.accountMatch = accountMatch;
        if (unchecked) {
            plan.account = accountMatch.sourceAccount;
            if (!plan.account) fail('account_missing', 'the statement names no account');
            else warn('account_unchecked', `no ledger: the statement's account ${plan.account} is not checked `
                + 'against one');
        } else if (accountMatch.status === 'missing') fail('account_missing', 'the statement names no account');
        else if (accountMatch.status === 'mismatch') {
            fail('account_mismatch', `the statement is for ${accountMatch.sourceAccount}, not ${book.account}`);
        } else if (accountMatch.status === 'confirmation_required') {
            fail('account_confirmation_required',
                `the statement account ${accountMatch.sourceAccount} is masked; confirm it is ${book.account}`);
        }

        // The timezone every local time is read in.
        const zone = context.timeZone || (statement.timeZoneEvidence && statement.timeZoneEvidence.zone) || null;
        if (zone && !knownZone(zone)) fail('timezone_unknown', `unknown timezone ${zone}`);
        plan.timeZone = zone && knownZone(zone)
            ? { name: zone, source: context.timeZone ? 'stated' : 'statement' } : null;
        if (!plan.timeZone) {
            fail('timezone_missing', statement.timeZoneEvidence && statement.timeZoneEvidence.abbreviation
                ? `the statement's timezone ${statement.timeZoneEvidence.abbreviation} names no single zone; `
                    + 'state the account timezone'
                : 'the statement names no timezone; state the account timezone');
        }
        if (!statement.period.from || !statement.period.through) {
            fail('period_missing', 'the statement names no period');
        } else if (statement.period.fromRows) {
            warn('period_from_rows', `a Flex export prints no period; coverage is ${statement.period.from}`
                + ` to ${statement.period.through}, the dates its rows span`);
        }

        const ledger = ledgerIndex(context.graph, book);
        const evidence = instrumentEvidence(statement, mapping);
        const contracts = contractResolver(plan, ledger, evidence, rules, book, context, fail, warn);

        // Rows -> readings (one per economic row of this ledger).
        const readings = [];
        const occurrences = new Map();
        statement.trades.forEach((entry, index) => {
            const reading = readTradeRow(entry, index, plan, statement, mapping, rules, book, contracts, fail, warn);
            if (!reading) return;
            if (reading.namespace === 'activity_row' || !reading.sourceRef) {
                const base = reading.sourceRef;
                const count = (occurrences.get(base) || 0) + 1;
                occurrences.set(base, count);
                if (count > 1) reading.sourceRef = `${base}-${count}`;
            }
            readings.push(reading);
        });
        plan.readings = readings;

        // Deliveries: the option row and the future row it delivered.
        const events = pairDeliveries(readings, plan, contracts, fail);

        // Against the ledger: repeats, other formats, TWS executions.
        matchLedger(events, ledger, plan, fail, warn);
        plan.realizedEvidence = realizedEvidence(readings, mapping);

        // Quantity proof and a baseline when the history starts before the file.
        proveQuantities(statement, events, ledger, plan, contracts, rules, book, context, mapping, fail, warn);
        // Which periods statements cover, independent of the quantities: a
        // month that opens and closes flat still needs its statement.
        checkCoverage(plan, context, ledger, events, warn);

        buildPackage(plan, events, contracts, book, context, ledger);
        checkReplay(plan, context, book);
        return finish(plan);
    }

    /**
     * The ledger with this plan replayed by the core (plan §9.2): an order no
     * evidence fixes or a close with nothing open is a problem here, before
     * the server refuses it.
     */
    function checkReplay(plan, context, book) {
        const core = globalScope.OptionComboCostBasisFopCore;
        if (!core || plan.problems.some((item) => item.blocking) || !plan.events.length) return;
        const graph = previewGraph(context.graph || null, plan, book);
        const trace = core.computeLedger(graph, { trace: true, rolls: false });
        // A closed cycle boundary still sits after its whole group, where
        // nothing is open (plan §9.2); a backfilled fill can undo that.
        const groupOf = new Map();
        for (const group of trace.groups) for (const id of group) groupOf.set(id, group);
        const after = new Map(trace.steps.map((step) => [step.after, step.positions]));
        for (const cycle of graph.cycles || []) {
            if (cycle.state !== 'closed' || (cycle.supersededByRevision !== null && cycle.supersededByRevision !== undefined)) continue;
            const group = groupOf.get(cycle.anchorEventId) || [cycle.anchorEventId];
            const open = after.get(group[group.length - 1]);
            if (open && Object.keys(open).length) {
                plan.problems.push(problem('cycle_boundary_violated', `cycle boundary ${cycle.boundaryId} would no `
                    + 'longer sit where nothing is open; revoke it or import the missing rows after it', null, true));
            }
        }
        for (const found of trace.problems) {
            const index = Number(String(found.eventId).replace('preview-', '')) - 1;
            const planned = plan.plannedEvents[index];
            const where = planned && planned.line ? `line ${planned.line}` : found.eventId;
            if (found.code === 'order_ambiguous') {
                plan.problems.push(problem('order_ambiguous', `${where}: fills of ${found.contracts.join(', ')} share a `
                    + 'time and their order changes the result; the statement gives no order for them', planned && planned.line, true));
            } else {
                plan.problems.push(problem('position_overdraw', `${where}: it closes more than is open at that point; `
                    + 'import the earlier history first', planned && planned.line, true));
            }
        }
    }

    function finish(plan) {
        plan.blocking = plan.problems.some((item) => item.blocking);
        return plan;
    }

    // ------------------------------------------------------------------
    // The ledger as the importer needs it
    // ------------------------------------------------------------------

    function ledgerIndex(graph, book) {
        const index = {
            contracts: [], contractById: new Map(), bindings: new Map(), events: [], sources: new Map(),
            historyScope: book.fop.historyScope, recordedDecisions: new Map(),
        };
        if (!graph) return index;
        // Same-fill decisions earlier imports recorded (their answers in the request log).
        for (const request of graph.requests || []) {
            if (request.action !== 'import') continue;
            let answer = null;
            try {
                answer = JSON.parse(request.resultJson);
            } catch (_) {
                continue;
            }
            for (const decision of (answer && answer.duplicateDecisions) || []) {
                if (decision.decision !== 'same_fill') continue;
                index.recordedDecisions.set(`${decision.namespace}|${decision.sourceRef}`, Object.assign({
                    importBatchId: answer.importBatchId || null, recordedAtUtc: request.createdAtUtc }, decision));
            }
        }
        for (const stored of graph.contracts || []) {
            if (stored.supersededByRevision === null || stored.supersededByRevision === undefined) {
                index.contracts.push(stored.record);
                index.contractById.set(stored.record.contractId, stored.record);
            }
        }
        for (const binding of graph.bindings || []) {
            if (binding.supersededByRevision === null || binding.supersededByRevision === undefined) {
                index.bindings.set(binding.optionContractId, binding);
            }
        }
        const sourceById = new Map((graph.sources || []).map((source) => [source.sourceId, source]));
        const allocations = new Map();
        for (const allocation of graph.allocations || []) {
            if (!allocations.has(allocation.eventId)) allocations.set(allocation.eventId, []);
            allocations.get(allocation.eventId).push(allocation);
        }
        const records = new Map();
        for (const stored of graph.contracts || []) {
            records.set(`${stored.record.contractId}#${stored.record.revision}`, stored.record);
        }
        for (const stored of graph.events || []) {
            const row = stored.row;
            const sources = (allocations.get(row.eventId) || []).map((allocation) => {
                const source = sourceById.get(allocation.sourceId);
                return Object.assign({}, allocation, { namespace: source.namespace, sourceRef: source.sourceRef,
                    account: source.account, rawFields: source.rawFields || {} });
            });
            const reference = (ref) => (ref ? records.get(`${ref.contractId}#${ref.revision}`) || null : null);
            const item = { row, sources, contract: reference(row.fop.contractRef),
                delivered: reference(row.fop.deliveredContractRef), live: !row.voidedAtUtc };
            index.events.push(item);
            for (const source of sources) {
                index.sources.set(`${source.account}|${source.namespace}|${source.sourceRef}`, item);
            }
        }
        return index;
    }

    // Contract terms beyond the identity that a statement row can state.
    const STATED_TERMS = Object.freeze(['futurePointValue', 'premiumMultiplier', 'futureLastTradeDate',
        'settlementType', 'deliverableFuturesPerOption']);

    function identityKey(record) {
        if (record.secType === 'FUT') {
            return ['FUT', record.root, record.exchange, record.currency, record.tradingClass || '',
                record.futureContractMonth].join('|');
        }
        return ['FOP', record.root, record.exchange, record.currency, record.tradingClass || '',
            record.optionRight, String(Number(record.optionStrike)), record.optionExpiry].join('|');
    }

    /**
     * A new contract's record id: readable (its root and month, or option
     * terms) and scoped to its ledger. Record ids are unique across every
     * ledger of a database, while two accounts hold the same real contract.
     */
    function contractIdFor(book, record) {
        const base = record.secType === 'FUT'
            ? `fut-${tokenPart(record.root)}-${record.futureContractMonth}`
            : `fop-${tokenPart(record.root)}-${tokenPart(record.tradingClass || 'x')}-`
                + `${record.optionExpiry.replace(/-/g, '')}-${record.optionRight.toLowerCase()}`
                + `${strikeText(record.optionStrike)}`;
        return `${base}-${Common.hash16(`ledger|${book.bookId || ''}`).slice(0, 6)}`;
    }

    function contractResolver(plan, ledger, evidence, rules, book, context, fail, warn) {
        const byIdentity = new Map(ledger.contracts.map((record) => [identityKey(record), record]));
        const byConId = new Map(ledger.contracts.filter((record) => record.conId).map((record) => [record.conId, record]));
        const created = new Map();
        const observedAtUtc = context.observedAtUtc;
        return {
            evidence,
            /** The contract record of a reading, stored or new; null with a problem. */
            resolve(terms, line) {
                // The product rules fix what a statement row does not print.
                const candidate = Object.assign({ root: rules.root, exchange: rules.exchange,
                    currency: rules.currency }, terms);
                const key = identityKey(candidate);
                const stored = byIdentity.get(key);
                if (candidate.conId && byConId.has(candidate.conId)
                        && identityKey(byConId.get(candidate.conId)) !== key) {
                    fail('contract_conflict', `line ${line}: conId ${candidate.conId} is stored as `
                        + `${byConId.get(candidate.conId).contractId} with other terms`, line);
                    return null;
                }
                if (stored) {
                    if (candidate.conId && stored.conId && stored.conId !== candidate.conId) {
                        fail('contract_conflict', `line ${line}: ${stored.contractId} has conId ${stored.conId}, `
                            + `the statement says ${candidate.conId}`, line);
                        return null;
                    }
                    // The visible name is not the contract: every term the
                    // row states takes part (plan §9.1).
                    for (const field of STATED_TERMS) {
                        const value = candidate[field];
                        if (value !== undefined && value !== null && stored[field] !== undefined
                                && stored[field] !== null && value !== stored[field]) {
                            fail('contract_conflict', `line ${line}: ${stored.contractId} is stored with ${field} `
                                + `${stored[field]}, the statement says ${value}`, line);
                            return null;
                        }
                    }
                    return stored;
                }
                if (created.has(key)) {
                    const existing = created.get(key);
                    for (const field of ['conId', 'localSymbol', 'futureLastTradeDate', 'futurePointValue',
                        'premiumMultiplier']) {
                        if (candidate[field] !== undefined && existing[field] !== undefined
                                && candidate[field] !== null && existing[field] !== null
                                && candidate[field] !== existing[field]) {
                            fail('contract_conflict', `line ${line}: the file names ${existing.localSymbol || existing.contractId} `
                                + `with two different ${field} values`, line);
                            return null;
                        }
                    }
                    return existing;
                }
                const record = Object.assign({
                    revision: 1, root: rules.root, exchange: rules.exchange, currency: rules.currency,
                    ruleVersion: book.fop.productRules, evidenceStatus: 'verified_statement',
                    observedAtUtc,
                }, candidate);
                delete record.evidenceNote;
                record.contractId = contractIdFor(book, record);
                if (ledger.contracts.some((stored) => stored.contractId === record.contractId)) {
                    record.contractId = `${record.contractId}-${Common.hash16(key).slice(0, 6)}`;
                }
                created.set(key, record);
                plan.contracts.push(record);
                return record;
            },
            created,
            stored: ledger.contracts,
        };
    }

    // ------------------------------------------------------------------
    // One Trades row
    // ------------------------------------------------------------------

    function readTradeRow(entry, index, plan, statement, mapping, rules, book, contracts, fail, warn) {
        const fields = entry.fields;
        const format = statement.format === 'activity_csv' ? 'activity' : 'flex';
        const asset = assetOf(mapping, fields.assetClass);
        const line = entry.line;
        const record = (disposition, extra) => {
            const row = Object.assign({ line, section: entry.section, disposition }, extra || {});
            plan.rows.push(row);
            return row;
        };
        if (asset !== 'FUT' && asset !== 'FOP') {
            record('other_ledger', { reason: asset ? `asset class ${fields.assetClass}` : 'no asset class' });
            return null;
        }
        const symbol = upper(fields.symbol);
        const codes = codesOf(fields.codes);
        const code = mapping.codes;
        let event = 'trade';
        if (codes.includes(code.assignment)) event = asset === 'FOP' ? 'assignment' : 'delivery_leg';
        else if (codes.includes(code.exercise)) event = asset === 'FOP' ? 'exercise' : 'delivery_leg';
        else if (codes.includes(code.expiry) && asset === 'FOP') event = 'expiry';

        // Which root the row belongs to: the underlying future, never a
        // substring of the option or future symbol (MCL is not CL).
        let root = null;
        let futureSymbol = null;
        if (asset === 'FUT') {
            const parsed = FUT_SYMBOL.exec(symbol);
            root = upper(fields.underlyingSymbol) || (parsed ? parsed[1] : null);
            if (root && FUT_SYMBOL.test(root)) root = FUT_SYMBOL.exec(root)[1];
        } else {
            const info = contracts.evidence.bySymbol.get(symbol)
                || (number(fields.conId) ? contracts.evidence.byConId.get(number(fields.conId)) : null);
            const underlying = upper(fields.underlyingSymbol) || (info ? upper(info.fields.underlyingSymbol) : '');
            if (FUT_SYMBOL.test(underlying)) {
                futureSymbol = underlying;
                root = FUT_SYMBOL.exec(underlying)[1];
            } else {
                root = underlying || null;
            }
            if (!root) {
                const description = OPTION_DESCRIPTION.exec(upper(fields.description));
                root = description ? description[1] : null;
            }
        }
        if (!root) {
            record('problem', { reason: 'no underlying root' });
            fail('row_unreadable', `line ${line}: ${symbol || 'a row'} names no underlying root`, line);
            return null;
        }
        if (root !== rules.root) {
            record('other_ledger', { reason: `root ${root}` });
            return null;
        }

        const key = `${format}/trades/${asset}/${event}`;
        if (entry.unknownKind !== undefined) {
            record('problem', { key, status: statusOf(statement.capabilities, key),
                reason: `row kind ${entry.unknownKind || '(empty)'}` });
            fail('row_kind_unknown', `line ${line}: the ${symbol} row has DataDiscriminator `
                + `"${entry.unknownKind}", which is neither an order, an execution nor a closed lot; it can `
                + 'be neither read nor left out (plan §9.4)', line);
            return null;
        }
        const facts = rowFacts(entry, statement, plan, rules, asset, event, line, fail);
        if (!facts) {
            record('problem', { key, status: statusOf(statement.capabilities, key) });
            return null;
        }

        // The contract of the row.
        let candidate;
        let unsupportedKey = null;
        if (asset === 'FUT') {
            candidate = futureCandidate(entry, symbol, dateOf(facts.time), contracts.evidence, rules, line, fail);
        } else {
            candidate = optionCandidate(entry, symbol, contracts.evidence, rules, mapping, line, fail);
            if (candidate && candidate.unsupported) {
                unsupportedKey = `${format}/trades/FOP.${candidate.unsupported}/any`;
            }
        }
        if (unsupportedKey) {
            const status = statusOf(statement.capabilities, unsupportedKey);
            record('unsupported', { key: unsupportedKey, status });
            fail('row_unsupported', `line ${line}: ${symbol} is ${candidate.unsupported.replace('_', ' ')}; `
                + 'the first release does not support it (plan §1.2)', line);
            return null;
        }
        if (!candidate) {
            record('problem', { key, status: statusOf(statement.capabilities, key) });
            return null;
        }
        const contract = contracts.resolve(candidate.record, line);
        if (!contract) {
            record('problem', { key, status: statusOf(statement.capabilities, key) });
            return null;
        }
        const status = statusOf(statement.capabilities, key);
        const row = record('event', { key, status });
        if (status === 'unknown') {
            fail('capability_unknown', `line ${line}: ${key} is not a known row type`, line);
        }

        // The source record of the row (plan §8.1): its own reference.
        let namespace;
        let sourceRef;
        const tradeId = String(fields.tradeId || '').trim();
        const execId = String(fields.execId || '').trim();
        if (format === 'flex' && tradeId) {
            namespace = 'flex_trade';
            sourceRef = tradeId;
        } else if (format === 'flex' && execId) {
            namespace = 'ib_exec';
            sourceRef = execId;
        } else {
            namespace = format === 'flex' ? 'flex_trade' : 'activity_row';
            sourceRef = `${format === 'flex' ? 'flx' : 'act'}-${Common.hash16([
                upper(statement.account), fields.dateTime || '', fields.tradeDate || '', symbol,
                fields.quantity || '', fields.price || '', fields.proceeds || '', fields.commission || '',
                codes.join(' '), normalizeHeader(fields.discriminator),
            ].join('|'))}`;
        }
        return {
            line, row, key, status, asset, event, symbol, codes, contract, futureSymbol,
            candidate, facts, namespace, sourceRef, execId: execId || null, index,
            orderRef: String(fields.orderId || '').trim() || null,
            raw: entry.raw, section: entry.section, orderLine: entry.orderLine || null,
        };
    }

    /** Quantity, price, fees, cash and time of a Trades row. */
    function rowFacts(entry, statement, plan, rules, asset, event, line, fail) {
        const fields = entry.fields;
        const quantity = number(fields.quantity);
        if (quantity === null || quantity === 0 || Math.abs(quantity - Math.round(quantity)) > EPSILON) {
            fail('row_unreadable', `line ${line}: quantity ${fields.quantity} is not a whole number of contracts`, line);
            return null;
        }
        const price = number(fields.price);
        if (price === null && event !== 'expiry') {
            fail('row_unreadable', `line ${line}: no trade price`, line);
            return null;
        }
        const commission = number(fields.commission);
        if (commission === null && String(fields.commission || '').trim() !== '') {
            fail('row_unreadable', `line ${line}: commission ${fields.commission} is not a number`, line);
            return null;
        }
        const proceeds = number(fields.proceeds);
        const currency = upper(fields.currency);
        if (currency && currency !== rules.currency) {
            fail('row_currency', `line ${line}: the row is in ${currency}; this ledger is in ${rules.currency}`, line);
            return null;
        }
        const time = timeFacts(entry, statement, plan, rules, line, fail);
        if (!time) return null;
        // The realized P&L the statement states for the row: evidence beside
        // the ledger, never a figure of it (plan §19 P5-C4). Blank is no value.
        const realizedText = String(fields.realizedPnl === undefined ? '' : fields.realizedPnl).trim();
        return {
            quantity: Math.round(quantity), price, fees: Math.abs(commission || 0), commission: commission || 0,
            proceeds, time, realizedPnl: realizedText === '' ? null : number(realizedText),
            realizedColumn: fields.realizedPnl !== undefined,
        };
    }

    /**
     * What the statement says it realized, per contract of this ledger, for
     * its period (plan §19 P5-C4): the sum of its rows' stated realized P&L,
     * the closing rows that state none, and whether the file names its lot
     * method (a Flex FifoPnlRealized column is FIFO; an Activity Realized
     * P/L column does not say). Evidence only: it is compared with the
     * ledger, never written into it.
     */
    function realizedEvidence(readings, mapping) {
        const byContract = new Map();
        const closing = new Set([mapping.codes.close, mapping.codes.expiry, mapping.codes.assignment,
            mapping.codes.exercise].map(upper));
        for (const reading of readings) {
            // A file without the column states nothing to compare.
            if (!reading.contract || !reading.facts || !reading.facts.realizedColumn) continue;
            const id = reading.contract.contractId;
            if (!byContract.has(id)) {
                byContract.set(id, { contractId: id, localSymbol: reading.contract.localSymbol || id,
                    secType: reading.contract.secType, statementRealized: null, stated: 0, missing: 0,
                    method: 'unspecified', lines: [] });
            }
            const entry = byContract.get(id);
            const headers = Object.keys(reading.raw || {}).map((name) => normalizeHeader(name.replace(/#\d+$/, '')));
            if (headers.includes('fifopnlrealized')) entry.method = 'fifo';
            const value = reading.facts.realizedPnl;
            const closes = reading.codes.some((code) => closing.has(upper(code))) || reading.event !== 'trade';
            if (value === null || value === undefined) {
                if (closes) entry.missing += 1;
                continue;
            }
            entry.statementRealized = (entry.statementRealized || 0) + value;
            entry.stated += 1;
            entry.lines.push(reading.line);
        }
        return [...byContract.values()].filter((entry) => entry.stated || entry.missing);
    }

    function timeFacts(entry, statement, plan, rules, line, fail) {
        const fields = entry.fields;
        const text = String(fields.dateTime || '').trim();
        const local = Common.localTimestamp(text);
        const tradeDate = statement.format === 'flex_csv' ? isoDateOrNull(fields.tradeDate) : null;
        const zone = plan.timeZone ? plan.timeZone.name : null;
        const facts = { exchangeTradeDate: tradeDate, executedAtUtc: null, timeRange: null,
            sourceTimeText: text || (fields.tradeDate ? String(fields.tradeDate).trim() : null),
            sourceTimezone: null, orderEvidence: null };
        if (local) {
            if (!zone) return null;
            const converted = localToUtc(local, zone);
            if (converted.error) {
                fail('time_invalid', `line ${line}: ${converted.error}`, line);
                return null;
            }
            facts.sourceTimezone = zone;
            if (converted.instant) facts.executedAtUtc = converted.instant;
            else facts.timeRange = { startUtc: converted.range[0], endUtc: converted.range[1] };
            facts.local = local;
            return facts;
        }
        // No time of day: the exchange trade date covers the evening session
        // of the day before (plan §9.2); a calendar date covers its own day.
        const date = tradeDate || isoDateOrNull(text);
        if (!date) {
            fail('row_unreadable', `line ${line}: no trade date or time`, line);
            return null;
        }
        const range = tradeDate
            ? dayRange(date, rules.exchangeTimeZone, 1)
            : (zone ? dayRange(date, zone, 0) : null);
        if (!range || range.error) {
            fail('time_invalid', `line ${line}: ${range ? range.error : 'no timezone for a calendar date'}`, line);
            return null;
        }
        facts.timeRange = { startUtc: range.range[0], endUtc: range.range[1] };
        facts.sourceTimezone = tradeDate ? rules.exchangeTimeZone : zone;
        facts.local = null;
        facts.localDate = date;
        return facts;
    }

    /** tradeDate: the row's local or exchange date, which a one-digit year is read against. */
    function dateOf(time) {
        return (time.local || time.localDate || time.exchangeTradeDate || '').slice(0, 10);
    }

    function futureCandidate(entry, symbol, tradeDate, evidence, rules, line, fail) {
        const fields = entry.fields;
        const info = evidence.bySymbol.get(symbol)
            || (number(fields.conId) ? evidence.byConId.get(number(fields.conId)) : null);
        const infoFields = info ? info.fields : {};
        const parsed = FUT_SYMBOL.exec(symbol);
        const fromSymbol = parsed ? monthFromCode(parsed[2], parsed[3], tradeDate) : null;
        const stated = monthField(fields.deliveryMonth) || monthField(infoFields.deliveryMonth);
        if (stated && fromSymbol && stated !== fromSymbol) {
            fail('contract_conflict', `line ${line}: ${symbol} reads as ${fromSymbol} but the statement `
                + `states delivery month ${stated}`, line);
            return null;
        }
        const month = stated || fromSymbol;
        if (!month) {
            fail('contract_month_missing', `line ${line}: ${symbol} states no delivery month and its local `
                + 'symbol does not name one; an expiry date is never a delivery month (plan §4.1)', line);
            return null;
        }
        const multiplier = number(fields.multiplier) || number(infoFields.multiplier) || null;
        if (multiplier !== null && Math.abs(multiplier - rules.futurePointValue) > EPSILON) {
            fail('contract_conflict', `line ${line}: ${symbol} has multiplier ${multiplier}; `
                + `${rules.root} futures have ${rules.futurePointValue}`, line);
            return null;
        }
        const exchange = upper(fields.exchange) || upper(infoFields.exchange);
        if (exchange && exchange !== rules.exchange) {
            fail('contract_conflict', `line ${line}: ${symbol} is listed on ${exchange}, not ${rules.exchange}`, line);
            return null;
        }
        const conId = number(fields.conId) || (info ? info.conId : null) || null;
        const lastTrade = isoDateOrNull(fields.expiry) || isoDateOrNull(infoFields.expiry);
        const source = stated ? (monthField(fields.deliveryMonth) ? 'the trade row' : `instrument line ${info.line}`)
            : `local symbol ${symbol}`;
        return {
            record: {
                secType: 'FUT', conId, tradingClass: upper(fields.tradingClass) || upper(infoFields.tradingClass)
                    || rules.futureClass, localSymbol: symbol || null, futureContractMonth: month,
                futureLastTradeDate: lastTrade, futureLastTradeAsOf: null, futurePointValue: rules.futurePointValue,
                evidenceSummary: `statement: ${symbol}${conId ? ` conId ${conId}` : ''}, delivery month ${month} `
                    + `from ${source}${lastTrade ? `, last trade ${lastTrade}` : ''}`,
            },
            info,
        };
    }

    function optionCandidate(entry, symbol, evidence, rules, mapping, line, fail) {
        const fields = entry.fields;
        const info = evidence.bySymbol.get(symbol)
            || (number(fields.conId) ? evidence.byConId.get(number(fields.conId)) : null);
        const infoFields = info ? info.fields : {};
        const description = OPTION_DESCRIPTION.exec(upper(fields.description) || upper(infoFields.description));
        const local = FOP_SYMBOL.exec(symbol);
        let strike = number(fields.strike);
        if (strike === null) strike = number(infoFields.strike);
        if (strike === null && description) strike = number(description[5]);
        let right = upper(fields.right || infoFields.right).slice(0, 1);
        if (right !== 'C' && right !== 'P') right = description ? description[6] : (local ? local[4] : '');
        let expiry = isoDateOrNull(fields.expiry) || isoDateOrNull(infoFields.expiry);
        if (!expiry && description) {
            const year = description[4].length === 2 ? `20${description[4]}` : description[4];
            expiry = `${year}-${MONTH_WORDS[description[3]]}-${pad(description[2], 2)}`;
        }
        const settlement = normalizeHeader(fields.settlement || infoFields.settlement);
        if (settlement && mapping.cashSettlement.includes(settlement)) return { unsupported: 'cash_settled' };
        if (strike !== null && strike <= 0) return { unsupported: 'nonpositive_strike' };
        if (strike === null || !right || !expiry) {
            fail('row_unreadable', `line ${line}: ${symbol} does not state its strike, right and expiry`, line);
            return null;
        }
        const multiplier = number(fields.multiplier) || number(infoFields.multiplier) || rules.premiumMultiplier;
        if (Math.abs(multiplier - rules.premiumMultiplier) > EPSILON) {
            fail('contract_conflict', `line ${line}: ${symbol} has multiplier ${multiplier}; `
                + `${rules.root} options have ${rules.premiumMultiplier}`, line);
            return null;
        }
        const tradingClass = upper(fields.tradingClass) || upper(infoFields.tradingClass) || (local ? local[1] : null);
        const conId = number(fields.conId) || (info ? info.conId : null) || null;
        return {
            record: {
                secType: 'FOP', conId, tradingClass, localSymbol: symbol || null, optionRight: right,
                optionStrike: strike, optionExpiry: expiry, optionExpiryAsOf: null, premiumMultiplier: multiplier,
                deliverableFuturesPerOption: rules.deliverableFuturesPerOption,
                settlementType: rules.settlementType, exerciseStyle: rules.exerciseStyle,
                evidenceSummary: `statement: ${symbol}${conId ? ` conId ${conId}` : ''}, ${right} ${strike} `
                    + `expiring ${expiry}`,
            },
            info,
            underlyingConId: number(fields.underlyingConId) || number(infoFields.underlyingConId) || null,
        };
    }

    // ------------------------------------------------------------------
    // Deliveries (plan §6.1)
    // ------------------------------------------------------------------

    function sameTime(a, b) {
        return JSON.stringify([a.executedAtUtc, a.timeRange]) === JSON.stringify([b.executedAtUtc, b.timeRange]);
    }

    function deliverySign(right, closing) {
        if (closing > 0) return right === 'C' ? -1 : 1;
        return right === 'C' ? 1 : -1;
    }

    /**
     * Readings -> planned events. An assignment or exercise is the option row
     * and the future row it delivered, at one time, in the direction and
     * size the option's right and deliverable fix; a leg without its partner
     * blocks the batch (plan §6.1) and is never booked as an ordinary trade.
     */
    function pairDeliveries(readings, plan, contracts, fail) {
        const events = [];
        const futureLegs = readings.filter((reading) => reading.event === 'delivery_leg');
        const used = new Set();
        for (const reading of readings) {
            if (reading.event === 'delivery_leg') continue;
            if (reading.event !== 'assignment' && reading.event !== 'exercise') {
                events.push(eventOf(reading));
                continue;
            }
            const option = reading.contract;
            const closing = reading.facts.quantity;
            const expected = deliverySign(option.optionRight, closing) * Math.abs(closing)
                * option.deliverableFuturesPerOption;
            const partners = futureLegs.filter((leg) => !used.has(leg) && sameTime(leg.facts.time, reading.facts.time)
                && leg.facts.quantity === expected
                && Math.abs(leg.facts.price - option.optionStrike) <= PRICE_TOLERANCE
                && (!reading.futureSymbol || leg.symbol === reading.futureSymbol));
            if (partners.length !== 1) {
                reading.row.disposition = 'problem';
                fail('delivery_leg_missing', `line ${reading.line}: the ${reading.event} of ${reading.symbol} `
                    + (partners.length ? `matches ${partners.length} future rows; it needs exactly one`
                        : `has no future row delivering ${expected} at the strike ${option.optionStrike}`),
                reading.line);
                continue;
            }
            const leg = partners[0];
            used.add(leg);
            events.push(deliveryOf(reading, leg));
        }
        for (const leg of futureLegs) {
            if (used.has(leg)) continue;
            leg.row.disposition = 'problem';
            fail('delivery_leg_missing', `line ${leg.line}: the delivered ${leg.symbol} has no option `
                + 'assignment or exercise row at the same time', leg.line);
        }
        return events;
    }

    function allocation(reading, role) {
        return { namespace: reading.namespace, sourceRef: reading.sourceRef, role,
            quantity: Math.abs(reading.facts.quantity), fees: reading.facts.fees };
    }

    function eventOf(reading) {
        const facts = reading.facts;
        const base = {
            kind: null, readings: [reading], contract: reading.contract, time: facts.time,
            fees: facts.fees, sources: [allocation(reading, 'trade')], line: reading.line,
        };
        if (reading.asset === 'FUT') {
            return Object.assign(base, { kind: 'futures_trade', futureContracts: facts.quantity, price: facts.price,
                cashAmount: -facts.fees, openClose: openCloseOf(reading.codes) });
        }
        if (reading.event === 'expiry') {
            return Object.assign(base, { kind: 'option_expiry', contracts: facts.quantity, cashAmount: -facts.fees });
        }
        // The statement's own cash: proceeds already carry the sign.
        const cash = facts.proceeds === null
            ? -facts.quantity * reading.contract.premiumMultiplier * facts.price - facts.fees
            : facts.proceeds + facts.commission;
        return Object.assign(base, { kind: 'option_trade', contracts: facts.quantity, price: facts.price,
            cashAmount: cash, openClose: openCloseOf(reading.codes) });
    }

    function deliveryOf(option, future) {
        return {
            kind: option.event === 'assignment' ? 'option_assignment' : 'option_exercise',
            readings: [option, future], contract: option.contract, delivered: future.contract,
            time: option.facts.time, contracts: option.facts.quantity, futureContracts: future.facts.quantity,
            price: option.contract.optionStrike, fees: option.facts.fees + future.facts.fees,
            cashAmount: -(option.facts.fees + future.facts.fees), line: option.line,
            sources: [allocation(option, 'option_leg'), allocation(future, 'future_leg')],
        };
    }

    function openCloseOf(codes) {
        const open = codes.includes('O');
        const close = codes.includes('C');
        if (open && close) return 'CO';
        if (close) return 'C';
        if (open) return 'O';
        return null;
    }

    // ------------------------------------------------------------------
    // Against the stored ledger (plan §9.1, §9.3)
    // ------------------------------------------------------------------

    function secondOf(time) {
        return time.executedAtUtc ? time.executedAtUtc.slice(0, 19) : null;
    }

    function signedQuantity(item) {
        return item.kind === 'futures_trade' ? item.futureContracts : item.contracts;
    }

    function storedView(item) {
        const row = item.row;
        const time = row.fop.time;
        return {
            eventId: row.eventId, kind: row.kind, contractId: item.contract ? item.contract.contractId : null,
            contractKey: item.contract ? identityKey(item.contract) : null,
            deliveredKey: item.delivered ? identityKey(item.delivered) : null,
            quantity: row.kind === 'futures_trade' ? row.futureContracts : row.contracts,
            price: row.price, time, second: time.executedAtUtc ? time.executedAtUtc.slice(0, 19) : null,
            sources: item.sources, live: item.live, fees: row.fees, cashAmount: row.cashAmount,
            openClose: row.fop.openClose, futureContracts: row.futureContracts,
        };
    }

    function samePrice(a, b) {
        const none = (value) => value === null || value === undefined;
        if (none(a) || none(b)) return none(a) && none(b);
        return Math.abs(Number(a) - Number(b)) <= PRICE_TOLERANCE;
    }

    /** A column of a stored row's raw fields ('' when it has none), as row_values reads it. */
    function rawValue(raw, aliases) {
        for (const [name, value] of Object.entries(raw || {})) {
            if (aliases.includes(normalizeHeader(name.replace(/#\d+$/, '')))) return String(value || '').trim();
        }
        return '';
    }

    /** The broker order references a stored fill's statement rows name. */
    function storedOrders(item, mapping) {
        return new Set(item.sources.map((source) => rawValue(source.rawFields, mapping.columns.orderId))
            .filter(Boolean));
    }

    /**
     * Two fills of different broker orders are never the same fill: proven
     * only when both sides name their order.
     */
    function distinctOrders(event, orders) {
        const own = event.readings[0] ? event.readings[0].orderRef : null;
        return Boolean(own && orders.size && !orders.has(own));
    }

    /** The underlying future a statement row names for its option: {symbol, conId}. */
    function statedUnderlying(reading) {
        return {
            symbol: reading && reading.futureSymbol ? reading.futureSymbol : null,
            conId: reading && reading.candidate && reading.candidate.underlyingConId
                ? reading.candidate.underlyingConId : null,
        };
    }

    /**
     * How an option event's future differs from the one the ledger binds
     * the option to ('' when it agrees or either side names none). The
     * visible option name is never enough (plan §9.1).
     */
    function bindingDifference(event, ledger) {
        if (!event.contract || event.contract.secType !== 'FOP') return '';
        const stored = ledger.bindings.get(event.contract.contractId);
        if (!stored || !stored.futureContractId) return '';
        const future = ledger.contractById.get(stored.futureContractId);
        if (!future) return '';
        const option = event.contract.localSymbol || event.contract.contractId;
        const bound = future.localSymbol || future.contractId;
        if (event.delivered && identityKey(event.delivered) !== identityKey(future)) {
            return `underlying future (the ledger binds ${option} to ${bound}; this row delivers `
                + `${event.delivered.localSymbol || event.delivered.contractId})`;
        }
        const stated = statedUnderlying(event.readings[0]);
        if ((stated.symbol && future.localSymbol && upper(stated.symbol) !== upper(future.localSymbol))
                || (stated.conId && future.conId && Number(stated.conId) !== Number(future.conId))) {
            return `underlying future (the ledger binds ${option} to ${bound}; this row names `
                + `${stated.symbol || `conId ${stated.conId}`})`;
        }
        return '';
    }

    function money(value) {
        return String(Math.round(Number(value || 0) * 1e6) / 1e6);
    }

    /**
     * What makes incoming fills and the stored fills they repeat differ
     * beyond kind, contract, quantity and price (plan §9.1: every economic
     * and identity field takes part): fees, cash, the open/close intent, the
     * exchange trade date, a delivery's future and the option's binding.
     */
    function contentDifferences(incoming, stored, ledger) {
        const differences = [];
        const sum = (list, field) => list.reduce((total, item) => total + Number(item[field] || 0), 0);
        const stated = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined))];
        const fees = [sum(incoming, 'fees'), sum(stored, 'fees')];
        if (Math.abs(fees[0] - fees[1]) > FEE_TOLERANCE) {
            differences.push(`fees (${money(fees[1])} stored, ${money(fees[0])} in this file)`);
        }
        const cash = [sum(incoming, 'cashAmount'), sum(stored, 'cashAmount')];
        if (Math.abs(cash[0] - cash[1]) > FEE_TOLERANCE) {
            differences.push(`cash (${money(cash[1])} stored, ${money(cash[0])} in this file)`);
        }
        // The intents each side states together (an opening and a closing part are CO) and the
        // trade dates each side states, as same_fill_total_mismatches reads them on the server.
        const together = (list) => openCloseOf(stated(list.map((item) => item.openClose)).join('').split(''));
        const intent = [together(incoming), together(stored)];
        if (intent[0] && intent[1] && intent[0] !== intent[1]) {
            differences.push(`open/close (${intent[1]} stored, ${intent[0]} in this file)`);
        }
        const dates = [stated(incoming.map((item) => item.time.exchangeTradeDate)).sort(),
            stated(stored.map((item) => item.time.exchangeTradeDate)).sort()];
        if (dates[0].length && dates[1].length && dates[0].join() !== dates[1].join()) {
            const other = dates[0].filter((date) => !dates[1].includes(date));
            differences.push(`exchange trade date (${dates[1].join(', ')} stored, `
                + `${(other.length ? other : dates[0]).join(', ')} in this file)`);
        }
        if (incoming.length === 1 && stored.length === 1 && incoming[0].delivered) {
            if (identityKey(incoming[0].delivered) !== stored[0].deliveredKey
                    || incoming[0].futureContracts !== stored[0].futureContracts) {
                differences.push('delivered future');
            }
        }
        for (const event of incoming) {
            const binding = bindingDifference(event, ledger);
            if (binding && !differences.includes(binding)) differences.push(binding);
        }
        return differences;
    }

    /**
     * Repeats of stored history:
     * - the same reference (account, namespace, sourceRef): the server
     *   compares the content (repeated_source_matches_or_conflicts); the plan
     *   predicts it and keeps the event in the package, where the server
     *   reports it as a duplicate or refuses a revision;
     * - the same fill under another statement reference: matched one to one
     *   by kind, contract, quantity, price and time, then held to the same
     *   fees, cash, intent, trade date and binding; one order at another
     *   granularity only through the broker order reference both name. A
     *   match whose content differs blocks (duplicate_conflict); the plan
     *   leaves an equal one out;
     * - a TWS execution: superseded by the statement row (supersedeTwsEventIds).
     * A stored statement fill of the same contract, direction and day that
     * nothing proves equal, or distinct, blocks the batch.
     */
    function matchLedger(events, ledger, plan, fail, warn) {
        const account = plan.account;
        const mapping = plan.statement.capabilities.mapping;
        const live = ledger.events.filter((item) => item.live && item.row.kind !== 'fee'
            && item.row.kind !== 'manual_adjust' && item.row.kind !== 'opening_balance');
        const claimed = new Set();
        const tws = live.filter((item) => item.sources.length && item.sources.every((s) => s.namespace === 'tws_exec'));
        const statementLive = live.filter((item) => item.sources.some((s) => s.namespace !== 'tws_exec'));
        const orders = new Map(statementLive.map((item) => [item, storedOrders(item, mapping)]));
        const conflict = (event, stored, differences) => {
            event.disposition = 'conflict';
            event.storedEventId = stored.map((item) => item.row.eventId).join(',');
            fail('duplicate_conflict', `line ${event.line}: the same fill is stored as ${event.storedEventId} `
                + `under another reference, with other content: ${differences.join('; ')}. Correct it by a void `
                + 'or a rebuild, never by importing a changed row (plan §9.1, §9.4)', event.line);
        };
        for (const event of events) {
            event.disposition = 'new';
            const primary = event.sources[0];
            const stored = ledger.sources.get(`${account}|${primary.namespace}|${primary.sourceRef}`);
            if (stored) {
                event.disposition = sameRepeat(event, storedView(stored)) ? 'repeat' : 'revision';
                event.storedEventId = stored.row.eventId;
                // Accounted for: no other row of the file can be this stored fill.
                claimed.add(stored);
                if (event.disposition === 'revision') {
                    fail('import_revision_conflict', `line ${event.line}: ${primary.namespace}:${primary.sourceRef} `
                        + 'is stored with other economic content; correct it by a void or a rebuild, never by '
                        + 'importing a changed row (plan §9.4)', event.line);
                }
            }
        }
        // TWS executions the statement repeats: by execution id, then by content.
        for (const event of events) {
            if (event.disposition !== 'new') continue;
            const execIds = event.readings.map((reading) => reading.execId).filter(Boolean);
            let match = tws.find((item) => !claimed.has(item) && item.sources.some((s) => execIds.includes(s.sourceRef)));
            if (!match) {
                match = tws.find((item) => !claimed.has(item) && sameContent(event, storedView(item)));
            }
            if (match) {
                claimed.add(match);
                event.supersedes = match.row.eventId;
                plan.supersede.push(match.row.eventId);
            }
        }
        // Other statement formats, one to one: the same fill, then the same content.
        const open = events.filter((event) => event.disposition === 'new' && !event.supersedes);
        for (const event of open) {
            const match = statementLive.find((item) => !claimed.has(item) && !sameReference(item, event)
                && !distinctOrders(event, orders.get(item)) && sameContent(event, storedView(item)));
            if (!match) continue;
            claimed.add(match);
            const differences = contentDifferences([event], [storedView(match)], ledger);
            if (differences.length) {
                conflict(event, [match], differences);
            } else {
                event.disposition = 'other_format';
                event.storedEventId = match.row.eventId;
            }
        }
        matchOrders(open.filter((event) => event.disposition === 'new'), statementLive, orders, claimed, ledger,
            conflict);
        reviewPossibleDuplicates(open, statementLive, orders, claimed, ledger, plan, fail);
        // A TWS execution inside the statement period that the statement does
        // not list (plan §9.1: a month without statement trades still checks TWS).
        if (plan.timeZone && plan.period.from && plan.period.through) {
            for (const item of tws) {
                if (claimed.has(item)) continue;
                const day = localDay(item.row.fop.time, plan.timeZone.name);
                if (day && day >= plan.period.from && day <= plan.period.through) {
                    fail('tws_not_in_statement', `TWS execution ${item.row.eventId} on ${day} is inside the statement `
                        + 'period but the statement does not list it; check the file or void the execution');
                }
            }
        }
        for (const event of events) {
            for (const reading of event.readings) {
                reading.row.disposition = event.disposition === 'new' ? 'event'
                    : (['repeat', 'other_format', 'confirmed_same'].includes(event.disposition) ? 'duplicate'
                        : 'problem');
                if (event.supersedes) reading.row.supersedes = event.supersedes;
                if (event.storedEventId) reading.row.storedEventId = event.storedEventId;
            }
            if (event.disposition === 'other_format') {
                plan.duplicates.push({ line: event.line, reason: 'the same fill is stored under another reference',
                    storedEventId: event.storedEventId });
            } else if (event.disposition === 'repeat') {
                plan.duplicates.push({ line: event.line, reason: 'this row is already stored',
                    storedEventId: event.storedEventId });
            } else if (event.disposition === 'confirmed_same') {
                plan.duplicates.push({ line: event.line, reason: event.confirmation === 'recorded'
                    ? 'confirmed by hand as the stored fill by an earlier import'
                    : 'confirmed by hand as the stored fill', storedEventId: event.storedEventId,
                attestation: event.attestation });
            }
        }
    }

    // Trades are the only rows a person may decide to be a stored fill or
    // another one; a delivery or an expiry is corrected by a void or a rebuild.
    const DECIDABLE_KINDS = Object.freeze(new Set(['futures_trade', 'option_trade']));

    function sourceKeyOf(event) {
        const primary = event.sources[0];
        return primary ? `${primary.namespace}|${primary.sourceRef}` : `line|${event.line}`;
    }

    /** What the page shows of a stored fill a row may repeat. */
    function candidateOf(item) {
        const view = storedView(item);
        return {
            eventId: view.eventId, kind: view.kind, contractId: view.contractId,
            localSymbol: item.contract ? item.contract.localSymbol || item.contract.contractId : null,
            quantity: view.quantity, price: view.price, fees: view.fees, cashAmount: view.cashAmount,
            openClose: view.openClose || null, time: view.time,
            sources: item.sources.map((source) => `${source.namespace}:${source.sourceRef}`),
        };
    }

    /**
     * A stored statement fill of the same contract, direction and day that
     * nothing proves equal or distinct (plan §9.1) blocks the batch until the
     * user decides, stating the check the decision rests on (plan §19 P5-C1):
     *
     * - same_fill: the row is (part of) one stored fill. The rows named the
     *   same as one fill must add up to it in quantity and average price, and
     *   agree in fees, cash, intent, trade date and binding, or the batch
     *   stays blocked. The row is left out; nothing is written for it;
     * - distinct_fill: the row is another fill than every candidate. It is
     *   written once, and its note keeps the check.
     *
     * A same-fill decision an earlier import recorded (its request's answer,
     * in the ledger's request log) still holds for the same row while that
     * fill is live. A decision never lifts another problem: row type,
     * account, contract, binding and opening checks stay, and the server
     * checks each decision again against its own reading of the row.
     */
    function reviewPossibleDuplicates(open, statementLive, orders, claimed, ledger, plan, fail) {
        const given = plan.decisionsGiven;
        const same = new Map();
        for (const event of open) {
            if (event.disposition !== 'new') continue;
            const near = statementLive.filter((item) => !claimed.has(item) && !distinctOrders(event, orders.get(item))
                && overlaps(event, storedView(item)));
            if (!near.length) continue;
            const key = sourceKeyOf(event);
            const primary = event.sources[0] || {};
            const ids = near.map((item) => item.row.eventId);
            const earlier = ledger.recordedDecisions.get(key);
            const decision = given.get(key) || (earlier && ids.includes(earlier.eventIds[0])
                ? Object.assign({ recorded: true }, earlier) : null);
            const review = {
                line: event.line, sourceKey: key, namespace: primary.namespace || null,
                sourceRef: primary.sourceRef || null, kind: event.kind,
                localSymbol: event.contract.localSymbol || event.contract.contractId,
                quantity: signedQuantity(event), price: event.price === undefined ? null : event.price,
                fees: event.fees || 0, cashAmount: event.cashAmount, time: event.time,
                candidates: near.map(candidateOf), decidable: DECIDABLE_KINDS.has(event.kind),
                decision: decision ? { decision: decision.decision, eventIds: (decision.eventIds || []).slice(),
                    attestation: decision.attestation || '', recorded: Boolean(decision.recorded) } : null,
                status: 'undecided',
            };
            plan.duplicateReviews.push(review);
            const blocked = (code, message) => {
                review.status = code === 'possible_duplicate' ? 'undecided' : 'incomplete';
                fail(code, `line ${event.line}: ${message}`, event.line);
            };
            if (!review.decidable) {
                blocked('possible_duplicate', `${near.length} stored ${event.kind} event(s) (${ids.join(', ')}) may be `
                    + 'this one; a delivery or an expiry is not decided by hand: void the stored one or rebuild');
                continue;
            }
            if (!decision) {
                blocked('possible_duplicate', `${near.length} stored fill(s) of the same contract, direction and day `
                    + `(${ids.join(', ')}) may be this one at another granularity or reference; nothing proves it is `
                    + 'the same fill or another one');
                continue;
            }
            const attestation = String(decision.attestation || '').trim();
            if (!attestation) {
                blocked('duplicate_decision_incomplete', 'a decision on a possible duplicate states the check it '
                    + 'rests on');
                continue;
            }
            if (decision.decision === 'distinct_fill') {
                const named = new Set(decision.eventIds || []);
                const unchecked = ids.filter((id) => !named.has(id));
                if (unchecked.length) {
                    blocked('duplicate_decision_incomplete', `another fill than which? It is also near `
                        + `${unchecked.join(', ')}; compare it with every candidate`);
                    continue;
                }
                event.note = `人工核实为另一笔成交（不同于 ${ids.join('、')}）：${attestation}`.slice(0, 500);
                review.status = 'distinct';
                plan.decisions.push({ decision: 'distinct_fill', namespace: primary.namespace,
                    sourceRef: primary.sourceRef, eventIds: ids.slice().sort(), attestation, source: null });
                continue;
            }
            if (decision.decision !== 'same_fill' || (decision.eventIds || []).length !== 1
                    || !ids.includes(decision.eventIds[0])) {
                blocked('duplicate_decision_incomplete', `a same-fill decision names exactly one of the stored `
                    + `fills ${ids.join(', ')}`);
                continue;
            }
            const target = near.find((item) => item.row.eventId === decision.eventIds[0]);
            if (!same.has(target)) same.set(target, []);
            same.get(target).push({ event, review, decision, attestation });
        }
        for (const [item, members] of same) {
            claimed.add(item);
            const view = storedView(item);
            const incoming = members.map((member) => member.event);
            const quantity = incoming.reduce((total, event) => total + signedQuantity(event), 0);
            const notional = incoming.reduce((total, event) => total + signedQuantity(event) * event.price, 0);
            const differences = [];
            if (Math.abs(quantity - view.quantity) > EPSILON) {
                differences.push(`quantity (${view.quantity} stored, ${quantity} in the rows named the same fill)`);
            } else if (Math.abs(notional / quantity - Number(view.price)) > PRICE_TOLERANCE) {
                differences.push(`average price (${view.price} stored, ${money(notional / quantity)} in this file)`);
            }
            differences.push(...contentDifferences(incoming, [view], ledger));
            for (const member of members) {
                const event = member.event;
                if (differences.length) {
                    member.review.status = 'conflict';
                    fail('duplicate_decision_conflict', `line ${event.line}: named the same fill as ${view.eventId}, `
                        + `but ${differences.join('; ')}`, event.line);
                    continue;
                }
                event.disposition = 'confirmed_same';
                event.storedEventId = view.eventId;
                event.confirmation = member.decision.recorded ? 'recorded' : 'given';
                event.attestation = member.attestation;
                member.review.status = 'same';
                if (member.decision.recorded) continue;
                const reading = event.readings[0];
                plan.decisions.push({
                    decision: 'same_fill', namespace: reading.namespace, sourceRef: reading.sourceRef,
                    eventIds: [view.eventId], attestation: member.attestation,
                    source: {
                        account: plan.account, namespace: reading.namespace, sourceRef: reading.sourceRef,
                        capabilityKey: reading.key, format: plan.format, section: reading.section,
                        rawFields: reading.raw, statedQuantity: Math.abs(reading.facts.quantity),
                        statedFees: reading.facts.fees,
                    },
                });
            }
        }
    }

    function localDay(time, zone) {
        const at = time.executedAtUtc || (time.timeRange ? time.timeRange.startUtc : null);
        if (!at) return null;
        const millis = Date.UTC(Number(at.slice(0, 4)), Number(at.slice(5, 7)) - 1, Number(at.slice(8, 10)),
            Number(at.slice(11, 13)), Number(at.slice(14, 16)), Number(at.slice(17, 19)));
        const wall = new Date(wallClock(millis, zone));
        return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1, 2)}-${pad(wall.getUTCDate(), 2)}`;
    }

    function sameReference(item, event) {
        return item.sources.some((source) => event.sources.some((own) => own.namespace === source.namespace
            && own.sourceRef === source.sourceRef));
    }

    function sameContent(event, stored) {
        if (stored.kind !== event.kind || stored.contractKey !== identityKey(event.contract)) return false;
        if (stored.quantity !== signedQuantity(event)) return false;
        if (!samePrice(stored.price, event.price)) return false;
        const second = secondOf(event.time);
        if (second && stored.second) return second === stored.second;
        return JSON.stringify(stored.time.timeRange) === JSON.stringify(event.time.timeRange);
    }

    /**
     * The same reference again (repeated_source_matches_or_conflicts): the
     * same fill with the same fees, cash, open/close intent and time facts.
     * The server decides; this only predicts it for the preview.
     */
    function sameRepeat(event, stored) {
        if (!sameContent(event, stored)) return false;
        const close = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) <= FEE_TOLERANCE;
        if (!close(event.fees, stored.fees) || !close(event.cashAmount, stored.cashAmount)) return false;
        if ((event.openClose || null) !== (stored.openClose || null)) return false;
        if (event.delivered && event.futureContracts !== stored.futureContracts) return false;
        const facts = ['exchangeTradeDate', 'executedAtUtc', 'orderEvidence'];
        if (facts.some((name) => (event.time[name] || null) !== (stored.time[name] || null))) return false;
        return JSON.stringify(event.time.timeRange || null) === JSON.stringify(stored.time.timeRange || null);
    }

    function overlaps(event, stored) {
        if (stored.contractKey !== identityKey(event.contract) || stored.kind !== event.kind) return false;
        if (Math.sign(stored.quantity) !== Math.sign(signedQuantity(event))) return false;
        const a = event.time.executedAtUtc || event.time.timeRange.startUtc;
        const b = stored.time.executedAtUtc || stored.time.timeRange.startUtc;
        return a.slice(0, 10) === b.slice(0, 10);
    }

    /**
     * One broker order at two granularities (an order row and its
     * executions, in either direction) is the same fill only through the
     * order reference both sides name: the same contract and kind, the
     * quantities adding up, the order price the executions' average and the
     * same fees and cash. Time, day and size alone never link them (plan
     * §9.1); an order both sides name that does not add up is a conflict.
     */
    function matchOrders(open, statementLive, orders, claimed, ledger, conflict) {
        const groups = new Map();
        const groupOf = (ref, contractKey, kind) => {
            const key = `${ref}|${contractKey}|${kind}`;
            if (!groups.has(key)) groups.set(key, { ref, incoming: [], stored: [] });
            return groups.get(key);
        };
        for (const event of open) {
            const ref = event.readings[0] ? event.readings[0].orderRef : null;
            if (!ref || (event.kind !== 'futures_trade' && event.kind !== 'option_trade')) continue;
            groupOf(ref, identityKey(event.contract), event.kind).incoming.push(event);
        }
        for (const item of statementLive) {
            if (claimed.has(item)) continue;
            const view = storedView(item);
            for (const ref of orders.get(item)) {
                const key = `${ref}|${view.contractKey}|${view.kind}`;
                if (groups.has(key)) groups.get(key).stored.push({ item, view });
            }
        }
        for (const group of groups.values()) {
            if (!group.incoming.length || !group.stored.length) continue;
            const stored = group.stored.map((part) => part.view);
            const items = group.stored.map((part) => part.item);
            for (const item of items) claimed.add(item);
            const quantity = [group.incoming.reduce((total, event) => total + signedQuantity(event), 0),
                stored.reduce((total, view) => total + view.quantity, 0)];
            const notional = [group.incoming.reduce((total, event) => total + signedQuantity(event) * event.price, 0),
                stored.reduce((total, view) => total + view.quantity * view.price, 0)];
            const differences = [];
            if (Math.abs(quantity[0] - quantity[1]) > EPSILON) {
                differences.push(`order ${group.ref} quantity (${quantity[1]} stored, ${quantity[0]} in this file)`);
            } else if (Math.abs(notional[0] / quantity[0] - notional[1] / quantity[1]) > PRICE_TOLERANCE) {
                differences.push(`order ${group.ref} average price`);
            }
            differences.push(...contentDifferences(group.incoming, stored, ledger));
            for (const event of group.incoming) {
                if (differences.length) {
                    conflict(event, items, differences);
                } else {
                    event.disposition = 'other_format';
                    event.storedEventId = items.map((item) => item.row.eventId).join(',');
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Statement coverage (plan §9.5 item 5)
    // ------------------------------------------------------------------

    function addDays(iso, days) {
        const date = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1,
            Number(iso.slice(8, 10)) + days));
        return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
    }

    /**
     * The days statements cover, this one included, and the gaps between
     * them. context.coverage lists the statement periods the ledger has
     * registered ({periodFrom, periodThrough}, list_cost_basis_import_batches).
     * The history runs from the first covered day, or an earlier event, to
     * the last covered day; a day inside it that no statement covers is a
     * gap even when the positions are flat on both sides of it, and a ledger
     * with a gap has no complete-history result there (plan §1 item 7,
     * §9.5 item 5). Events after the last statement are the current period.
     */
    /**
     * Statement coverage of a history (pure): periods [{periodFrom,
     * periodThrough}] merged into ranges, and the gaps from the first covered
     * day (or an earlier event day) to the last covered day. days are the
     * account-local days of the history's events, in any order. The page's
     * ledger view uses it with the registered periods alone.
     */
    function coverageOf(periods, days) {
        const ranges = (periods || []).filter((item) => item && item.periodFrom && item.periodThrough)
            .map((item) => [item.periodFrom, item.periodThrough])
            .sort((a, b) => (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)));
        const merged = [];
        for (const [from, through] of ranges) {
            const last = merged[merged.length - 1];
            if (last && from <= addDays(last.through, 1)) {
                if (through > last.through) last.through = through;
            } else {
                merged.push({ from, through });
            }
        }
        const sorted = (days || []).filter(Boolean).slice().sort();
        const gaps = [];
        if (merged.length && sorted.length && sorted[0] < merged[0].from) {
            gaps.push({ from: sorted[0], through: addDays(merged[0].from, -1) });
        }
        for (let index = 1; index < merged.length; index += 1) {
            gaps.push({ from: addDays(merged[index - 1].through, 1), through: addDays(merged[index].from, -1) });
        }
        return { ranges: merged, gaps };
    }

    function checkCoverage(plan, context, ledger, events, warn) {
        // Without a ledger (a read-only preview) nothing else is registered.
        plan.coverage = { known: Array.isArray(context.coverage) || !context.graph, ranges: [], gaps: [],
            complete: false };
        if (!plan.period.from || !plan.period.through) return;
        const zone = plan.timeZone ? plan.timeZone.name : 'Etc/UTC';
        const days = ledger.events.filter((item) => item.live && item.row.kind !== 'opening_balance')
            .map((item) => localDay(item.row.fop.time, zone))
            .concat(events.map((event) => localDay(event.time, zone)));
        const coverage = coverageOf((context.coverage || []).concat([{ periodFrom: plan.period.from,
            periodThrough: plan.period.through }]), days);
        plan.coverage.ranges = coverage.ranges;
        plan.coverage.gaps = coverage.gaps;
        plan.coverage.complete = plan.coverage.known && !coverage.gaps.length;
        plan.checks.coverageContinuous = plan.coverage.complete;
        if (!plan.coverage.known && ledger.events.length) {
            warn('coverage_unknown', 'the ledger\'s registered statement periods were not read, so gaps in its '
                + 'history cannot be checked');
        }
        for (const gap of coverage.gaps) {
            warn('coverage_gap', `${gap.from} to ${gap.through} is covered by no statement: the history there is `
                + 'unproven, so the results are not complete-history conclusions; import that period\'s '
                + 'statement, even one without trades (plan §9.5)');
        }
    }

    // ------------------------------------------------------------------
    // Quantity proof and a baseline (plan §9.2)
    // ------------------------------------------------------------------

    function periodStart(plan) {
        if (!plan.timeZone || !plan.period.from) return null;
        const converted = localToUtc(`${plan.period.from}T00:00:00`, plan.timeZone.name);
        return converted.instant || (converted.range ? converted.range[0] : null);
    }

    /**
     * What the ledger holds when a period starts at instant: every event that
     * ends before it, and an opening balance at it. A baseline B is the state
     * at B (plan §9.2), so a statement that starts at B opens with it; a
     * trade at the instant itself is the period's own.
     */
    function positionsBefore(ledger, instant) {
        const positions = new Map();
        for (const item of ledger.events) {
            if (!item.live || !item.contract) continue;
            const time = item.row.fop.time;
            const end = time.executedAtUtc || time.timeRange.endUtc;
            if (item.row.kind === 'opening_balance' ? end > instant : end >= instant) continue;
            const add = (record, delta) => {
                if (!delta || !record) return;
                const key = identityKey(record);
                positions.set(key, (positions.get(key) || 0) + delta);
            };
            const row = item.row;
            if (row.kind === 'futures_trade' || (row.kind === 'opening_balance' && row.futureContracts !== null)) {
                add(item.contract, row.futureContracts);
            } else if (row.kind !== 'fee' && row.kind !== 'manual_adjust') {
                add(item.contract, row.contracts);
                const delivered = row.fop.deliveredContractRef;
                if (delivered) {
                    add(ledger.contracts.find((contract) => contract.contractId === delivered.contractId),
                        row.futureContracts);
                }
            }
        }
        return positions;
    }

    /**
     * Opening quantity = closing quantity - net change in the period, per
     * contract (plan §9.2). It must equal what the ledger holds when the
     * period starts; an empty ledger kept since a baseline may start from it.
     */
    function proveQuantities(statement, events, ledger, plan, contracts, rules, book, context, mapping, fail, warn) {
        const start = periodStart(plan);
        // A section with a header and no rows says nothing is open.
        if (!statement.sections.has('openPositions')) {
            if (statement.format === 'activity_csv') {
                warn('no_quantity_proof', 'the statement has no Open Positions section, so the opening '
                    + 'quantities are not proven');
            }
            plan.checks.quantityProof = false;
            return;
        }
        const net = new Map();
        const touched = new Map();
        for (const event of events) {
            const key = identityKey(event.contract);
            net.set(key, (net.get(key) || 0) + (signedQuantity(event) || 0));
            touched.set(key, event.contract);
            if (event.delivered) {
                const future = identityKey(event.delivered);
                net.set(future, (net.get(future) || 0) + event.futureContracts);
                touched.set(future, event.delivered);
            }
        }
        const closing = new Map();
        const costs = new Map();
        for (const entry of statement.openPositions) {
            const fields = entry.fields;
            const asset = assetOf(mapping, fields.assetClass);
            if (asset !== 'FUT' && asset !== 'FOP') continue;
            if (fields.discriminator !== undefined && normalizeHeader(fields.discriminator)
                && normalizeHeader(fields.discriminator) !== 'summary') continue;
            const symbol = upper(fields.symbol);
            const fake = { fields: Object.assign({}, fields), line: entry.line, raw: entry.raw };
            const candidate = asset === 'FUT'
                ? futureCandidate(fake, symbol, statement.period.through, contracts.evidence, rules, entry.line, () => {})
                : optionCandidate(fake, symbol, contracts.evidence, rules, mapping, entry.line, () => {});
            if (!candidate || candidate.unsupported) {
                const root = asset === 'FUT' ? (FUT_SYMBOL.exec(symbol) || [])[1] : null;
                if (root && root !== rules.root) continue;
                warn('position_unreadable', `line ${entry.line}: the open position ${symbol} cannot be read`, entry.line);
                continue;
            }
            const record = Object.assign({ root: rules.root, exchange: rules.exchange, currency: rules.currency },
                candidate.record);
            const key = identityKey(record);
            closing.set(key, (closing.get(key) || 0) + (number(fields.quantity) || 0));
            if (!touched.has(key)) touched.set(key, record);
            costs.set(key, number(fields.costPrice));
        }
        const before = start ? positionsBefore(ledger, start) : new Map();
        for (const key of before.keys()) {
            if (!touched.has(key)) {
                const record = ledger.contracts.find((contract) => identityKey(contract) === key);
                if (record) touched.set(key, record);
            }
        }
        let proven = true;
        for (const [key, record] of touched) {
            const opening = (closing.get(key) || 0) - (net.get(key) || 0);
            const held = before.get(key) || 0;
            const entry = { contract: record.localSymbol || record.contractId, opening, periodNet: net.get(key) || 0,
                closing: closing.get(key) || 0, ledger: held };
            plan.quantityProof.push(entry);
            if (Math.abs(opening - held) <= EPSILON) continue;
            if (held === 0 && ledger.events.length === 0) {
                plan.openings.push({ key, record, quantity: opening, costPrice: costs.get(key),
                    traded: Math.abs(net.get(key) || 0) > EPSILON || events.some((event) => identityKey(event.contract) === key) });
                continue;
            }
            proven = false;
            fail('quantity_proof_failed', `${entry.contract}: the statement opens the period with ${opening}, `
                + `the ledger holds ${held} then; import the history between them first`);
        }
        plan.checks.quantityProof = proven;
        if (plan.openings.length) proposeBaseline(plan, start, rules, book, context, contracts, fail);
    }

    function proposeBaseline(plan, start, rules, book, context, contracts, fail) {
        if (book.fop.historyScope !== 'since_baseline') {
            fail('history_before_statement', `the statement opens with positions in `
                + `${plan.openings.map((item) => item.record.localSymbol || item.record.contractId).join(', ')}; `
                + 'import the earlier history first, or keep this ledger since a baseline');
            return;
        }
        if (!start) return;
        const prices = context.baselinePrices || {};
        for (const opening of plan.openings) {
            const record = contracts.resolve(opening.record, null);
            if (!record) continue;
            const stated = prices[record.localSymbol] || null;
            let kind = stated ? stated.kind : null;
            let price = stated ? stated.price : null;
            if (!kind && !opening.traded && opening.costPrice !== null && opening.costPrice !== undefined) {
                // Untouched all period: the closing position is the opening
                // one and its cost price is what it was bought at.
                kind = 'trade_cost';
                price = opening.costPrice;
            }
            if (!kind) {
                if (record.secType === 'FUT') {
                    fail('baseline_price_missing', `${record.localSymbol}: a futures baseline needs its trade cost `
                        + 'or a reference price at the baseline (plan §9.2)');
                    continue;
                }
                kind = 'unknown_cost';
                price = null;
            }
            plan.baselineEvents = plan.baselineEvents || [];
            plan.baselineEvents.push({
                kind: 'opening_balance', contract: record, time: { exchangeTradeDate: null, executedAtUtc: start,
                    timeRange: null, sourceTimeText: `${plan.period.from} 00:00`,
                    sourceTimezone: plan.timeZone.name, orderEvidence: null },
                contracts: record.secType === 'FOP' ? opening.quantity : null,
                futureContracts: record.secType === 'FUT' ? opening.quantity : null,
                price, baselineKind: kind, baselineAsOfUtc: start, sources: [], readings: [],
                disposition: 'new', line: null,
            });
        }
    }

    // ------------------------------------------------------------------
    // The package
    // ------------------------------------------------------------------

    function buildPackage(plan, events, contracts, book, context, ledger) {
        const incoming = (plan.baselineEvents || []).concat(events.filter((event) => event.disposition === 'new'
            || event.disposition === 'repeat'));
        const usedContracts = new Set();
        const bindings = new Map();
        for (const event of incoming) {
            usedContracts.add(event.contract.contractId);
            if (event.delivered) usedContracts.add(event.delivered.contractId);
        }
        // Bindings for the options this file touches (plan §4.3). Every row
        // of a bound option is held to the ledger's binding.
        for (const event of incoming) {
            if (event.contract.secType !== 'FOP') continue;
            const option = event.contract;
            const stored = ledger.bindings.get(option.contractId);
            if (stored) {
                const difference = bindingDifference(event, ledger);
                if (difference) {
                    plan.problems.push(problem('binding_conflict', `${event.line ? `line ${event.line}: ` : ''}`
                        + `${difference}; adopt another binding by a metadata commit first`, event.line, true));
                }
                if (!bindings.has(option.contractId)) {
                    bindings.set(option.contractId, { stored, ref: { bindingId: stored.bindingId,
                        revision: stored.revision } });
                }
                // The ledger could not prove this option's future; this file may,
                // even by a row whose fill is stored already (a cumulative file).
                // Never silently: the page offers the adoption, a versioned
                // metadata commit.
                const offered = plan.bindingUpgrades.some((item) => item.bindingId === stored.bindingId);
                if (!offered && !stored.futureContractId && stored.status === 'unresolved') {
                    const future = statedFuture(event, plan, contracts);
                    if (future) {
                        plan.bindingUpgrades.push({ bindingId: stored.bindingId, revision: stored.revision, option,
                            future, evidence: bindingEvidence(event, future, plan) });
                    }
                }
                continue;
            }
            if (bindings.has(option.contractId)) continue;
            if (event.disposition === 'repeat') continue;
            const future = bindingFuture(event, plan, contracts);
            const bindingId = `bind-${option.contractId}`.slice(0, 64);
            const record = {
                bindingId, revision: 1, optionContractId: option.contractId,
                futureContractId: future ? future.contractId : null,
                status: future ? 'verified_statement' : 'unresolved',
                evidenceSummary: future ? `statement: ${option.localSymbol} delivers ${future.localSymbol} `
                    + `(${future.futureContractMonth})` : 'the statement names no underlying future',
                evidenceCredential: null, observedAtUtc: context.observedAtUtc,
            };
            if (future) {
                usedContracts.add(future.contractId);
                plan.bindingRequests.push({ bindingId, option, future,
                    evidence: bindingEvidence(event, future, plan) });
            }
            bindings.set(option.contractId, { record, ref: { bindingId, revision: 1 } });
            plan.bindings.push(record);
        }
        for (const event of incoming) {
            if (!event.delivered) continue;
            const binding = bindings.get(event.contract.contractId);
            if (!binding) continue;
            const record = binding.record || binding.stored;
            if (!record.futureContractId || record.status === 'unresolved' || record.status === 'conflict') {
                const upgrade = plan.bindingUpgrades.find((item) => item.bindingId === record.bindingId);
                plan.problems.push(problem('binding_missing', `line ${event.line}: the ${event.kind} of `
                    + `${event.contract.localSymbol} needs the option's future proven by the statement or the broker`
                    + (upgrade ? `; this file proves ${upgrade.future.localSymbol || upgrade.future.contractId}: `
                        + 'adopt that binding first, then preview again' : ''),
                event.line, true));
            } else if (record.futureContractId !== event.delivered.contractId) {
                plan.problems.push(problem('binding_conflict', `line ${event.line}: ${event.contract.localSymbol} is `
                    + `bound to ${record.futureContractId} but delivered ${event.delivered.contractId}`, event.line, true));
            }
            event.bindingRef = binding.ref;
        }
        plan.contracts = plan.contracts.filter((record) => usedContracts.has(record.contractId));
        const records = new Map();
        const packageEvents = [];
        incoming.sort((a, b) => compareTime(a.time, b.time) || (a.line || 0) - (b.line || 0));
        incoming.forEach((event, index) => {
            for (const reading of event.readings) {
                const key = `${reading.namespace}|${reading.sourceRef}`;
                if (records.has(key)) continue;
                records.set(key, {
                    account: plan.account, namespace: reading.namespace, sourceRef: reading.sourceRef,
                    capabilityKey: reading.key, format: plan.format, section: reading.section,
                    rawFields: reading.raw, statedQuantity: Math.abs(reading.facts.quantity),
                    statedFees: reading.facts.fees,
                });
            }
            packageEvents.push(fopEvent(event, index, plan));
        });
        plan.sourceRecords = [...records.values()];
        plan.events = packageEvents;
        plan.plannedEvents = incoming;
    }

    function compareTime(a, b) {
        const left = a.executedAtUtc || a.timeRange.startUtc;
        const right = b.executedAtUtc || b.timeRange.startUtc;
        return left < right ? -1 : (left > right ? 1 : 0);
    }

    /**
     * The future a statement proves an option delivers, or null. It is a
     * future this file brings, or one the ledger holds already that the file
     * shows (a row of it or its instrument line): the rows the server checks
     * the binding credential on (plan §4.3). A later file whose option rows
     * name that future's conId still binds the option.
     */
    function bindingFuture(event, plan, contracts) {
        return event.delivered || statedFuture(event, plan, contracts);
    }

    /** The future an option row itself names (never the leg a delivery paired with it), or null. */
    function statedFuture(event, plan, contracts) {
        const reading = event.readings[0];
        if (!reading || !reading.candidate) return null;
        const shown = (record) => (plan.readings || []).some((item) => item.contract
            && item.contract.contractId === record.contractId)
            || Boolean(record.localSymbol && contracts.evidence.bySymbol.get(record.localSymbol))
            || Boolean(record.conId && contracts.evidence.byConId.get(record.conId));
        const known = [...contracts.created.values()].concat(contracts.stored.filter(shown))
            .filter((record) => record.secType === 'FUT');
        let future = null;
        if (reading.futureSymbol) {
            for (const record of known) {
                if (record.localSymbol === reading.futureSymbol) future = record;
            }
        }
        if (!future && reading.candidate.underlyingConId) {
            for (const record of known) {
                if (record.conId === reading.candidate.underlyingConId) future = record;
            }
        }
        if (!future && reading.futureSymbol) {
            const info = contracts.evidence.bySymbol.get(reading.futureSymbol);
            if (info) {
                const candidate = futureCandidate({ fields: info.fields, line: info.line }, reading.futureSymbol,
                    dateOf(reading.facts.time), contracts.evidence, plan.rules, info.line, () => {});
                if (candidate) future = contracts.resolve(candidate.record, info.line);
            }
        }
        return future;
    }

    /** The statement rows a binding credential is issued on (plan §4.3). */
    function bindingEvidence(event, future, plan) {
        const option = event.readings[0];
        const rows = [{ role: 'option', section: option.section, rawFields: option.raw }];
        if (option.candidate && option.candidate.info) {
            rows.push({ role: 'option_instrument', section: 'Financial Instrument Information',
                rawFields: option.candidate.info.raw });
        }
        const statement = plan.statement;
        const index = instrumentEvidence(statement, statement.capabilities.mapping);
        const info = index.bySymbol.get(future.localSymbol) || (future.conId ? index.byConId.get(future.conId) : null);
        if (info) rows.push({ role: 'future_instrument', section: 'Financial Instrument Information', rawFields: info.raw });
        // Without an instrument row, a row of the future itself (its delivery
        // leg, or any trade of it in the file) shows its local symbol and conId.
        const futureRow = event.delivered ? event.readings[1]
            : (plan.readings || []).find((reading) => reading.contract && reading.contract.contractId === future.contractId);
        if (futureRow) rows.push({ role: 'future', section: futureRow.section, rawFields: futureRow.raw });
        return { format: plan.format, rows };
    }

    function fopEvent(event, index, plan) {
        const time = {
            exchangeTradeDate: event.time.exchangeTradeDate || null,
            executedAtUtc: event.time.executedAtUtc || null,
            timeRange: event.time.timeRange || null,
            sourceTimeText: event.time.sourceTimeText || null,
            sourceTimezone: event.time.sourceTimezone || null,
            orderEvidence: event.time.orderEvidence || null,
        };
        const common = {
            account: plan.account,
            source: event.kind === 'opening_balance' ? 'reconcile' : 'csv_import',
            externalRef: event.sources.length ? event.sources[0].sourceRef : null,
            packageKey: `pk-${String(index + 1).padStart(5, '0')}`,
            note: event.kind === 'opening_balance'
                ? `opening quantity from ${plan.statement.fileName || 'the statement'} (${plan.period.from})`
                : (event.note || ''),
            time, sources: event.sources.map((source) => Object.assign({}, source)),
            kind: event.kind,
            contractRef: { contractId: event.contract.contractId, revision: event.contract.revision },
            includeInCost: true,
        };
        switch (event.kind) {
        case 'futures_trade':
            return Object.assign(common, { futureContracts: event.futureContracts, price: event.price,
                cashAmount: event.cashAmount, fees: event.fees, openClose: event.openClose });
        case 'option_trade':
            return Object.assign(common, { contracts: event.contracts, price: event.price,
                cashAmount: event.cashAmount, fees: event.fees, openClose: event.openClose });
        case 'option_expiry':
            return Object.assign(common, { contracts: event.contracts, cashAmount: event.cashAmount, fees: event.fees });
        case 'option_assignment':
        case 'option_exercise':
            return Object.assign(common, {
                deliveredContractRef: { contractId: event.delivered.contractId, revision: event.delivered.revision },
                bindingRef: event.bindingRef, contracts: event.contracts, futureContracts: event.futureContracts,
                price: event.price, cashAmount: event.cashAmount, fees: event.fees });
        case 'opening_balance':
            return Object.assign(common, { contracts: event.contracts, futureContracts: event.futureContracts,
                price: event.price, cashAmount: 0, fees: 0, baselineKind: event.baselineKind,
                baselineAsOfUtc: event.baselineAsOfUtc });
        default:
            throw new Error(`unknown kind ${event.kind}`);
        }
    }

    // ------------------------------------------------------------------
    // Requests (protocol.json ImportRequest, FopRebuildRequest)
    // ------------------------------------------------------------------

    /**
     * The adoptions of the stored unresolved bindings this file proves (plan
     * §4.3): one adopt_binding metadata operation per binding the server
     * signed a verified_statement credential for (results: its
     * StatementBindingResult items). A binding revision moves the references
     * of the live deliveries on the old one (an unresolved binding has none);
     * a future the ledger does not hold yet travels with the first operation
     * that names it (the operations are committed in order). The server
     * checks the credential against exactly these records. Returns
     * {operations, refused: [{bindingId, problems}]}.
     */
    function bindingUpgradeAdoptions(plan, graph, book, results) {
        const byId = new Map((results || []).map((result) => [result.bindingId, result]));
        const held = new Set(((graph && graph.contracts) || []).map((item) => item.record.contractId));
        const live = ((graph && graph.events) || []).filter((item) => !item.row.voidedAtUtc).map((item) => item.row);
        const operations = [];
        const refused = [];
        for (const upgrade of plan.bindingUpgrades || []) {
            const result = byId.get(upgrade.bindingId);
            if (!result || result.status !== 'verified_statement' || !result.evidenceCredential) {
                refused.push({ bindingId: upgrade.bindingId, problems: result ? result.problems || [] : ['no answer'] });
                continue;
            }
            const { option, future } = upgrade;
            const binding = {
                bindingId: upgrade.bindingId, revision: upgrade.revision + 1, optionContractId: option.contractId,
                futureContractId: future.contractId, status: 'verified_statement',
                evidenceSummary: `statement: ${option.localSymbol} delivers ${future.localSymbol} `
                    + `(${future.futureContractMonth})`,
                evidenceCredential: result.evidenceCredential, observedAtUtc: future.observedAtUtc,
            };
            const affected = live.filter((row) => row.fop.bindingRef && row.fop.bindingRef.bindingId === upgrade.bindingId
                && row.fop.bindingRef.revision === upgrade.revision).map((row) => ({ eventId: row.eventId,
                reference: 'binding', before: { id: upgrade.bindingId, revision: upgrade.revision },
                after: { id: upgrade.bindingId, revision: binding.revision } }));
            const operation = { kind: 'adopt_binding', binding, affected };
            if (!held.has(future.contractId)) {
                operation.contracts = [Object.assign({}, future)];
                held.add(future.contractId);
            }
            operations.push(operation);
        }
        return { operations, refused };
    }

    /** The plan with server credentials for its statement bindings. */
    function withCredentials(plan, credentials) {
        const byId = new Map(Object.entries(credentials || {}));
        const bindings = plan.bindings.map((record) => {
            if (record.status !== 'verified_statement') return record;
            const credential = byId.get(record.bindingId);
            return Object.assign({}, record, { evidenceCredential: credential || null });
        });
        return Object.assign({}, plan, { bindings });
    }

    function packageOf(plan, engineVersion) {
        const missing = plan.bindings.filter((record) => record.status === 'verified_statement'
            && !record.evidenceCredential);
        if (missing.length) {
            throw new Error(`the statement bindings ${missing.map((record) => record.bindingId).join(', ')} `
                + 'need their server credentials (request them for this preview)');
        }
        return {
            version: PACKAGE_VERSION, engineVersion,
            contracts: plan.contracts.map((record) => Object.assign({}, record)),
            bindings: plan.bindings.map((record) => Object.assign({}, record)),
            sourceRecords: plan.sourceRecords.map((record) => Object.assign({}, record,
                { rawFields: Object.assign({}, record.rawFields) })),
            events: plan.events.map((event) => JSON.parse(JSON.stringify(event))),
        };
    }

    function statementOf(plan, request) {
        return {
            format: plan.format, fileName: request.fileName || plan.statement.fileName || 'statement.csv',
            fileSha256: request.fileSha256, account: plan.accountMatch ? plan.accountMatch.sourceAccount : plan.account,
            periodFrom: request.periodFrom || plan.period.from, periodThrough: request.periodThrough || plan.period.through,
            checks: {
                quantityProof: Boolean(plan.checks.quantityProof),
                accountExact: Boolean(plan.accountMatch && plan.accountMatch.status === 'exact'),
                periodPrinted: !plan.period.fromRows,
                coverageContinuous: Boolean(plan.checks.coverageContinuous),
            },
            confirmedDuplicates: plan.duplicates.filter((item) => item.reason !== 'this row is already stored').length,
        };
    }

    function assertWritable(plan) {
        if (plan.blocking) {
            const first = plan.problems.find((item) => item.blocking);
            throw new Error(`this preview cannot be committed: ${first.message}`);
        }
        if (plan.accountMatch && plan.accountMatch.status === 'unchecked') {
            throw new Error('a preview without a ledger is read-only and cannot be committed');
        }
    }

    /**
     * request: {requestId, bookId, expectedLedgerVersion, bookIdentity,
     * importBatchId, clientTokenPrefix, fileSha256, fileName, engineVersion}.
     * A statement that adds no event (a month without trades, or rows all
     * stored under other references) still registers its period: the
     * request carries no package, only the statement (plan §9.5 item 5).
     */
    function buildImportRequest(plan, request) {
        assertWritable(plan);
        return Object.assign({
            requestId: request.requestId, bookId: request.bookId,
            expectedLedgerVersion: request.expectedLedgerVersion, bookIdentity: request.bookIdentity,
            action: 'import_cost_basis_events', importBatchId: request.importBatchId,
            clientTokenPrefix: request.clientTokenPrefix, statement: statementOf(plan, request),
            supersedeTwsEventIds: plan.supersede.slice(),
            fopPackage: plan.events.length ? packageOf(plan, request.engineVersion) : null,
        }, (plan.decisions || []).length ? { duplicateDecisions: plan.decisions.map((item) => Object.assign({}, item)) }
            : {});
    }

    /** request as buildImportRequest, plus confirmation, clientToken, reason, revokeBoundaries. */
    function buildRebuildRequest(plan, request) {
        assertWritable(plan);
        if (!plan.events.length) throw new Error('a rebuild replaces the history with this statement, which has no events');
        if ((plan.decisions || []).length) {
            throw new Error('a rebuild replaces the stored fills the duplicate decisions name; decide nothing for it');
        }
        if (plan.supersede.length) {
            throw new Error('a rebuild replaces the whole history; it supersedes no TWS execution');
        }
        return {
            action: 'rebuild_cost_basis_book', requestId: request.requestId, bookId: request.bookId,
            expectedLedgerVersion: request.expectedLedgerVersion, bookIdentity: request.bookIdentity,
            confirmation: request.confirmation, clientToken: request.clientToken,
            importBatchId: request.importBatchId, statement: statementOf(plan, request),
            reason: request.reason || '', revokeBoundaries: (request.revokeBoundaries || []).slice(),
            fopPackage: packageOf(plan, request.engineVersion),
        };
    }

    /**
     * A synthetic_only row the user attests by hand (plan §9.7): the event it
     * reads as becomes a manual event that still names the row, so the server
     * can check it against the row and keep the row covered. The page shows
     * such an event as manually verified.
     */
    function claimRows(plan, lines, attestation) {
        const wanted = new Set(lines);
        const events = plan.events.map((event) => {
            const lineSet = (plan.plannedEvents[plan.events.indexOf(event)].readings || []).map((reading) => reading.line);
            if (!lineSet.some((line) => wanted.has(line))) return event;
            return Object.assign({}, event, { source: 'manual',
                note: [event.note, attestation || 'manually verified against the statement row']
                    .filter(Boolean).join('；').slice(0, 500) });
        });
        return Object.assign({}, plan, { events });
    }

    /**
     * Split a plan into batches of at most maxEvents events by month of
     * execution (plan §9.5 item 7), each a whole contiguous period that a
     * request can carry and retry on its own. Returns [{from, through,
     * plan}]; a single month over the limit cannot be split and is refused.
     */
    function splitPlan(plan, maxEvents) {
        if (plan.events.length <= maxEvents) return [{ from: plan.period.from, through: plan.period.through, plan }];
        const months = new Map();
        plan.plannedEvents.forEach((event, index) => {
            const day = plan.timeZone ? localDay(event.time, plan.timeZone.name) : null;
            const month = (day || plan.period.from).slice(0, 7);
            if (!months.has(month)) months.set(month, []);
            months.get(month).push(index);
        });
        const batches = [];
        let current = null;
        for (const [month, indexes] of [...months].sort()) {
            if (indexes.length > maxEvents) {
                throw new Error(`${month} alone holds ${indexes.length} events, over the limit of ${maxEvents}; `
                    + 'split the statement by a shorter period');
            }
            if (!current || current.indexes.length + indexes.length > maxEvents) {
                current = { months: [], indexes: [] };
                batches.push(current);
            }
            current.months.push(month);
            current.indexes.push(...indexes);
        }
        return batches.map((batch, number) => {
            const first = batch.months[0];
            const last = batch.months[batch.months.length - 1];
            const from = number === 0 ? plan.period.from : `${first}-01`;
            const through = number === batches.length - 1 ? plan.period.through : lastDay(last);
            const keep = new Set(batch.indexes);
            const events = plan.events.filter((_event, index) => keep.has(index));
            const planned = plan.plannedEvents.filter((_event, index) => keep.has(index));
            const refs = new Set(events.flatMap((event) => event.sources.map((source) => `${source.namespace}|${source.sourceRef}`)));
            const contractIds = new Set(events.flatMap((event) => [event.contractRef.contractId,
                event.deliveredContractRef ? event.deliveredContractRef.contractId : null]).filter(Boolean));
            const bindingIds = new Set(events.map((event) => (event.bindingRef ? event.bindingRef.bindingId : null)));
            const optionIds = new Set(events.map((event) => event.contractRef.contractId));
            const bindings = plan.bindings.filter((record) => bindingIds.has(record.bindingId)
                || optionIds.has(record.optionContractId));
            for (const record of bindings) if (record.futureContractId) contractIds.add(record.futureContractId);
            return {
                from, through,
                plan: Object.assign({}, plan, {
                    events: events.map((event, index) => Object.assign({}, event,
                        { packageKey: `pk-${String(index + 1).padStart(5, '0')}` })),
                    plannedEvents: planned,
                    sourceRecords: plan.sourceRecords.filter((record) => refs.has(`${record.namespace}|${record.sourceRef}`)),
                    contracts: plan.contracts.filter((record) => contractIds.has(record.contractId)),
                    bindings,
                    supersede: plan.supersede.filter((id) => planned.some((event) => event.supersedes === id)),
                    period: { from, through, fromRows: plan.period.fromRows },
                    // A same-fill decision writes nothing and goes with the first
                    // batch; a distinct-fill one with the row it writes.
                    decisions: (plan.decisions || []).filter((item) => (item.decision === 'same_fill'
                        ? number === 0 : refs.has(`${item.namespace}|${item.sourceRef}`))),
                }),
            };
        });
    }

    function lastDay(month) {
        const [year, value] = month.split('-').map(Number);
        const day = new Date(Date.UTC(year, value, 0)).getUTCDate();
        return `${month}-${pad(day, 2)}`;
    }

    /**
     * The ledger graph with the plan's new events in it, for the core: a
     * read-only preview of what the ledger would become. Nothing is written.
     */
    function previewGraph(graph, plan, book) {
        const base = graph ? JSON.parse(JSON.stringify(graph)) : {
            book: { bookId: book.bookId || 'preview-ledger', account: book.account, symbol: book.symbol,
                secType: 'FUT', currency: book.currency },
            fopBook: { engineVersion: book.fop.engineVersion, productRules: book.fop.productRules,
                historyScope: book.fop.historyScope },
            contracts: [], bindings: [], events: [], cycles: [], sources: [], allocations: [],
            operations: [], referenceRevisions: [], eventIdMappings: [], requests: [],
        };
        const superseded = new Set(plan.supersede);
        for (const stored of base.events) {
            if (superseded.has(stored.row.eventId)) stored.row.voidedAtUtc = 'preview';
        }
        const known = new Set(base.contracts.map((stored) => `${stored.record.contractId}#${stored.record.revision}`));
        for (const record of plan.contracts) {
            if (!known.has(`${record.contractId}#${record.revision}`)) {
                base.contracts.push({ record, supersededByRevision: null });
            }
        }
        for (const record of plan.bindings) {
            base.bindings.push(Object.assign({}, record, { supersededByRevision: null }));
        }
        const sources = new Map();
        plan.events.forEach((event, index) => {
            const planned = plan.plannedEvents[index];
            if (planned.disposition === 'repeat') return;
            const eventId = `preview-${String(index + 1).padStart(5, '0')}`;
            for (const source of event.sources) {
                const key = `${source.namespace}|${source.sourceRef}`;
                if (!sources.has(key)) {
                    sources.set(key, `src-${Common.hash16(key)}`);
                    base.sources.push({ sourceId: sources.get(key), account: event.account,
                        namespace: source.namespace, sourceRef: source.sourceRef });
                }
                base.allocations.push({ sourceId: sources.get(key), eventId, role: source.role,
                    quantity: source.quantity, fees: source.fees });
            }
            base.events.push({
                row: {
                    eventId, seq: base.events.length + 1, kind: event.kind, account: event.account,
                    contracts: event.contracts === undefined ? null : event.contracts,
                    futureContracts: event.futureContracts === undefined ? null : event.futureContracts,
                    price: event.price === undefined ? null : event.price, cashAmount: event.cashAmount,
                    fees: event.fees, includeInCost: true, source: event.source, externalRef: event.externalRef,
                    note: event.note, voidedAtUtc: null,
                    fop: {
                        contractRef: event.contractRef, deliveredContractRef: event.deliveredContractRef || null,
                        bindingRef: event.bindingRef || null, openClose: event.openClose || null,
                        feeCategory: null, feeIsRefund: false, feeSourceEventId: null, adjustmentScope: null,
                        baselineKind: event.baselineKind || null, baselineAsOfUtc: event.baselineAsOfUtc || null,
                        time: event.time,
                    },
                },
                primarySourceId: event.sources.length ? sources.get(`${event.sources[0].namespace}|${event.sources[0].sourceRef}`) : null,
            });
        });
        return base;
    }

    globalScope.OptionComboCostBasisFopImport = Object.freeze({
        PRODUCT_RULES,
        readStatement,
        planImport,
        withCredentials,
        bindingUpgradeAdoptions,
        buildImportRequest,
        buildRebuildRequest,
        claimRows,
        splitPlan,
        previewGraph,
        localToUtc,
        localDay,
        coverageOf,
        contractIdFor,
        _internal: Object.freeze({ monthFromCode, dayRange, identityKey }),
    });
})(typeof window !== 'undefined' ? window : globalThis);
