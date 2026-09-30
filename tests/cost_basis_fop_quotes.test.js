// P5: one-shot quotes valued in the plan's fixed order (js/cost_basis_fop_quotes.js).
//
// CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §10.3 and §14.1 F16, F23, F43:
// mid, then the side a position closes against, then a dated settlement or
// close, then nothing; a zero bid only with a size behind it; a crossed book
// gives neither mid nor side; negative FUT prices are prices; a quote is
// current only while fresh and in sync, by the broker's time, never the page's;
// a batch belongs to the ledger version it was taken against.
'use strict';

const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

const Quotes = loadBrowserScripts(['js/cost_basis_fop_quotes.js']).OptionComboCostBasisFopQuotes;
const NOW = Date.parse('2026-11-12T15:00:00Z');
const VERSION = { eventCount: 5, liveEventCount: 5, maxSeq: 5, digest: 'a'.repeat(64) };
const LONG_FUT = { contractId: 'fut-cl-202701', secType: 'FUT', contracts: 1 };
const SHORT_FUT = { contractId: 'fut-cl-202612', secType: 'FUT', contracts: -2 };
const SHORT_CALL = { contractId: 'fop-c75', secType: 'FOP', contracts: -1 };
const LONG_PUT = { contractId: 'fop-p65', secType: 'FOP', contracts: 1 };

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function at(offsetSeconds) {
    return new Date(NOW + offsetSeconds * 1000).toISOString().replace('Z', '000Z');
}

function evidence(contractId, fields) {
    return Object.assign({ contractId, status: 'ok', reason: null, bid: null, bidSize: null, ask: null, askSize: null,
        last: null, lastSize: null, close: null, closeDate: null, settlement: null, settlementDate: null,
        observedAtUtc: at(-10), marketDataType: 1 }, fields);
}

function value(targets, quotes, context = {}) {
    const batch = { bookId: 'fopbook0001', quoteBatchId: 'quotes-1', ledgerVersion: context.version || VERSION,
        quotes };
    return plain(Quotes.evaluateBatch(batch, { targets, ledgerVersion: VERSION, now: context.now || NOW }));
}

function levels(result) {
    return result.quotes.map((quote) => [quote.contractId, quote.level, quote.mark]);
}

