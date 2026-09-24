// Synthetic IBKR statements for the FOP importer tests (plan §13.3 P4).
//
// Writes a list of fills as the two statement shapes js/cost_basis_fop_import.js
// reads: an Activity Statement (sections, English or Chinese headers, Order and
// Trade rows, instrument, open-position, cash and mark-to-market sections) and a
// flat Flex trades export. The layouts are the ones listed in
// tests/fixtures/cost_basis_fop/statements/README.md; no real statement was
// used, so every key they exercise stays synthetic_only (plan §9.7).
//
// A fill: {symbol, local: 'YYYY-MM-DDTHH:MM:SS' (account-local), qty, price,
// commission (<= 0, as IBKR prints it), codes, tradeId?, execId?, orderId?,
// tradeDate? (exchange trade date, Flex), dateOnly? (Flex without DateTime)}.
'use strict';

const ACCOUNT = 'U1111111';

const CONTRACTS = {
    CLZ6: { asset: 'FUT', conid: 555, delivery: '2026-12', lastTrade: '2026-11-19', description: 'CL 19NOV26' },
    CLF7: { asset: 'FUT', conid: 556, delivery: '2027-01', lastTrade: '2026-12-17', description: 'CL 17DEC26' },
    CLG7: { asset: 'FUT', conid: 557, delivery: '2027-02', lastTrade: '2027-01-20', description: 'CL 20JAN27' },
    CLH7: { asset: 'FUT', conid: 558, delivery: '2027-03', lastTrade: '2027-02-19', description: 'CL 19FEB27' },
    MCLZ6: { asset: 'FUT', conid: 777, delivery: '2026-12', lastTrade: '2026-11-19', description: 'MCL 19NOV26',
        underlying: 'MCL', multiplier: 100 },
    'LOZ6 C7500': { asset: 'FOP', conid: 9001, underlying: 'CLZ6', underlyingConid: 555, right: 'C', strike: 75,
        expiry: '2026-11-17', description: 'CL 17NOV26 75 C' },
    'LOZ6 P6500': { asset: 'FOP', conid: 9002, underlying: 'CLZ6', underlyingConid: 555, right: 'P', strike: 65,
        expiry: '2026-11-17', description: 'CL 17NOV26 65 P' },
    'LOF7 C8000': { asset: 'FOP', conid: 9003, underlying: 'CLF7', underlyingConid: 556, right: 'C', strike: 80,
        expiry: '2026-12-16', description: 'CL 16DEC26 80 C' },
    // Outside the first release (plan §1.2): cash settled, and a zero strike.
    'LCZ6 C7500': { asset: 'FOP', conid: 9004, underlying: 'CLZ6', underlyingConid: 555, right: 'C', strike: 75,
        expiry: '2026-11-17', description: 'CL 17NOV26 75 C', settlement: 'Cash' },
    'LOZ6 C0': { asset: 'FOP', conid: 9005, underlying: 'CLZ6', underlyingConid: 555, right: 'C', strike: 0,
        expiry: '2026-11-17', description: 'CL 17NOV26 0 C' },
};

const EN = {
    trades: 'Trades', instruments: 'Financial Instrument Information', open: 'Open Positions',
    account: 'Account Information',
    tradeHeader: ['DataDiscriminator', 'Asset Category', 'Currency', 'Symbol', 'Date/Time', 'Quantity',
        'T. Price', 'Proceeds', 'Comm/Fee', 'Code'],
    fut: 'Futures', fop: 'Options On Futures',
};
const ZH = {
    trades: '交易', instruments: '金融产品信息', open: '未平仓持仓', account: '账户信息',
    // The Chinese header names both the contract and the notes column 代码.
    tradeHeader: ['DataDiscriminator', '资产分类', '货币', '代码', '日期/时间', '数量', '交易价格', '收益',
        '佣金/税', '代码'],
    fut: '期货', fop: '期货期权',
};

