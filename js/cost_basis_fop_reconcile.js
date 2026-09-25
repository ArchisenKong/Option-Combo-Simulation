/**
 * TWS positions against the FOP ledger (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md
 * §10.3, §19 P5-C3). DOM-free and Node-testable; the page loads it after the
 * core and js/cost_basis_fop_quotes.js.
 *
 * request_cost_basis_fop_positions reports the positions of the ledger's own
 * account and root, bound to the ledger version they were read against. This
 * module compares them with what the core replays, contract by contract, and
 * keeps four states apart (plan §10.3): quantity, AvgCost, binding and cash.
 *
 * - A position is the ledger contract with its conId, else with its local
 *   symbol; never by root or month alone, so an old-month option and a
 *   new-month future stay two contracts. A conId on both sides that
 *   disagrees is an identity conflict, never matched by the symbol.
 * - An unknown ledger quantity is never matched and never 0.
 * - AvgCost is corroboration only. IB reports it per contract, multiplier and
 *   commissions included; it is compared only when the multiplier is the
 *   contract's own, the lots were opened at one price (IB keeps lots, the
 *   ledger averages) and the ledger's figure is a trade cost (a since-baseline
 *   opening at a reference price is not). A FUT average excludes fees in the
 *   ledger, so a difference within the commission per contract agrees. The
 *   ledger agrees only when every row does; some rows agreeing and the rest
 *   not comparable is partial.
 * - Cash is never reconciled in the first release (plan §6.3).
 * - Positions read against another ledger version, of an account TWS does not
 *   manage, or before TWS finished reading them reconcile nothing.
 *
 * realizedComparison puts a statement's realized P&L beside the ledger's
 * (plan §19 P5-C4): evidence only, never a figure of the ledger.
 */
