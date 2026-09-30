/**
 * Manual entries, ledger operations and the delivery preview of the FOP
 * page (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §1.4, §6.1, §11 item 7,
 * §12.1, §13.3 P5 item 3). DOM-free and Node-testable.
 *
 * CSV is the main input; these builders are the exception path. Each builds
 * exactly the frozen request (protocol.json AppendRequest, VoidRequest,
 * MetadataCommitRequest) for one ledger, from what the user states:
 *
 * - a trade names a stored contract, or new terms kept as manual_attested
 *   (a FUT by its delivery month, never an expiry; a new option with the
 *   FUT it delivers, also manual_attested);
 * - an assignment or exercise is one event that closes the option and moves
 *   the FUT its binding names, at the strike; its cash is only fees (§6.1);
 * - a time is an instant in a stated zone, or a whole day as a range.
 *
 * The delivery preview replays a copy of the ledger graph with the chosen
 * deliveries (a quantity per option) added in memory and prices per real
 * FUT; nothing is sent and nothing is stored. A path that holds any FUT past
 * its last trade date, or leaves an option open past its expiry, stops
 * (§12.1).
 */
(function attachCostBasisFopForms(globalScope) {
    'use strict';

    const Import = globalScope.OptionComboCostBasisFopImport;
    const Core = globalScope.OptionComboCostBasisFopCore;
    const PACKAGE_VERSION = 1;
    const POSITION_KINDS = new Set(['futures_trade', 'option_trade', 'option_assignment', 'option_exercise',
        'option_expiry', 'opening_balance']);

    class FormError extends Error {}

    function fail(message) {
        throw new FormError(message);
    }

    function integer(value, name, { allowZero = false } = {}) {
        const number = Number(value);
        if (!Number.isInteger(number) || (!allowZero && number === 0)) fail(`${name} 必须是非零整数`);
        return number;
    }

    function finiteNumber(value, name, { min = null } = {}) {
        const number = typeof value === 'number' ? value : Number(String(value || '').trim());
        if (String(value === undefined || value === null ? '' : value).trim() === '' || !Number.isFinite(number)) {
            fail(`${name} 必须是数字`);
        }
        if (min !== null && number < min) fail(`${name} 不能小于 ${min}`);
        return number;
    }

    function tokenPart(text) {
        return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    }

    // ------------------------------------------------------------------
    // Time (plan §9.2): an instant in a stated zone, or a day as a range
    // ------------------------------------------------------------------

    /**
     * input: {local: 'YYYY-MM-DDTHH:MM[:SS]'} or {date: 'YYYY-MM-DD'}, plus an
     * optional exchangeTradeDate. zone: the account timezone the user states.
     */
    function timeFacts(input, zone) {
        if (!zone) fail('请说明账户时区');
        const exchangeTradeDate = input.exchangeTradeDate || null;
        if (input.local) {
            const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.local) ? `${input.local}:00` : input.local;
            const converted = Import.localToUtc(local, zone);
            if (converted.error) fail(converted.error);
            return {
                exchangeTradeDate,
                executedAtUtc: converted.instant || null,
                timeRange: converted.range ? { startUtc: converted.range[0], endUtc: converted.range[1] } : null,
                sourceTimeText: input.local, sourceTimezone: zone, orderEvidence: null,
            };
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) fail('请填写成交时刻或日期');
        const range = Import._internal.dayRange(input.date, zone, 0);
        if (range.error) fail(range.error);
        return {
            exchangeTradeDate, executedAtUtc: null,
            timeRange: { startUtc: range.range[0], endUtc: range.range[1] },
            sourceTimeText: input.date, sourceTimezone: zone, orderEvidence: null,
        };
    }

    // ------------------------------------------------------------------
    // Contracts
    // ------------------------------------------------------------------

    function ledgerIndex(graph) {
        const records = new Map();
        const bindings = new Map();
        for (const stored of (graph && graph.contracts) || []) {
            if (stored.supersededByRevision === null || stored.supersededByRevision === undefined) {
                records.set(stored.record.contractId, stored.record);
            }
        }
        for (const binding of (graph && graph.bindings) || []) {
            if (binding.supersededByRevision === null || binding.supersededByRevision === undefined) {
                bindings.set(binding.optionContractId, binding);
            }
        }
        return { records, bindings };
    }

    function rulesOf(book) {
        const rules = Import.PRODUCT_RULES[book.fop.productRules];
        if (!rules) fail(`不支持的产品规则 ${book.fop.productRules}`);
        return rules;
    }

    /**
     * A FUT the user names: a stored one by id, or new terms by delivery
     * month (YYYYMM) and local symbol, kept as manual_attested.
     */
    function futureContract(input, context) {
        const index = ledgerIndex(context.graph);
        if (input.contractId) {
            const record = index.records.get(input.contractId);
            if (!record || record.secType !== 'FUT') fail(`账本中没有期货合约 ${input.contractId}`);
            return { record, created: null };
        }
        const month = String(input.month || '').replace(/[^0-9]/g, '');
        if (!/^\d{6}$/.test(month)) fail('期货交割月必须是 YYYYMM（不是最后交易日）');
        const rules = rulesOf(context.book);
        const existing = [...index.records.values()].find((record) => record.secType === 'FUT'
            && record.futureContractMonth === month && (record.tradingClass || rules.futureClass) === rules.futureClass);
        if (existing) return { record: existing, created: null };
        const record = {
            contractId: null, revision: 1, secType: 'FUT', conId: null,
            root: rules.root, tradingClass: rules.futureClass, localSymbol: input.localSymbol || null,
            exchange: rules.exchange, currency: rules.currency, futureContractMonth: month,
            futureLastTradeDate: input.lastTradeDate || null, futureLastTradeAsOf: null,
            futurePointValue: rules.futurePointValue, ruleVersion: context.book.fop.productRules,
            evidenceStatus: 'manual_attested', evidenceSummary: `manual entry: delivery month ${month}`,
            observedAtUtc: context.observedAtUtc,
        };
        record.contractId = Import.contractIdFor(context.book, record);
        if (index.records.has(record.contractId)) record.contractId = `${record.contractId}-m${Date.now() % 100000}`;
        return { record, created: record };
    }

    /**
     * An option the user names: a stored one by id, or new terms with the FUT
     * it delivers (a stored FUT or new FUT terms); both manual_attested.
     */
    function optionContract(input, context) {
        const index = ledgerIndex(context.graph);
        if (input.contractId) {
            const record = index.records.get(input.contractId);
            if (!record || record.secType !== 'FOP') fail(`账本中没有期权合约 ${input.contractId}`);
            return { record, created: [], binding: null };
        }
        const rules = rulesOf(context.book);
        const right = String(input.right || '').toUpperCase();
        if (right !== 'C' && right !== 'P') fail('期权类型必须是 C 或 P');
        const strike = finiteNumber(input.strike, '行权价');
        if (strike <= 0) fail('零或负行权价的期权首版不支持（§1.2）');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiry || '')) fail('期权到期日必须是 YYYY-MM-DD');
        const tradingClass = String(input.tradingClass || '').trim().toUpperCase();
        if (!tradingClass) fail('请填写期权交易类（如 LO）');
        const existing = [...index.records.values()].find((record) => record.secType === 'FOP'
            && record.optionRight === right && Number(record.optionStrike) === strike
            && record.optionExpiry === input.expiry && record.tradingClass === tradingClass);
        if (existing) return { record: existing, created: [], binding: null };
        const future = futureContract(input.future || {}, context);
        const record = {
            contractId: null, revision: 1, secType: 'FOP', conId: null, root: rules.root, tradingClass,
            localSymbol: input.localSymbol || null, exchange: rules.exchange, currency: rules.currency,
            optionRight: right, optionStrike: strike, optionExpiry: input.expiry, optionExpiryAsOf: null,
            premiumMultiplier: rules.premiumMultiplier, deliverableFuturesPerOption: rules.deliverableFuturesPerOption,
            settlementType: rules.settlementType, exerciseStyle: rules.exerciseStyle,
            ruleVersion: context.book.fop.productRules, evidenceStatus: 'manual_attested',
            evidenceSummary: 'manual entry', observedAtUtc: context.observedAtUtc,
        };
        record.contractId = Import.contractIdFor(context.book, record);
        const binding = {
            bindingId: `bind-${record.contractId}`.slice(0, 64), revision: 1, optionContractId: record.contractId,
            futureContractId: future.record.contractId, status: 'manual_attested',
            evidenceSummary: `manual: delivers ${future.record.localSymbol || future.record.futureContractMonth}`,
            evidenceCredential: null, observedAtUtc: context.observedAtUtc,
        };
        return { record, created: future.created ? [future.created, record] : [record], binding };
    }

    // ------------------------------------------------------------------
    // Events and the AppendRequest
    // ------------------------------------------------------------------

    function common(kind, context, input) {
        return {
            kind, account: context.book.account, source: 'manual', externalRef: null, packageKey: 'pk-00001',
            note: String(input.note || '').trim(), time: timeFacts(input.time || {}, context.timeZone),
            sources: [], includeInCost: true,
        };
    }

    function ref(record) {
        return { contractId: record.contractId, revision: record.revision };
    }

    function packageOf(event, contracts, bindings, context) {
        return { version: PACKAGE_VERSION, engineVersion: context.book.fop.engineVersion,
            contracts: contracts || [], bindings: bindings || [], sourceRecords: [], events: [event] };
    }

    function futuresTrade(input, context) {
        const future = futureContract(input.contract || {}, context);
        const quantity = integer(input.quantity, '期货张数');
        const price = finiteNumber(input.price, '成交价');  // zero and negative FUT prices are real (§6.4)
        const fees = finiteNumber(input.fees || 0, '费用', { min: 0 });
        const event = Object.assign(common('futures_trade', context, input), {
            contractRef: ref(future.record), futureContracts: quantity, price, cashAmount: -fees, fees,
            openClose: input.openClose || null,
        });
        return packageOf(event, future.created ? [future.created] : [], [], context);
    }

    function optionTrade(input, context) {
        const option = optionContract(input.contract || {}, context);
        const quantity = integer(input.quantity, '期权张数');
        const price = finiteNumber(input.price, '权利金价格', { min: 0 });
        const fees = finiteNumber(input.fees || 0, '费用', { min: 0 });
        const event = Object.assign(common('option_trade', context, input), {
            contractRef: ref(option.record), contracts: quantity, price,
            cashAmount: -quantity * option.record.premiumMultiplier * price - fees, fees,
            openClose: input.openClose || null,
        });
        return packageOf(event, option.created, option.binding ? [option.binding] : [], context);
    }

    /**
     * An assignment of a short or an exercise of a long (plan §6.1): the
     * option's binding names the FUT; each contract delivers one FUT at the
     * strike, in the direction the right and side fix.
     */
    function delivery(input, context) {
        const index = ledgerIndex(context.graph);
        const option = index.records.get(input.optionContractId);
        if (!option || option.secType !== 'FOP') fail('请选择账本中的期权');
        const binding = index.bindings.get(option.contractId);
        if (!binding || !binding.futureContractId || binding.status === 'unresolved' || binding.status === 'conflict') {
            fail('这张期权的对应期货尚未确定：先由券商、报表或人工核实补全绑定（§4.3）');
        }
        const future = index.records.get(binding.futureContractId);
        const count = Math.abs(integer(input.contracts, '交割张数'));
        const fees = finiteNumber(input.fees || 0, '费用', { min: 0 });
        const assignment = input.kind === 'assignment';
        if (!assignment && input.kind !== 'exercise') fail('交割种类必须是被指派或行权');
        const perContract = option.deliverableFuturesPerOption || 1;
        // Short call assigned: -FUT; short put assigned: +FUT; long call
        // exercised: +FUT; long put exercised: -FUT (§6.1).
        const direction = option.optionRight === 'C' ? (assignment ? -1 : 1) : (assignment ? 1 : -1);
        const event = Object.assign(common(assignment ? 'option_assignment' : 'option_exercise', context, input), {
            contractRef: ref(option), deliveredContractRef: ref(future),
            bindingRef: { bindingId: binding.bindingId, revision: binding.revision },
            contracts: assignment ? count : -count, futureContracts: direction * count * perContract,
            price: option.optionStrike, cashAmount: -fees, fees,
        });
        return packageOf(event, [], [], context);
    }

    function expiry(input, context) {
        const index = ledgerIndex(context.graph);
        const option = index.records.get(input.optionContractId);
        if (!option || option.secType !== 'FOP') fail('请选择账本中的期权');
        const closing = integer(input.contracts, '到期张数');
        const fees = finiteNumber(input.fees || 0, '费用', { min: 0 });
        const event = Object.assign(common('option_expiry', context, input), {
            contractRef: ref(option), contracts: closing, cashAmount: -fees, fees,
        });
        return packageOf(event, [], [], context);
    }

    function fee(input, context) {
        const amount = finiteNumber(input.amount, '费用金额', { min: 0 });
        if (amount === 0) fail('费用金额不能为零');
        const categories = ['futures', 'short_option', 'long_option', 'strategy'];
        if (!categories.includes(input.category)) fail('请选择费用归属');
        const event = Object.assign(common('fee', context, input), {
            feeSource: input.feeSourceEventId ? { eventId: input.feeSourceEventId, packageKey: null } : null,
            feeCategory: input.category, feeIsRefund: Boolean(input.refund),
            cashAmount: input.refund ? amount : -amount, fees: 0,
        });
        return packageOf(event, [], [], context);
    }

    /** request: {requestId, clientToken, expectedLedgerVersion, bookIdentity}. */
    function appendRequest(fopPackage, context, request) {
        return {
            requestId: request.requestId, bookId: context.book.bookId,
            expectedLedgerVersion: request.expectedLedgerVersion, bookIdentity: request.bookIdentity,
            action: 'append_cost_basis_event', clientToken: request.clientToken, fopPackage,
        };
    }

    function voidRequest(eventId, reason, context, request) {
        if (!String(reason || '').trim()) fail('冲销必须写明原因');
        return {
            requestId: request.requestId, bookId: context.book.bookId,
            expectedLedgerVersion: request.expectedLedgerVersion, bookIdentity: request.bookIdentity,
            engineVersion: context.book.fop.engineVersion, action: 'void_cost_basis_event', eventId,
            reason: String(reason).trim(), clientToken: request.clientToken,
        };
    }

    function metadataRequest(operation, context, request) {
        return {
            requestId: request.requestId, bookId: context.book.bookId,
            expectedLedgerVersion: request.expectedLedgerVersion, bookIdentity: request.bookIdentity,
            engineVersion: context.book.fop.engineVersion, action: 'commit_cost_basis_fop_metadata',
            clientToken: request.clientToken, operation,
        };
    }

    /**
     * Where a cycle may end (plan §1.3): after an event (or its whole
     * simultaneous group) that leaves every FUT and FOP flat, in the
     * current cycle. The core's trace says what is open after each step.
     */
    function cycleAnchors(graph) {
        const trace = Core.computeLedger(graph, { trace: true, rolls: false });
        const lastOfGroup = new Map();
        for (const group of trace.groups) for (const id of group) lastOfGroup.set(id, group[group.length - 1]);
        const closed = new Set(((graph && graph.cycles) || []).filter((cycle) => cycle.state === 'closed'
            && (cycle.supersededByRevision === null || cycle.supersededByRevision === undefined))
            .map((cycle) => cycle.anchorEventId));
        // A boundary sits on the event that leaves everything flat: one that
        // moves a position, never a fee or an adjustment after it.
        const moves = new Set(((graph && graph.events) || []).filter((stored) => !stored.row.voidedAtUtc
            && POSITION_KINDS.has(stored.row.kind)).map((stored) => stored.row.eventId));
        const anchors = [];
        for (const step of trace.steps) {
            if (closed.has(step.after)) {
                anchors.length = 0;
                continue;
            }
            const last = lastOfGroup.get(step.after) || step.after;
            if (last !== step.after || !moves.has(step.after)) continue;
            if (Object.keys(step.positions || {}).length === 0) anchors.push(step.after);
        }
        return anchors;
    }

    // ------------------------------------------------------------------
    // Manual entries: preview before the confirmation (plan §19 P5-C5)
    // ------------------------------------------------------------------

    /** A copy of the ledger graph with one package added as the server would store it; nothing is sent. */
    function previewPackage(graph, fopPackage) {
        const copy = JSON.parse(JSON.stringify(graph));
        const known = new Set((copy.contracts || []).map((item) => `${item.record.contractId}#${item.record.revision}`));
        for (const record of fopPackage.contracts) {
            if (!known.has(`${record.contractId}#${record.revision}`)) {
                copy.contracts.push({ record: Object.assign({}, record), supersededByRevision: null });
            }
        }
        for (const record of fopPackage.bindings) {
            for (const stored of copy.bindings) {
                if (stored.bindingId === record.bindingId && stored.supersededByRevision === null) {
                    stored.supersededByRevision = record.revision;
                }
            }
            copy.bindings.push(Object.assign({}, record, { supersededByRevision: null }));
        }
        const keys = new Map();
        fopPackage.events.forEach((event, index) => {
            const eventId = `preview-manual-${String(index + 1).padStart(3, '0')}`;
            if (event.packageKey) keys.set(event.packageKey, eventId);
            const source = event.feeSource || null;
            copy.events.push({
                row: {
                    eventId, seq: copy.events.length + 1, kind: event.kind, account: event.account,
                    contracts: event.contracts === undefined ? null : event.contracts,
                    futureContracts: event.futureContracts === undefined ? null : event.futureContracts,
                    price: event.price === undefined ? null : event.price, cashAmount: event.cashAmount,
                    fees: event.fees === undefined ? 0 : event.fees, includeInCost: true, source: event.source,
                    externalRef: event.externalRef, note: event.note, voidedAtUtc: null,
                    fop: {
                        contractRef: event.contractRef || null, deliveredContractRef: event.deliveredContractRef || null,
                        bindingRef: event.bindingRef || null, openClose: event.openClose || null,
                        feeCategory: event.feeCategory || null, feeIsRefund: Boolean(event.feeIsRefund),
                        feeSourceEventId: source ? (source.eventId || keys.get(source.packageKey) || null) : null,
                        adjustmentScope: event.adjustmentScope || null, baselineKind: null, baselineAsOfUtc: null,
                        time: event.time,
                    },
                },
                primarySourceId: null,
            });
        });
        return copy;
    }

    /**
     * What one manual package would do, replayed in memory (plan §19 P5-C5):
     * every contract it touches before and after, its cash and fees, and the
     * totals before and after at the same marks. It stops where the server
     * would refuse the replay (a close with nothing open, an order no
     * evidence fixes); the server still checks everything on confirmation.
     */
    function manualPreview(graph, fopPackage, marks) {
        const copy = previewPackage(graph, fopPackage);
        const trace = Core.computeLedger(copy, { trace: true, rolls: false, marks: marks || {} });
        const records = ledgerIndex(copy).records;
        const name = (id) => (records.has(id) ? records.get(id).localSymbol || id : id);
        if (trace.problems.length) {
            const first = trace.problems[0];
            return { stopped: true, reason: first.code === 'overdraw'
                ? `平仓超过当时持仓（${first.contracts.map(name).join('、')}）：先补记更早的成交`
                : `同一时刻的成交顺序未知且影响结果（${(first.contracts || []).map(name).join('、')}）` };
        }
        const before = Core.computeLedger(graph, { rolls: false, marks: marks || {} });
        const after = trace.output;
        const quantities = (output) => {
            const map = new Map();
            for (const row of output.futures) map.set(row.contractId, row.contracts.value);
            for (const row of output.options) map.set(row.contractId, row.contracts.value);
            return map;
        };
        const was = quantities(before);
        const now = quantities(after);
        const touched = new Set();
        for (const event of fopPackage.events) {
            if (event.contractRef) touched.add(event.contractRef.contractId);
            if (event.deliveredContractRef) touched.add(event.deliveredContractRef.contractId);
        }
        const rows = [...touched].map((id) => ({ contractId: id, localSymbol: name(id),
            before: was.has(id) ? was.get(id) : 0, after: now.has(id) ? now.get(id) : 0 }));
        const events = fopPackage.events.map((event) => ({
            kind: event.kind, contract: event.contractRef ? name(event.contractRef.contractId) : '—',
            delivered: event.deliveredContractRef ? name(event.deliveredContractRef.contractId) : null,
            quantity: event.kind === 'futures_trade' ? event.futureContracts
                : (event.contracts === undefined || event.contracts === null ? event.futureContracts : event.contracts),
            futureContracts: event.futureContracts === undefined ? null : event.futureContracts,
            price: event.price === undefined ? null : event.price, fees: event.fees || 0, cash: event.cashAmount,
            time: event.time,
        }));
        return { stopped: false, reason: null, before, after, rows, events,
            created: fopPackage.contracts.map((record) => record.localSymbol || record.contractId) };
    }

    // ------------------------------------------------------------------
    // Binding evidence from the broker (plan §4.3, §19 P5-C2)
    // ------------------------------------------------------------------

    // Terms a revision may fill in when the ledger does not know them (the
    // server's SUPPLEMENTABLE_TERMS); any other difference is an economic
    // correction, which an adoption never makes.
    const SUPPLEMENTABLE = new Set(['conId', 'tradingClass', 'localSymbol', 'futureLastTradeDate',
        'futureLastTradeAsOf', 'optionExpiryAsOf']);
    const NON_TERMS = new Set(['contractId', 'revision', 'evidenceStatus', 'evidenceSummary', 'observedAtUtc']);
    const BINDING_STATUS = Object.freeze({ verified_broker: '券商验证', verified_statement: '报表验证',
        manual_attested: '人工核实', unresolved: '待补全', conflict: '冲突' });

    function known(value) {
        return value !== null && value !== undefined;
    }

    function sameTerm(a, b) {
        if (!known(a) || !known(b)) return !known(a) && !known(b);
        return typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : a === b;
    }

    /** The structural identity of a FUT (the server's contract_identity_key). */
    function futureIdentity(record) {
        return ['FUT', record.root, record.exchange, record.currency, record.tradingClass || '',
            record.futureContractMonth].join('|');
    }

    /**
     * A stored record against the terms the broker proved: {record: null}
     * when they already agree, {record: its next revision} filling in what
     * was unknown, or {problem} naming a known term that differs.
     */
    function proved(stored, candidate) {
        const fields = Object.keys(candidate).filter((field) => !NON_TERMS.has(field));
        const differing = fields.filter((field) => !sameTerm(stored[field], candidate[field]));
        if (!differing.length) return { record: null, filled: [] };
        const fixed = differing.filter((field) => !SUPPLEMENTABLE.has(field) || known(stored[field]));
        if (fixed.length) {
            return { problem: fixed.map((field) => `${field}（账本 ${known(stored[field]) ? stored[field] : '空'}，`
                + `券商 ${known(candidate[field]) ? candidate[field] : '空'}）`).join('、') };
        }
        const record = Object.assign({}, stored, {
            revision: stored.revision + 1, evidenceStatus: 'verified_broker',
            evidenceSummary: candidate.evidenceSummary, observedAtUtc: candidate.observedAtUtc,
        });
        for (const field of differing) record[field] = candidate[field];
        return { record, filled: differing };
    }

    /**
     * The adoption a verified broker answer allows (plan §19 P5-C2), in
     * memory: the metadata operation to send and what it changes. result is
     * one ContractDetailsResult for an option of the ledger. The option and
     * its future become exactly what the broker proved (the server checks the
     * credential against them): a record's next revision fills in unknown
     * terms, and a future the ledger lacks is added. It stops, proposing
     * nothing, when the broker proved nothing, when a known term differs, or
     * when deliveries already rest on another future (an economic
     * correction). Returns {stopped, reason} or {stopped: false, operation,
     * changes, affected}; changes are the lines the page lists before the
     * user confirms.
     */
    function bindingAdoption(graph, book, result) {
        const stop = (reason) => ({ stopped: true, reason });
        if (!result || result.status !== 'verified_broker' || !result.evidenceCredential || !result.future) {
            const Messages = globalScope.OptionComboCostBasisFopMessages;
            const why = result && result.problems && result.problems.length
                ? result.problems.map((text) => (Messages ? Messages.brokerProblem(text) : text)).join('；') : '没有证据';
            return stop(`券商没有证明对应期货（${result ? result.status : '无回复'}：${why}）。`
                + '不猜交割月，也不自动选主力合约。');
        }
        const index = ledgerIndex(graph);
        const option = index.records.get(result.contractId);
        if (!option || option.secType !== 'FOP') return stop(`${result.contractId} 不是账本中的期权`);
        const name = option.localSymbol || option.contractId;
        const binding = index.bindings.get(option.contractId);
        if (!binding) return stop(`${name} 没有绑定记录：首个绑定随记账包写入`);
        const optionStep = proved(option, result.option);
        if (optionStep.problem) {
            return stop(`${name} 的条款与券商不同：${optionStep.problem}。这需要经济更正（重建），不能采纳`);
        }
        const candidate = result.future;
        const stored = [...index.records.values()].find((record) => record.secType === 'FUT'
            && (futureIdentity(record) === futureIdentity(candidate)
                || (known(record.conId) && record.conId === candidate.conId)));
        let futureStep = { record: null, filled: [] };
        let added = null;
        if (stored) {
            futureStep = proved(stored, candidate);
            if (futureStep.problem) {
                return stop(`账本中的 ${stored.localSymbol || stored.contractId} 与券商条款不同：${futureStep.problem}`);
            }
        } else {
            added = Object.assign({}, candidate, { revision: 1 });
            added.contractId = Import.contractIdFor(book, added);
            if ((graph.contracts || []).some((item) => item.record.contractId === added.contractId)) {
                added.contractId = `${added.contractId}-b${binding.revision + 1}`;
            }
        }
        const futureId = stored ? stored.contractId : added.contractId;
        const live = (graph.events || []).filter((item) => !item.row.voidedAtUtc).map((item) => item.row);
        const deliveries = live.filter((row) => row.fop.bindingRef && row.fop.bindingRef.bindingId === binding.bindingId
            && row.fop.bindingRef.revision === binding.revision);
        if (deliveries.length && binding.futureContractId && binding.futureContractId !== futureId) {
            return stop(`${deliveries.length} 笔交割已记在 ${binding.futureContractId} 上；改到另一期货会移动已实现盈亏，`
                + '属于经济更正（重建），不能用采纳绑定完成');
        }
        const affected = [];
        for (const revised of [optionStep.record, futureStep.record].filter(Boolean)) {
            const before = { id: revised.contractId, revision: revised.revision - 1 };
            const after = { id: revised.contractId, revision: revised.revision };
            for (const row of live) {
                const ref = row.fop.contractRef;
                const delivered = row.fop.deliveredContractRef;
                if (ref && ref.contractId === before.id && ref.revision === before.revision) {
                    affected.push({ eventId: row.eventId, reference: 'contract', before, after });
                }
                if (delivered && delivered.contractId === before.id && delivered.revision === before.revision) {
                    affected.push({ eventId: row.eventId, reference: 'delivered_contract', before, after });
                }
            }
        }
        const record = {
            bindingId: binding.bindingId, revision: binding.revision + 1, optionContractId: option.contractId,
            futureContractId: futureId, status: 'verified_broker', evidenceSummary: result.evidenceSummary,
            evidenceCredential: result.evidenceCredential, observedAtUtc: candidate.observedAtUtc,
        };
        for (const row of deliveries) {
            affected.push({ eventId: row.eventId, reference: 'binding',
                before: { id: binding.bindingId, revision: binding.revision },
                after: { id: binding.bindingId, revision: record.revision } });
        }
        const contracts = [optionStep.record, futureStep.record, added].filter(Boolean);
        const operation = { kind: 'adopt_binding', binding: record, affected };
        if (contracts.length) operation.contracts = contracts;
        const futureName = candidate.localSymbol || `${candidate.root} ${candidate.futureContractMonth}`;
        const changes = [
            ['绑定', `${name} → ${futureName}（交割月 ${candidate.futureContractMonth}）：`
                + `${BINDING_STATUS[binding.status] || binding.status} → 券商验证（修订 ${binding.revision} → ${record.revision}）`],
            ['证据', result.evidenceSummary],
        ];
        if (optionStep.record) {
            changes.push(['期权条款', `补全 ${optionStep.filled.join('、')}（修订 ${option.revision} → ${optionStep.record.revision}）`]);
        }
        if (futureStep.record) {
            changes.push(['期货条款', `补全 ${futureStep.filled.join('、')}（修订 ${stored.revision} → ${futureStep.record.revision}）`]);
        }
        if (added) {
            changes.push(['新增期货', `${futureName}，交割月 ${candidate.futureContractMonth}，最后交易日 `
                + `${candidate.futureLastTradeDate || '未知'}（券商验证）`]);
        }
        return { stopped: false, reason: null, operation, changes, affected };
    }

    // ------------------------------------------------------------------
    // Delivery preview (plan §12.1): in memory only
    // ------------------------------------------------------------------

    /**
     * One in-memory settlement of an open option (plan §6.1), shared by the
     * delivery preview and the stress scenarios: an expiry, or a delivery
     * onto the FUT its binding names at the strike. quantity is the open
     * signed count, count how many settle; cash and fees are 0.
     */
    function settlementEvent(option, action, count, quantity, binding, future) {
        const side = quantity < 0 ? -1 : 1;
        if (action === 'expire') {
            return { kind: 'option_expiry', contractRef: ref(option), contracts: -side * count, cashAmount: 0, fees: 0,
                option };
        }
        const assignment = action === 'assign';
        const direction = option.optionRight === 'C' ? (assignment ? -1 : 1) : (assignment ? 1 : -1);
        return { kind: assignment ? 'option_assignment' : 'option_exercise', contractRef: ref(option),
            deliveredContractRef: ref(future), bindingRef: { bindingId: binding.bindingId, revision: binding.revision },
            contracts: assignment ? count : -count,
            futureContracts: direction * count * (option.deliverableFuturesPerOption || 1),
            price: option.optionStrike, cashAmount: 0, fees: 0, option };
    }

    /**
     * A copy of the graph with settlements appended as in-memory rows:
     * items [{event (settlementEvent), at (UtcInstant), orderEvidence?}].
     * Nothing is stored; the rows exist only in the returned copy.
     */
    function withSettlements(graph, account, items, { idPrefix = 'preview-delivery', note = '假设交割（仅预览）' } = {}) {
        const copy = JSON.parse(JSON.stringify(graph));
        items.forEach(({ event, at, orderEvidence }, position) => {
            const eventId = `${idPrefix}-${String(position + 1).padStart(3, '0')}`;
            copy.events.push({
                row: {
                    eventId, seq: copy.events.length + 1, kind: event.kind, account,
                    contracts: event.contracts, futureContracts: event.futureContracts === undefined ? null : event.futureContracts,
                    price: event.price === undefined ? null : event.price, cashAmount: 0, fees: 0, includeInCost: true,
                    source: 'manual', externalRef: null, note, voidedAtUtc: null,
                    fop: { contractRef: event.contractRef, deliveredContractRef: event.deliveredContractRef || null,
                        bindingRef: event.bindingRef || null, openClose: null, feeCategory: null, feeIsRefund: false,
                        feeSourceEventId: null, adjustmentScope: null, baselineKind: null, baselineAsOfUtc: null,
                        time: { exchangeTradeDate: null, executedAtUtc: at, timeRange: null,
                            sourceTimeText: null, sourceTimezone: null, orderEvidence: orderEvidence || null } },
                },
                primarySourceId: null,
            });
        });
        return copy;
    }

    /** The exchange date of an instant: last trade dates and expiries are exchange dates. */
    function exchangeDay(book, at) {
        const rules = Import.PRODUCT_RULES[book.fop.productRules];
        return Import.localDay({ executedAtUtc: at }, rules ? rules.exchangeTimeZone : 'Etc/UTC');
    }

    /**
     * choices: [{optionContractId, action: 'assign'|'exercise'|'expire',
     * contracts}] for open options, each at most once; contracts is how many
     * of the open ones (all of them when left out). prices: {futureContractId:
     * price} assumed per real FUT; at: the UtcInstant of the assumed
     * deliveries. Returns {stopped, reason, before, after, rows} where
     * before/after are core outputs valued at the same assumed prices.
     *
     * The path stops (§12.1) when a FUT it holds or delivers is past its last
     * trade date at that instant, or an option it leaves open is past its
     * expiry: the first release neither rolls, settles nor expires anything
     * by itself.
     */
    function deliveryPreview(graph, book, choices, prices, at) {
        const stop = (reason) => ({ stopped: true, reason });
        const index = ledgerIndex(graph);
        // An assumed delivery comes after everything the ledger holds: it is
        // a future path, never a rewrite of recorded history.
        const latest = (graph.events || []).filter((stored) => !stored.row.voidedAtUtc).map((stored) => {
            const time = stored.row.fop.time;
            return time.executedAtUtc || (time.timeRange ? time.timeRange.endUtc : '');
        }).sort().pop() || '';
        if (!at || at <= latest) return stop(`假设交割时刻必须晚于账本最后一笔事件（${latest || '—'}）`);
        const day = exchangeDay(book, at);
        const before = Core.computeLedger(graph, { marks: prices, rolls: false });
        const openOptions = new Map(before.options.map((row) => [row.contractId, row]));
        const events = [];
        const chosen = new Set();
        const delivered = new Set();
        for (const choice of choices || []) {
            const row = openOptions.get(choice.optionContractId);
            if (!row || row.contracts.value === null) {
                return stop(`${choice.optionContractId} 不是持仓数量已知的未平期权`);
            }
            const option = index.records.get(choice.optionContractId);
            const name = option.localSymbol || option.contractId;
            if (chosen.has(option.contractId)) return stop(`${name}：同一期权只能选择一次`);
            chosen.add(option.contractId);
            const quantity = row.contracts.value;
            const open = Math.abs(quantity);
            const count = choice.contracts === undefined || choice.contracts === null ? open : choice.contracts;
            if (!Number.isInteger(count) || count < 1 || count > open) {
                return stop(`${name}：交割张数必须是 1 到 ${open} 之间的整数`);
            }
            if (choice.action === 'expire') {
                events.push(settlementEvent(option, 'expire', count, quantity, null, null));
                continue;
            }
            const assignment = choice.action === 'assign';
            if (assignment !== quantity < 0) {
                return stop(`${name}：${assignment ? '只有空头会被指派' : '只有多头可以行权'}`);
            }
            const binding = index.bindings.get(option.contractId);
            if (!binding || !binding.futureContractId || binding.status === 'unresolved'
                || binding.status === 'conflict') {
                return stop(`${name} 的对应期货未确定，不能预览交割`);
            }
            const future = index.records.get(binding.futureContractId);
            delivered.add(future.contractId);
            events.push(settlementEvent(option, choice.action, count, quantity, binding, future));
        }
        if (!events.length) return stop('请至少选择一张期权');
        // Every FUT on the path: the ones held until then and the ones the
        // deliveries move. Any of them past its last trade date stops it.
        for (const id of new Set([...before.futures.map((row) => row.contractId), ...delivered])) {
            const future = index.records.get(id);
            if (future && future.futureLastTradeDate && day > future.futureLastTradeDate) {
                return stop(`${future.localSymbol || future.contractId} 在 ${future.futureLastTradeDate}`
                    + ' 已最后交易：跨过期货最后交易日的路径首版停止，不自动滚仓或实物结算（§12.1）');
            }
        }
        const copy = withSettlements(graph, book.account, events.map((event) => ({ event, at })));
        const after = Core.computeLedger(copy, { marks: prices, rolls: false });
        // An option still open past its expiry would already have expired or
        // been delivered: the path needs a choice for it.
        for (const row of after.options) {
            if (row.contracts.value !== 0 && row.expiry && day > row.expiry) {
                const record = index.records.get(row.contractId);
                return stop(`${(record && record.localSymbol) || row.contractId} 已于 ${row.expiry} 到期：`
                    + '请为它选择到期结果，或把假设交割时刻放在到期之前（§12.1）');
            }
        }
        const quantities = (output) => {
            const map = new Map();
            for (const row of output.futures) map.set(row.contractId, row.contracts.value);
            for (const row of output.options) map.set(row.contractId, row.contracts.value);
            return map;
        };
        const was = quantities(before);
        const now = quantities(after);
        const ids = [...new Set([...was.keys(), ...now.keys()])];
        const rows = ids.map((id) => ({
            contractId: id, localSymbol: index.records.has(id) ? (index.records.get(id).localSymbol || id) : id,
            before: was.has(id) ? was.get(id) : 0, after: now.has(id) ? now.get(id) : 0,
        })).filter((row) => row.before !== row.after || row.before);
        return { stopped: false, reason: null, before, after, rows, label: '假设交割：仅在内存中演算，不写入账本' };
    }

    /** Which way each open option would go at expiry, at an assumed price of its FUT. */
    function atExpiry(output, graph, prices) {
        const index = ledgerIndex(graph);
        return output.options.filter((row) => row.contracts.value).map((row) => {
            const binding = index.bindings.get(row.contractId);
            const future = binding ? binding.futureContractId : null;
            const price = future !== null && Object.prototype.hasOwnProperty.call(prices || {}, future)
                ? prices[future] : null;
            if (price === null || price === undefined) return { optionContractId: row.contractId, action: null };
            const inTheMoney = row.right === 'C' ? price > row.strike : price < row.strike;
            if (!inTheMoney) return { optionContractId: row.contractId, action: 'expire' };
            return { optionContractId: row.contractId, action: row.contracts.value < 0 ? 'assign' : 'exercise' };
        });
    }

    globalScope.OptionComboCostBasisFopForms = Object.freeze({
        FormError,
        timeFacts,
        futureContract,
        optionContract,
        futuresTrade,
        optionTrade,
        delivery,
        expiry,
        fee,
        appendRequest,
        voidRequest,
        metadataRequest,
        cycleAnchors,
        previewPackage,
        manualPreview,
        bindingAdoption,
        settlementEvent,
        withSettlements,
        deliveryPreview,
        atExpiry,
    });
})(typeof window !== 'undefined' ? window : globalThis);
