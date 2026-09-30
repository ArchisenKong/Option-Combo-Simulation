/**
 * Stress scenarios of the FOP ledger (CODE PLAN/COST_BASIS_FOP_STRESS_CONTRACT.md).
 * DOM-free and Node-testable; the page runs it in js/cost_basis_fop_stress_worker.js.
 *
 * One run freezes a ledger graph, one quote batch, a discount rate and the
 * scenario parameters, and answers: if every futures month moves as assumed,
 * time passes and implied volatility scales, what does the economic P&L of
 * the positions held now become (plan §5.2)?
 *
 * - Each option is priced off its own bound future: an American CRR tree on a
 *   future (js/american_binomial.js with dividendYield = riskFreeRate) or
 *   Black-76 for a European option. At expiry an option is worth its
 *   intrinsic value whatever the sign of F; before it, a future at or below
 *   zero stops the model (no epsilon).
 * - Implied volatility comes from synced mids only, its future's too.
 * - The path is immediate: every month jumps to its scenario price and holds.
 *   An option expiring inside the horizon settles at that price, strictly in
 *   the money onto its future at the strike; an American option may be chosen
 *   for delivery at the horizon where it is strictly in the money there.
 * - change is position-based and exactly 0 at the anchor; the total is the
 *   ledger core's replay of the graph plus the scenario's settlements, which
 *   exist only in memory. Nothing is written and nothing is sent.
 */