(function attachCostBasisFopReconcile(globalScope) {
    'use strict';

    const EPSILON = 1e-9;
    const QUANTITY_LABELS = Object.freeze({
        matched: '数量一致', mismatch: '数量不一致', unknown: '账本数量未知', not_checked: '未核对',
    });
    const AVG_COST_LABELS = Object.freeze({
        matched: '一致（旁证）', differs: '不同（旁证）', partial: '部分一致、部分不可比', not_comparable: '不可比',
        not_checked: '未核对',
    });

    function known(value) {
        return value !== null && value !== undefined && Number.isFinite(value);
    }

    function compact(text) {
        return String(text || '').replace(/\s+/g, '').toUpperCase();
    }

    function currentRecords(graph) {
        const records = new Map();
        for (const stored of (graph && graph.contracts) || []) {
            if (stored.supersededByRevision === null || stored.supersededByRevision === undefined) {
                records.set(stored.record.contractId, stored.record);
            }
        }
        return records;
    }

    /**
     * The ledger contract a TWS position is: {record, conflict}. By conId,
     * else by local symbol. A local symbol never outweighs a conId: when the
     * contract of that symbol has another conId than the position, the two
     * are different contracts and conflict is that record (review P5-C3).
     */
    function placePosition(position, records) {
        for (const record of records.values()) {
            if (record.secType === position.secType && known(record.conId) && record.conId === position.conId) {
                return { record, conflict: null };
            }
        }
        if (!position.localSymbol) return { record: null, conflict: null };
        for (const record of records.values()) {
            if (record.secType !== position.secType || !record.localSymbol
                || compact(record.localSymbol) !== compact(position.localSymbol)) continue;
            if (known(record.conId) && known(position.conId) && position.conId) {
                return { record: null, conflict: record };
            }
            return { record, conflict: null };
        }
        return { record: null, conflict: null };
    }

    /** One summary of the rows' quantities: any mismatch, else any unknown, else matched. */
    function quantitySummary(rows) {
        if (rows.some((row) => row.quantityStatus === 'mismatch')) return 'mismatch';
        if (rows.some((row) => row.quantityStatus === 'unknown')) return 'unknown';
        return 'matched';
    }

    /**
     * One summary of the rows' AvgCost: any difference; else matched only
     * when every row agrees; partial when some agree and the rest are not
     * comparable; else not comparable (review P5-C3).
     */
    function avgCostSummary(rows) {
        if (rows.some((row) => row.avgCostStatus === 'differs')) return 'differs';
        const matched = rows.filter((row) => row.avgCostStatus === 'matched').length;
        if (matched && matched === rows.length) return 'matched';
        return matched ? 'partial' : 'not_comparable';
    }

    /**
     * Per contract of the trace: were the open lots opened at one price
     * (per-unit cost unchanged since the position last opened)? A partial
     * close keeps the per-unit cost; an add at another price changes it.
     */
    function lotPrices(trace) {
        const uniform = new Map();
        const base = new Map();
        for (const step of (trace && trace.steps) || []) {
            for (const id of [...base.keys()]) {
                if (!step.positions[id]) base.delete(id);
            }
            for (const [id, position] of Object.entries(step.positions)) {
                let per = null;
                if (known(position.averagePrice)) per = position.averagePrice;
                else if (known(position.remainingNetPremium) && position.contracts) {
                    per = position.remainingNetPremium / position.contracts;
                }
                if (!base.has(id)) {
                    base.set(id, per);
                    uniform.set(id, per !== null);
                } else if (per === null || base.get(id) === null || Math.abs(per - base.get(id)) > EPSILON) {
                    uniform.set(id, false);
                }
            }
        }
        return uniform;
    }

    /** The largest commission per contract of a FUT's live fills, deliveries included. */
    function commissionPerContract(graph, contractId) {
        let most = 0;
        for (const stored of (graph && graph.events) || []) {
            const row = stored.row;
            if (row.voidedAtUtc || !row.fees) continue;
            const ref = row.fop && row.fop.contractRef;
            const delivered = row.fop && row.fop.deliveredContractRef;
            const quantity = row.kind === 'futures_trade' ? row.futureContracts
                : (delivered && delivered.contractId === contractId ? row.futureContracts : null);
            const own = (ref && ref.contractId === contractId) || (delivered && delivered.contractId === contractId);
            if (own && quantity) most = Math.max(most, Math.abs(row.fees / quantity));
        }
        return most;
    }

    function round(value, digits) {
        const factor = 10 ** digits;
        return Math.round(value * factor) / factor;
    }

    /** AvgCost of one contract: {status, ledgerAverage, twsAverage, note} (plan §10.3). */
    function compareAvgCost(record, ledgerRow, positions, context) {
        const out = (status, note, ledgerAverage = null, twsAverage = null) => ({ status, note, ledgerAverage,
            twsAverage });
        if (!ledgerRow || !positions.length) return out('not_comparable', '只有一方持有');
        if (positions.length > 1) return out('not_comparable', 'TWS 对同一合约报告了多条持仓');
        const position = positions[0];
        const multiplier = record.secType === 'FUT' ? record.futurePointValue : record.premiumMultiplier;
        if (!known(position.multiplier) || position.multiplier !== multiplier) {
            return out('not_comparable', `单位不明：TWS 乘数 ${known(position.multiplier) ? position.multiplier : '缺失'}，`
                + `账本 ${multiplier}`);
        }
        if (!known(position.averageCost)) return out('not_comparable', 'TWS 没有给出 AvgCost');
        if (context.openingAtReference.has(record.contractId)) {
            return out('not_comparable', '自基线起的期初是 B 时刻参考价，不是成交成本');
        }
        const quantity = ledgerRow.contracts.value;
        if (!known(quantity) || Math.sign(quantity) !== Math.sign(position.position)) {
            return out('not_comparable', '数量方向不一致，先核对数量');
        }
        const tws = position.averageCost / multiplier;
        let ledger;
        let allowance;
        let basis;
        if (record.secType === 'FUT') {
            if (!known(ledgerRow.averagePrice.value)) return out('not_comparable', '账本均价未知', null, tws);
            ledger = ledgerRow.averagePrice.value;
            // IB's average carries the commission, the ledger's FUT average does not (fees are in E).
            allowance = commissionPerContract(context.graph, record.contractId) / multiplier + 1e-6;
            basis = 'IB AvgCost 含佣金、账本期货均价不含费用';
        } else {
            if (!known(ledgerRow.remainingNetPremium.value)) {
                return out('not_comparable', '账本剩余权利金未知', null, Math.abs(tws));
            }
            // Both carry the commissions: the option's remaining net cash per contract.
            ledger = Math.abs(ledgerRow.remainingNetPremium.value) / (Math.abs(quantity) * multiplier);
            allowance = 0.01 / multiplier + 1e-9;
            basis = '两边都含佣金';
        }
        const twsAverage = record.secType === 'FUT' ? tws : Math.abs(tws);
        const difference = twsAverage - ledger;
        if (Math.abs(difference) <= allowance) {
            return out('matched', `${basis}；差 ${round(difference, 6)}`, round(ledger, 8), round(twsAverage, 8));
        }
        if (!context.uniform.get(record.contractId)) {
            return out('not_comparable', '多笔不同价格开仓：IB 按批次成本，账本按加权平均，口径不同',
                round(ledger, 8), round(twsAverage, 8));
        }
        return out('differs', `${basis}；相差 ${round(difference, 6)}`, round(ledger, 8), round(twsAverage, 8));
    }

    /**
     * input: {output (core output), trace (core trace, for lot prices), graph,
     * evidence (FopPositionsResponse or null), ledgerVersion (on screen)}.
     * Returns {state, reason, rows, quantityStatus, avgCostStatus, binding,
     * cash, reconciled, labels} where rows are FopReconciliationRow.
     */
    function reconcile(input) {
        const { output, trace, graph, evidence, ledgerVersion } = input;
        const binding = output.options.some((row) => row.bindingStatus === 'unresolved'
            || row.bindingStatus === 'conflict') ? 'incomplete' : 'complete';
        const result = (state, reason, extra) => Object.assign({ state, reason, rows: [],
            quantityStatus: 'not_checked', avgCostStatus: 'not_checked', binding, cash: 'not_checked',
            reconciled: false }, extra || {});
        if (!evidence) return result('none', '尚未读取 TWS 持仓');
        if (!evidence.accountConnected) {
            return result('offline', `账户 ${evidence.account} 不在当前 TWS 中：没有它的持仓证据，不能对账（账本仍可离线建账和导入）`);
        }
        if (!evidence.positionsReady) return result('not_ready', 'TWS 尚未读完持仓：不能对账，稍后重新读取');
        if (!ledgerVersion || evidence.ledgerVersion.digest !== ledgerVersion.digest) {
            return result('stale', '持仓是对照另一账本版本读取的：请重新读取');
        }
        const records = currentRecords(graph);
        const ledgerRows = new Map();
        for (const row of output.futures) ledgerRows.set(row.contractId, row);
        for (const row of output.options) ledgerRows.set(row.contractId, row);
        const byContract = new Map();
        const unplaced = [];
        for (const position of evidence.positions) {
            if (position.account !== evidence.account) continue;
            const { record, conflict } = placePosition(position, records);
            if (!record) {
                unplaced.push({ position, conflict });
                continue;
            }
            if (!byContract.has(record.contractId)) byContract.set(record.contractId, []);
            byContract.get(record.contractId).push(position);
        }
        const openingAtReference = new Set();
        for (const stored of (graph && graph.events) || []) {
            const row = stored.row;
            if (!row.voidedAtUtc && row.kind === 'opening_balance' && row.fop.baselineKind === 'reference_price') {
                openingAtReference.add(row.fop.contractRef.contractId);
            }
        }
        const context = { graph, uniform: lotPrices(trace), openingAtReference };
        const rows = [];
        for (const id of new Set([...ledgerRows.keys(), ...byContract.keys()])) {
            const record = records.get(id);
            const ledgerRow = ledgerRows.get(id) || null;
            const positions = byContract.get(id) || [];
            const ledgerQuantity = ledgerRow ? ledgerRow.contracts.value : 0;
            const twsQuantity = positions.reduce((total, position) => total + position.position, 0);
            let quantityStatus = 'matched';
            if (!known(ledgerQuantity)) quantityStatus = 'unknown';
            else if (Math.abs(ledgerQuantity - twsQuantity) > EPSILON) quantityStatus = 'mismatch';
            const average = record ? compareAvgCost(record, ledgerRow, positions, context)
                : { status: 'not_comparable', note: '', ledgerAverage: null, twsAverage: null };
            const notes = [];
            if (quantityStatus === 'unknown') notes.push(`账本数量未知（${ledgerRow.contracts.reason}）`);
            if (!positions.length) notes.push('TWS 没有这张合约的持仓');
            if (!ledgerRow) notes.push('账本没有这张合约的持仓');
            if (average.note) notes.push(`AvgCost：${average.note}`);
            rows.push({
                contractId: id, localSymbol: record ? record.localSymbol || id : id,
                ledgerQuantity: known(ledgerQuantity) ? ledgerQuantity : null, twsQuantity,
                quantityStatus, ledgerAverage: average.ledgerAverage, twsAverage: average.twsAverage,
                avgCostStatus: average.status, note: notes.join('；'),
            });
        }
        for (const { position, conflict } of unplaced) {
            rows.push({
                contractId: null, localSymbol: position.localSymbol || `conId ${position.conId}`, ledgerQuantity: 0,
                twsQuantity: position.position, quantityStatus: 'mismatch', ledgerAverage: null,
                twsAverage: null, avgCostStatus: 'not_comparable',
                note: conflict
                    ? `身份冲突：TWS 的 ${position.localSymbol} 是 conId ${position.conId}，账本的 `
                        + `${conflict.localSymbol} 是 conId ${conflict.conId}：本地代码相同也不是同一张合约，先核对合约`
                    : '账本没有这张合约：conId 与本地代码都对不上（不按根代码或月份猜测）',
            });
        }
        // A stable order: by symbol, the ledger's own contract before a position it cannot place.
        rows.sort((a, b) => (a.localSymbol < b.localSymbol ? -1 : (a.localSymbol > b.localSymbol ? 1
            : (a.contractId === null) - (b.contractId === null))));
        const quantityStatus = quantitySummary(rows);
        return result('fresh', '', { rows, quantityStatus, avgCostStatus: avgCostSummary(rows),
            reconciled: quantityStatus === 'matched' });
    }

    /**
     * The snapshot a user saves (SnapshotRequest summary and twsSnapshot):
     * the version, the quote batch with its quotes, the completeness states
     * and, when positions were read for this version, the positions with
     * every comparison. reconciled only when every quantity matched.
     */
    function snapshotParts(input) {
        const { ledgerVersion, quoteState, integrity, evidence, reconciliation } = input;
        const quotes = quoteState && quoteState.usable ? quoteState.quotes.map((quote) => ({
            contractId: quote.contractId, bid: quote.bid, ask: quote.ask, last: quote.last, mark: quote.mark,
            markSource: quote.markSource, referenceDate: quote.referenceDate, observedAtUtc: quote.observedAtUtc,
            marketDataType: quote.marketDataType })) : [];
        const state = (name) => {
            const item = integrity.find((entry) => entry.name === name);
            return item && item.state === 'complete' ? 'complete'
                : (item && item.state === 'not_checked' ? 'not_checked' : 'incomplete');
        };
        const fresh = reconciliation.state === 'fresh' || reconciliation.state === 'offline'
            || reconciliation.state === 'not_ready';
        return {
            summary: {
                ledgerVersion, quoteBatchId: quotes.length ? quoteState.quoteBatchId : null, quotes,
                // The ledger's own completeness; whether TWS agrees is the positions' part.
                completeness: { quantity: state('数量'), openingCost: state('期初成本'), binding: state('期权绑定'),
                    marketData: state('行情'), coverage: state('报表覆盖'), cash: 'not_checked' },
            },
            twsSnapshot: evidence && fresh ? {
                kind: 'fop_positions', account: evidence.account, observedAtUtc: evidence.observedAtUtc,
                ledgerVersion: evidence.ledgerVersion, accountConnected: evidence.accountConnected,
                positionsReady: evidence.positionsReady, positions: evidence.positions,
                evidenceCredential: evidence.evidenceCredential, rows: reconciliation.rows,
                quantityStatus: reconciliation.quantityStatus, avgCostStatus: reconciliation.avgCostStatus,
            } : null,
            reconciled: reconciliation.reconciled,
        };
    }

    // ------------------------------------------------------------------
    // The statement's realized P&L beside the ledger's (plan §19 P5-C4)
    // ------------------------------------------------------------------

    const COMPARISON_LABELS = Object.freeze({
        matched: '相符', different: '有差异', not_comparable: '不可比',
    });

    /**
     * One contract's movements in economic order, as the statement would lot
     * them: [{eventId, day, kind, quantity (signed), price, perUnit (FUT: the
     * commission per contract; FOP: the net cash per contract, commissions
     * included), lot ('trade'|'opening'|'delivery'), closesByDelivery}].
     */
    function movementsOf(record, graph, order, localDay, zone) {
        const rows = new Map(((graph && graph.events) || []).map((stored) => [stored.row.eventId, stored.row]));
        const multiplier = record.premiumMultiplier;
        const moves = [];
        for (const id of order) {
            const row = rows.get(id);
            if (!row || row.voidedAtUtc) continue;
            const ref = row.fop.contractRef;
            const delivered = row.fop.deliveredContractRef;
            const day = localDay(row.fop.time, zone);
            const own = ref && ref.contractId === record.contractId;
            if (record.secType === 'FUT') {
                if (own && row.kind === 'futures_trade') {
                    moves.push({ eventId: id, day, kind: row.kind, quantity: row.futureContracts, price: row.price,
                        perUnit: row.fees / Math.abs(row.futureContracts), lot: 'trade' });
                } else if (own && row.kind === 'opening_balance') {
                    moves.push({ eventId: id, day, kind: row.kind, quantity: row.futureContracts, price: row.price,
                        perUnit: 0, lot: row.fop.baselineKind === 'trade_cost' ? 'trade' : 'opening' });
                } else if (delivered && delivered.contractId === record.contractId) {
                    moves.push({ eventId: id, day, kind: row.kind, quantity: row.futureContracts, price: row.price,
                        perUnit: 0, lot: 'delivery', closesByDelivery: true });
                }
                continue;
            }
            if (!own) continue;
            if (row.kind === 'option_trade') {
                moves.push({ eventId: id, day, kind: row.kind, quantity: row.contracts, price: row.price,
                    perUnit: row.cashAmount / Math.abs(row.contracts), lot: 'trade' });
            } else if (row.kind === 'opening_balance') {
                moves.push({ eventId: id, day, kind: row.kind, quantity: row.contracts, price: row.price,
                    perUnit: row.fop.baselineKind === 'trade_cost' ? -Math.sign(row.contracts) * multiplier * row.price
                        : null, lot: row.fop.baselineKind === 'trade_cost' ? 'trade' : 'opening' });
            } else if (['option_expiry', 'option_assignment', 'option_exercise'].includes(row.kind)) {
                moves.push({ eventId: id, day, kind: row.kind, quantity: row.contracts, price: null,
                    perUnit: -(row.fees || 0) / Math.abs(row.contracts), lot: 'trade',
                    closesByDelivery: row.kind !== 'option_expiry' });
            }
        }
        return moves;
    }

    /**
     * FIFO lots with their commissions, closes on the period's days (IB's
     * basis), beside the ledger's own average-cost figure. Returns
     * {fifo, own, closes, flags} for the period.
     */
    function replayRealized(record, moves, period) {
        const futures = record.secType === 'FUT';
        const multiplier = futures ? record.futurePointValue : record.premiumMultiplier;
        const lots = [];
        const average = { q: 0, price: 0, cash: 0 };
        // lotChoice: a close in the period met open lots of different prices, so
        // which lot a statement closes (FIFO or another method) changes it.
        const result = { fifo: 0, own: 0, closes: [], openingLot: false, deliveryLot: false, byDelivery: false,
            lotChoice: false };
        for (const move of moves) {
            const inPeriod = move.day >= period.from && move.day <= period.through;
            let rest = move.quantity;
            const direction = Math.sign(move.quantity);
            // The ledger's own figure: average cost (FUT gross, fees apart; FOP its net premium released).
            if (average.q === 0 || Math.sign(average.q) === direction) {
                if (futures) average.price = (average.q * average.price + move.quantity * (move.price || 0)) / (average.q + move.quantity);
                else average.cash += (move.perUnit || 0) * Math.abs(move.quantity);
                average.q += move.quantity;
            } else {
                const closed = Math.min(Math.abs(move.quantity), Math.abs(average.q));
                const own = futures ? closed * multiplier * Math.sign(average.q) * ((move.price || 0) - average.price)
                    : average.cash * closed / Math.abs(average.q) + (move.perUnit || 0) * closed;
                if (!futures) average.cash -= average.cash * closed / Math.abs(average.q);
                if (inPeriod) result.own += own;
                average.q += direction * closed;
                const left = Math.abs(move.quantity) - closed;
                if (left > EPSILON) {
                    average.q = direction * left;
                    average.price = move.price || 0;
                    average.cash = (move.perUnit || 0) * left;
                }
            }
            // FIFO lots.
            if (inPeriod && lots.length && Math.sign(lots[0].quantity) !== direction
                && new Set(lots.map((lot) => (futures ? lot.price : lot.perUnit))).size > 1) {
                result.lotChoice = true;
            }
            while (Math.abs(rest) > EPSILON && lots.length && Math.sign(lots[0].quantity) !== direction) {
                const lot = lots[0];
                const part = Math.min(Math.abs(rest), Math.abs(lot.quantity));
                const pnl = futures
                    ? part * multiplier * Math.sign(lot.quantity) * (move.price - lot.price) - part * (lot.perUnit + move.perUnit)
                    : part * (lot.perUnit === null ? NaN : lot.perUnit) + part * move.perUnit;
                if (inPeriod) {
                    result.fifo += pnl;
                    result.closes.push(move.eventId);
                    if (lot.lot === 'opening') result.openingLot = true;
                    if (lot.lot === 'delivery') result.deliveryLot = true;
                    if (move.closesByDelivery) result.byDelivery = true;
                }
                lot.quantity -= Math.sign(lot.quantity) * part;
                rest -= direction * part;
                if (Math.abs(lot.quantity) < EPSILON) lots.shift();
            }
            if (Math.abs(rest) > EPSILON) {
                lots.push({ quantity: rest, price: move.price, perUnit: move.perUnit, lot: move.lot });
            }
        }
        return result;
    }

    /**
     * The statement's realized P&L beside the ledger's, contract by contract
     * (plan §19 P5-C4). input: {graph (the ledger, with the statement's own
     * events when previewing), order (economic event order: the core trace's),
     * evidence (plan.realizedEvidence), period {from, through}, zone,
     * localDay}. The ledger side is rebuilt on the statement's basis (FIFO
     * lots with their commissions, closes on the period's days); the ledger's
     * own figure (average cost) stands beside it. Comparable only when that
     * basis is certain: every close states its value, no lot came from a
     * baseline at a reference price or a delivery, no exercise or assignment
     * closed a lot, and either the file says FIFO or every closed lot had one
     * price. Nothing is written; Rf is never replaced.
     */
    function realizedComparison(input) {
        const { graph, order, evidence, period, zone, localDay } = input;
        const records = currentRecords(graph);
        return (evidence || []).map((item) => {
            const record = records.get(item.contractId);
            // A close without its value makes the statement's total unknown, never a partial sum.
            const base = { contractId: item.contractId, localSymbol: item.localSymbol,
                statementRealized: item.missing ? null : item.statementRealized, method: item.method,
                lines: item.lines.slice(),
                ledgerFifo: null, ledgerOwn: null, difference: null, events: [] };
            const refuse = (reason) => Object.assign(base, { status: 'not_comparable', reason });
            if (!record) return refuse('账本没有这张合约');
            const replayed = replayRealized(record, movementsOf(record, graph, order, localDay, zone), period);
            Object.assign(base, { ledgerFifo: round(replayed.fifo, 6), ledgerOwn: round(replayed.own, 6),
                events: [...new Set(replayed.closes)] });
            if (item.missing) return refuse(`报表有 ${item.missing} 行平仓没有给出已实现值（按缺值处理，不当作 0）`);
            if (item.statementRealized === null) return refuse('报表没有给出已实现值（按缺值处理，不当作 0）');
            if (replayed.openingLot) return refuse('平掉的是期初持仓：它的成交成本不在账本内（自基线起），与报表口径不同');
            if (replayed.deliveryLot || replayed.byDelivery) {
                return refuse('期间有行权、指派或由交割建立的期货：报表可能把权利金并入期货成本，口径不同');
            }
            if (!Number.isFinite(replayed.fifo)) return refuse('账本期初权利金未知');
            if (replayed.lotChoice && item.method !== 'fifo') {
                return refuse('平仓时持有不同价格的批次，而报表没有说明批次方法（账本对照按 FIFO）');
            }
            base.difference = round(item.statementRealized - replayed.fifo, 6);
            return Object.assign(base, Math.abs(base.difference) <= 0.01
                ? { status: 'matched', reason: '按报表口径（FIFO 批次、含佣金）重算相符' }
                : { status: 'different', reason: `按报表口径重算相差 ${base.difference}：逐笔核对所列报表行与账本事件` });
        });
    }

    globalScope.OptionComboCostBasisFopReconcile = Object.freeze({
        QUANTITY_LABELS,
        AVG_COST_LABELS,
        COMPARISON_LABELS,
        placePosition,
        quantitySummary,
        avgCostSummary,
        reconcile,
        snapshotParts,
        realizedComparison,
    });
})(typeof window !== 'undefined' ? window : globalThis);
