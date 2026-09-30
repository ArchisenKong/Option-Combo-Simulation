/**
 * One-shot quotes for the FOP ledger page (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md
 * §10.3, §13.3 P5 item 2). DOM-free and Node-testable; the page loads it
 * after js/cost_basis_fop_core.js.
 *
 * The server's request_cost_basis_fop_market_snapshot reports, per contract,
 * what the broker said (MarketQuoteEvidence). This module turns one batch
 * into Quote rows (protocol.json) and the marks the core values with, in the
 * plan's fixed order, labelling every contract with the level it reached:
 *
 *   1. mid: both sides valid, not crossed, real-time, fresh and in sync;
 *   2. one_sided_conservative: no usable mid, but the side a position would
 *      close against is valid, real-time and fresh (a short needs the ask, a
 *      long the bid; the wrong side is never used);
 *   3. settlement_reference, then close_reference: a prior settlement or
 *      close with its date. Values from it are a reference, never current;
 *   4. unavailable.
 *
 * A zero bid is valid only with a size standing there; IB's -1 without a size
 * is no quote (the server already removed it), and a FUT may be negative. A
 * crossed book gives no mid and no side. The batch is used only for the
 * ledger version it was taken against, and a quote counts as current only
 * for FRESH_SECONDS after the broker observed it and within SYNC_SECONDS of
 * the batch's other quotes: the page's clock never re-dates a quote.
 *
 * A future that an open option is bound to but the ledger does not hold is
 * quoted too, as an anchor for the stress view (stress contract §2.2): its
 * level and mark stand apart in `anchors` and never enter the ledger's marks,
 * the lowest level the ledger view reports, or the sync window its quotes are
 * held to. The stress view reads `stress` instead: every quoted contract,
 * anchors included, held to one sync window over the whole batch, since an
 * implied volatility needs its option and its future observed together.
 */
