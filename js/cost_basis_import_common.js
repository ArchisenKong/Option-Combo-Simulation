/**
 * Lexical tools shared by the statement importers (plan §7.1, §7.2): the
 * stock ledger's js/cost_basis_import.js and the FOP ledger's
 * js/cost_basis_fop_import.js. DOM-free and Node-testable.
 *
 * Only reading is shared here: CSV fields, localized headers and sections,
 * numbers, dates, account-local timestamps, the statement period and account,
 * and a stable row digest. Nothing here decides what a row means; each
 * importer keeps its own alias tables and its own economics, and the stock
 * importer's delivery inference is never shared (plan §7.1).
 */

(function attachCostBasisImportCommon(globalScope) {
    'use strict';

    /** RFC4180-ish reader: quoted fields, doubled quotes, CRLF or LF. */
    function parseCsv(text) {
        const rows = [];
        let row = [];
        let field = '';
        let quoted = false;
        // A BOM would otherwise ride along inside the first header cell and
        // stop the first column from ever matching an alias.
        const source = String(text === null || text === undefined ? '' : text)
            .replace(/^\uFEFF/, '');

        for (let index = 0; index < source.length; index += 1) {
            const character = source[index];
            if (quoted) {
                if (character === '"') {
                    if (source[index + 1] === '"') {
                        field += '"';
                        index += 1;
                    } else {
                        quoted = false;
                    }
                } else {
                    field += character;
                }
                continue;
            }
            if (character === '"') {
                quoted = true;
            } else if (character === ',') {
                row.push(field);
                field = '';
            } else if (character === '\n' || character === '\r') {
                if (character === '\r' && source[index + 1] === '\n') index += 1;
                row.push(field);
                field = '';
                if (row.some((value) => value !== '')) rows.push(row);
                row = [];
            } else {
                field += character;
            }
        }
        row.push(field);
        if (row.some((value) => value !== '')) rows.push(row);
        if (quoted) {
            // The file ended inside a quoted field: every row after the
            // opening quote has been swallowed into one cell. Reporting the
            // rows read so far as a valid statement would silently drop
            // trades, so the reader marks the result as damaged.
            rows.error = `unterminated quoted field; the file ended inside quotes `
                + `that opened around row ${rows.length + 1}`;
        }
        return rows;
    }

    function normalizeHeader(value) {
        return String(value === null || value === undefined ? '' : value)
            .trim().toLowerCase().replace(/\s+/g, ' ');
    }

    function upper(value) {
        return String(value === null || value === undefined ? '' : value)
            .trim().replace(/\s+/g, ' ').toUpperCase();
    }

    const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

    function number(value) {
        if (value === null || value === undefined) return null;
        // Statements ship thousands separators and parenthesised negatives.
        const text = String(value).trim().replace(/,/g, '');
        if (!text) return null;
        const negated = /^\((.*)\)$/.exec(text);
        const body = (negated ? negated[1] : text).trim();
        // parseFloat would read "10abc" as 10 and "1e5x" as 100000; a cell
        // that is not entirely a number is a damaged cell, not a number.
        if (!NUMBER_RE.test(body)) return null;
        const parsed = parseFloat(body);
        if (!Number.isFinite(parsed)) return null;
        return negated ? -parsed : parsed;
    }

    /** True when a cell holds text that is not a readable number. */
    function malformedNumber(value) {
        if (value === null || value === undefined) return false;
        const text = String(value).trim();
        return text !== '' && number(text) === null;
    }

    function isoDate(value) {
        const text = String(value === null || value === undefined ? '' : value).trim();
        if (!text) return '';
        const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
        if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
        const slashed = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(text);
        if (slashed) return `${slashed[1]}-${slashed[2]}-${slashed[3]}`;
        const digits = text.replace(/[^0-9]/g, '');
        if (digits.length >= 8) {
            return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
        }
        return '';
    }

    /**
     * IBKR timestamps are account-local wall-clock values. Keep them that
     * way: converting through Date would silently move a trade to another
     * day on machines in a different timezone. The fixed-width result sorts
     * lexicographically.
     *
     * A date-only cell yields '' rather than a fabricated 23:59:59: that
     * second would otherwise be offered as broker evidence when matching
     * against TWS fills or ordering against an adopted snapshot. A caller
     * that only needs a sort key makes its own end-of-day stamp.
     */
    function localTimestamp(value) {
        const text = String(value === null || value === undefined ? '' : value).trim();
        const date = isoDate(text);
        if (!date) return '';
        const time = /(?:^|[\s,T])(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
        if (time) {
            return `${date}T${time[1].padStart(2, '0')}:${time[2]}:${time[3] || '00'}`;
        }
        // Flex Query commonly emits account-local time as YYYYMMDD;HHMMSS
        // (and some custom queries remove the semicolon as well). Treating
        // that as an end-of-day date would break second-level reconciliation.
        const compact = /(?:^|[\s,T;])(\d{2})(\d{2})(\d{2})(?:\D|$)/.exec(text)
            || /^\D*\d{8}(\d{2})(\d{2})(\d{2})\D*$/.exec(text);
        if (!compact) return '';
        return `${date}T${compact[1]}:${compact[2]}:${compact[3]}`;
    }

    const PERIOD_MONTHS = Object.freeze({
        january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
        july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
        '一月': 1, '二月': 2, '三月': 3, '四月': 4, '五月': 5, '六月': 6,
        '七月': 7, '八月': 8, '九月': 9, '十月': 10, '十一月': 11, '十二月': 12,
    });

    function periodDates(value) {
        const text = String(value === null || value === undefined ? '' : value).trim();
        const dates = [];
        const words = /(January|February|March|April|May|June|July|August|September|October|November|December|一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月)\s+(\d{1,2}),\s*(\d{4})/gi;
        let match = words.exec(text);
        while (match) {
            const month = PERIOD_MONTHS[match[1].toLowerCase()] || PERIOD_MONTHS[match[1]];
            dates.push(`${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`);
            match = words.exec(text);
        }
        const iso = /(\d{4})-(\d{2})-(\d{2})/g;
        match = iso.exec(text);
        while (match) {
            dates.push(`${match[1]}-${match[2]}-${match[3]}`);
            match = iso.exec(text);
        }
        return dates;
    }

    /**
     * The statement's own reporting period, independent of the selected
     * symbol. `from` is the first date printed and `through` the last; a
     * single-day statement prints one date and gets it for both.
     */
    function extractStatementPeriod(rows) {
        let found = { from: '', through: '' };
        (rows || []).forEach((row) => {
            if (normalizeHeader(row[0]) !== 'statement'
                || normalizeHeader(row[1]) !== 'data'
                || normalizeHeader(row[2]) !== 'period') return;
            const dates = periodDates(row[3]);
            if (dates.length) {
                found = { from: dates[0], through: dates[dates.length - 1] };
            }
        });
        return found;
    }

    /** End of the reporting period as a cutoff timestamp. */
    function extractStatementThrough(rows) {
        const period = extractStatementPeriod(rows);
        return period.through ? `${period.through}T23:59:59` : '';
    }

    /**
     * Deterministic 64-bit-ish digest, two FNV-1a lanes with different seeds.
     *
     * Neither the browser nor Node offers a synchronous SHA, and this only
     * has to be stable and collision-free across the few thousand rows of a
     * statement - not cryptographic.
     */
    function hash16(text) {
        const source = String(text === null || text === undefined ? '' : text);
        let low = 0x811c9dc5;
        let high = 0x01000193;
        for (let index = 0; index < source.length; index += 1) {
            const code = source.charCodeAt(index);
            low = Math.imul(low ^ code, 0x01000193) >>> 0;
            high = Math.imul(high ^ (code + index), 0x85ebca6b) >>> 0;
        }
        return (`0000000${low.toString(16)}`).slice(-8)
            + (`0000000${high.toString(16)}`).slice(-8);
    }

    /**
     * Map header names onto canonical fields; unknown headers are reported.
     *
     * Every occurrence of an alias is considered, not just the first. A
     * Chinese Trades header carries 代码 twice - the contract and the notes -
     * and stopping at the first match would leave the notes column unmapped
     * and every assignment misread as an ordinary trade.
     */
    function buildMapping(headers, aliasTable) {
        const normalized = (headers || []).map(normalizeHeader);
        const mapping = {};
        const used = new Set();
        Object.keys(aliasTable).forEach((field) => {
            const aliases = aliasTable[field];
            for (let index = 0; index < aliases.length; index += 1) {
                const alias = aliases[index];
                for (let position = 0; position < normalized.length; position += 1) {
                    if (normalized[position] === alias && !used.has(position)) {
                        mapping[field] = position;
                        used.add(position);
                        return;
                    }
                }
            }
        });
        const unmapped = normalized
            .map((name, index) => ({ name, index }))
            .filter((item) => item.name && !used.has(item.index))
            .map((item) => item.name);
        return { mapping, unmapped, headers: normalized };
    }

    /** True when a section name is one of `aliases` (normalized). */
    function sectionMatches(name, aliases) {
        return (aliases || []).indexOf(normalizeHeader(name)) >= 0;
    }

    /**
     * Pull one section out of an Activity Statement.
     *
     * Only Data rows are taken. When a DataDiscriminator column exists,
     * "Order" rows are preferred and "Trade" rows are used only if there are
     * no Order rows: the two describe the same fill at different
     * granularities, and taking both double-counts every trade.
     */
    function extractSection(rows, aliases, aliasTable) {
        const groups = [];
        let current = null;
        (rows || []).forEach((row, index) => {
            if (!sectionMatches(row[0], aliases)) return;
            const rowType = normalizeHeader(row[1]);
            if (rowType === 'header') {
                const headers = row.slice(2);
                current = { headers, built: buildMapping(headers, aliasTable || {}), records: [] };
                groups.push(current);
                return;
            }
            // SubTotal and Total rows repeat figures already counted in the
            // Data rows; taking them would double every position.
            if (rowType !== 'data' || !current) return;
            current.records.push({ values: row.slice(2), lineNumber: index + 1 });
        });
        if (!groups.length) return null;

        groups.forEach((group) => {
            const discriminator = group.built.mapping.discriminator;
            if (discriminator === undefined) return;
            // Order and Trade rows describe the same fill at different
            // granularities; taking both double-counts every trade.
            const orders = group.records.filter(
                (record) => normalizeHeader(record.values[discriminator]) === 'order');
            const trades = group.records.filter(
                (record) => normalizeHeader(record.values[discriminator]) === 'trade');
            if (orders.length) {
                group.records = orders;
                // The per-fill rows are kept beside the order rows: they are
                // the statement's own evidence of how an order filled, which
                // is what lets a partially imported order be matched fill by
                // fill against TWS instead of blocked as a whole.
                group.fillRecords = trades;
            } else if (trades.length) {
                group.records = trades;
            }
            // Neither label matched: some sections discriminate by something
            // else entirely (Open Positions says "Summary"), and a locale
            // could translate the values. Dropping every row there would
            // fail silently as "0 drafts" with nothing to explain it, so
            // the records are kept as they are.

        });
        return { groups };
    }

    function extractAccount(rows, aliases) {
        const section = extractSection(rows, aliases);
        if (!section) return '';
        let found = '';
        section.groups.forEach((group) => {
            group.records.forEach((record) => {
                const label = normalizeHeader(record.values[0]);
                if (!found && (label === 'account' || label === '账户')) {
                    found = String(record.values[1] || '').trim();
                }
            });
        });
        return found;
    }

    // A redacted account is evidence of a possible match, never an identity.
    // Stars may hide more digits than their count, but visible digits must
    // all match. The caller must obtain a file-specific user confirmation.
    function matchStatementAccount(sourceAccount, targetAccount, confirmation) {
        const source = upper(sourceAccount);
        const target = upper(targetAccount);
        const mask = /^([A-Z]+\d*)\*+(\d{4,})$/.exec(source);
        const canConfirm = Boolean(mask && /^[A-Z]+\d+$/.test(target)
            && target.startsWith(mask[1]) && target.endsWith(mask[2])
            && target.length > mask[1].length + mask[2].length);
        const confirmed = canConfirm && confirmation
            && upper(confirmation.sourceAccount) === source
            && upper(confirmation.targetAccount) === target;
        const status = !source ? 'missing'
            : (source === target && !source.includes('*') ? 'exact'
                : (confirmed ? 'confirmed' : (canConfirm ? 'confirmation_required' : 'mismatch')));
        return { sourceAccount: source, targetAccount: target, canConfirm,
            status, confirmed: Boolean(confirmed) };
    }

    globalScope.OptionComboCostBasisImportCommon = Object.freeze({
        parseCsv,
        normalizeHeader,
        upper,
        number,
        malformedNumber,
        isoDate,
        localTimestamp,
        periodDates,
        extractStatementPeriod,
        extractStatementThrough,
        hash16,
        buildMapping,
        sectionMatches,
        extractSection,
        extractAccount,
        matchStatementAccount,
    });
})(typeof window !== 'undefined' ? window : globalThis);
