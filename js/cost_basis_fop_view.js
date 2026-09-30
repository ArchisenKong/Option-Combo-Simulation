/**
 * What the FOP ledger page shows, as data (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md
 * §5.3, §10.3, §11, §13.3 P5 item 1). DOM-free and Node-testable; the page
 * loads it after the core, the importer and js/cost_basis_fop_quotes.js.
 *
 * Every figure comes from the core's output (js/cost_basis_fop_core.js) over
 * the exported ledger graph, and every row names the contracts or events it
 * rests on, so an amount can be traced back. An unknown figure is shown with
 * its reason, never as 0. Quotes carry the level they reached; a total that
 * rests on a reference price is labelled a reference, never current.
 */
(function attachCostBasisFopView(globalScope) {
    'use strict';

    const Quotes = globalScope.OptionComboCostBasisFopQuotes;

    // ------------------------------------------------------------------
    // Labels
    // ------------------------------------------------------------------

    const KIND_LABELS = Object.freeze({
        futures_trade: '期货成交', option_trade: '期权成交', option_assignment: '期权被指派',
        option_exercise: '期权行权', option_expiry: '期权到期', opening_balance: '期初持仓',
        fee: '费用', manual_adjust: '经济调整',
    });
    const SOURCE_LABELS = Object.freeze({
        manual: '人工核实', csv_import: '报表导入', execution_report: 'TWS 成交', reconcile: '期初/对账',
    });
    const BINDING_LABELS = Object.freeze({
        verified_broker: '券商验证', verified_statement: '报表验证', manual_attested: '人工核实',
        unresolved: '待补全', conflict: '冲突',
    });
    const STATUS_LABELS = Object.freeze({
        complete: '完整', incomplete: '不完整', reference: '仅参考价', not_checked: '未核对',
    });
    const REASON_LABELS = Object.freeze({
        no_quote: '没有报价', missing_mark: '缺报价', invalid_quote: '报价无效',
        not_applicable_full_history: '完整历史账本不适用', as_of_before_baseline: '查询时点早于基线',
        no_future_position: '当前没有期货持仓：每桶成本不适用',
        multiple_future_contracts: '持有多个期货合约：只显示逐合约均价与总盈亏，不给单一回本价',
        history_before_baseline: '自基线起的账本没有基线前的历史，不能给延续全历史的回本价',
        order_ambiguous: '同一时刻的成交顺序未知且影响结果', overdraw: '平仓超过当时持仓',
        event_time_unresolved: '事件时间范围尚未确定', delivery_time_unresolved: '交割时间范围尚未确定',
        binding_conflict: '期权绑定冲突', cycle_unattributed: '有未归属周期的费用或调整',
        unknown_opening_cost: '期初成本未知', opening_premium_unknown: '期初权利金未知',
        baseline_not_at_reference: '基线不是 B 时刻参考价，无法计算自基线变化',
    });

    /** A reason in words; records (contractId -> record) turn contract ids into local symbols. */
    function reasonText(reason, records) {
        if (!reason) return '';
        const [code, detail] = String(reason).split(/:(.*)/s);
        const label = REASON_LABELS[code] || code;
        if (!detail) return label;
        const named = records && records.has(detail) ? (records.get(detail).localSymbol || detail) : detail;
        return `${label}（${named}）`;
    }

    function round(value, digits) {
        const factor = 10 ** digits;
        return Math.round(value * factor) / factor;
    }

    /** A dollar amount or a price as text; an unknown metric shows its reason. */
    function metricText(metric, digits = 2, records = null) {
        if (!metric) return '—';
        if (metric.value === null || metric.value === undefined) return `未知：${reasonText(metric.reason, records)}`;
        const value = round(metric.value, digits);
        return (Object.is(value, -0) ? 0 : value).toFixed(digits);
    }

    function priceText(value) {
        if (value === null || value === undefined || !Number.isFinite(value)) return '—';
        return String(round(value, 6));
    }

    // ------------------------------------------------------------------
    // The graph as the page needs it
    // ------------------------------------------------------------------

    function currentRecords(graph) {
        const records = new Map();
        for (const stored of (graph && graph.contracts) || []) {
            if (stored.supersededByRevision === null || stored.supersededByRevision === undefined) {
                records.set(stored.record.contractId, stored.record);
            }
        }
        return records;
    }

    function symbolOf(records, contractId) {
        const record = records.get(contractId);
        return record ? (record.localSymbol || record.contractId) : (contractId || '—');
    }

    function quoteOf(quoteState, contractId) {
        if (!quoteState || !quoteState.usable) return null;
        return quoteState.quotes.find((quote) => quote.contractId === contractId) || null;
    }

    function quoteText(quote) {
        if (!quote) return '未取报价';
        const Messages = globalScope.OptionComboCostBasisFopMessages;
        if (quote.level === 'unavailable') {
            return `无可用报价：${Messages ? Messages.quoteReason(quote.reason) : quote.reason || '—'}`;
        }
        const date = quote.referenceDate ? ` ${quote.referenceDate}` : '';
        return `${priceText(quote.mark)}（${quote.label}${date}）`;
    }

    // ------------------------------------------------------------------
    // Panels
    // ------------------------------------------------------------------

    /**
     * How current the figures that need prices are: realtime when every
     * open contract has a current mid or one-sided price, reference when
     * one rests on a dated settlement or close, else unavailable. The label
     * names the lowest level used (plan §10.3): a one-sided conservative
     * price is current, but never shown as a plain mid.
     */
    function priceQuality(output, quoteState) {
        const open = Quotes.quoteTargets(output).length;
        if (!open) return { level: 'none', label: '无未平仓，无需报价' };
        if (!quoteState || !quoteState.usable) return { level: 'not_checked', label: '尚未取报价' };
        if (quoteState.marketData === 'complete') {
            const oneSided = quoteState.lowest === 'one_sided_conservative';
            return { level: 'realtime', oneSided,
                label: oneSided ? `实时（批内同步；最低一级：${Quotes.LEVEL_LABELS.one_sided_conservative}）`
                    : '实时（批内同步）' };
        }
        if (quoteState.marketData === 'reference') {
            return { level: 'reference', label: `参考值（最低一级：${Quotes.LEVEL_LABELS[quoteState.lowest]}）` };
        }
        return { level: 'unavailable', label: '部分合约无可用报价' };
    }

    function overview(output, quoteState, graph) {
        const quality = priceQuality(output, quoteState);
        const totals = output.totals;
        const lens = output.sellerLens;
        const records = currentRecords(graph);
        const text = (metric) => metricText(metric, 2, records);
        const pnl = text(totals.economicPnl);
        // A price-dependent figure names the lowest level it rests on: a
        // settlement or close reference, else a one-sided conservative price.
        const futureIds = new Set(output.futures.map((row) => row.contractId));
        const levelsOf = (futures) => new Set(quoteState && quoteState.usable ? quoteState.quotes
            .filter((quote) => futureIds.has(quote.contractId) === futures).map((quote) => quote.level) : []);
        const label = (base, futures) => {
            const levels = levelsOf(futures);
            if (levels.has('settlement_reference') || levels.has('close_reference')) return `${base}（含结算/收盘参考价）`;
            if (levels.has('one_sided_conservative')) return `${base}（含单边保守估值）`;
            return base;
        };
        let tag = '';
        if (totals.economicPnl.value === null) tag = '不可用';
        else if (quality.level === 'reference') tag = '参考值，非实时';
        else if (quality.level === 'realtime') tag = quality.oneSided ? '实时 · 含单边保守估值' : '实时';
        const scope = output.scope.history === 'since_baseline'
            ? `自基线起（B = ${output.scope.baselineAsOfUtc || '—'}）` : '完整历史';
        return {
            scope,
            quality,
            headline: {
                label: '完整策略经济盈亏',
                value: pnl,
                tag,
            },
            rows: [
                ['期货已实现（Rf）', text(totals.Rf)],
                [label('期货浮动（Uf）', true), text(totals.Uf)],
                ['期权净现金（Co，含佣金）', text(totals.Co)],
                [label('未平期权市值（Vo）', false), text(totals.Vo)],
                ['费用（E，不含期权成交佣金）', text(totals.E)],
                ['经济调整（J）', text(totals.J)],
                ['卖方已结算净收益（Rs）', text(lens.Rs)],
                ['卖方口径费用（Es）', text(lens.Es)],
            ],
            identity: 'Rf + Uf + Co + Vo − E + J'
                + (output.scope.history === 'since_baseline' ? ' − 期初价值 O_B' : ''),
            // The buyer's options apart (plan §5.2): already inside Co, Vo and E, never added again.
            buyer: [
                ['已结束的买方期权（Rb，含佣金）', text(output.buyerOptions.Rb)],
                ['买方专属费用（Eb，行权/到期等，不进卖方口径）', text(output.buyerOptions.Eb)],
                ['未平买方期权净权利金（已付为负）', text(output.buyerOptions.openPremium)],
                [label('未平买方期权市值', false), text(output.buyerOptions.openValue)],
                ['买方期权结果（Rb − Eb + 净权利金 + 市值）', text(output.buyerOptions.result)],
            ],
            unattributed: output.unattributed.E.value || output.unattributed.J.value
                || output.unattributed.E.reason || output.unattributed.J.reason
                ? [['待归属费用', text(output.unattributed.E)], ['待归属调整', text(output.unattributed.J)]]
                : [],
        };
    }

    /** The break-even card (plan §5.3): only for exactly one open FUT contract. */
    function breakEvenCard(output, graph) {
        const lens = output.sellerLens;
        const records = currentRecords(graph);
        if (lens.breakEven.value === null) {
            return { shown: false, reason: reasonText(lens.breakEven.reason, records), rows: [], hint: '' };
        }
        const future = output.futures[0];
        return {
            shown: true,
            reason: '',
            contract: symbolOf(records, future.contractId),
            rows: [
                ['实际开仓均价', priceText(future.averagePrice.value)],
                ['卖方策略等效回本价（已结算结果）', priceText(lens.breakEven.value)],
                ['未平卖方期权全部归零假设价', lens.breakEvenIfOpenShortsExpire.value === null
                    ? `未知：${reasonText(lens.breakEvenIfOpenShortsExpire.reason, records)}`
                    : priceText(lens.breakEvenIfOpenShortsExpire.value)],
            ],
            note: '这是已结算结果的价格换算，不含未平期权的当前价值，也不是保证金结论。',
            hint: lens.longExerciseAffectsBreakEven
                ? '本周期发生过买方行权：同一经济结果若改为卖出期权兑现，回本价会不同（§5.3）。' : '',
        };
    }

    function futuresTable(output, graph, quoteState) {
        const records = currentRecords(graph);
        let long = 0;
        let short = 0;
        const rows = output.futures.map((row) => {
            const record = records.get(row.contractId) || {};
            const quote = quoteOf(quoteState, row.contractId);
            const contracts = row.contracts.value;
            if (contracts > 0) long += contracts;
            if (contracts < 0) short += contracts;
            return {
                contractId: row.contractId,
                month: row.contractMonth,
                localSymbol: row.localSymbol || record.localSymbol || row.contractId,
                lastTradeDate: record.futureLastTradeDate || '未知',
                contracts: metricText(row.contracts, 0),
                average: row.averagePrice.value === null ? metricText(row.averagePrice) : priceText(row.averagePrice.value),
                quote: quoteText(quote),
                level: quote ? quote.level : null,
                unrealized: metricText(row.unrealized),
            };
        });
        return { rows, long, short, net: long + short,
            note: long && short ? '持有跨月多空：净张数不代表已平仓。' : '' };
    }

    function optionsTable(output, graph, quoteState, today) {
        const records = currentRecords(graph);
        const openFutures = new Set(output.futures.filter((row) => row.contracts.value)
            .map((row) => row.contractId));
        return output.options.map((row) => {
            const record = records.get(row.contractId) || {};
            const quote = quoteOf(quoteState, row.contractId);
            const flags = [];
            if (row.boundFutureContractId && !openFutures.has(row.boundFutureContractId)) {
                flags.push(openFutures.size ? '旧月期权：对应期货未持有' : '对应期货未持有');
            }
            if (today && row.expiry && row.expiry < today) flags.push('已过到期日仍未平：缺到期或交割记录');
            return {
                contractId: row.contractId,
                localSymbol: record.localSymbol || row.contractId,
                expiry: row.expiry,
                right: row.right,
                strike: priceText(row.strike),
                tradingClass: record.tradingClass || '—',
                contracts: metricText(row.contracts, 0),
                future: row.boundFutureContractId ? symbolOf(records, row.boundFutureContractId) : '未绑定',
                binding: BINDING_LABELS[row.bindingStatus] || row.bindingStatus,
                premium: metricText(row.remainingNetPremium),
                quote: quoteText(quote),
                level: quote ? quote.level : null,
                value: metricText(row.value),
                flags,
            };
        });
    }

    /**
     * Delivery coverage per real FUT (plan §11 item 5): what the open options
     * bound to it would deliver, beside that FUT's own position. Another
     * month's FUT never covers them (F08), a call and a put are not netted,
     * and an unbound option is listed apart. This is not a margin statement.
     */
    function deliveryCoverage(output, graph) {
        const records = currentRecords(graph);
        const positions = new Map(output.futures.map((row) => [row.contractId, row.contracts.value]));
        const byFuture = new Map();
        const unbound = [];
        for (const row of output.options) {
            const quantity = row.contracts.value;
            const bound = row.boundFutureContractId
                && row.bindingStatus !== 'unresolved' && row.bindingStatus !== 'conflict';
            if (!bound || quantity === null) {
                unbound.push({ contractId: row.contractId, localSymbol: symbolOf(records, row.contractId),
                    reason: quantity === null ? '持仓数量未知' : '绑定未确定，无法判断交割到哪个期货' });
                continue;
            }
            if (!byFuture.has(row.boundFutureContractId)) {
                byFuture.set(row.boundFutureContractId, { shortCalls: 0, shortPuts: 0, longCalls: 0, longPuts: 0,
                    options: [] });
            }
            const entry = byFuture.get(row.boundFutureContractId);
            const count = Math.abs(quantity);
            if (row.right === 'C') entry[quantity < 0 ? 'shortCalls' : 'longCalls'] += count;
            else entry[quantity < 0 ? 'shortPuts' : 'longPuts'] += count;
            entry.options.push(symbolOf(records, row.contractId));
        }
        const otherHeld = (futureId) => output.futures.some((row) => row.contractId !== futureId && row.contracts.value);
        const rows = [...byFuture.entries()].map(([futureId, entry]) => {
            const position = positions.get(futureId) || 0;
            const notes = [];
            let calls = '无空头 Call';
            if (entry.shortCalls) {
                calls = position >= entry.shortCalls ? '已由同合约多头覆盖'
                    : (position > 0 ? `部分覆盖（缺 ${entry.shortCalls - position} 张）` : '无同合约多头覆盖');
            }
            let puts = '无空头 Put';
            if (entry.shortPuts) {
                puts = position <= -entry.shortPuts ? '已由同合约空头覆盖'
                    : (position < 0 ? `部分覆盖（缺 ${entry.shortPuts + position} 张）` : '无同合约空头覆盖');
            }
            if ((entry.shortCalls || entry.shortPuts) && !position && otherHeld(futureId)) {
                notes.push('持有的是其他月份期货，不构成同合约覆盖');
            }
            return {
                futureId,
                future: symbolOf(records, futureId),
                position,
                ifShortsAssigned: entry.shortPuts - entry.shortCalls,
                ifLongsExercised: entry.longCalls - entry.longPuts,
                calls, puts, notes, options: entry.options,
            };
        });
        return { rows, unbound, note: 'Call 与 Put 的可能结果分别列出、不互相抵销；这不是券商保证金结论。' };
    }

    /** ROLL groups the core derived at read time (plan §6.2): never stored, never a P&L. */
    function rollHistory(output, graph) {
        const records = currentRecords(graph);
        return (output.roll.groups || []).map((group) => {
            const byContract = new Map();
            for (const leg of group.legs) {
                if (!byContract.has(leg.contractId)) byContract.set(leg.contractId, { contracts: 0, notional: 0, fees: 0 });
                const entry = byContract.get(leg.contractId);
                entry.contracts += Math.abs(leg.contracts);
                entry.notional += Math.abs(leg.contracts) * leg.price;
                entry.fees += leg.fees;
            }
            const [from, to] = [...byContract.keys()].sort((a, b) => {
                const left = records.get(a);
                const right = records.get(b);
                return (left ? left.futureContractMonth : a) < (right ? right.futureContractMonth : b) ? -1 : 1;
            });
            const price = (id) => (byContract.get(id).contracts
                ? byContract.get(id).notional / byContract.get(id).contracts : null);
            const fees = group.legs.reduce((sum, leg) => sum + leg.fees, 0);
            return {
                evidence: group.evidence === 'order' ? '有证据' : '候选',
                from: symbolOf(records, from),
                to: symbolOf(records, to),
                contracts: group.matchedContracts,
                closePrice: priceText(price(from)),
                openPrice: priceText(price(to)),
                spread: priceText(price(to) - price(from)),
                fees: metricText({ value: fees, reason: null }),
                events: group.legs.map((leg) => leg.eventId),
            };
        });
    }

    function cyclesTable(output, graph) {
        const records = currentRecords(graph);
        const labels = new Map(((graph && graph.cycles) || []).filter((cycle) => cycle.supersededByRevision === null
            || cycle.supersededByRevision === undefined).map((cycle) => [cycle.boundaryId, cycle]));
        const rows = output.cycles.map((cycle) => {
            const boundary = cycle.closedByBoundaryId ? labels.get(cycle.closedByBoundaryId) : null;
            return {
                index: cycle.index + 1,
                state: cycle.closedByBoundaryId ? '已结束' : '当前',
                boundary: cycle.closedByBoundaryId || '—',
                label: boundary && boundary.label ? boundary.label : '',
                anchor: boundary ? boundary.anchorEventId : null,
                Rf: metricText(cycle.totals.Rf, 2, records),
                E: metricText(cycle.totals.E, 2, records),
                economicPnl: metricText(cycle.totals.economicPnl, 2, records),
            };
        });
        const unattributed = output.unattributed.E.value || output.unattributed.J.value
            || output.unattributed.E.reason || output.unattributed.J.reason;
        return { rows, unattributed: unattributed ? metricText(output.unattributed.E) : null,
            note: '整本合计 = 各周期合计 + 待归属项；迟到费用按其源成交归入原周期。' };
    }

    /**
     * The five completeness states plus cash (plan §10.3, FopSnapshotSummary):
     * quantity, opening cost, binding, market data and statement coverage are
     * judged apart; cash is never checked in the first release (§6.3).
     */
    function integrity(output, context) {
        const records = currentRecords(context.graph);
        const gaps = output.gaps || [];
        const quantityGaps = gaps.filter((gap) => /\.contracts$|^realizedByContract/.test(gap.metric));
        const openingGaps = gaps.filter((gap) => gap.metric === 'scope.openingValue'
            || /remainingNetPremium$/.test(gap.metric));
        const unbound = output.options.filter((row) => row.bindingStatus === 'unresolved'
            || row.bindingStatus === 'conflict');
        const quality = priceQuality(output, context.quoteState);
        const coverage = context.coverage;
        const states = [
            ['数量', quantityGaps.length ? 'incomplete' : 'complete',
                quantityGaps.map((gap) => reasonText(gap.reason, records)).join('；')],
            ['期初成本', openingGaps.length ? 'incomplete' : 'complete',
                openingGaps.map((gap) => reasonText(gap.reason, records)).join('；')],
            ['期权绑定', unbound.length ? 'incomplete' : 'complete',
                unbound.map((row) => `${symbolOf(records, row.contractId)}：${BINDING_LABELS[row.bindingStatus]}`).join('；')],
            ['行情', { none: 'complete', realtime: 'complete', reference: 'reference', unavailable: 'incomplete',
                not_checked: 'not_checked' }[quality.level], quality.label],
            ['报表覆盖', !coverage || !coverage.ranges.length ? 'not_checked'
                : (coverage.gaps.length ? 'incomplete' : 'complete'),
            !coverage || !coverage.ranges.length ? '没有登记的报表期间'
                : (coverage.gaps.length ? `缺口：${coverage.gaps.map((gap) => `${gap.from} 至 ${gap.through}`)
                    .join('，')}` : `覆盖 ${coverage.ranges.map((range) => `${range.from} 至 ${range.through}`)
                    .join('，')}`)],
            ['现金', 'not_checked', '未核对（首版不做资金对账）'],
        ];
        return states.map(([name, state, detail]) => ({ name, state, label: STATUS_LABELS[state], detail }));
    }

    function timeText(time) {
        if (!time) return '';
        if (time.executedAtUtc) return `${time.executedAtUtc.slice(0, 19).replace('T', ' ')} UTC`;
        if (time.timeRange) {
            return `${time.timeRange.startUtc.slice(0, 16).replace('T', ' ')} ~ `
                + `${time.timeRange.endUtc.slice(0, 16).replace('T', ' ')} UTC`;
        }
        return '';
    }

    /**
     * The event list (ListedFopEvent rows) in the order given. The server's
     * rows carry their display projection; without one the graph's contract
     * records name the contracts.
     */
    function eventsTable(events, graph) {
        const records = currentRecords(graph);
        const named = (ref) => (ref && records.has(ref.contractId) ? records.get(ref.contractId).localSymbol : null);
        return (events || []).map((event) => {
            const fop = event.fop || {};
            const display = event.display || { localSymbol: named(fop.contractRef),
                deliveredLocalSymbol: named(fop.deliveredContractRef) };
            const quantity = event.kind === 'futures_trade' ? event.futureContracts
                : (event.contracts !== null && event.contracts !== undefined ? event.contracts : event.futureContracts);
            const delivered = display.deliveredLocalSymbol
                ? ` → ${display.deliveredLocalSymbol} ${event.futureContracts > 0 ? '+' : ''}${event.futureContracts}` : '';
            return {
                eventId: event.eventId,
                kind: KIND_LABELS[event.kind] || event.kind,
                contract: `${display.localSymbol || '—'}${delivered}`,
                quantity: quantity === null || quantity === undefined ? '—' : String(quantity),
                price: priceText(event.price),
                fees: metricText({ value: event.fees, reason: null }),
                cash: metricText({ value: event.cashAmount, reason: null }),
                time: timeText(event.fop && event.fop.time),
                tradeDate: event.fop && event.fop.time && event.fop.time.exchangeTradeDate
                    ? `交易所交易日 ${event.fop.time.exchangeTradeDate}` : '',
                source: SOURCE_LABELS[event.source] || event.source,
                manual: event.source === 'manual',
                voided: Boolean(event.voidedAtUtc),
                note: event.note || '',
            };
        });
    }

    // ------------------------------------------------------------------
    // Stress scenarios (CODE PLAN/COST_BASIS_FOP_STRESS_CONTRACT.md §8, §11)
    // ------------------------------------------------------------------

    const STRESS_LABELS = Object.freeze({
        immediate_path: '价格立即到位并保持', sticky_strike: '每张期权保留自己的隐含波动率（sticky-strike）',
        no_delivery_fees: '情景交割未计费用', assumed_rate: '利率为手工假设',
        reference_quotes: '部分期货锚点是结算/收盘参考价',
    });
    const SETTLEMENT_LABELS = Object.freeze({ assign: '被指派', exercise: '行权', expire: '到期作废' });
    const STRESS_ANCHOR_FUTURE_COLUMNS = Object.freeze(['期货', '合约月', '锚点价', '报价级别', '持仓（张）']);
    const STRESS_ANCHOR_OPTION_COLUMNS = Object.freeze(['期权', '持仓（张）', '绑定期货', '期货锚点价', '期权中间价',
        '锚定模型值', '隐含波动率 σ', '情景 σ（× IV 倍数）', '贴现利率', '剩余天数', '到期时刻']);
    const NOT_DELIVERED_LABELS = Object.freeze({ out_of_the_money: '价外，未提前交割', settled_at_expiry: '已在到期时结算' });

    function moneyText(value) {
        if (value === null || value === undefined || !Number.isFinite(value)) return '—';
        const rounded = round(value, 2);
        return (Object.is(rounded, -0) ? 0 : rounded).toFixed(2);
    }

    /** What a stress run assumes, in one line (contract §11): always shown beside the curve. */
    function stressAssumptions(result, records) {
        const parts = (result.labels || []).map((label) => {
            const [code, id] = String(label).split(/:(.*)/s);
            if (code === 'expiry_time_by_rule') return `到期时刻按品种规则推定（${symbolOf(records, id)}）`;
            return STRESS_LABELS[code] || code;
        });
        const inputs = result.inputs || {};
        const rate = !inputs.rate ? '无利率' : (inputs.rate.source === 'assumed'
            ? `假设利率 ${round(inputs.rate.value * 100, 4)}%` : `贴现曲线（${inputs.rate.asOfDate || '日期未知'}）`);
        const edge = (result.points || []).length ? Math.abs(result.points[0].shift) : null;
        const range = edge === null ? null : (inputs.range !== null && inputs.range !== undefined
            ? `扫描范围 ±${priceText(edge)} 美元/桶（按美元输入）`
            : `扫描范围 ±${priceText(edge)} 美元/桶（参考月价格的 ${inputs.rangePct}%）`);
        parts.push(`模型：美式 CRR ${inputs.steps || 201} 步，欧式 Black-76`, rate,
            `行情批 ${inputs.quoteBatchId || '—'}，时刻 ${inputs.asOf || '—'}`);
        if (range) parts.push(range);
        parts.push('情景范围不是概率、置信区间或保证金结论');
        return parts.join('；');
    }

    function percentText(value) {
        return Number.isFinite(value) ? `${round(value * 100, 4)}%` : '—';
    }

    /** How an option ended at a point that settled it: at its expiry, or delivered early at the horizon. */
    function optionOutcome(settlement, anchorOption) {
        if (settlement.action === 'expire') return '到期作废';
        const early = anchorOption && settlement.at !== anchorOption.expiryAt;
        return `${early ? '提前' : '到期'}${SETTLEMENT_LABELS[settlement.action] || settlement.action}`;
    }

    /**
     * The anchors of a run (contract §8, §11): each future's price and level,
     * each option's mid, anchored model value and implied volatility, the
     * scenario sigma, its rate, time left and expiry. {futureColumns,
     * futureRows, optionColumns, optionRows, futures, options} where futures
     * and options are the contract ids in the order the tables list them.
     */
    function stressAnchors(result, records) {
        const anchor = result.anchor;
        const month = (id) => (records.get(id) || {}).futureContractMonth || '';
        const futures = Object.keys(anchor.futures).sort((a, b) => month(a).localeCompare(month(b)) || a.localeCompare(b));
        const options = Object.keys(anchor.options).sort((a, b) => String(anchor.options[a].expiryAt)
            .localeCompare(String(anchor.options[b].expiryAt)) || symbolOf(records, a).localeCompare(symbolOf(records, b)));
        const scale = result.inputs.ivScale;
        const held = anchor.held || {};
        const futureRows = futures.map((id) => [symbolOf(records, id), month(id), priceText(anchor.futures[id]),
            Quotes.LEVEL_LABELS[anchor.levels[id]] || anchor.levels[id] || '—', held[id] || 0]);
        const optionRows = options.map((id) => {
            const item = anchor.options[id];
            return [symbolOf(records, id), item.contracts, symbolOf(records, item.future),
                priceText(anchor.futures[item.future]), priceText(item.mid), priceText(item.value), percentText(item.sigma),
                percentText(item.sigma * scale), percentText(item.rate), priceText(round(item.tau * 365, 4)),
                `${item.expiryAt}${item.expiryByRule ? '（按品种规则推定）' : ''}`];
        });
        return { futureColumns: STRESS_ANCHOR_FUTURE_COLUMNS.slice(), futureRows,
            optionColumns: STRESS_ANCHOR_OPTION_COLUMNS.slice(), optionRows, futures, options };
    }

    function settlementText(settlement, records) {
        const head = `${symbolOf(records, settlement.option)} ${SETTLEMENT_LABELS[settlement.action] || settlement.action}`;
        if (!settlement.future) return head;
        const count = settlement.futureContracts > 0 ? `+${settlement.futureContracts}` : String(settlement.futureContracts);
        return `${head} → ${symbolOf(records, settlement.future)} ${count}（按行权价）`;
    }

    /**
     * The stress panel as data: {available, empty, status, reasons, assumptions,
     * columns, rows, anchorFutureColumns, anchorFutureRows,
     * anchorOptionColumns, anchorOptionRows, chart}. options: {showTotal}.
     * Each point lists every month's scenario price and every option's model
     * value, or how the option settled there (contract §8, §11). Unavailable
     * points stay in the table with their reason; the curve breaks there
     * (contract §5.3).
     */
    function stressView(result, records, options = {}) {
        const Messages = globalScope.OptionComboCostBasisFopMessages;
        const nameOf = (id) => symbolOf(records, id);
        const none = { columns: [], rows: [], anchorFutureColumns: [], anchorFutureRows: [], anchorOptionColumns: [],
            anchorOptionRows: [], chart: { available: false } };
        if (!result || !result.available) {
            const reasons = ((result && result.reasons) || ['stress_failed']).map((reason) => Messages.stressReason(reason, nameOf));
            return Object.assign(none, { available: false, empty: false, status: `不能计算：${reasons.join(' ')}`, reasons,
                assumptions: '' });
        }
        if (result.empty) {
            return Object.assign(none, { available: true, empty: true, reasons: [], assumptions: '',
                status: `当前没有未平持仓：情景不改变经济盈亏（变化恒为 0，账本经济盈亏 `
                    + `${metricText(result.anchor.ledgerEconomicPnl)}）。` });
        }
        const anchor = result.anchor.futures[result.inputs.reference];
        const anchors = stressAnchors(result, records);
        const band = new Map(((result.band && result.band.available && result.band.points) || [])
            .map((point) => [point.shift, point]));
        const columns = ['参考月价格'].concat(anchors.futures.map((id) => `${nameOf(id)} 情景价`),
            anchors.options.map((id) => `${nameOf(id)} 模型值`),
            ['经济盈亏变化', '情景经济盈亏', 'IV 区间（变化）', '情景交割', '说明']);
        const contracts = anchors.futures.length + anchors.options.length;
        const rows = result.points.map((point) => {
            const x = priceText(anchor + point.shift);
            if (!point.available) {
                return [x].concat(Array(contracts).fill('—'), ['—', '—', '—', '—', Messages.stressReason(point.reason, nameOf)]);
            }
            const prices = anchors.futures.map((id) => priceText(point.futures[id]));
            const values = anchors.options.map((id) => {
                if (point.values[id] !== undefined) return priceText(point.values[id]);
                const settled = point.settlements.find((item) => item.option === id);
                return settled ? optionOutcome(settled, result.anchor.options[id]) : '—';
            });
            const range = band.get(point.shift);
            const settled = point.settlements.map((item) => settlementText(item, records)).join('；');
            const skipped = point.notDelivered.map((item) => `${nameOf(item.option)}：${NOT_DELIVERED_LABELS[item.why]}`);
            return [x].concat(prices, values, [moneyText(point.change), metricText(point.economicPnl),
                range && range.available ? `${moneyText(range.lower)} ～ ${moneyText(range.upper)}` : '—',
                settled || '—', skipped.join('；')]);
        });
        const unavailable = result.points.filter((point) => !point.available).length;
        const status = `${result.points.length} 个情景点（参考月 ${nameOf(result.inputs.reference)}，经过 `
            + `${result.inputs.horizonDays} 天，IV × ${result.inputs.ivScale}）`
            + (unavailable ? `，其中 ${unavailable} 个不可用` : '') + `；当前账本经济盈亏 `
            + `${metricText(result.anchor.ledgerEconomicPnl)}。`;
        return { available: true, empty: false, status, reasons: [], assumptions: stressAssumptions(result, records),
            columns, rows, anchorFutureColumns: anchors.futureColumns, anchorFutureRows: anchors.futureRows,
            anchorOptionColumns: anchors.optionColumns, anchorOptionRows: anchors.optionRows,
            chart: stressChart(result, options) };
    }

    /**
     * The curve as SVG paths in a width x height box: the line (broken at
     * unavailable points), the IV band over each unbroken run, the zero line
     * and the anchor. y is the change, or the total with showTotal.
     */
    function stressChart(result, options = {}) {
        const width = options.width || 640;
        const height = options.height || 240;
        const pad = 32;
        const anchor = result.anchor.futures[result.inputs.reference];
        const band = new Map(((result.band && result.band.available && result.band.points) || [])
            .map((point) => [point.shift, point]));
        const series = result.points.map((point) => {
            const total = point.available && point.economicPnl && point.economicPnl.value !== null
                ? point.economicPnl.value : null;
            const y = !point.available ? null : (options.showTotal ? total : point.change);
            const offset = options.showTotal ? (total === null ? null : total - point.change) : 0;
            const range = band.get(point.shift);
            return { x: anchor + point.shift, y, lower: range && range.available && offset !== null ? range.lower + offset : null,
                upper: range && range.available && offset !== null ? range.upper + offset : null };
        });
        const ys = series.flatMap((item) => [item.y, item.lower, item.upper]).filter((value) => value !== null);
        if (!ys.length) return { available: false };
        const xMin = Math.min(...series.map((item) => item.x));
        const xMax = Math.max(...series.map((item) => item.x));
        let yMin = Math.min(0, ...ys);
        let yMax = Math.max(0, ...ys);
        const margin = (yMax - yMin) * 0.05 || 1;
        yMin -= margin;
        yMax += margin;
        const sx = (x) => (xMax === xMin ? width / 2 : pad + (x - xMin) / (xMax - xMin) * (width - 2 * pad));
        const sy = (y) => height - pad - (y - yMin) / (yMax - yMin) * (height - 2 * pad);
        const at = (x, y) => `${round(sx(x), 1)} ${round(sy(y), 1)}`;
        let line = '';
        let drawing = false;
        for (const item of series) {
            if (item.y === null) {
                drawing = false;
                continue;
            }
            line += `${drawing ? ' L' : `${line ? ' ' : ''}M`} ${at(item.x, item.y)}`;
            drawing = true;
        }
        const runs = [];
        let current = [];
        for (const item of series) {
            if (item.lower === null) {
                if (current.length) runs.push(current);
                current = [];
            } else {
                current.push(item);
            }
        }
        if (current.length) runs.push(current);
        const bandPath = runs.filter((run) => run.length > 1).map((run) => `M ${run.map((item) => at(item.x, item.upper))
            .join(' L ')} L ${run.slice().reverse().map((item) => at(item.x, item.lower)).join(' L ')} Z`).join(' ');
        return {
            available: true, width, height, line, band: bandPath,
            zero: `M ${pad} ${round(sy(0), 1)} L ${width - pad} ${round(sy(0), 1)}`,
            anchorX: round(sx(anchor), 1), top: pad, bottom: height - pad,
            axes: { xMin: round(xMin, 4), xMax: round(xMax, 4), yMin: round(yMin, 2), yMax: round(yMax, 2) },
        };
    }

    globalScope.OptionComboCostBasisFopView = Object.freeze({
        stressView,
        stressChart,
        stressAssumptions,
        stressAnchors,
        KIND_LABELS,
        SOURCE_LABELS,
        BINDING_LABELS,
        reasonText,
        metricText,
        priceText,
        currentRecords,
        priceQuality,
        overview,
        breakEvenCard,
        futuresTable,
        optionsTable,
        deliveryCoverage,
        rollHistory,
        cyclesTable,
        integrity,
        eventsTable,
    });
})(typeof window !== 'undefined' ? window : globalThis);