(function attachCostBasisFopQuotes(globalScope) {
    'use strict';

    const SYNC_SECONDS = 60;
    const FRESH_SECONDS = 120;
    const REALTIME = 1;
    const LEVELS = Object.freeze(['mid', 'one_sided_conservative', 'settlement_reference', 'close_reference',
        'unavailable']);
    const LEVEL_LABELS = Object.freeze({
        mid: '实时中间价', one_sided_conservative: '单边保守估值', settlement_reference: '结算参考',
        close_reference: '收盘参考', unavailable: '无可用报价',
    });

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function instantMillis(text) {
        if (typeof text !== 'string') return null;
        const millis = Date.parse(text);
        return Number.isFinite(millis) ? millis : null;
    }

    /** A quoted side is usable: a number, never a negative option price, and a size behind zero or less. */
    function sideValid(price, size, secType) {
        if (!finite(price)) return false;
        if (secType === 'FOP' && price < 0) return false;
        if (price <= 0) return finite(size) && size > 0;
        return !finite(size) || size > 0;
    }

    /**
     * The contracts a batch should quote: every open FUT and FOP of the core
     * output with its signed quantity. A closed contract needs no price
     * (plan §10.3); a contract whose quantity is unknown is still quoted,
     * valued only by a mid or a reference.
     */
    function quoteTargets(output) {
        const targets = [];
        for (const row of output.futures || []) {
            targets.push({ contractId: row.contractId, secType: 'FUT', contracts: row.contracts.value });
        }
        for (const row of output.options || []) {
            targets.push({ contractId: row.contractId, secType: 'FOP', contracts: row.contracts.value });
        }
        // Anchors: the bound futures the ledger does not hold. No quantity, so
        // only a mid or a dated reference can value one.
        const quoted = new Set(targets.map((target) => target.contractId));
        for (const row of output.options || []) {
            const future = row.boundFutureContractId;
            if (!future || quoted.has(future) || row.bindingStatus === 'unresolved' || row.bindingStatus === 'conflict'
                || row.contracts.value === 0) continue;
            quoted.add(future);
            targets.push({ contractId: future, secType: 'FUT', contracts: null, role: 'anchor' });
        }
        return targets;
    }

    function unavailable(evidence, reason) {
        return { level: 'unavailable', mark: null, reason, referenceDate: null };
    }

    /** One contract's level, mark and reason from its evidence (plan §10.3). */
    function valueOne(evidence, target, context) {
        if (!evidence) return unavailable(null, 'not_quoted');
        if (evidence.status !== 'ok') return unavailable(evidence, evidence.status);
        const secType = target.secType;
        const observed = instantMillis(evidence.observedAtUtc);
        const realtime = evidence.marketDataType === REALTIME;
        const fresh = observed !== null && context.now - observed <= FRESH_SECONDS * 1000
            && context.now - observed >= -SYNC_SECONDS * 1000;
        const synced = observed !== null && context.newest !== null
            && context.newest - observed <= SYNC_SECONDS * 1000;
        const current = realtime && fresh && synced;
        const bid = sideValid(evidence.bid, evidence.bidSize, secType);
        const ask = sideValid(evidence.ask, evidence.askSize, secType);
        const crossed = bid && ask && evidence.bid > evidence.ask;
        let reason = null;
        if (current && !crossed) {
            if (bid && ask) return { level: 'mid', mark: (evidence.bid + evidence.ask) / 2, reason, referenceDate: null };
            const quantity = target.contracts;
            if (finite(quantity) && quantity < 0 && ask) {
                return { level: 'one_sided_conservative', mark: evidence.ask, reason: 'short_uses_ask',
                    referenceDate: null };
            }
            if (finite(quantity) && quantity > 0 && bid) {
                return { level: 'one_sided_conservative', mark: evidence.bid, reason: 'long_uses_bid',
                    referenceDate: null };
            }
            reason = (bid || ask) ? 'only_the_opposite_side' : 'no_bid_or_ask';
        } else if (crossed) {
            reason = 'crossed_bbo';
        } else if (!realtime) {
            reason = evidence.marketDataType === null || evidence.marketDataType === undefined
                ? 'market_data_type_unknown' : `market_data_type_${evidence.marketDataType}`;
        } else if (observed === null) {
            reason = 'no_observation_time';
        } else if (!fresh) {
            reason = 'stale';
        } else {
            reason = 'out_of_sync';
        }
        // A dated prior settlement, else a dated prior close: a reference.
        const reference = (price, date) => finite(price) && typeof date === 'string'
            && (secType !== 'FOP' || price >= 0);
        if (reference(evidence.settlement, evidence.settlementDate)) {
            return { level: 'settlement_reference', mark: evidence.settlement, reason,
                referenceDate: evidence.settlementDate };
        }
        if (reference(evidence.close, evidence.closeDate)) {
            return { level: 'close_reference', mark: evidence.close, reason, referenceDate: evidence.closeDate };
        }
        return unavailable(evidence, reason);
    }

    /**
     * The newest real-time observation among some targets' evidence (epoch
     * ms and its text), the instant their sync window is measured from. An
     * observation more than SYNC_SECONDS ahead of the page's clock is not
     * counted.
     */
    function newestOf(targets, byId, now) {
        let newest = null;
        let text = null;
        for (const target of targets) {
            const evidence = byId.get(target.contractId);
            const observed = evidence && evidence.status === 'ok' && evidence.marketDataType === REALTIME
                ? instantMillis(evidence.observedAtUtc) : null;
            if (observed !== null && observed <= now + SYNC_SECONDS * 1000 && (newest === null || observed > newest)) {
                newest = observed;
                text = evidence.observedAtUtc;
            }
        }
        return { newest, text };
    }

    /**
     * One batch valued against what the page shows.
     * batch: the MarketSnapshotResponse; context: {targets (quoteTargets),
     * ledgerVersion (the ledger the page shows), now (epoch ms, the page's
     * clock, only to age quotes)}. Returns {usable, reason, quoteBatchId,
     * quotes: [Quote + level, label, reason], marks: {contractId: mark},
     * lowest, marketData: complete|reference|incomplete|not_checked,
     * anchors: {contractId: {level, label, mark, reason, referenceDate,
     * observedAtUtc}}, stress: {asOf, quotes: {contractId: the same}}}.
     * The ledger's quotes are synced among themselves only, exactly as
     * without anchors; anchors are the targets with role 'anchor'. `stress`
     * values every target, anchors included, against the newest observation
     * of the whole batch (stress contract §2.2), and asOf is that
     * observation's text (null without one).
     */
    function evaluateBatch(batch, context) {
        const all = context.targets || [];
        const targets = all.filter((target) => target.role !== 'anchor');
        const anchorTargets = all.filter((target) => target.role === 'anchor');
        const empty = { usable: false, reason: null, quoteBatchId: batch ? batch.quoteBatchId : null, quotes: [],
            marks: {}, lowest: null, marketData: targets.length ? 'not_checked' : 'complete', anchors: {},
            stress: { asOf: null, quotes: {} } };
        if (!batch) return Object.assign(empty, { reason: 'no_batch' });
        const version = context.ledgerVersion;
        if (!version || !batch.ledgerVersion || batch.ledgerVersion.digest !== version.digest) {
            // Taken against another ledger version: never shown (F23).
            return Object.assign(empty, { reason: 'ledger_changed' });
        }
        const byId = new Map((batch.quotes || []).map((evidence) => [evidence.contractId, evidence]));
        const { newest } = newestOf(targets, byId, context.now);
        const joint = newestOf(all, byId, context.now);
        const quotes = [];
        const marks = {};
        let lowest = 0;
        for (const target of targets) {
            const evidence = byId.get(target.contractId) || null;
            const valued = valueOne(evidence, target, { now: context.now, newest });
            lowest = Math.max(lowest, LEVELS.indexOf(valued.level));
            if (valued.mark !== null) marks[target.contractId] = valued.mark;
            quotes.push({
                contractId: target.contractId,
                bid: evidence && finite(evidence.bid) ? evidence.bid : null,
                ask: evidence && finite(evidence.ask) ? evidence.ask : null,
                last: evidence && finite(evidence.last) ? evidence.last : null,
                mark: valued.mark,
                markSource: valued.level,
                referenceDate: valued.referenceDate,
                observedAtUtc: evidence ? evidence.observedAtUtc || null : null,
                marketDataType: evidence && Number.isInteger(evidence.marketDataType) ? evidence.marketDataType : null,
                level: valued.level,
                label: LEVEL_LABELS[valued.level],
                reason: valued.reason,
            });
        }
        // The stress view's quotes: one sync window over the whole batch.
        const stressQuotes = {};
        for (const target of all) {
            const evidence = byId.get(target.contractId) || null;
            const valued = valueOne(evidence, target, { now: context.now, newest: joint.newest });
            stressQuotes[target.contractId] = { level: valued.level, label: LEVEL_LABELS[valued.level],
                mark: valued.mark, reason: valued.reason, referenceDate: valued.referenceDate,
                observedAtUtc: evidence ? evidence.observedAtUtc || null : null };
        }
        const anchors = {};
        for (const target of anchorTargets) anchors[target.contractId] = stressQuotes[target.contractId];
        const level = targets.length ? LEVELS[lowest] : null;
        let marketData = 'complete';
        if (level === 'unavailable') marketData = 'incomplete';
        else if (level === 'settlement_reference' || level === 'close_reference') marketData = 'reference';
        return { usable: true, reason: null, quoteBatchId: batch.quoteBatchId, quotes, marks, lowest: level,
            marketData, anchors, stress: { asOf: joint.text, quotes: stressQuotes } };
    }

    /**
     * When the first quote now counted as current stops being fresh (epoch
     * ms), or null when none is: the page re-ages the batch at that moment,
     * so no quote is shown as current past FRESH_SECONDS.
     */
    function currentUntil(quoteState) {
        let until = null;
        const anchors = Object.values((quoteState && quoteState.usable && quoteState.anchors) || {});
        for (const quote of ((quoteState && quoteState.usable && quoteState.quotes) || []).concat(anchors)) {
            if (quote.level !== 'mid' && quote.level !== 'one_sided_conservative') continue;
            const observed = instantMillis(quote.observedAtUtc);
            if (observed === null) continue;
            const expires = observed + FRESH_SECONDS * 1000;
            if (until === null || expires < until) until = expires;
        }
        return until;
    }

    /**
     * Which quote batch the page may still show: the answer to the latest
     * request of the ledger on screen, taken against the version on screen.
     * request: {bookId, generation}; state: {bookId, generation, ledgerVersion}.
     */
    function acceptsBatch(request, batch, state) {
        if (!request || !batch || !state) return false;
        if (request.bookId !== state.bookId || request.generation !== state.generation) return false;
        if (batch.bookId !== state.bookId) return false;
        return Boolean(state.ledgerVersion && batch.ledgerVersion
            && batch.ledgerVersion.digest === state.ledgerVersion.digest);
    }

    globalScope.OptionComboCostBasisFopQuotes = Object.freeze({
        SYNC_SECONDS,
        FRESH_SECONDS,
        LEVELS,
        LEVEL_LABELS,
        sideValid,
        quoteTargets,
        evaluateBatch,
        currentUntil,
        acceptsBatch,
    });
})(typeof window !== 'undefined' ? window : globalThis);
