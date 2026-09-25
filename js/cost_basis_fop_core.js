// Standalone FOP ledger core: replay, economic P&L, seller lens, cycles and
// read-time ROLL groups (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §5, §6,
// §9.2, §13.2). DOM-free; the FOP page loads it after the common layer.
//
// Input is the FOP ledger graph in the shape of a version 2 backup payload
// (BackupPayloadV2 in tests/fixtures/cost_basis_fop/contract/protocol.json):
// the server exports exactly this, so the page and the tests replay the same
// thing. Output is FopLedgerOutput (contract/core_output.json): every figure is
// a Metric, a value or null with the reason it is unknown; an unknown is never 0.
//
// The economic order follows plan §9.2 and is the same one
// cost_basis_fop_domain.py builds on the server (build_timeline); both run the
// vectors in tests/fixtures/cost_basis_fop/core_vectors.json. Nothing is
// rounded in between: averages, realized results and allocations keep full
// precision (plan §6.4, F47).
(function (globalScope) {
    'use strict';

    const ENGINE_VERSION = 1;
    const EPSILON = 1e-9;
    const DELIVERY_KINDS = new Set(['option_assignment', 'option_exercise']);
    const ORDER_EVIDENCE = /^([^#]+)#([0-9]{1,15})$/;
    const SELLER_FEE_CATEGORIES = new Set(['futures', 'short_option']);
    // A fee of the buyer's options alone (plan §5.3: kept out of the seller lens).
    const BUYER_FEE_CATEGORY = 'long_option';

    // ------------------------------------------------------------------
    // Metrics
    // ------------------------------------------------------------------

    const known = (value) => ({ value, reason: null });
    const unknown = (reason) => ({ value: null, reason });

    /** A running sum that turns unknown, with the first reason, once any part is. */
    function createSum() {
        return { value: 0, reason: null };
    }

    function addTo(sum, amount, reason) {
        if (sum.reason !== null) return;
        if (reason) {
            sum.value = null;
            sum.reason = reason;
            return;
        }
        sum.value += amount;
    }

    function combine(parts) {
        // Σ sign × metric; the first unknown part names the reason.
        let total = 0;
        for (const [sign, metric] of parts) {
            if (metric.reason !== null) return unknown(metric.reason);
            total += sign * metric.value;
        }
        return known(total);
    }

    // ------------------------------------------------------------------
    // The stable key and order evidence (plan §9.2)
    // ------------------------------------------------------------------

    function compareValues(left, right) {
        if (left === right) return 0;
        if (left === null || left === undefined) return -1;
        if (right === null || right === undefined) return 1;
        if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1;
        const a = String(left);
        const b = String(right);
        return a < b ? -1 : (a > b ? 1 : 0);
    }

    function compareKeys(left, right) {
        for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
            const order = compareValues(left[index], right[index]);
            if (order !== 0) return order;
        }
        return 0;
    }

    function parseOrderEvidence(text) {
        const match = ORDER_EVIDENCE.exec(text || '');
        return match ? { scope: match[1], sequence: Number(match[2]) } : null;
    }

    // ------------------------------------------------------------------
    // Reading the graph
    // ------------------------------------------------------------------

    function readGraph(graph) {
        // Events keep the revision they reference; a live event always holds
        // the current one (the server moves it on every correction).
        const contracts = new Map();
        for (const stored of graph.contracts || []) {
            const record = stored.record;
            contracts.set(`${record.contractId}#${record.revision}`, record);
        }
        const bindings = new Map();
        for (const binding of graph.bindings || []) {
            if (binding.supersededByRevision === null || binding.supersededByRevision === undefined) {
                bindings.set(binding.optionContractId, binding);
            }
        }
        const sources = new Map((graph.sources || []).map((source) => [source.sourceId, source]));
        const allocations = new Map();
        for (const allocation of graph.allocations || []) {
            if (!allocations.has(allocation.eventId)) allocations.set(allocation.eventId, []);
            allocations.get(allocation.eventId).push(allocation);
        }
        const events = [];
        for (const stored of graph.events || []) {
            if (stored.row.voidedAtUtc) continue;
            events.push(eventView(stored, contracts, sources, allocations));
        }
        const cycles = (graph.cycles || []).filter((cycle) => cycle.state === 'closed'
            && (cycle.supersededByRevision === null || cycle.supersededByRevision === undefined));
        return {
            scope: graph.fopBook ? graph.fopBook.historyScope : 'full_history',
            contracts, bindings, events, cycles,
        };
    }

    function eventView(stored, contracts, sources, allocations) {
        const row = stored.row;
        const fop = row.fop;
        const time = fop.time;
        const interval = time.executedAtUtc
            ? [time.executedAtUtc, time.executedAtUtc]
            : [time.timeRange.startUtc, time.timeRange.endUtc];
        const lookup = (ref) => (ref ? contracts.get(`${ref.contractId}#${ref.revision}`) || null : null);
        const primary = stored.primarySourceId ? sources.get(stored.primarySourceId) : null;
        let sourceKey = '';
        if (primary) sourceKey = `${primary.namespace}:${primary.sourceRef}`;
        else if (row.externalRef) sourceKey = `manual:${row.externalRef}`;
        const view = {
            id: row.eventId,
            kind: row.kind,
            interval,
            contract: lookup(fop.contractRef),
            delivered: lookup(fop.deliveredContractRef),
            contracts: row.contracts,
            futureContracts: row.futureContracts,
            price: row.price,
            cash: row.cashAmount,
            fees: row.fees,
            includeInCost: row.includeInCost,
            openClose: fop.openClose,
            feeCategory: fop.feeCategory,
            feeSourceEventId: fop.feeSourceEventId,
            adjustmentScope: fop.adjustmentScope,
            baselineKind: fop.baselineKind,
            baselineAsOfUtc: fop.baselineAsOfUtc,
            evidence: parseOrderEvidence(time.orderEvidence),
            sourceIds: (allocations.get(row.eventId) || []).map((allocation) => allocation.sourceId),
        };
        view.key = [sourceKey, row.kind, row.futureContracts, row.contracts, row.price,
            row.cashAmount, row.fees, row.eventId];
        view.deltas = eventDeltas(view);
        return view;
    }

    /** [{key: 'FUT:id' | 'FOP:id', id, secType, delta}] of one event. */
    function eventDeltas(event) {
        if (event.kind === 'fee' || event.kind === 'manual_adjust') return [];
        const id = event.contract ? event.contract.contractId : null;
        if (event.kind === 'futures_trade'
            || (event.kind === 'opening_balance' && event.futureContracts !== null)) {
            return [{ key: `FUT:${id}`, id, secType: 'FUT', delta: event.futureContracts }];
        }
        const deltas = [{ key: `FOP:${id}`, id, secType: 'FOP', delta: event.contracts }];
        if (DELIVERY_KINDS.has(event.kind) && event.delivered) {
            deltas.push({ key: `FUT:${event.delivered.contractId}`, id: event.delivered.contractId,
                secType: 'FUT', delta: event.futureContracts });
        }
        return deltas;
    }

    // ------------------------------------------------------------------
    // Pass 1: economic order and quantities (plan §9.2)
    // ------------------------------------------------------------------

    function orderIndependent(position, deltas) {
        const signs = new Set(deltas.map((delta) => (delta > 0 ? 1 : -1)));
        if (signs.size !== 1) return false;
        const sign = [...signs][0];
        if (Math.abs(position) < EPSILON || (position > 0) === (sign > 0)) return true;
        return Math.abs(deltas.reduce((sum, delta) => sum + delta, 0)) <= Math.abs(position) + EPSILON;
    }

    function ambiguityGroups(events) {
        const ordered = events.slice().sort((a, b) => compareKeys(
            [a.interval[0], a.interval[1], ...a.key], [b.interval[0], b.interval[1], ...b.key]));
        const groups = [];
        let latestEnd = null;
        for (const event of ordered) {
            if (groups.length && event.interval[0] <= latestEnd) {
                groups[groups.length - 1].push(event);
                if (event.interval[1] > latestEnd) latestEnd = event.interval[1];
            } else {
                groups.push([event]);
                latestEnd = event.interval[1];
            }
        }
        return groups;
    }

    /**
     * The group in order, the ids the evidence orders (in its order), and the
     * contracts whose order no evidence fixes. Evidence that puts an event
     * after one that ended before it started orders nothing.
     */
    function orderGroup(group, balances) {
        const byKey = group.slice().sort((a, b) => compareKeys(a.key, b.key));
        const touched = new Map();
        for (const event of group) {
            for (const delta of event.deltas) {
                if (!touched.has(delta.key)) touched.set(delta.key, []);
                touched.get(delta.key).push({ event, delta: delta.delta });
            }
        }
        const unsettled = [...touched.keys()].filter((key) => !orderIndependent(
            balances.get(key) || 0, touched.get(key).map((item) => item.delta)));
        if (!unsettled.length) return { ordered: byKey, proven: [], ambiguous: null };
        const needing = new Map();
        for (const key of unsettled) {
            for (const item of touched.get(key)) needing.set(item.event.id, item.event);
        }
        const evidence = [...needing.values()].map((event) => event.evidence);
        const scopes = new Set(evidence.filter(Boolean).map((found) => found.scope));
        const sequences = evidence.filter(Boolean).map((found) => found.sequence);
        const refuse = (eventId) => ({ ordered: byKey, proven: [], ambiguous: { eventId, contracts: unsettled } });
        if (evidence.some((found) => !found) || scopes.size !== 1
            || new Set(sequences).size !== sequences.length) {
            return refuse(byKey.find((event) => needing.has(event.id)).id);
        }
        const first = [...needing.values()].sort((a, b) => a.evidence.sequence - b.evidence.sequence);
        let latestStart = null;
        for (const event of first) {
            if (latestStart !== null && latestStart > event.interval[1]) return refuse(event.id);
            if (latestStart === null || event.interval[0] > latestStart) latestStart = event.interval[0];
        }
        return { ordered: first.concat(byKey.filter((event) => !needing.has(event.id))),
            proven: first.map((event) => event.id), ambiguous: null };
    }

    function closes(event, position, delta, secType) {
        // plan §5.1 and §6.1: which rows must reduce, and by no more than is open.
        if (secType === 'FUT' && DELIVERY_KINDS.has(event.kind)) return null;
        const closing = DELIVERY_KINDS.has(event.kind) || event.kind === 'option_expiry'
            || event.openClose === 'C';
        if (closing) {
            if (Math.abs(position) < EPSILON || position * delta > 0
                || Math.abs(delta) > Math.abs(position) + EPSILON) return 'overdraw';
        } else if (event.openClose === 'O' && Math.abs(position) > EPSILON && position * delta < 0) {
            return 'overdraw';
        } else if (event.openClose === 'CO' && !(position * delta < 0
            && Math.abs(delta) > Math.abs(position) + EPSILON)) {
            return 'overdraw';
        }
        return null;
    }

    /**
     * Order the events and replay their quantities. Never throws: an order no
     * evidence fixes, or a close that overdraws, taints the contracts it touches
     * (their averages and realized results become unknown); the server refuses
     * both, so only a preview of unsaved rows meets them.
     */
    function buildTimeline(events) {
        const balances = new Map();
        const ordered = [];
        const groupOf = new Map();
        const taints = new Map();
        const problems = [];
        // Per group of more than one event: its first start, the ids its
        // evidence orders, and the contracts no evidence orders.
        const groups = [];
        for (const rawGroup of ambiguityGroups(events)) {
            let group = rawGroup;
            if (group.length > 1) {
                const result = orderGroup(group, balances);
                group = result.ordered;
                const ambiguous = [];
                if (result.ambiguous) {
                    const reason = `order_ambiguous:${result.ambiguous.eventId}`;
                    problems.push({ code: 'order_ambiguous', eventId: result.ambiguous.eventId,
                        contracts: result.ambiguous.contracts.map((key) => key.slice(4)) });
                    for (const key of result.ambiguous.contracts) {
                        if (!taints.has(key)) taints.set(key, reason);
                        ambiguous.push([key, reason]);
                    }
                }
                groups.push({ start: rawGroup[0].interval[0], proven: result.proven, ambiguous });
            }
            const ids = group.map((event) => event.id);
            for (const event of group) {
                for (const delta of event.deltas) {
                    const position = balances.get(delta.key) || 0;
                    if (closes(event, position, delta.delta, delta.secType)) {
                        problems.push({ code: 'overdraw', eventId: event.id, contracts: [delta.id] });
                        if (!taints.has(delta.key)) taints.set(delta.key, `overdraw:${event.id}`);
                    }
                    balances.set(delta.key, position + delta.delta);
                }
                ordered.push(event);
                groupOf.set(event.id, ids);
            }
        }
        return { ordered, groupOf, taints, problems, groups };
    }

    /**
     * Which events have happened by an as-of instant: those whose interval has
     * ended, and those the order evidence puts before one of them (the broker
     * sequence proves they came first). An event that has started but is
     * proven by nothing is unresolved; one that starts later has not happened.
     */
    function asOfStatus(events, full, asOf) {
        const status = new Map();
        for (const event of events) {
            let state = 'future';
            if (event.interval[1] <= asOf) state = 'happened';
            else if (event.interval[0] <= asOf) state = 'unresolved';
            status.set(event.id, state);
        }
        for (const group of full.groups) {
            let last = -1;
            group.proven.forEach((id, index) => {
                if (status.get(id) === 'happened') last = index;
            });
            for (const id of group.proven.slice(0, Math.max(last, 0))) {
                if (status.get(id) === 'unresolved') status.set(id, 'happened');
            }
        }
        return status;
    }

    /**
     * Cycles from the whole ledger (plan §9.2, §13.2): a boundary sits after
     * the whole group of its anchor, whichever member anchors it, so every
     * event keeps its cycle in an as-of view too. There a boundary is passed
     * only once every event of its group has happened; later ones are not.
     * An event's cycle is at most the current one.
     */
    function placeCycles(read, full, happened) {
        const anchors = new Map(read.cycles.map((cycle) => [cycle.anchorEventId, cycle]));
        const closing = new Map();
        for (const event of full.ordered) {
            if (!anchors.has(event.id)) continue;
            const group = full.groupOf.get(event.id);
            if (!closing.has(group[group.length - 1])) closing.set(group[group.length - 1], anchors.get(event.id));
        }
        const cycleOf = new Map();
        const boundaries = [];
        // Events that share their time with a boundary's group: cycle it closes.
        const straddling = new Map();
        let index = 0;
        for (const event of full.ordered) {
            cycleOf.set(event.id, index);
            const boundary = closing.get(event.id);
            if (!boundary) continue;
            const group = full.groupOf.get(event.id);
            boundaries.push({ boundary, passed: group.every((id) => happened(id)) });
            if (group.length > 1) for (const id of group) straddling.set(id, index);
            index += 1;
        }
        let current = boundaries.findIndex((item) => !item.passed);
        if (current === -1) current = boundaries.length;
        const cycleIndex = (id) => Math.min(cycleOf.get(id), current);
        return { cycleOf, cycleIndex, straddling, current,
            boundaries: boundaries.slice(0, current).map((item) => item.boundary) };
    }

    // ------------------------------------------------------------------
    // Pass 2: economics (plan §5.1-§5.3, §6.1, §9.2 baseline, §13.2)
    // ------------------------------------------------------------------

    function createBuckets() {
        return { Rf: createSum(), Co: createSum(), E: createSum(), J: createSum(),
            Rs: createSum(), Es: createSum(), Js: createSum(), Rb: createSum(), Eb: createSum(), longExercise: false };
    }

    function futureState(record) {
        return { record, q: 0, average: null, realized: 0, closedAny: false, taint: null, quantityReason: null };
    }

    function optionState(record) {
        return { record, n: 0, premium: 0, premiumReason: null, taint: null, quantityReason: null };
    }

    /** One FUT fill or delivery leg at a price; returns the gross realized result. */
    function applyFuture(state, delta, price) {
        const pointValue = state.record.futurePointValue;
        if (Math.abs(state.q) < EPSILON || (state.q > 0) === (delta > 0)) {
            const quantity = state.q + delta;
            state.average = Math.abs(state.q) < EPSILON
                ? price : (state.q * state.average + delta * price) / quantity;
            state.q = quantity;
            return 0;
        }
        const closed = Math.min(Math.abs(delta), Math.abs(state.q));
        const direction = state.q > 0 ? 1 : -1;
        const realized = closed * pointValue * direction * (price - state.average);
        state.realized += realized;
        state.closedAny = true;
        const rest = Math.abs(delta) - closed;
        state.q += Math.sign(delta) * closed;
        if (rest > EPSILON) {
            state.q = Math.sign(delta) * rest;
            state.average = price;
        } else if (Math.abs(state.q) < EPSILON) {
            state.q = 0;
            state.average = null;
        }
        return realized;
    }

    /**
     * One option trade: returns {settled, shortSide} for the part that closes.
     * The open part's cash joins the remaining net premium; a close releases
     * its share of it, and the last close releases exactly what is left.
     */
    function applyOptionTrade(state, delta, cash) {
        if (state.n === 0 || (state.n > 0) === (delta > 0)) {
            state.n += delta;
            state.premium += cash;
            return null;
        }
        const closed = Math.min(Math.abs(delta), Math.abs(state.n));
        const shortSide = state.n < 0;
        const released = releasePremium(state, closed);
        const closeCash = closed === Math.abs(delta) ? cash : cash * closed / Math.abs(delta);
        state.n += Math.sign(delta) * closed;
        const rest = Math.abs(delta) - closed;
        if (rest > 0) {
            // A reversal: the rest opens the other side with its share of the cash.
            state.n = Math.sign(delta) * rest;
            state.premium = cash - closeCash;
            state.premiumReason = null;
        }
        return { settled: released.amount + closeCash, reason: released.reason, shortSide };
    }

    /** An expiry or a delivery closing `closed` contracts with no premium cash. */
    function applyOptionClose(state, closedContracts) {
        const closed = Math.abs(closedContracts);
        const shortSide = state.n < 0;
        const released = releasePremium(state, closed);
        state.n += state.n < 0 ? closed : -closed;
        return { settled: released.amount, reason: released.reason, shortSide };
    }

    /**
     * The share of the remaining net premium `closed` contracts take with
     * them; the last close takes exactly what is left, so settled plus open
     * premium always adds back to the cash paid and received (plan §14.2).
     */
    function releasePremium(state, closed) {
        const open = Math.abs(state.n);
        const reason = state.premiumReason;
        const amount = closed >= open ? state.premium : state.premium * closed / open;
        state.premium -= amount;
        if (closed >= open) {
            state.premium = 0;
            state.premiumReason = null;
        }
        return { amount: reason ? 0 : amount, reason };
    }

    /**
     * Where an event's money goes (plan §13.2): {cycle} or, for a fee or an
     * adjustment no single cycle owns, {affected: [cycle indices]}. A fee
     * with a source goes to its source's cycle; one without, that shares its
     * time with a boundary's group, could belong to either side of it.
     */
    function targetOf(event, placement) {
        if (event.kind === 'fee' && event.feeSourceEventId) {
            if (placement.cycleOf.has(event.feeSourceEventId)) {
                return { cycle: placement.cycleIndex(event.feeSourceEventId) };
            }
            return { affected: Array.from({ length: placement.current + 1 }, (_value, index) => index) };
        }
        if ((event.kind === 'fee' || event.kind === 'manual_adjust') && placement.straddling.has(event.id)) {
            const before = placement.straddling.get(event.id);
            return { affected: [before, before + 1].filter((index) => index <= placement.current) };
        }
        return { cycle: placement.cycleIndex(event.id) };
    }

    /** Pass 2 over the ordered events; per-cycle and whole-book buckets. */
    function replayEconomics(read, timeline, placement, options) {
        const futures = new Map();
        const optionsState = new Map();
        const cycles = [];
        for (let index = 0; index <= placement.current; index += 1) {
            cycles.push({
                index,
                startsAfterBoundaryId: index > 0 ? placement.boundaries[index - 1].boundaryId : null,
                closedByBoundaryId: index < placement.current ? placement.boundaries[index].boundaryId : null,
                buckets: createBuckets(),
                // The first reason its net result, or its seller lens, is not
                // complete: money it may own sits in no cycle.
                pnlReason: null,
                lensReason: null,
            });
        }
        const book = createBuckets();
        const unattributed = { E: createSum(), J: createSum() };
        const openingValue = createSum();
        const baselineReasons = [];
        const steps = [];

        function futureOf(record) {
            if (!futures.has(record.contractId)) futures.set(record.contractId, futureState(record));
            return futures.get(record.contractId);
        }
        function optionOf(record) {
            if (!optionsState.has(record.contractId)) {
                optionsState.set(record.contractId, optionState(record));
            }
            return optionsState.get(record.contractId);
        }
        function taintOf(key) {
            return timeline.taints.get(key) || null;
        }
        function add(name, amount, cycle, reason) {
            addTo(book[name], amount, reason);
            addTo(cycles[cycle].buckets[name], amount, reason);
        }
        /** A fee's or an adjustment's cash into its buckets (E, J; Es, Js). */
        function addCash(names, amount, target, eventId) {
            if (target.cycle !== undefined) {
                for (const name of names) add(name, amount, target.cycle, null);
                return;
            }
            // Owned by no single cycle: the whole book and the unattributed
            // row hold it, and every cycle it may belong to is incomplete.
            for (const name of names) {
                addTo(book[name], amount, null);
                if (unattributed[name]) addTo(unattributed[name], amount, null);
            }
            if (Math.abs(amount) < EPSILON) return;
            const reason = `cycle_unattributed:${eventId}`;
            const seller = names.includes('Es') || names.includes('Js');
            for (const index of target.affected) {
                if (!cycles[index].pnlReason) cycles[index].pnlReason = reason;
                if (seller && !cycles[index].lensReason) cycles[index].lensReason = reason;
            }
        }

        for (const event of timeline.ordered) {
            const target = targetOf(event, placement);
            const cycle = target.cycle;
            const record = event.contract;
            switch (event.kind) {
            case 'futures_trade': {
                const state = futureOf(record);
                const realized = applyFuture(state, event.futureContracts, event.price);
                add('Rf', realized, cycle, taintOf(`FUT:${record.contractId}`));
                add('E', event.fees, cycle, null);
                add('Es', event.fees, cycle, null);
                break;
            }
            case 'option_trade': {
                const state = optionOf(record);
                add('Co', event.cash, cycle, null);
                const result = applyOptionTrade(state, event.contracts, event.cash);
                if (result) {
                    add(result.shortSide ? 'Rs' : 'Rb', result.settled, cycle,
                        taintOf(`FOP:${record.contractId}`) || result.reason);
                }
                break;
            }
            case 'option_expiry':
            case 'option_assignment':
            case 'option_exercise': {
                const state = optionOf(record);
                const result = applyOptionClose(state, event.contracts);
                add(result.shortSide ? 'Rs' : 'Rb', result.settled, cycle,
                    taintOf(`FOP:${record.contractId}`) || result.reason);
                add('E', event.fees, cycle, null);
                add(result.shortSide ? 'Es' : 'Eb', event.fees, cycle, null);
                if (DELIVERY_KINDS.has(event.kind) && event.delivered) {
                    const future = futureOf(event.delivered);
                    const realized = applyFuture(future, event.futureContracts, event.price);
                    add('Rf', realized, cycle, taintOf(`FUT:${event.delivered.contractId}`));
                }
                if (event.kind === 'option_exercise') {
                    book.longExercise = true;
                    cycles[cycle].buckets.longExercise = true;
                }
                break;
            }
            case 'opening_balance': {
                if (record.secType === 'FUT') {
                    applyFuture(futureOf(record), event.futureContracts, event.price);
                    if (event.baselineKind !== 'reference_price') {
                        baselineReasons.push(`baseline_not_at_reference:${record.contractId}`);
                    }
                } else {
                    const state = optionOf(record);
                    state.n += event.contracts;
                    if (event.baselineKind === 'trade_cost') {
                        state.premium += -event.contracts * record.premiumMultiplier * event.price;
                        addTo(openingValue, 0, `baseline_not_at_reference:${record.contractId}`);
                    } else if (event.baselineKind === 'reference_price') {
                        state.premiumReason = `opening_premium_unknown:${record.contractId}`;
                        addTo(openingValue, event.contracts * record.premiumMultiplier * event.price, null);
                    } else {
                        state.premiumReason = `unknown_opening_cost:${record.contractId}`;
                        addTo(openingValue, 0, `unknown_opening_cost:${record.contractId}`);
                    }
                }
                break;
            }
            case 'fee': {
                if (!event.includeInCost) break;
                let names = ['E'];
                if (SELLER_FEE_CATEGORIES.has(event.feeCategory)) names = ['E', 'Es'];
                else if (event.feeCategory === BUYER_FEE_CATEGORY) names = ['E', 'Eb'];
                addCash(names, -event.cash, target, event.id);
                break;
            }
            case 'manual_adjust': {
                if (!event.includeInCost) break;
                addCash(event.adjustmentScope === 'seller_lens' ? ['J', 'Js'] : ['J'],
                    event.cash, target, event.id);
                break;
            }
            default:
                break;
            }
            if (options.trace) steps.push(stepOf(event, futures, optionsState, book));
        }
        return { futures, options: optionsState, cycles, book, unattributed, openingValue,
            baselineReasons, steps };
    }

    function stepOf(event, futures, optionsState, book) {
        const positions = {};
        for (const [id, state] of futures) {
            if (Math.abs(state.q) > EPSILON) positions[id] = { contracts: state.q, averagePrice: state.average };
        }
        for (const [id, state] of optionsState) {
            if (Math.abs(state.n) > EPSILON) {
                positions[id] = { contracts: state.n,
                    remainingNetPremium: state.premiumReason === null ? state.premium : null };
            }
        }
        const value = (sum) => (sum.reason === null ? sum.value : null);
        return { after: event.id, positions, Rf: value(book.Rf), Co: value(book.Co), E: value(book.E),
            J: value(book.J), Rs: value(book.Rs), Es: value(book.Es), Js: value(book.Js) };
    }

    // ------------------------------------------------------------------
    // Pass 3: read-time ROLL groups (plan §6.2)
    // ------------------------------------------------------------------

    /**
     * Each FUT trade splits into a closing segment (up to the open quantity) and
     * an opening segment. Trades that share an allocated source are one order
     * group; when its closes are all in one contract and its opens in one other,
     * it pairs them in economic order as "order" evidence. Everything left is a
     * candidate: in economic order, each segment pairs with the earliest earlier
     * unmatched segment of the other side with the same root, currency, point
     * value and position direction, where the opening contract is a later
     * delivery month than the closing one (a roll goes forward, and either leg
     * may come first). Candidates never consume quantity from evidence groups,
     * and nothing here changes a P&L figure.
     */
    function deriveRolls(timeline, range) {
        const balances = new Map();
        const segments = [];
        for (const event of timeline.ordered) {
            for (const delta of event.deltas) {
                const before = balances.get(delta.key) || 0;
                balances.set(delta.key, before + delta.delta);
                if (event.kind !== 'futures_trade') continue;
                const record = event.contract;
                const closing = Math.abs(before) > EPSILON && (before > 0) !== (delta.delta > 0)
                    ? Math.min(Math.abs(before), Math.abs(delta.delta)) : 0;
                const opening = Math.abs(delta.delta) - closing;
                const base = { event, record, sign: Math.sign(delta.delta),
                    classKey: [record.root, record.currency, record.futurePointValue].join('|') };
                if (closing > 0) {
                    segments.push({ ...base, side: 'close', quantity: closing, left: closing,
                        direction: before > 0 ? 1 : -1 });
                }
                if (opening > 0) {
                    segments.push({ ...base, side: 'open', quantity: opening, left: opening,
                        direction: Math.sign(delta.delta) });
                }
            }
        }
        const feesUsed = new Map();
        function leg(segment, used) {
            const event = segment.event;
            const total = Math.abs(event.futureContracts);
            const before = feesUsed.get(event.id) || { contracts: 0, fees: 0 };
            const contracts = before.contracts + used;
            const fees = contracts >= total - EPSILON
                ? event.fees - before.fees : event.fees * used / total;
            feesUsed.set(event.id, { contracts, fees: before.fees + fees });
            return { eventId: event.id, contractId: segment.record.contractId,
                contracts: segment.sign * used, price: event.price, fees };
        }
        const groups = [];
        // Order evidence: trades that share a source record.
        const clusters = new Map();
        for (const segment of segments) {
            for (const sourceId of segment.event.sourceIds) {
                if (!clusters.has(sourceId)) clusters.set(sourceId, new Set());
                clusters.get(sourceId).add(segment.event.id);
            }
        }
        const clusterOf = unionClusters(clusters);
        const byCluster = new Map();
        for (const segment of segments) {
            const cluster = clusterOf.get(segment.event.id);
            if (!cluster) continue;
            if (!byCluster.has(cluster)) byCluster.set(cluster, []);
            byCluster.get(cluster).push(segment);
        }
        for (const clusterSegments of byCluster.values()) {
            const closesIn = new Set(clusterSegments.filter((s) => s.side === 'close')
                .map((s) => s.record.contractId));
            const opensIn = new Set(clusterSegments.filter((s) => s.side === 'open')
                .map((s) => s.record.contractId));
            const classes = new Set(clusterSegments.map((s) => `${s.classKey}|${s.direction}`));
            if (closesIn.size !== 1 || opensIn.size !== 1 || classes.size !== 1
                || [...closesIn][0] === [...opensIn][0]) continue;
            const closes = clusterSegments.filter((s) => s.side === 'close');
            const opens = clusterSegments.filter((s) => s.side === 'open');
            const legs = [];
            let matched = 0;
            for (const close of closes) {
                for (const open of opens) {
                    const used = Math.min(close.left, open.left);
                    if (used <= 0) continue;
                    close.left -= used;
                    open.left -= used;
                    matched += used;
                    legs.push(leg(close, used), leg(open, used));
                    if (close.left <= 0) break;
                }
            }
            if (matched > 0) groups.push({ evidence: 'order', legs: mergeLegs(legs), matchedContracts: matched });
        }
        // Candidates within the query range.
        const inRange = (segment) => (!range || ((!range.fromUtc || segment.event.interval[0] >= range.fromUtc)
            && (!range.toUtc || segment.event.interval[1] <= range.toUtc)));
        const waiting = [];
        for (const segment of segments) {
            if (segment.left <= 0 || !inRange(segment)) continue;
            for (const other of waiting) {
                if (segment.left <= 0) break;
                if (other.left <= 0 || other.side === segment.side
                    || other.classKey !== segment.classKey || other.direction !== segment.direction) continue;
                const close = other.side === 'close' ? other : segment;
                const open = other.side === 'close' ? segment : other;
                if (!(open.record.futureContractMonth > close.record.futureContractMonth)) continue;
                const used = Math.min(other.left, segment.left);
                other.left -= used;
                segment.left -= used;
                groups.push({ evidence: 'candidate', legs: [leg(close, used), leg(open, used)],
                    matchedContracts: used });
            }
            if (segment.left > 0) waiting.push(segment);
        }
        return groups;
    }

    function unionClusters(clusters) {
        const parent = new Map();
        const find = (id) => {
            while (parent.get(id) !== id) id = parent.get(id);
            return id;
        };
        for (const members of clusters.values()) {
            const list = [...members];
            for (const id of list) if (!parent.has(id)) parent.set(id, id);
            for (const id of list.slice(1)) parent.set(find(id), find(list[0]));
        }
        const result = new Map();
        for (const members of clusters.values()) {
            if (members.size < 2) continue;
            for (const id of members) result.set(id, find(id));
        }
        return result;
    }

    function mergeLegs(legs) {
        const merged = new Map();
        for (const leg of legs) {
            const key = `${leg.eventId}|${Math.sign(leg.contracts)}`;
            if (!merged.has(key)) merged.set(key, { ...leg });
            else {
                const existing = merged.get(key);
                existing.contracts += leg.contracts;
                existing.fees += leg.fees;
            }
        }
        return [...merged.values()];
    }

    // ------------------------------------------------------------------
    // The ledger output
    // ------------------------------------------------------------------

    function markOf(marks, record) {
        if (!marks || !Object.prototype.hasOwnProperty.call(marks, record.contractId)
            || marks[record.contractId] === null || marks[record.contractId] === undefined) {
            return unknown('no_quote');
        }
        const price = marks[record.contractId];
        if (typeof price !== 'number' || !Number.isFinite(price)
            || (record.secType === 'FOP' && price < 0)) return unknown('invalid_quote');
        return known(price);
    }

    function byMonth(a, b) {
        return compareKeys([a.record.futureContractMonth, a.record.contractId],
            [b.record.futureContractMonth, b.record.contractId]);
    }

    function byOption(a, b) {
        return compareKeys([a.record.optionExpiry, a.record.optionRight, a.record.optionStrike, a.record.contractId],
            [b.record.optionExpiry, b.record.optionRight, b.record.optionStrike, b.record.contractId]);
    }

    /**
     * The buckets an event the as-of instant falls inside of could still
     * change, given the positions before it: a fill that can only add to a
     * position realizes nothing, a long option's close never reaches the seller
     * lens, and a zero fee changes no fee total. Where the order of such an
     * event matters, evidence puts it after everything that has happened (one
     * it puts earlier has happened); where it does not, it changes nothing
     * already realized. `realized` gets the FUT contracts whose realized
     * result it could still change.
     */
    function bucketsAtRisk(event, economics, pending, realized) {
        const names = [];
        const reducing = (position, delta) => Math.abs(position) > EPSILON && (position > 0) !== (delta > 0);
        for (const delta of event.deltas) {
            if (delta.secType === 'FUT') {
                const state = economics.futures.get(delta.id);
                if ((state && reducing(state.q, delta.delta)) || pending.get(delta.key) > 1) {
                    names.push('Rf');
                    realized.add(delta.key);
                }
            } else {
                const state = economics.options.get(delta.id);
                const short = state && state.n < 0 && reducing(state.n, delta.delta);
                const long = state && state.n > 0 && reducing(state.n, delta.delta);
                if (short || pending.get(delta.key) > 1) names.push('Rs');
                if (long || pending.get(delta.key) > 1) names.push('Rb');
                if (short && event.kind !== 'option_trade' && event.fees) names.push('Es');
                if (long && event.kind !== 'option_trade' && event.fees) names.push('Eb');
            }
        }
        if (event.kind === 'option_trade') names.push('Co');
        if (event.kind !== 'option_trade' && event.fees) names.push('E');
        if (event.kind === 'futures_trade' && event.fees) names.push('Es');
        if (event.kind === 'fee' && event.includeInCost) {
            names.push('E');
            if (SELLER_FEE_CATEGORIES.has(event.feeCategory)) names.push('Es');
            if (event.feeCategory === BUYER_FEE_CATEGORY) names.push('Eb');
        }
        if (event.kind === 'manual_adjust' && event.includeInCost) {
            names.push('J');
            if (event.adjustmentScope === 'seller_lens') names.push('Js');
        }
        return names;
    }

    /**
     * The FopLedgerOutput of one ledger graph.
     *
     * options.marks: {contractId: price} (FUT prices may be zero or negative);
     * options.asOf: a UtcInstant for the view at that instant, else current;
     * options.rollRange: {fromUtc, toUtc} limiting ROLL candidates (display only);
     * options.rolls: false leaves ROLL groups out (they never change a figure);
     * options.trace: return {output, steps, order, groups, problems} instead.
     */
    function computeLedger(graph, options = {}) {
        const read = readGraph(graph);
        const asOf = options.asOf || null;
        // The whole ledger fixes the order, the cycles and what evidence
        // proves; an as-of view replays the part that has happened.
        const full = buildTimeline(read.events);
        let timeline = full;
        const unresolved = [];
        let happened = () => true;
        if (asOf) {
            const status = asOfStatus(read.events, full, asOf);
            happened = (id) => status.get(id) === 'happened';
            timeline = buildTimeline(read.events.filter((event) => happened(event.id)));
            for (const event of read.events) {
                if (status.get(event.id) === 'unresolved') unresolved.push(event);
            }
            // An order no evidence fixes stays unfixed for a view inside it.
            for (const group of full.groups) {
                if (group.start > asOf) continue;
                for (const [key, reason] of group.ambiguous) {
                    if (!timeline.taints.has(key)) timeline.taints.set(key, reason);
                }
            }
        }
        const placement = placeCycles(read, full, happened);
        const economics = replayEconomics(read, timeline, placement, options);
        const marks = options.marks || {};

        const quantityReason = new Map();
        const realizedReason = new Map();
        // Buckets an unresolved event could still change: of the whole book,
        // of the cycle it belongs to, and of the unattributed row.
        const bookRisk = {};
        const cycleRisk = economics.cycles.map(() => ({}));
        const unattributedRisk = {};
        const pending = new Map();
        // How far unresolved events could still raise each position: only these can make a contract long.
        const pendingRise = new Map();
        for (const event of unresolved) {
            for (const delta of event.deltas) {
                pending.set(delta.key, (pending.get(delta.key) || 0) + 1);
                if (delta.delta > 0) pendingRise.set(delta.key, (pendingRise.get(delta.key) || 0) + delta.delta);
            }
        }
        for (const event of unresolved) {
            const reason = `${DELIVERY_KINDS.has(event.kind) ? 'delivery' : 'event'}_time_unresolved:${event.id}`;
            const realized = new Set();
            const target = targetOf(event, placement);
            for (const name of bucketsAtRisk(event, economics, pending, realized)) {
                if (!bookRisk[name]) bookRisk[name] = reason;
                if (target.cycle !== undefined) {
                    if (!cycleRisk[target.cycle][name]) cycleRisk[target.cycle][name] = reason;
                    continue;
                }
                if ((name === 'E' || name === 'J') && !unattributedRisk[name]) unattributedRisk[name] = reason;
                for (const index of target.affected) {
                    const cycle = economics.cycles[index];
                    if (!cycle.pnlReason) cycle.pnlReason = reason;
                    if ((name === 'Es' || name === 'Js') && !cycle.lensReason) cycle.lensReason = reason;
                }
            }
            for (const key of realized) if (!realizedReason.has(key)) realizedReason.set(key, reason);
            for (const delta of event.deltas) {
                if (!quantityReason.has(delta.key)) quantityReason.set(delta.key, reason);
                const record = delta.secType === 'FUT' && event.delivered
                    && event.delivered.contractId === delta.id ? event.delivered : event.contract;
                if (delta.secType === 'FUT' && !economics.futures.has(delta.id)) {
                    economics.futures.set(delta.id, futureState(record));
                }
                if (delta.secType === 'FOP' && !economics.options.has(delta.id)) {
                    economics.options.set(delta.id, optionState(record));
                }
            }
        }
        const contractReason = (key) => quantityReason.get(key) || timeline.taints.get(key) || null;
        const withRisk = (sum, reason) => (reason && sum.reason === null ? unknown(reason) : { ...sum });

        const futureRows = [];
        const openFutures = [];
        const Uf = createSum();
        for (const state of [...economics.futures.values()].sort(byMonth)) {
            const key = `FUT:${state.record.contractId}`;
            const qReason = quantityReason.get(key) || null;
            const reason = contractReason(key);
            if (!qReason && Math.abs(state.q) < EPSILON) continue;
            const pointValue = state.record.futurePointValue;
            const mark = markOf(marks, state.record);
            let unrealized;
            if (reason) unrealized = unknown(reason);
            else if (mark.reason) unrealized = unknown('missing_mark');
            else unrealized = known(state.q * pointValue * (mark.value - state.average));
            futureRows.push({
                contractId: state.record.contractId,
                localSymbol: state.record.localSymbol,
                contractMonth: state.record.futureContractMonth,
                contracts: qReason ? unknown(qReason) : known(state.q),
                pointValue,
                averagePrice: reason ? unknown(reason) : known(state.average),
                basis: reason ? unknown(reason) : known(state.q * pointValue * state.average),
                mark,
                unrealized,
            });
            openFutures.push(state);
            if (reason) addTo(Uf, 0, reason);
            else if (mark.reason) addTo(Uf, 0, `missing_mark:${state.record.contractId}`);
            else addTo(Uf, unrealized.value, null);
        }

        const optionRows = [];
        const Vo = createSum();
        const openShortPremium = createSum();
        // The open longs apart (plan §5.2): the net premium paid and their value.
        const openLongPremium = createSum();
        const openLongValue = createSum();
        let bindingConflict = null;
        for (const state of [...economics.options.values()].sort(byOption)) {
            const key = `FOP:${state.record.contractId}`;
            const qReason = quantityReason.get(key) || null;
            const reason = contractReason(key);
            if (!qReason && Math.abs(state.n) < EPSILON) continue;
            const binding = read.bindings.get(state.record.contractId) || null;
            const mark = markOf(marks, state.record);
            let premium;
            if (reason) premium = unknown(reason);
            else if (state.premiumReason) premium = unknown(state.premiumReason);
            else premium = known(state.premium);
            let value;
            if (qReason) value = unknown(qReason);
            else if (mark.reason) value = unknown('missing_mark');
            else value = known(state.n * state.record.premiumMultiplier * mark.value);
            optionRows.push({
                contractId: state.record.contractId,
                right: state.record.optionRight,
                strike: state.record.optionStrike,
                expiry: state.record.optionExpiry,
                contracts: qReason ? unknown(qReason) : known(state.n),
                premiumMultiplier: state.record.premiumMultiplier,
                remainingNetPremium: premium,
                boundFutureContractId: binding ? binding.futureContractId : null,
                bindingStatus: binding ? binding.status : 'unresolved',
                mark,
                value,
            });
            if (qReason) addTo(Vo, 0, qReason);
            else if (mark.reason) addTo(Vo, 0, `missing_mark:${state.record.contractId}`);
            else addTo(Vo, value.value, null);
            if (qReason) addTo(openShortPremium, 0, qReason);
            else if (state.n < 0) addTo(openShortPremium, premium.value, premium.reason);
            if (qReason) {
                // An unknown quantity reaches the buyer's side only if the
                // events still unresolved could leave the contract long.
                if (state.n + (pendingRise.get(key) || 0) > EPSILON) {
                    addTo(openLongPremium, 0, qReason);
                    addTo(openLongValue, 0, qReason);
                }
            } else if (state.n > 0) {
                addTo(openLongPremium, premium.value, premium.reason);
                addTo(openLongValue, value.value, value.reason ? `missing_mark:${state.record.contractId}` : null);
            }
            if (binding && binding.status === 'conflict' && !bindingConflict) {
                bindingConflict = `binding_conflict:${state.record.contractId}`;
            }
        }

        // A realized result is unknown where no order fixes it, or where an
        // unresolved event could still close part of the contract.
        const realizedRows = [];
        for (const state of [...economics.futures.values()].sort(byMonth)) {
            const key = `FUT:${state.record.contractId}`;
            if (!state.closedAny && !realizedReason.has(key)) continue;
            const reason = timeline.taints.get(key) || realizedReason.get(key) || null;
            realizedRows.push({ contractId: state.record.contractId, localSymbol: state.record.localSymbol,
                realized: reason ? unknown(reason) : known(state.realized) });
        }

        const history = read.scope;
        const book = economics.book;
        // B is a fact of the ledger (every opening balance states it and
        // happens at it), not of what an as-of view has replayed.
        const baseline = read.events.find((event) => event.kind === 'opening_balance');
        const baselineAsOfUtc = baseline ? baseline.baselineAsOfUtc : null;
        let openingValue;
        if (history === 'full_history') openingValue = unknown('not_applicable_full_history');
        else if (asOf && baselineAsOfUtc && asOf < baselineAsOfUtc) openingValue = unknown('as_of_before_baseline');
        else openingValue = { ...economics.openingValue };
        // A FUT baseline at its trade cost has no value at B: the change since
        // B cannot be told (plan §9.2).
        const baselineReason = economics.baselineReasons[0] || null;

        const totals = {
            Rf: withRisk(book.Rf, bookRisk.Rf), Uf: { ...Uf }, Co: withRisk(book.Co, bookRisk.Co), Vo: { ...Vo },
            E: withRisk(book.E, bookRisk.E), J: withRisk(book.J, bookRisk.J),
        };
        const pnlParts = [[1, totals.Rf], [1, totals.Uf], [1, totals.Co], [1, totals.Vo], [-1, totals.E],
            [1, totals.J]];
        if (history === 'since_baseline') pnlParts.push([-1, openingValue]);
        totals.economicPnl = baselineReason ? unknown(baselineReason) : combine(pnlParts);

        // Cycles: a closed cycle holds no position, the current one holds
        // today's. A cycle's buckets hold what is attributed to it; the whole
        // book is the cycles plus the unattributed row (plan §13.2), and a
        // cycle that row may belong to shows no complete net result.
        const currentIndex = economics.cycles.length - 1;
        const cycles = economics.cycles.map((cycle) => {
            const b = cycle.buckets;
            const risk = cycleRisk[cycle.index];
            const open = cycle.index === currentIndex;
            const cycleTotals = {
                Rf: withRisk(b.Rf, risk.Rf), Uf: open ? totals.Uf : known(0),
                Co: withRisk(b.Co, risk.Co), Vo: open ? totals.Vo : known(0),
                E: withRisk(b.E, risk.E), J: withRisk(b.J, risk.J),
            };
            const parts = [[1, cycleTotals.Rf], [1, cycleTotals.Uf], [1, cycleTotals.Co], [1, cycleTotals.Vo],
                [-1, cycleTotals.E], [1, cycleTotals.J]];
            if (history === 'since_baseline' && cycle.index === 0) parts.push([-1, openingValue]);
            cycleTotals.economicPnl = withRisk(baselineReason && cycle.index === 0
                ? unknown(baselineReason) : combine(parts), cycle.pnlReason);
            return { index: cycle.index, startsAfterBoundaryId: cycle.startsAfterBoundaryId,
                closedByBoundaryId: cycle.closedByBoundaryId, totals: cycleTotals };
        });

        // The seller lens of the current cycle (plan §5.3): only with exactly
        // one FUT contract open and nothing it depends on unknown.
        const lensCycle = economics.cycles[currentIndex];
        const lensBuckets = lensCycle.buckets;
        const lensRisk = cycleRisk[currentIndex];
        const lens = { Rs: withRisk(lensBuckets.Rs, lensRisk.Rs), Es: withRisk(lensBuckets.Es, lensRisk.Es),
            Js: withRisk(lensBuckets.Js, lensRisk.Js) };
        const dataReasons = [
            ...quantityReason.values(), ...timeline.taints.values(),
            ...optionRows.map((row) => row.remainingNetPremium.reason),
            bindingConflict, lens.Rs.reason, lens.Es.reason, lens.Js.reason, cycles[currentIndex].totals.Rf.reason,
            lensCycle.lensReason,
        ].filter(Boolean);
        let lensReason = dataReasons[0] || null;
        if (!lensReason && history === 'since_baseline' && currentIndex === 0) lensReason = 'history_before_baseline';
        if (!lensReason && openFutures.length === 0) lensReason = 'no_future_position';
        if (!lensReason && openFutures.length > 1) lensReason = 'multiple_future_contracts';
        let breakEven;
        let ifExpire;
        if (lensReason) {
            breakEven = unknown(lensReason);
            ifExpire = unknown(lensReason);
        } else {
            const state = openFutures[0];
            const exposure = state.q * state.record.futurePointValue;
            const settled = cycles[currentIndex].totals.Rf.value + lens.Rs.value - lens.Es.value + lens.Js.value;
            breakEven = known(state.average - settled / exposure);
            ifExpire = openShortPremium.reason ? unknown(openShortPremium.reason)
                : known(breakEven.value - openShortPremium.value / exposure);
        }

        const output = {
            engineVersion: ENGINE_VERSION,
            asOf: asOf ? { kind: 'as_of', utc: asOf } : { kind: 'current', utc: null },
            scope: { history, baselineAsOfUtc, openingValue },
            cycles,
            currentCycleIndex: currentIndex,
            futures: futureRows,
            options: optionRows,
            realizedByContract: realizedRows,
            totals,
            sellerLens: { ...lens, breakEven, breakEvenIfOpenShortsExpire: ifExpire,
                longExerciseAffectsBreakEven: Boolean(lensBuckets.longExercise) },
            buyerOptions: buyerOptionsOf(book, bookRisk, openLongPremium, openLongValue, withRisk),
            unattributed: { E: withRisk(economics.unattributed.E, unattributedRisk.E),
                J: withRisk(economics.unattributed.J, unattributedRisk.J) },
            roll: { groups: options.rolls === false ? [] : deriveRolls(timeline, options.rollRange || null) },
            gaps: [],
        };
        output.gaps = gapsOf(output);
        if (options.trace) {
            return { output, steps: economics.steps, order: timeline.ordered.map((event) => event.id),
                groups: groupsOf(timeline), problems: full.problems };
        }
        return output;
    }

    /**
     * The buyer's options of the whole ledger (plan §5.2, §5.3), apart from
     * the seller lens and never added to the totals again: Rb the settled
     * result of longs that ended (their net cash, commissions included; an
     * exercise ends the premium, the future it delivers stays in Rf/Uf), Eb
     * the fees only longs carry (their exercise and expiry fees, long_option
     * fees; never in Es), the open longs' remaining net premium (paid:
     * negative) and value, and the result they make together.
     */
    function buyerOptionsOf(book, risk, openPremium, openValue, withRisk) {
        const parts = {
            Rb: withRisk(book.Rb, risk.Rb), Eb: withRisk(book.Eb, risk.Eb),
            openPremium: { ...openPremium }, openValue: { ...openValue },
        };
        parts.result = combine([[1, parts.Rb], [-1, parts.Eb], [1, parts.openPremium], [1, parts.openValue]]);
        return parts;
    }

    function groupsOf(timeline) {
        const seen = new Set();
        const groups = [];
        for (const event of timeline.ordered) {
            const group = timeline.groupOf.get(event.id);
            const key = group.join('|');
            if (group.length > 1 && !seen.has(key)) {
                seen.add(key);
                groups.push(group);
            }
        }
        return groups;
    }

    /**
     * Every unknown ledger fact and every unknown aggregate, in document
     * order: the opening value of a since-baseline ledger, the quantities and
     * remaining premiums of the listed contracts, realized results, totals and
     * the seller lens. The quote figures of a row (mark, unrealized, value)
     * are not repeated: the row carries its reason and the totals the effect.
     */
    function gapsOf(output) {
        const gaps = [];
        const note = (metric, value) => {
            if (value && value.reason) gaps.push({ metric, reason: value.reason });
        };
        if (output.scope.history === 'since_baseline') note('scope.openingValue', output.scope.openingValue);
        output.futures.forEach((row, index) => note(`futures[${index}].contracts`, row.contracts));
        output.options.forEach((row, index) => {
            note(`options[${index}].contracts`, row.contracts);
            note(`options[${index}].remainingNetPremium`, row.remainingNetPremium);
        });
        output.realizedByContract.forEach((row, index) => note(`realizedByContract[${index}].realized`, row.realized));
        for (const name of ['Rf', 'Uf', 'Co', 'Vo', 'E', 'J', 'economicPnl']) {
            note(`totals.${name}`, output.totals[name]);
        }
        for (const name of ['Rs', 'Es', 'Js', 'breakEven', 'breakEvenIfOpenShortsExpire']) {
            note(`sellerLens.${name}`, output.sellerLens[name]);
        }
        for (const name of ['Rb', 'Eb', 'openPremium', 'openValue', 'result']) {
            note(`buyerOptions.${name}`, output.buyerOptions[name]);
        }
        return gaps;
    }

    const api = {
        ENGINE_VERSION,
        computeLedger,
        compareKeys,
        parseOrderEvidence,
        orderIndependent,
        _internal: { readGraph, buildTimeline, deriveRolls },
    };
    globalScope.OptionComboCostBasisFopCore = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
