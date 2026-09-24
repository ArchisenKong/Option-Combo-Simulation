// Builds FOP ledger graphs (BackupPayloadV2 shape) from the compact vectors of
// tests/fixtures/cost_basis_fop/core_vectors.json, for js/cost_basis_fop_core.js.
//
// The graph is what export_cost_basis_backup returns for a FOP ledger, so the
// core replays the same shape in these tests as on the page. The Python chain
// test (tests/cost_basis_fop_core_test.py) writes the same vectors through the
// real store and replays the exported graph, which checks this builder against
// the server. CLI: `node tests/helpers/cost_basis_fop_vectors.js` reads one JSON
// request per line ({vector, catalogue, options} or {graph, options}) and prints
// {result} or {error} per line; the Python tests drive the core through it.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const STAMP = '2026-10-01T00:00:00Z';
const OBSERVED = '2026-10-01T00:00:00.000000Z';
const ACCOUNT = 'U1111111';

function instant(text) {
    if (!text.endsWith('Z')) throw new Error(`${text}: a vector time ends with Z`);
    const body = text.slice(0, -1);
    const [head, fraction = ''] = body.split('.');
    return `${head}.${fraction.padEnd(6, '0')}Z`;
}

function contractRecord(spec) {
    const common = {
        contractId: spec.contractId, revision: 1, conId: spec.conId ?? null, root: 'CL',
        localSymbol: spec.localSymbol ?? null, exchange: 'NYMEX', currency: 'USD',
        ruleVersion: 'NYMEX-CL-v1', evidenceStatus: 'verified_broker', evidenceSummary: '',
        observedAtUtc: OBSERVED,
    };
    if (spec.secType === 'FUT') {
        return { ...common, secType: 'FUT', tradingClass: 'CL', futureContractMonth: spec.month,
            futureLastTradeDate: spec.lastTrade ?? null, futureLastTradeAsOf: null,
            futurePointValue: spec.pointValue ?? 1000 };
    }
    return { ...common, secType: 'FOP', tradingClass: 'LO', optionRight: spec.right,
        optionStrike: spec.strike, optionExpiry: spec.expiry, optionExpiryAsOf: null,
        premiumMultiplier: spec.multiplier ?? 1000, deliverableFuturesPerOption: spec.deliverable ?? 1,
        settlementType: 'physical_future', exerciseStyle: 'american' };
}