(function attachCostBasisFopStress(globalScope) {
    'use strict';

    const VERSION = 'fop-stress-v1';
    const MODEL_VERSION = 'crr201-black76-v1';
    const STEPS = 201;
    const SIGMA_MAX = 8;
    const BISECTIONS = 60;
    const PRICE_TOLERANCE = 1e-7;
    const DAY_MS = 86400 * 1000;
    const YEAR_MS = 365 * DAY_MS;
    const ORDER_SCOPE = 'fop-stress';
    const DEFAULTS = Object.freeze({ rangePct: 30, points: 61, slope: 0, horizonDays: 0, ivScale: 1, band: 0.2 });

    class StressStop extends Error {
        constructor(reason) {
            super(reason);
            this.reason = reason;
        }
    }

    function stop(reason) {
        throw new StressStop(reason);
    }

    function modules() {
        return {
            Core: globalScope.OptionComboCostBasisFopCore,
            Forms: globalScope.OptionComboCostBasisFopForms,
            Import: globalScope.OptionComboCostBasisFopImport,
            Binomial: globalScope.OptionComboAmericanBinomial,
            Curves: globalScope.OptionComboMarketCurves,
        };
    }

    // ------------------------------------------------------------------
    // Time (UtcInstant text; ACT/365F on milliseconds)
    // ------------------------------------------------------------------

    const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

    function millis(text) {
        const match = INSTANT.exec(String(text || ''));
        if (!match) return null;
        const fraction = (match[7] || '').padEnd(3, '0').slice(0, 3);
        return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]),
            Number(match[5]), Number(match[6]), Number(fraction));
    }

    function pad(value, width) {
        return String(value).padStart(width, '0');
    }

    function instantOf(ms) {
        const stamp = new Date(ms);
        return `${stamp.getUTCFullYear()}-${pad(stamp.getUTCMonth() + 1, 2)}-${pad(stamp.getUTCDate(), 2)}`
            + `T${pad(stamp.getUTCHours(), 2)}:${pad(stamp.getUTCMinutes(), 2)}:${pad(stamp.getUTCSeconds(), 2)}`
            + `.${pad(stamp.getUTCMilliseconds(), 3)}000Z`;
    }

    function years(fromMs, toMs) {
        return (toMs - fromMs) / YEAR_MS;
    }

    // ------------------------------------------------------------------
    // Pricers (contract §3)
    // ------------------------------------------------------------------

    /**
     * The standard normal distribution function, to double precision (Hart's
     * algorithm 5666 as given by G. West, 2005): contract §3.3 asks for an
     * absolute error of at most 1e-12.
     */
    function normalCdf(x) {
        const z = Math.abs(x);
        let tail;
        if (z > 37) {
            tail = 0;
        } else {
            const exponential = Math.exp(-z * z / 2);
            if (z < 7.07106781186547) {
                let numerator = 3.52624965998911e-02 * z + 0.700383064443688;
                numerator = numerator * z + 6.37396220353165;
                numerator = numerator * z + 33.912866078383;
                numerator = numerator * z + 112.079291497871;
                numerator = numerator * z + 221.213596169931;
                numerator = numerator * z + 220.206867912376;
                let denominator = 8.83883476483184e-02 * z + 1.75566716318264;
                denominator = denominator * z + 16.064177579207;
                denominator = denominator * z + 86.7807322029461;
                denominator = denominator * z + 296.564248779674;
                denominator = denominator * z + 637.333633378831;
                denominator = denominator * z + 793.826512519948;
                denominator = denominator * z + 440.413735824752;
                tail = exponential * numerator / denominator;
            } else {
                let fraction = z + 0.65;
                fraction = z + 4 / fraction;
                fraction = z + 3 / fraction;
                fraction = z + 2 / fraction;
                fraction = z + 1 / fraction;
                tail = exponential / fraction / 2.506628274631;
            }
        }
        return x > 0 ? 1 - tail : tail;
    }

    function intrinsic(right, future, strike) {
        return right === 'C' ? Math.max(0, future - strike) : Math.max(0, strike - future);
    }

    /**
     * A European option on a future (Black-76). At expiry its intrinsic
     * value whatever the sign of F; before it, null when F <= 0. Never
     * js/pricing_core.js calculateBlack76Price, which moves F <= 0 to 1e-4.
     */
    function black76(right, future, strike, tau, rate, sigma) {
        if (![future, strike, tau, rate, sigma].every(Number.isFinite) || strike <= 0 || tau < 0 || sigma < 0) {
            return null;
        }
        if (tau === 0) return intrinsic(right, future, strike);
        if (future <= 0) return null;
        const discount = Math.exp(-rate * tau);
        if (sigma === 0) return discount * intrinsic(right, future, strike);
        const root = sigma * Math.sqrt(tau);
        const d1 = (Math.log(future / strike) + 0.5 * sigma * sigma * tau) / root;
        const d2 = d1 - root;
        if (right === 'C') return discount * (future * normalCdf(d1) - strike * normalCdf(d2));
        return discount * (strike * normalCdf(-d2) - future * normalCdf(-d1));
    }

    /**
     * An American option on a future: the CRR tree of js/american_binomial.js
     * with no drift (dividendYield = riskFreeRate), 201 steps. That module
     * answers NaN for F <= 0 even at expiry, so expiry is handled here first.
     */
    function american(right, future, strike, tau, rate, sigma) {
        if (![future, strike, tau, rate, sigma].every(Number.isFinite) || strike <= 0 || tau < 0 || sigma < 0) {
            return null;
        }
        if (tau === 0) return intrinsic(right, future, strike);
        if (future <= 0) return null;
        const value = modules().Binomial.calculateAmericanOptionPrice({
            type: right === 'C' ? 'call' : 'put', spot: future, strike, varianceTime: tau, rateTime: tau,
            riskFreeRate: rate, dividendYield: rate, volatility: sigma, steps: STEPS,
        });
        return Number.isFinite(value) ? value : null;
    }

    function price(option, future, tau, rate, sigma) {
        const pricer = option.style === 'european' ? black76 : american;
        return pricer(option.right, future, option.strike, tau, rate, sigma);
    }

    /** Contract §4.1: bisection on [0, 8] for 60 halvings, or a named stop. */
    function impliedSigma(option, future, tau, rate, mark) {
        const floor = price(option, future, tau, rate, 0);
        const ceiling = price(option, future, tau, rate, SIGMA_MAX);
        if (floor === null || ceiling === null) stop('model_domain');
        if (mark < floor - PRICE_TOLERANCE) stop('quote_below_model_floor');
        if (mark > ceiling + PRICE_TOLERANCE) stop('quote_above_model_ceiling');
        let low = 0;
        let high = SIGMA_MAX;
        for (let index = 0; index < BISECTIONS; index += 1) {
            const middle = (low + high) / 2;
            if (price(option, future, tau, rate, middle) < mark) low = middle;
            else high = middle;
        }
        const sigma = (low + high) / 2;
        if (Math.abs(price(option, future, tau, rate, sigma) - mark) > PRICE_TOLERANCE) stop('calibration_failed');
        return sigma;
    }

    // ------------------------------------------------------------------
    // Rate (contract §2.3)
    // ------------------------------------------------------------------

    // The backend's answers for a curve dated no earlier than the latest market
    // business date (yield_curve/backend_adapter.py); 'cache_fallback' is an
    // older one kept because nothing newer is cached.
    const CURRENT_CURVE = Object.freeze(['cached', 'updated']);

    /**
     * {source, at(tauYears) -> rate | null}, {stale: true, asOfDate} or null.
     * A dated discount curve (the backend snapshot, with the status the
     * backend answered it with) gives the zero rate at each remaining tenor,
     * the curve's shape held fixed; a curve the backend calls out of date,
     * or that marks itself stale, is not used (contract §2.3). An assumed
     * rate is one labelled constant.
     */
    function rateSource(rate) {
        if (!rate) return null;
        if (rate.source === 'assumed') {
            return Number.isFinite(rate.value) ? { source: 'assumed', value: rate.value, at: () => rate.value } : null;
        }
        if (rate.source !== 'curve' || !rate.curve) return null;
        const { Curves } = modules();
        let curve;
        try {
            curve = Curves.createDiscountCurveFromSnapshot(rate.curve);
        } catch (_) {
            return null;
        }
        if (curve.currency && curve.currency !== 'USD') return null;
        if (rate.status === 'cache_fallback' || (curve.metadata && curve.metadata.stale === true)) {
            return { stale: true, asOfDate: curve.asOf || null };
        }
        if (!CURRENT_CURVE.includes(rate.status)) return null;
        return {
            source: 'curve', asOfDate: curve.asOf || null, status: rate.status,
            at(tau) {
                if (tau <= 0) return 0;
                try {
                    const resolved = Curves.resolveDiscount(curve, { tenorDays: tau * 365 });
                    return resolved && resolved.usable !== false && Number.isFinite(resolved.zeroRate)
                        ? resolved.zeroRate : null;
                } catch (_) {
                    return null;
                }
            },
        };
    }

    // ------------------------------------------------------------------
    // Compile: positions, anchors and implied volatilities at asOf
    // ------------------------------------------------------------------

    function current(graph) {
        const records = new Map();
        for (const stored of (graph && graph.contracts) || []) {
            if (stored.supersededByRevision === null || stored.supersededByRevision === undefined) {
                records.set(stored.record.contractId, stored.record);
            }
        }
        const bindings = new Map();
        for (const binding of (graph && graph.bindings) || []) {
            if (binding.supersededByRevision === null || binding.supersededByRevision === undefined) {
                bindings.set(binding.optionContractId, binding);
            }
        }
        return { records, bindings };
    }

    function latestEvent(graph) {
        return ((graph && graph.events) || []).filter((stored) => !stored.row.voidedAtUtc).map((stored) => {
            const time = stored.row.fop.time;
            return millis(time.executedAtUtc || (time.timeRange ? time.timeRange.endUtc : null));
        }).filter((value) => value !== null).reduce((latest, value) => Math.max(latest, value), -Infinity);
    }

    function monthIndex(month) {
        return Number(month.slice(0, 4)) * 12 + Number(month.slice(4, 6));
    }

    /**
     * input: {graph, asOf (UtcInstant), quotes {contractId: {level, mark}},
     * rate ({source: 'curve', curve, status} | {source: 'assumed', value} |
     * null), reference (a future's contractId, optional), ledgerDigest,
     * quoteBatchId}. Returns the compiled run, {available: true, empty: true}
     * when nothing is open, or {available: false, reasons} listing every stop
     * (§4.2): every check that stands on its own is made before any implied
     * volatility, which needs all of them to pass, is solved.
     */
    function compile(input) {
        const { Core, Import } = modules();
        const graph = input.graph;
        const asOfMs = millis(input.asOf);
        const reasons = [];
        const add = (reason) => {
            if (!reasons.includes(reason)) reasons.push(reason);
        };
        if (!graph || asOfMs === null) return { version: VERSION, available: false, reasons: ['quote_batch_unusable'] };
        const productRules = graph.fopBook && graph.fopBook.productRules;
        const rules = Import.PRODUCT_RULES[productRules];
        if (!rules) return { version: VERSION, available: false, reasons: [`product_rules_unsupported:${productRules}`] };
        if (latestEvent(graph) >= asOfMs) add('ledger_changed');
        const output = Core.computeLedger(graph, { rolls: false });
        const { records, bindings } = current(graph);
        const futures = {};
        const options = {};
        for (const row of output.futures) {
            if (row.contracts.value === null) add(`quantity_unknown:${row.contractId}`);
            else if (row.contracts.value !== 0) futures[row.contractId] = row.contracts.value;
        }
        const openOptions = [];
        for (const row of output.options) {
            if (row.contracts.value === null) add(`quantity_unknown:${row.contractId}`);
            else if (row.contracts.value !== 0) openOptions.push(row);
        }
        const quotes = input.quotes || {};
        const ledgerMarks = {};
        for (const [id, quote] of Object.entries(quotes)) {
            if (quote && quote.level !== 'unavailable' && Number.isFinite(quote.mark)) ledgerMarks[id] = quote.mark;
        }
        const ledger = Core.computeLedger(graph, { rolls: false, marks: ledgerMarks });
        const base = { version: VERSION, asOf: input.asOf, ledgerDigest: input.ledgerDigest || null,
            quoteBatchId: input.quoteBatchId || null, ledgerEconomicPnl: ledger.totals.economicPnl };
        if (!reasons.length && !Object.keys(futures).length && !openOptions.length) {
            // Nothing open, nothing to move (contract §7.5).
            return Object.assign(base, { available: true, empty: true, reasons: [] });
        }
        const rate = rateSource(input.rate);
        if (!rate) add('rate_unavailable');
        else if (rate.stale) add(`rate_curve_stale:${rate.asOfDate || 'unknown'}`);
        const usableRate = rate && !rate.stale ? rate : null;
        for (const row of openOptions) {
            // Each check on an option stands on its own, so none of them hides another.
            const quote = quotes[row.contractId];
            if (!quote || quote.level !== 'mid' || !Number.isFinite(quote.mark)) add(`iv_needs_mid:${row.contractId}`);
            const record = records.get(row.contractId);
            let expiryAt = record.optionExpiryAsOf;
            const byRule = !expiryAt;
            if (byRule) {
                const local = Import.localToUtc(`${record.optionExpiry}T${rules.optionExpiryLocalTime}`,
                    rules.exchangeTimeZone);
                expiryAt = local.instant || (local.range ? local.range[0] : null);
            }
            const expiryMs = millis(expiryAt);
            if (expiryMs === null) add(`option_expiry_unknown:${row.contractId}`);
            else if (expiryMs <= asOfMs) add(`option_expired_open:${row.contractId}`);
            else if (usableRate && usableRate.at(years(asOfMs, expiryMs)) === null) add('rate_unavailable');
            const binding = bindings.get(row.contractId);
            const future = binding && binding.futureContractId && binding.status !== 'unresolved'
                && binding.status !== 'conflict' ? records.get(binding.futureContractId) : null;
            if (!future) {
                add(`binding_unresolved:${row.contractId}`);
                continue;
            }
            if (record.premiumMultiplier !== (record.deliverableFuturesPerOption || 1) * future.futurePointValue) {
                add(`multiplier_mismatch:${row.contractId}`);
            }
            // Its future still needs an anchor, whatever else stops the run.
            options[row.contractId] = {
                contractId: row.contractId, n: row.contracts.value, record, binding, futureId: future.contractId,
                right: record.optionRight, strike: record.optionStrike, style: record.exerciseStyle || 'american',
                multiplier: record.premiumMultiplier, perOption: record.deliverableFuturesPerOption || 1,
                expiryAt: expiryMs === null ? null : instantOf(expiryMs), expiryMs, expiryByRule: byRule,
            };
        }
        // Anchors: every held future and every future an open option is bound to (§2.2).
        const bound = new Set(Object.values(options).map((option) => option.futureId));
        const needed = [...new Set([...Object.keys(futures), ...bound])].sort();
        const anchors = {};
        const levels = {};
        for (const id of needed) {
            const quote = quotes[id];
            if (!quote || quote.level === 'unavailable' || !Number.isFinite(quote.mark)) {
                add(`future_anchor_missing:${id}`);
                continue;
            }
            if (bound.has(id) && quote.level !== 'mid') {
                add(`iv_needs_live_future:${id}`);
                continue;
            }
            anchors[id] = quote.mark;
            levels[id] = quote.level;
        }
        for (const option of Object.values(options)) {
            if (anchors[option.futureId] !== undefined && !(anchors[option.futureId] > 0)) {
                add(`model_domain:${option.contractId}`);
            }
        }
        // Only now, with every input in place, is each implied volatility solved.
        if (reasons.length) return Object.assign(base, { available: false, reasons });
        for (const option of Object.values(options)) {
            const quote = quotes[option.contractId];
            const future = anchors[option.futureId];
            option.tau0 = years(asOfMs, option.expiryMs);
            option.rate0 = rate.at(option.tau0);
            option.mid = quote.mark;
            try {
                option.sigma = impliedSigma(option, future, option.tau0, option.rate0, quote.mark);
            } catch (error) {
                if (!(error instanceof StressStop)) throw error;
                add(`${error.reason}:${option.contractId}`);
                continue;
            }
            option.value0 = price(option, future, option.tau0, option.rate0, option.sigma);
        }
        if (reasons.length) return Object.assign(base, { available: false, reasons });
        const byMonth = needed.slice().sort((a, b) => monthIndex(records.get(a).futureContractMonth)
            - monthIndex(records.get(b).futureContractMonth) || (a < b ? -1 : 1));
        const reference = input.reference && anchors[input.reference] !== undefined ? input.reference : byMonth[0];
        const anchorMarks = Object.assign({}, anchors);
        for (const option of Object.values(options)) anchorMarks[option.contractId] = option.value0;
        const anchored = Core.computeLedger(graph, { rolls: false, marks: anchorMarks });
        const labels = ['immediate_path', 'sticky_strike', 'no_delivery_fees'];
        if (rate.source === 'assumed') labels.push('assumed_rate');
        for (const option of Object.values(options)) {
            if (option.expiryByRule) labels.push(`expiry_time_by_rule:${option.contractId}`);
        }
        if (Object.values(levels).some((level) => level !== 'mid')) labels.push('reference_quotes');
        return Object.assign(base, {
            available: true, empty: false, reasons: [], graph, records, rules, asOfMs, rate, futures, options,
            anchors, levels, reference, anchorEconomicPnl: anchored.totals.economicPnl, labels,
            account: graph.book ? graph.book.account : null,
        });
    }

    // ------------------------------------------------------------------
    // One scenario point (contract §5, §6, §7)
    // ------------------------------------------------------------------

    function inTheMoney(option, future) {
        return option.right === 'C' ? future > option.strike : future < option.strike;
    }

    /** Contract §6.2: whether a future still trades at an instant. */
    function requireTrading(compiled, futureId, atMs) {
        const record = compiled.records.get(futureId);
        let trading = null;
        if (record.futureLastTradeAsOf) {
            trading = atMs <= millis(record.futureLastTradeAsOf);
        } else if (record.futureLastTradeDate) {
            const day = modules().Import.localDay({ executedAtUtc: instantOf(atMs) }, compiled.rules.exchangeTimeZone);
            trading = day <= record.futureLastTradeDate;
        }
        if (trading === null) stop(`future_last_trade_unknown:${futureId}`);
        if (!trading) stop(`future_past_last_trade:${futureId}`);
    }

    function scenarioFutures(compiled, shift, slope) {
        const base = monthIndex(compiled.records.get(compiled.reference).futureContractMonth);
        const prices = {};
        for (const [id, anchor] of Object.entries(compiled.anchors)) {
            prices[id] = anchor + shift + slope * (monthIndex(compiled.records.get(id).futureContractMonth) - base);
        }
        return prices;
    }

    function delivery(option, delta, at) {
        return { option: option.contractId, action: option.n < 0 ? 'assign' : 'exercise', contracts: Math.abs(option.n),
            future: option.futureId, futureContracts: delta, at };
    }

    /**
     * params: {shift, slope, horizonDays, ivScale, early: [contractId],
     * totals (replay the ledger for the economic P&L)}. Throws StressStop
     * for a point that is unavailable.
     */
    function point(compiled, params = {}) {
        const shift = params.shift || 0;
        const slope = params.slope || 0;
        const horizonDays = params.horizonDays || 0;
        const ivScale = params.ivScale === undefined ? 1 : params.ivScale;
        if (compiled.empty) {
            return { available: true, shift, slope, horizonDays, ivScale, x: null, futures: {}, values: {},
                settlements: [], positions: {}, notDelivered: [], change: 0,
                economicPnl: params.totals ? compiled.ledgerEconomicPnl : null };
        }
        const targetMs = compiled.asOfMs + horizonDays * DAY_MS;
        const target = instantOf(targetMs);
        const prices = scenarioFutures(compiled, shift, slope);
        const positions = Object.assign({}, compiled.futures);
        const settlements = [];
        const move = (option, at) => {
            const delta = (option.right === 'C' ? (option.n < 0 ? -1 : 1) : (option.n < 0 ? 1 : -1))
                * Math.abs(option.n) * option.perOption;
            positions[option.futureId] = (positions[option.futureId] || 0) + delta;
            settlements.push(delivery(option, delta, at));
        };
        const all = Object.values(compiled.options).sort((a, b) => a.expiryMs - b.expiryMs
            || (a.contractId < b.contractId ? -1 : 1));
        for (const option of all) {
            if (option.expiryMs > targetMs) continue;
            if (inTheMoney(option, prices[option.futureId])) {
                requireTrading(compiled, option.futureId, option.expiryMs);
                move(option, option.expiryAt);
            } else {
                settlements.push({ option: option.contractId, action: 'expire', contracts: Math.abs(option.n),
                    at: option.expiryAt });
            }
        }
        const open = new Set(all.filter((option) => option.expiryMs > targetMs).map((option) => option.contractId));
        const notDelivered = [];
        for (const id of params.early || []) {
            const option = compiled.options[id];
            if (!option) stop(`early_delivery_unknown:${id}`);
            if (option.style !== 'american') stop(`early_delivery_european:${id}`);
            if (!open.has(id)) {
                notDelivered.push({ option: id, why: 'settled_at_expiry' });
                continue;
            }
            if (!inTheMoney(option, prices[option.futureId])) {
                notDelivered.push({ option: id, why: 'out_of_the_money' });
                continue;
            }
            requireTrading(compiled, option.futureId, targetMs);
            open.delete(id);
            move(option, target);
        }
        if (horizonDays !== 0) {
            for (const [id, quantity] of Object.entries(positions)) {
                if (quantity !== 0) requireTrading(compiled, id, targetMs);
            }
        }
        const values = {};
        for (const id of [...open].sort()) {
            const option = compiled.options[id];
            const tau = years(targetMs, option.expiryMs);
            const rate = compiled.rate.at(tau);
            if (rate === null) stop('rate_unavailable');
            const value = price(option, prices[option.futureId], tau, rate, option.sigma * ivScale);
            if (value === null) stop(`model_domain:${id}`);
            values[id] = value;
        }
        // change = the held futures' move + each delivery (bought or sold at the
        // strike, valued at the scenario price) - each settled option's anchor
        // value + the move of each option still open (contract §7.1).
        let change = 0;
        for (const [id, quantity] of Object.entries(compiled.futures)) {
            change += quantity * compiled.records.get(id).futurePointValue * (prices[id] - compiled.anchors[id]);
        }
        for (const settlement of settlements) {
            const option = compiled.options[settlement.option];
            if (settlement.future) {
                change += settlement.futureContracts * compiled.records.get(settlement.future).futurePointValue
                    * (prices[settlement.future] - option.strike);
            }
            change -= option.n * option.multiplier * option.value0;
        }
        for (const [id, value] of Object.entries(values)) {
            const option = compiled.options[id];
            change += option.n * option.multiplier * (value - option.value0);
        }
        let economicPnl = null;
        if (params.totals) economicPnl = replay(compiled, settlements, Object.assign({}, prices, values));
        const held = {};
        for (const [id, quantity] of Object.entries(positions)) if (quantity !== 0) held[id] = quantity;
        return { available: true, shift, slope, horizonDays, ivScale, x: prices[compiled.reference], futures: prices,
            values, settlements, positions: held, notDelivered, change, economicPnl };
    }

    /**
     * The ledger core's economic P&L with the scenario's settlements appended
     * in memory (contract §7.3), built exactly as the delivery preview builds
     * its rows; order evidence fixes the order of simultaneous settlements.
     */
    function replay(compiled, settlements, marks) {
        const { Core, Forms } = modules();
        let graph = compiled.graph;
        if (settlements.length) {
            const items = settlements.map((settlement, index) => {
                const option = compiled.options[settlement.option];
                const future = compiled.records.get(option.futureId);
                const action = settlement.action;
                return { event: Forms.settlementEvent(option.record, action, settlement.contracts, option.n,
                    option.binding, future), at: settlement.at, orderEvidence: `${ORDER_SCOPE}#${index + 1}` };
            });
            graph = Forms.withSettlements(compiled.graph, compiled.account, items,
                { idPrefix: 'stress-settlement', note: '压力情景交割（仅内存）' });
        }
        return Core.computeLedger(graph, { rolls: false, marks }).totals.economicPnl;
    }

    function pointOrStop(compiled, params) {
        try {
            return point(compiled, params);
        } catch (error) {
            if (!(error instanceof StressStop)) throw error;
            return { available: false, reason: error.reason, shift: params.shift || 0, slope: params.slope || 0,
                horizonDays: params.horizonDays || 0, ivScale: params.ivScale === undefined ? 1 : params.ivScale };
        }
    }

    // ------------------------------------------------------------------
    // The curve, the band and the whole run (contract §5.3, §7.4, §8)
    // ------------------------------------------------------------------

    function odd(value, low, high, fallback) {
        if (value === '' || value === null || value === undefined) return fallback;
        const number = Math.round(Number(value));
        if (!Number.isFinite(number)) return fallback;
        const clamped = Math.min(high, Math.max(low, number));
        return clamped % 2 ? clamped : clamped + (clamped < high ? 1 : -1);
    }

    /**
     * The parameters of one run, bounded as the contract fixes them (§2.4,
     * §5.3). A dollar range (range, $/bbl either side of the reference
     * price), when given, replaces the percentage: it is the only range when
     * the reference price is 0. One that is not a positive number stops the
     * run with range_invalid rather than being guessed at.
     */
    function normalize(params = {}) {
        const number = (value, fallback) => (Number.isFinite(Number(value)) && value !== '' && value !== null
            ? Number(value) : fallback);
        const rangePct = Math.min(90, Math.max(1, number(params.rangePct, DEFAULTS.rangePct)));
        const horizon = Math.round(number(params.horizonDays, DEFAULTS.horizonDays));
        const blank = params.range === undefined || params.range === null || String(params.range).trim() === '';
        return {
            rangePct, range: blank ? null : number(params.range, NaN),
            points: odd(params.points, 11, 121, DEFAULTS.points),
            slope: number(params.slope, DEFAULTS.slope),
            horizonDays: Math.min(365, Math.max(0, horizon)),
            ivScale: Math.max(0, number(params.ivScale, DEFAULTS.ivScale)),
            band: Math.min(0.5, Math.max(0, number(params.band, DEFAULTS.band))),
            early: Array.isArray(params.early) ? params.early.slice() : [],
            reference: params.reference || null,
        };
    }

    function shifts(compiled, params) {
        const anchor = compiled.anchors[compiled.reference];
        const range = params.range !== null ? params.range : Math.abs(anchor) * params.rangePct / 100;
        if (!(range > 0) || !Number.isFinite(range)) stop('range_invalid');
        const last = params.points - 1;
        return Array.from({ length: params.points }, (_, index) => range * ((2 * index - last) / last));
    }

    function sweep(compiled, params) {
        const grid = shifts(compiled, params);
        return grid.map((shift) => pointOrStop(compiled, { shift, slope: params.slope, horizonDays: params.horizonDays,
            ivScale: params.ivScale, early: params.early, totals: true }));
    }

    /** IV level members ivScale x (1 - b), ivScale, ivScale x (1 + b): whole-ledger reruns, never leg extremes. */
    function band(compiled, params, centerPoints) {
        if (!(params.band > 0)) return { available: false, reason: 'band_off', fraction: 0, points: [] };
        const members = [
            { name: 'low', ivScale: params.ivScale * (1 - params.band) },
            { name: 'center', ivScale: params.ivScale },
            { name: 'high', ivScale: params.ivScale * (1 + params.band) },
        ];
        const points = centerPoints.map((center) => {
            if (!center.available) return { shift: center.shift, available: false, reason: center.reason };
            const runs = members.map((member) => (member.name === 'center' ? { member: 'center', point: center }
                : { member: member.name, point: pointOrStop(compiled, { shift: center.shift, slope: params.slope,
                    horizonDays: params.horizonDays, ivScale: member.ivScale, early: params.early }) }));
            const failed = runs.find((item) => !item.point.available);
            if (failed) return { shift: center.shift, available: false, reason: failed.point.reason };
            const lower = runs.reduce((best, item) => (item.point.change < best.point.change ? item : best));
            const upper = runs.reduce((best, item) => (item.point.change > best.point.change ? item : best));
            return { shift: center.shift, available: true, lower: lower.point.change, upper: upper.point.change,
                lowerMember: lower.member, upperMember: upper.member };
        });
        return { available: true, fraction: params.band, members: members.map((member) => member.name), points };
    }

    function publicAnchor(compiled) {
        const options = {};
        for (const option of Object.values(compiled.options)) {
            options[option.contractId] = { contracts: option.n, sigma: option.sigma, value: option.value0, mid: option.mid,
                rate: option.rate0,
                tau: option.tau0, expiryAt: option.expiryAt, expiryByRule: option.expiryByRule, future: option.futureId };
        }
        return { futures: Object.assign({}, compiled.anchors), levels: Object.assign({}, compiled.levels),
            held: Object.assign({}, compiled.futures), options,
            ledgerEconomicPnl: compiled.ledgerEconomicPnl, anchorEconomicPnl: compiled.anchorEconomicPnl };
    }

    /**
     * The whole run as the page shows it (contract §8): compile, the curve,
     * the band. input as in compile; params as in normalize.
     */
    function run(input, rawParams) {
        const params = normalize(Object.assign({}, rawParams, { reference: (rawParams || {}).reference }));
        const compiled = compile(Object.assign({}, input, { reference: params.reference || input.reference }));
        const inputs = {
            ledgerDigest: input.ledgerDigest || null, quoteBatchId: input.quoteBatchId || null, asOf: input.asOf,
            rate: input.rate ? (input.rate.source === 'assumed' ? { source: 'assumed', value: input.rate.value }
                : { source: 'curve', asOfDate: compiled.rate ? compiled.rate.asOfDate : null,
                    status: input.rate.status || null }) : null,
            reference: compiled.reference || null, horizonDays: params.horizonDays, slope: params.slope,
            ivScale: params.ivScale, band: params.band, points: params.points, rangePct: params.rangePct,
            range: params.range, early: params.early, modelVersion: MODEL_VERSION, steps: STEPS,
        };
        if (!compiled.available) {
            return { version: VERSION, available: false, empty: false, reasons: compiled.reasons, inputs };
        }
        if (compiled.empty) {
            return { version: VERSION, available: true, empty: true, reasons: [], inputs,
                anchor: { ledgerEconomicPnl: compiled.ledgerEconomicPnl }, points: [], band: null, labels: [] };
        }
        // A choice the contract refuses makes the whole request invalid (§6.3); every one is listed.
        const refused = params.early.map((id) => {
            const option = compiled.options[id];
            return !option ? `early_delivery_unknown:${id}`
                : (option.style !== 'american' ? `early_delivery_european:${id}` : null);
        }).filter(Boolean);
        if (refused.length) return { version: VERSION, available: false, empty: false, reasons: refused, inputs };
        let points;
        try {
            points = sweep(compiled, params);
        } catch (error) {
            if (!(error instanceof StressStop)) throw error;
            return { version: VERSION, available: false, empty: false, reasons: [error.reason], inputs };
        }
        return { version: VERSION, available: true, empty: false, reasons: [], inputs, anchor: publicAnchor(compiled),
            points, band: band(compiled, params, points), labels: compiled.labels };
    }

    globalScope.OptionComboCostBasisFopStress = Object.freeze({
        VERSION,
        MODEL_VERSION,
        DEFAULTS,
        StressStop,
        normalCdf,
        intrinsic,
        black76,
        american,
        price,
        impliedSigma,
        rateSource,
        compile,
        point,
        pointOrStop,
        normalize,
        sweep,
        band,
        run,
        _internal: Object.freeze({ millis, instantOf }),
    });
})(typeof window !== 'undefined' ? window : globalThis);