function csv(values) {
    return values.map((value) => {
        const text = value === null || value === undefined ? '' : String(value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(',');
}

function termsOf(symbol) {
    const terms = CONTRACTS[symbol];
    if (!terms) throw new Error(`no synthetic contract ${symbol}`);
    return terms;
}

function multiplierOf(terms) {
    return terms.multiplier || 1000;
}

function proceeds(fill) {
    const terms = termsOf(fill.symbol);
    if (fill.proceeds !== undefined) return fill.proceeds;
    return Number((-fill.qty * fill.price * multiplierOf(terms)).toFixed(6));
}

function activityTime(local) {
    return `${local.slice(0, 10)}, ${local.slice(11, 19)}`;
}

/**
 * options: {account, period: {from, through, text?}, generated, fills,
 * instruments (default true), openPositions: [{symbol, quantity, costPrice}],
 * cashReport, markToMarket, chinese, bom, orders: [{fills: [indexes]}] to
 * print Order rows over those fills, unknownSection}.
 */
function activity(options) {
    const words = options.chinese ? ZH : EN;
    const lines = [];
    lines.push(csv(['Statement', 'Header', 'Field Name', 'Field Value']));
    lines.push(csv(['Statement', 'Data', 'Title', 'Activity Statement']));
    if (options.period) {
        lines.push(csv(['Statement', 'Data', 'Period', options.period.text
            || `${longDate(options.period.from)} - ${longDate(options.period.through)}`]));
    }
    if (options.generated !== null) {
        lines.push(csv(['Statement', 'Data', 'WhenGenerated', options.generated || '2027-03-01, 09:15:00 EST']));
    }
    lines.push(csv([words.account, 'Header', 'Field Name', 'Field Value']));
    lines.push(csv([words.account, 'Data', 'Name', 'Synthetic Account']));
    lines.push(csv([words.account, 'Data', 'Account', options.account || ACCOUNT]));
    if (options.cashReport) {
        lines.push(csv(['Cash Report', 'Header', 'Currency Summary', 'Currency', 'Total', 'Futures']));
        lines.push(csv(['Cash Report', 'Data', 'Starting Cash', 'USD', '100000', '0']));
        lines.push(csv(['Cash Report', 'Data', 'Cash Settling MTM', 'USD', '-1500', '-1500']));
    }
    if (options.markToMarket) {
        lines.push(csv(['Mark-to-Market Performance Summary', 'Header', 'Asset Category', 'Symbol',
            'Prior Quantity', 'Current Quantity', 'Prior Price', 'Current Price', 'Mark-to-Market P/L Total']));
        lines.push(csv(['Mark-to-Market Performance Summary', 'Data', 'Futures', 'CLZ6', '0', '1', '0', '71',
            '1000']));
    }
    if (options.unknownSection) {
        lines.push(csv(['Deposits & Withdrawals', 'Header', 'Currency', 'Settle Date', 'Description', 'Amount']));
        lines.push(csv(['Deposits & Withdrawals', 'Data', 'USD', '2026-10-02', 'Electronic Fund Transfer', '5000']));
    }
    lines.push(csv([words.trades, 'Header', ...words.tradeHeader]));
    const orders = options.orders || [];
    const inOrder = new Set(orders.flatMap((order) => order.fills));
    const printed = new Set();
    (options.fills || []).forEach((fill, index) => {
        const order = orders.find((item) => item.fills[0] === index);
        if (order) {
            const members = order.fills.map((position) => options.fills[position]);
            const quantity = members.reduce((sum, item) => sum + item.qty, 0);
            const notional = members.reduce((sum, item) => sum + item.qty * item.price, 0);
            const commission = members.reduce((sum, item) => sum + (item.commission || 0), 0);
            const aggregate = Object.assign({}, members[0], { qty: quantity, price: order.price === undefined
                ? Number((notional / quantity).toFixed(10)) : order.price,
            commission: order.commission === undefined ? Number(commission.toFixed(6)) : order.commission,
            proceeds: undefined });
            lines.push(activityTradeRow(words, 'Order', aggregate));
            for (const position of order.fills) {
                lines.push(activityTradeRow(words, 'Trade', options.fills[position]));
                printed.add(position);
            }
            return;
        }
        if (inOrder.has(index) || printed.has(index)) return;
        lines.push(activityTradeRow(words, options.discriminator || 'Order', fill));
    });
    if (options.instruments !== false) {
        const symbols = [...new Set((options.fills || []).map((fill) => fill.symbol)
            .concat((options.openPositions || []).map((position) => position.symbol))
            .concat(options.extraInstruments || []))];
        const futures = symbols.filter((symbol) => termsOf(symbol).asset === 'FUT');
        const optionsList = symbols.filter((symbol) => termsOf(symbol).asset === 'FOP');
        const header = ['Asset Category', 'Symbol', 'Description', 'Conid', 'Underlying', 'Listing Exch',
            'Multiplier', 'Expiry', 'Delivery Month', 'Type', 'Strike', 'Settlement Type', 'Code'];
        if (futures.length) {
            lines.push(csv([words.instruments, 'Header', ...header]));
            for (const symbol of futures) {
                const terms = termsOf(symbol);
                lines.push(csv([words.instruments, 'Data', words.fut, symbol, terms.description, terms.conid,
                    terms.underlying || 'CL', 'NYMEX', multiplierOf(terms), terms.lastTrade,
                    options.noDeliveryMonth ? '' : terms.delivery, '', '', '', '']));
            }
        }
        if (optionsList.length) {
            lines.push(csv([words.instruments, 'Header', ...header]));
            for (const symbol of optionsList) {
                const terms = termsOf(symbol);
                lines.push(csv([words.instruments, 'Data', words.fop, symbol, terms.description, terms.conid,
                    terms.underlying, 'NYMEX', multiplierOf(terms), terms.expiry, '', terms.right, terms.strike,
                    terms.settlement || '', '']));
            }
        }
    }
    if (options.openPositions) {
        lines.push(csv([words.open, 'Header', 'DataDiscriminator', 'Asset Category', 'Currency', 'Symbol',
            'Quantity', 'Mult', 'Cost Price', 'Close Price']));
        for (const position of options.openPositions) {
            const terms = termsOf(position.symbol);
            lines.push(csv([words.open, 'Data', 'Summary', terms.asset === 'FUT' ? words.fut : words.fop, 'USD',
                position.symbol, position.quantity, multiplierOf(terms),
                position.costPrice === undefined ? '' : position.costPrice, position.closePrice || '']));
        }
    }
    const text = lines.join('\n') + '\n';
    return options.bom ? `﻿${text}` : text;
}

function activityTradeRow(words, discriminator, fill) {
    const terms = termsOf(fill.symbol);
    return csv([words.trades, 'Data', discriminator, terms.asset === 'FUT' ? words.fut : words.fop,
        fill.currency || 'USD', fill.symbol, fill.dateOnly ? fill.local.slice(0, 10) : activityTime(fill.local),
        fill.qty, fill.price, proceeds(fill), fill.commission || 0, fill.codes || '']);
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
    'October', 'November', 'December'];

function longDate(iso) {
    return `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
}

const FLEX_HEADER = ['ClientAccountID', 'CurrencyPrimary', 'AssetClass', 'Symbol', 'Description', 'Conid',
    'UnderlyingConid', 'UnderlyingSymbol', 'Multiplier', 'Strike', 'Expiry', 'Put/Call', 'TradeID', 'IBExecID',
    'IBOrderID', 'DateTime', 'TradeDate', 'Quantity', 'TradePrice', 'Proceeds', 'IBCommission', 'Notes/Codes',
    'ListingExchange'];

/**
 * options: {account, fills}; each fill needs a tradeId (a Flex trade id) and
 * may name its broker order (orderId, IBOrderID): an order-level row and its
 * executions name the same one.
 */
function flex(options) {
    const lines = [csv(FLEX_HEADER)];
    for (const fill of options.fills || []) {
        const terms = termsOf(fill.symbol);
        const future = terms.asset === 'FUT';
        const date = fill.tradeDate || fill.local.slice(0, 10);
        lines.push(csv([options.account || ACCOUNT, 'USD', future ? 'FUT' : 'FOP', fill.symbol, terms.description,
            terms.conid, future ? '' : terms.underlyingConid, future ? (terms.underlying || 'CL') : 'CL',
            multiplierOf(terms), future ? '' : terms.strike,
            (future ? terms.lastTrade : terms.expiry).replace(/-/g, ''), future ? '' : terms.right,
            fill.tradeId || '', fill.execId || '', fill.orderId || '',
            fill.dateOnly ? '' : `${fill.local.slice(0, 10).replace(/-/g, '')};${fill.local.slice(11, 19).replace(/:/g, '')}`,
            date.replace(/-/g, ''), fill.qty, fill.price, proceeds(fill), fill.commission || 0, fill.codes || '',
            'NYMEX']));
    }
    return lines.join('\n') + '\n';
}

module.exports = { ACCOUNT, CONTRACTS, activity, flex, longDate };