function deliveredQuantity(spec, event) {
    if (event.fq !== undefined) return event.fq;
    const perOption = spec.deliverable ?? 1;
    const sign = event.q > 0 ? (spec.right === 'C' ? -1 : 1) : (spec.right === 'C' ? 1 : -1);
    return sign * Math.abs(event.q) * perOption;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/** A vector event id as a protocol Token (8-64 characters); readable ids stay as they are. */
function tokenOf(id) {
    return TOKEN.test(id) ? id : `${id}-evt-0000`;
}

function sourceIdOf(src) {
    return `src-${src.ns}-${src.ref}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}

/** The ledger graph of one vector; aliases resolve through the catalogue. */
function buildGraph(vector, catalogue) {
    const specs = { ...catalogue, ...(vector.contracts || {}) };
    const bookId = 'vectorbook0001';
    const used = new Set();
    for (const event of vector.events) {
        if (!event.contract) continue;
        used.add(event.contract);
        if (specs[event.contract].secType === 'FOP') used.add(specs[event.contract].future);
    }
    const aliases = [...used].sort();
    const idOf = (alias) => specs[alias].contractId;
    const contracts = aliases.map((alias) => ({ record: contractRecord(specs[alias]),
        supersededByRevision: null, createdAtUtc: STAMP }));
    const bindings = aliases.filter((alias) => specs[alias].secType === 'FOP').map((alias) => {
        const status = (vector.bindings || {})[alias] || 'manual_attested';
        return {
            bindingId: `bind-${idOf(alias)}`.slice(0, 64), revision: 1, optionContractId: idOf(alias),
            futureContractId: idOf(specs[alias].future), status, evidenceSummary: '',
            evidenceDigest: status.startsWith('verified') ? '0'.repeat(64) : null,
            observedAtUtc: OBSERVED, supersededByRevision: null, createdAtUtc: STAMP,
        };
    });
    const bindingOf = new Map(bindings.map((binding) => [binding.optionContractId, binding]));
    const sources = new Map();
    const allocations = [];
    const events = vector.events.map((event, index) => {
        const spec = event.contract ? specs[event.contract] : null;
        const fees = event.fees ?? 0;
        const time = {
            exchangeTradeDate: null,
            executedAtUtc: event.at && !event.range ? instant(event.at) : null,
            timeRange: event.range ? { startUtc: instant(event.range[0]), endUtc: instant(event.range[1]) } : null,
            sourceTimeText: null, sourceTimezone: null, orderEvidence: event.evidence ?? null,
        };
        const start = time.executedAtUtc || time.timeRange.startUtc;
        const row = {
            eventId: tokenOf(event.id), seq: index + 1, kind: event.kind, tradeDate: start.slice(0, 10),
            brokerTimestamp: null, account: ACCOUNT, contracts: null, futureContracts: null, price: null,
            cashAmount: -fees, fees, includeInCost: event.includeInCost ?? true,
            source: event.src ? 'execution_report' : 'manual', externalRef: event.src ? event.src.ref : null,
            note: '', voidedAtUtc: event.void ? STAMP : null,
            fop: {
                contractRef: spec ? { contractId: spec.contractId, revision: 1 } : null,
                deliveredContractRef: null, bindingRef: null, openClose: event.openClose ?? null,
                feeCategory: null, feeIsRefund: false, feeSourceEventId: null, adjustmentScope: null,
                baselineKind: null, baselineAsOfUtc: null, time,
            },
            display: { localSymbol: spec ? spec.localSymbol : null, contractMonth: null, right: null,
                strike: null, expiry: null, deliveredLocalSymbol: null, deliveredContractMonth: null },
        };
        switch (event.kind) {
        case 'futures_trade':
            row.futureContracts = event.q;
            row.price = event.price;
            break;
        case 'option_trade':
            row.contracts = event.q;
            row.price = event.price;
            row.cashAmount = event.cash ?? (-event.q * (spec.multiplier ?? 1000) * event.price - fees);
            break;
        case 'option_expiry':
            row.contracts = event.q;
            break;
        case 'option_assignment':
        case 'option_exercise': {
            row.contracts = event.q;
            row.futureContracts = deliveredQuantity(spec, event);
            row.price = spec.strike;
            const future = specs[spec.future];
            row.fop.deliveredContractRef = { contractId: future.contractId, revision: 1 };
            const binding = bindingOf.get(spec.contractId);
            row.fop.bindingRef = { bindingId: binding.bindingId, revision: 1 };
            break;
        }
        case 'opening_balance':
            if (spec.secType === 'FUT') row.futureContracts = event.q;
            else row.contracts = event.q;
            row.price = event.price ?? null;
            row.cashAmount = 0;
            row.fop.baselineKind = event.baseline;
            row.fop.baselineAsOfUtc = instant(event.baselineAsOf);
            break;
        case 'fee':
            row.cashAmount = event.cash;
            row.fees = 0;
            row.fop.feeCategory = event.category;
            row.fop.feeIsRefund = Boolean(event.refund);
            row.fop.feeSourceEventId = event.feeSource ? tokenOf(event.feeSource) : null;
            break;
        case 'manual_adjust':
            row.cashAmount = event.cash;
            row.fees = 0;
            row.fop.adjustmentScope = event.scope;
            break;
        default:
            throw new Error(`unknown kind ${event.kind}`);
        }
        let primarySourceId = null;
        if (event.src) {
            primarySourceId = sourceIdOf(event.src);
            if (!sources.has(primarySourceId)) {
                const stated = event.src.stated || [Math.abs(row.futureContracts ?? row.contracts), fees];
                sources.set(primarySourceId, {
                    sourceId: primarySourceId, account: ACCOUNT, namespace: event.src.ns, sourceRef: event.src.ref,
                    capabilityKey: null, format: 'tws_execution', section: null,
                    rawFields: { execId: event.src.ref }, statedQuantity: stated[0], statedFees: stated[1],
                    importBatchId: null, createdAtUtc: STAMP,
                });
            }
            allocations.push({ sourceId: primarySourceId, eventId: tokenOf(event.id), role: 'trade',
                quantity: Math.abs(row.futureContracts ?? row.contracts), fees, createdAtUtc: STAMP });
        }
        return { row, clientToken: `tok-${tokenOf(event.id)}`.slice(0, 64), createdAtUtc: STAMP,
            voidedByEventId: event.void ? `void-${tokenOf(event.id)}`.slice(0, 64) : null,
            voidReason: event.void ? 'entered in error' : null, primarySourceId };
    });
    const cycles = (vector.boundaries || []).map((boundary) => ({
        boundaryId: boundary.id, revision: 1, state: 'closed', anchorEventId: tokenOf(boundary.anchor), label: '',
        supersededByRevision: null, createdAtUtc: STAMP,
    }));
    return {
        book: { bookId, account: ACCOUNT, symbol: 'CL', secType: 'FUT', currency: 'USD',
            defaultSharesPerContract: null, startDate: '2026-01-01', note: '', createdAtUtc: STAMP,
            updatedAtUtc: STAMP, archivedAtUtc: null },
        fopBook: { engineVersion: 1, productRules: 'NYMEX-CL-v1',
            historyScope: vector.historyScope || 'full_history', createdAtUtc: STAMP, updatedAtUtc: STAMP },
        contracts, bindings, events, cycles, sources: [...sources.values()], allocations,
        operations: [], referenceRevisions: [], eventIdMappings: [], requests: [],
    };
}

/** Marks by contract id from marks by alias. */
function marksOf(vector, catalogue) {
    const specs = { ...catalogue, ...(vector.contracts || {}) };
    const marks = {};
    for (const [alias, price] of Object.entries(vector.marks || {})) marks[specs[alias].contractId] = price;
    return marks;
}

function loadVectors() {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/cost_basis_fop/core_vectors.json'), 'utf8'));
}

module.exports = { buildGraph, marksOf, loadVectors, instant, tokenOf };

if (require.main === module) {
    const readline = require('node:readline');
    require(path.join(ROOT, 'js/cost_basis_fop_core.js'));
    const core = globalThis.OptionComboCostBasisFopCore;
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
        try {
            const request = JSON.parse(line);
            const graph = request.graph || buildGraph(request.vector, request.catalogue || {});
            const options = { ...(request.options || {}) };
            if (request.vector && !options.marks) options.marks = marksOf(request.vector, request.catalogue || {});
            process.stdout.write(`${JSON.stringify({ result: core.computeLedger(graph, options) })}\n`);
        } catch (error) {
            process.stdout.write(`${JSON.stringify({ error: String(error && error.stack) })}\n`);
        }
    });
}