module.exports = {
    name: 'cost_basis_fop_quotes',
    tests: [
        {
            name: 'a two-sided, current and synchronised book is valued at its mid',
            run() {
                const result = value([LONG_FUT, SHORT_CALL], [
                    evidence(LONG_FUT.contractId, { bid: 72.4, bidSize: 3, ask: 72.5, askSize: 2 }),
                    evidence(SHORT_CALL.contractId, { bid: 0.3, bidSize: 5, ask: 0.35, askSize: 5 })]);
                const mid = (0.3 + 0.35) / 2;
                assert.deepEqual(levels(result), [[LONG_FUT.contractId, 'mid', (72.4 + 72.5) / 2],
                    [SHORT_CALL.contractId, 'mid', mid]]);
                assert.equal(result.marketData, 'complete');
                assert.equal(result.lowest, 'mid');
                assert.deepEqual(result.marks, { [LONG_FUT.contractId]: (72.4 + 72.5) / 2, [SHORT_CALL.contractId]: mid });
            },
        },
        {
            name: 'a single side is used only for the direction that would close against it (F43)',
            run() {
                const right = value([LONG_FUT, SHORT_FUT, SHORT_CALL, LONG_PUT], [
                    evidence(LONG_FUT.contractId, { bid: 72.4, bidSize: 3 }),
                    evidence(SHORT_FUT.contractId, { ask: 70.1, askSize: 1 }),
                    evidence(SHORT_CALL.contractId, { ask: 0.35, askSize: 5 }),
                    evidence(LONG_PUT.contractId, { bid: 0.02, bidSize: 4 })]);
                assert.deepEqual(right.quotes.map((quote) => [quote.level, quote.mark, quote.reason]), [
                    ['one_sided_conservative', 72.4, 'long_uses_bid'], ['one_sided_conservative', 70.1, 'short_uses_ask'],
                    ['one_sided_conservative', 0.35, 'short_uses_ask'], ['one_sided_conservative', 0.02, 'long_uses_bid']]);
                assert.equal(right.marketData, 'complete');
                // The wrong side: a long with only an ask, a short with only a bid.
                const wrong = value([LONG_FUT, SHORT_CALL], [
                    evidence(LONG_FUT.contractId, { ask: 72.5, askSize: 2 }),
                    evidence(SHORT_CALL.contractId, { bid: 0.3, bidSize: 5 })]);
                assert.deepEqual(wrong.quotes.map((quote) => [quote.level, quote.reason]),
                    [['unavailable', 'only_the_opposite_side'], ['unavailable', 'only_the_opposite_side']]);
                assert.deepEqual(wrong.marks, {});
                assert.equal(wrong.marketData, 'incomplete');
            },
        },
        {
            name: 'a zero bid counts only with a size, and a negative FUT price is a price (F16)',
            run() {
                const zero = value([LONG_PUT], [evidence(LONG_PUT.contractId, { bid: 0, bidSize: 4, ask: 0.05, askSize: 6 })]);
                assert.deepEqual(levels(zero), [[LONG_PUT.contractId, 'mid', 0.025]]);
                const empty = value([LONG_PUT], [evidence(LONG_PUT.contractId, { bid: 0, bidSize: 0 })]);
                assert.equal(empty.quotes[0].level, 'unavailable');
                assert.equal(Quotes.sideValid(0, null, 'FOP'), false, 'a zero without a size is no quote');
                assert.equal(Quotes.sideValid(-0.5, 3, 'FOP'), false, 'an option price is never negative');
                const negative = value([SHORT_FUT], [evidence(SHORT_FUT.contractId, { bid: -1.3, bidSize: 2, ask: -1.2,
                    askSize: 4 })]);
                assert.deepEqual(levels(negative), [[SHORT_FUT.contractId, 'mid', -1.25]]);
            },
        },
        {
            name: 'a crossed book or a stale, delayed or unsynchronised quote falls to a dated reference',
            run() {
                const settlement = { settlement: 72.3, settlementDate: '2026-11-11' };
                const crossed = value([LONG_FUT], [evidence(LONG_FUT.contractId, Object.assign({ bid: 72.6, bidSize: 3,
                    ask: 72.5, askSize: 2 }, settlement))]);
                assert.deepEqual(crossed.quotes.map((quote) => [quote.level, quote.mark, quote.reason, quote.referenceDate]),
                    [['settlement_reference', 72.3, 'crossed_bbo', '2026-11-11']]);
                assert.equal(crossed.marketData, 'reference');
                const two = { bid: 72.4, bidSize: 3, ask: 72.5, askSize: 2 };
                const stale = value([LONG_FUT], [evidence(LONG_FUT.contractId, Object.assign({}, two, settlement))],
                    { now: NOW + (Quotes.FRESH_SECONDS + 1) * 1000 });
                assert.deepEqual([stale.quotes[0].level, stale.quotes[0].reason], ['settlement_reference', 'stale']);
                const delayed = value([LONG_FUT], [evidence(LONG_FUT.contractId, Object.assign({ marketDataType: 3 }, two,
                    { close: 72.2, closeDate: '2026-11-11' }))]);
                assert.deepEqual([delayed.quotes[0].level, delayed.quotes[0].reason],
                    ['close_reference', 'market_data_type_3']);
                const apart = value([LONG_FUT, SHORT_CALL], [
                    evidence(LONG_FUT.contractId, Object.assign({}, two, { observedAtUtc: at(-100) })),
                    evidence(SHORT_CALL.contractId, { bid: 0.3, bidSize: 5, ask: 0.35, askSize: 5, observedAtUtc: at(-5) })]);
                assert.deepEqual(apart.quotes.map((quote) => [quote.level, quote.reason]),
                    [['unavailable', 'out_of_sync'], ['mid', null]]);
                // A reference needs its date; a close without one is no reference.
                const undated = value([LONG_FUT], [evidence(LONG_FUT.contractId, { close: 72.2, marketDataType: 2 })]);
                assert.equal(undated.quotes[0].level, 'unavailable');
            },
        },
        {
            name: 'the lowest level governs the batch and failed contracts are unavailable',
            run() {
                const result = value([LONG_FUT, SHORT_CALL, LONG_PUT], [
                    evidence(LONG_FUT.contractId, { bid: 72.4, bidSize: 3, ask: 72.5, askSize: 2 }),
                    evidence(SHORT_CALL.contractId, { status: 'identity_conflict', reason: 'conId 9002' })]);
                assert.deepEqual(result.quotes.map((quote) => [quote.level, quote.reason]),
                    [['mid', null], ['unavailable', 'identity_conflict'], ['unavailable', 'not_quoted']]);
                assert.equal(result.lowest, 'unavailable');
                assert.equal(result.marketData, 'incomplete');
                assert.deepEqual(Object.keys(result.marks), [LONG_FUT.contractId]);
                // Nothing open needs a price (F43): complete without a request.
                assert.equal(value([], []).marketData, 'complete');
            },
        },
        {
            name: 'a batch is shown only for the ledger, version and request it answers (F23)',
            run() {
                const other = value([LONG_FUT], [evidence(LONG_FUT.contractId, { bid: 72.4, bidSize: 3, ask: 72.5,
                    askSize: 2 })], { version: Object.assign({}, VERSION, { digest: 'b'.repeat(64) }) });
                assert.equal(other.usable, false);
                assert.equal(other.reason, 'ledger_changed');
                assert.deepEqual(other.marks, {});
                const batch = { bookId: 'fopbook0001', ledgerVersion: VERSION };
                const state = { bookId: 'fopbook0001', generation: 3, ledgerVersion: VERSION };
                assert.equal(Quotes.acceptsBatch({ bookId: 'fopbook0001', generation: 3 }, batch, state), true);
                assert.equal(Quotes.acceptsBatch({ bookId: 'fopbook0001', generation: 2 }, batch, state), false,
                    'an older request');
                assert.equal(Quotes.acceptsBatch({ bookId: 'fopbook0002', generation: 3 }, batch,
                    Object.assign({}, state, { bookId: 'fopbook0002' })), false, 'another ledger');
                assert.equal(Quotes.acceptsBatch({ bookId: 'fopbook0001', generation: 3 }, batch,
                    Object.assign({}, state, { ledgerVersion: { digest: 'c'.repeat(64) } })), false, 'a newer version');
            },
        },
        {
            name: 'a bound future the ledger does not hold is quoted as a stress anchor, apart from the ledger\'s marks (P7)',
            run() {
                const known = (count) => ({ value: count, reason: null });
                const output = {
                    futures: [{ contractId: LONG_FUT.contractId, contracts: known(1) }],
                    options: [
                        { contractId: SHORT_CALL.contractId, contracts: known(-1), boundFutureContractId: SHORT_FUT.contractId,
                            bindingStatus: 'verified_statement' },
                        { contractId: LONG_PUT.contractId, contracts: known(1), boundFutureContractId: LONG_FUT.contractId,
                            bindingStatus: 'verified_broker' },
                        { contractId: 'fop-unbound', contracts: known(-1), boundFutureContractId: null,
                            bindingStatus: 'unresolved' },
                    ],
                };
                const targets = Quotes.quoteTargets(output);
                assert.deepEqual(plain(targets.filter((target) => target.role === 'anchor')),
                    [{ contractId: SHORT_FUT.contractId, secType: 'FUT', contracts: null, role: 'anchor' }],
                    'only the bound future that is not held; a held one is quoted once, an unresolved one not at all');
                const quotes = [evidence(LONG_FUT.contractId, { bid: 72.4, bidSize: 3, ask: 72.5, askSize: 2 }),
                    evidence(SHORT_CALL.contractId, { bid: 1.1, bidSize: 3, ask: 1.2, askSize: 2 }),
                    evidence(LONG_PUT.contractId, { bid: 0.4, bidSize: 3, ask: 0.5, askSize: 2 }),
                    evidence('fop-unbound', { bid: 0.4, bidSize: 3, ask: 0.5, askSize: 2 }),
                    evidence(SHORT_FUT.contractId, { bid: 71.9, bidSize: 3, ask: 72.1, askSize: 2 })];
                const result = value(targets, quotes);
                assert.equal(result.anchors[SHORT_FUT.contractId].level, 'mid');
                assert.equal(result.anchors[SHORT_FUT.contractId].mark, 72);
                assert.ok(!(SHORT_FUT.contractId in result.marks), 'an anchor never values the ledger');
                assert.ok(!result.quotes.some((quote) => quote.contractId === SHORT_FUT.contractId));
                // An anchor without a quote leaves the ledger's own level alone, and has no side to fall back to.
                const missing = value(targets, quotes.slice(0, 4));
                assert.equal(missing.lowest, 'mid');
                assert.equal(missing.marketData, 'complete');
                assert.equal(missing.anchors[SHORT_FUT.contractId].level, 'unavailable');
                const oneSided = value(targets, quotes.slice(0, 4).concat([evidence(SHORT_FUT.contractId,
                    { bid: 71.9, bidSize: 3 })]));
                assert.equal(oneSided.anchors[SHORT_FUT.contractId].level, 'unavailable');
                // An anchor is re-aged with the rest: as the oldest current quote (50 s old, still in sync
                // with the others at 10 s), it is the first to stop being fresh.
                const aged = value(targets, quotes.slice(0, 4).concat([evidence(SHORT_FUT.contractId,
                    { bid: 71.9, bidSize: 3, ask: 72.1, askSize: 2, observedAtUtc: at(-50) })]));
                assert.equal(aged.anchors[SHORT_FUT.contractId].level, 'mid');
                assert.equal(Quotes.currentUntil(aged), NOW - 50 * 1000 + Quotes.FRESH_SECONDS * 1000);
                // The stress view reads every contract, anchor included, in one window with the batch's newest time.
                assert.deepEqual(Object.keys(result.stress.quotes).sort(), plain(targets.map((target) => target.contractId)).sort());
                assert.equal(result.stress.asOf, at(-10));
                assert.deepEqual(result.stress.quotes[SHORT_CALL.contractId].level, 'mid');
            },
        },
        {
            name: 'an anchor never moves the ledger\'s sync window; the stress view holds them all to one (P7 review)',
            run() {
                // Three ledger quotes, all 70 s old and in sync with each other, are mids. A bound future the
                // ledger does not hold, observed just now, must not push them out of sync on the ledger view.
                const known = (count) => ({ value: count, reason: null });
                const targets = Quotes.quoteTargets({
                    futures: [{ contractId: LONG_FUT.contractId, contracts: known(1) }],
                    options: [
                        { contractId: SHORT_CALL.contractId, contracts: known(-1), boundFutureContractId: SHORT_FUT.contractId,
                            bindingStatus: 'verified_statement' },
                        { contractId: LONG_PUT.contractId, contracts: known(1), boundFutureContractId: LONG_FUT.contractId,
                            bindingStatus: 'verified_broker' },
                    ],
                });
                const old = [evidence(LONG_FUT.contractId, { bid: 72.4, bidSize: 3, ask: 72.5, askSize: 2, observedAtUtc: at(-70) }),
                    evidence(SHORT_CALL.contractId, { bid: 1.1, bidSize: 3, ask: 1.2, askSize: 2, observedAtUtc: at(-70) }),
                    evidence(LONG_PUT.contractId, { bid: 0.4, bidSize: 3, ask: 0.5, askSize: 2, observedAtUtc: at(-70) })];
                const alone = value(targets.filter((target) => target.role !== 'anchor'), old);
                const withAnchor = value(targets, old.concat([evidence(SHORT_FUT.contractId,
                    { bid: 71.9, bidSize: 3, ask: 72.1, askSize: 2, observedAtUtc: at(0) })]));
                assert.deepEqual(levels(withAnchor), levels(alone), 'the ledger view is what it is without the anchor');
                assert.deepEqual(levels(withAnchor).map((row) => row[1]), ['mid', 'mid', 'mid']);
                assert.deepEqual(withAnchor.marks, alone.marks);
                assert.equal(withAnchor.lowest, 'mid');
                assert.equal(withAnchor.marketData, 'complete');
                // For the stress view the batch is not synchronised: the option mids are 70 s older than the
                // future the call is bound to, so none of them anchors an implied volatility.
                assert.equal(withAnchor.stress.asOf, at(0));
                assert.equal(withAnchor.stress.quotes[SHORT_FUT.contractId].level, 'mid');
                for (const id of [LONG_FUT.contractId, SHORT_CALL.contractId, LONG_PUT.contractId]) {
                    assert.deepEqual([withAnchor.stress.quotes[id].level, withAnchor.stress.quotes[id].reason],
                        ['unavailable', 'out_of_sync'], id);
                }
                // In sync with the anchor, the stress view has the same mids as the ledger.
                const together = value(targets, old.map((item) => Object.assign({}, item, { observedAtUtc: at(-20) }))
                    .concat([evidence(SHORT_FUT.contractId, { bid: 71.9, bidSize: 3, ask: 72.1, askSize: 2,
                        observedAtUtc: at(0) })]));
                assert.deepEqual(Object.values(together.stress.quotes).map((quote) => quote.level),
                    ['mid', 'mid', 'mid', 'mid']);
            },
        },
    ],
};
