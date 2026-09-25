// P3: the standalone FOP economic core (js/cost_basis_fop_core.js).
//
// CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §5, §6, §9.2, §13.2 and §13.3 P3.
// Every expected number comes from tests/fixtures/cost_basis_fop/core_vectors.json,
// worked by hand from the plan and reproduced by the independent rational model
// (tests/helpers/cost_basis_fop_model.py, run by tests/cost_basis_fop_core_test.py).
// Prices are compared to 1e-9 and dollar amounts to 1e-7 (plan §14.2): wide
// enough for binary floating point, far too narrow to hide a rounded step.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const { createChecker } = require('./helpers/fop-contract-schema');
const { buildGraph, marksOf, loadVectors, instant, tokenOf } = require('./helpers/cost_basis_fop_vectors');

const ROOT = path.resolve(__dirname, '..');
const core = loadBrowserScripts(['js/cost_basis_fop_core.js']).OptionComboCostBasisFopCore;
const DOCUMENT = loadVectors();
const OUTPUT_CONTRACT = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tests/fixtures/cost_basis_fop/contract/core_output.json'), 'utf8'));
const PRICE_FIELDS = new Set(['averagePrice', 'breakEven', 'breakEvenIfOpenShortsExpire']);

function number(expected) {
    if (typeof expected === 'string' && expected.includes('/')) {
        const [p, q] = expected.split('/').map(Number);
        return p / q;
    }
    return expected;
}

function near(actual, expected, field, label) {
    const tolerance = PRICE_FIELDS.has(field) ? 1e-9 : 1e-7;
    if (expected === null) {
        assert.equal(actual, null, `${label}: ${field} should be unknown`);
        return;
    }
    assert.ok(typeof actual === 'number' && Math.abs(actual - number(expected)) <= tolerance,
        `${label}: ${field} is ${actual}, expected ${expected}`);
}

function metric(value, field, expected, label) {
    if (typeof expected === 'boolean') {
        assert.equal(value, expected, `${label}: ${field}`);
        return;
    }
    near(value.value, expected, field, label);
    if (expected === null) assert.ok(value.reason, `${label}: ${field} names a reason`);
}

function options(vector, extra = {}) {
    const result = { marks: marksOf(vector, DOCUMENT.catalogue), trace: true, ...extra };
    if (vector.asOf) result.asOf = instant(vector.asOf);
    return result;
}

function run(vector, extra) {
    // Through JSON: the output must serialize, and the vm realm's arrays then
    // compare with this realm's under strict deep equality.
    return JSON.parse(JSON.stringify(
        core.computeLedger(buildGraph(vector, DOCUMENT.catalogue), options(vector, extra))));
}

function idOf(alias) {
    return DOCUMENT.catalogue[alias].contractId;
}

function checkVector(vector) {
    const label = vector.name;
    const expect = vector.expect;
    const { output, steps, order, groups, problems } = run(vector);
    for (const [field, value] of Object.entries(expect.totals || {})) {
        metric(output.totals[field], field, value, label);
    }
    for (const [field, value] of Object.entries(expect.sellerLens || {})) {
        metric(output.sellerLens[field], field, value, label);
    }
    for (const [field, value] of Object.entries(expect.buyerOptions || {})) {
        metric(output.buyerOptions[field], `buyerOptions.${field}`, value, label);
    }
    if (expect.positions) {
        const listed = {};
        for (const row of output.futures) listed[row.contractId] = row;
        for (const row of output.options) listed[row.contractId] = row;
        assert.deepEqual(Object.keys(listed).sort(),
            Object.keys(expect.positions).map(idOf).sort(), `${label}: open contracts`);
        for (const [alias, fields] of Object.entries(expect.positions)) {
            const row = listed[idOf(alias)];
            for (const [field, value] of Object.entries(fields)) {
                metric(row[field], field, value, `${label} ${alias}`);
            }
        }
    }
    if (expect.realized) {
        const realized = Object.fromEntries(output.realizedByContract.map((row) => [row.contractId, row.realized]));
        assert.deepEqual(Object.keys(realized).sort(), Object.keys(expect.realized).map(idOf).sort(),
            `${label}: contracts with realized results`);
        for (const [alias, value] of Object.entries(expect.realized)) {
            metric(realized[idOf(alias)], 'realized', value, `${label} ${alias}`);
        }
    }
    if (expect.cycles) assert.equal(output.cycles.length, expect.cycles.length, `${label}: cycles`);
    (expect.cycles || []).forEach((cycle, index) => {
        for (const [field, value] of Object.entries(cycle)) {
            metric(output.cycles[index].totals[field], field, value, `${label} cycle ${index}`);
        }
    });
    if (Object.prototype.hasOwnProperty.call(expect, 'openingValue')) {
        metric(output.scope.openingValue, 'openingValue', expect.openingValue, label);
    }
    if (expect.baselineAsOfUtc) {
        assert.equal(output.scope.baselineAsOfUtc, instant(expect.baselineAsOfUtc), `${label}: B`);
    }
    for (const [field, value] of Object.entries(expect.unattributed || {})) {
        metric(output.unattributed[field], field, value, `${label} unattributed`);
    }
    const byStep = new Map(steps.map((step) => [step.after, step]));
    for (const step of expect.steps || []) {
        const actual = byStep.get(tokenOf(step.after));
        assert.ok(actual, `${label}: a step after ${step.after}`);
        for (const [field, value] of Object.entries(step)) {
            if (field === 'after') continue;
            if (field === 'positions') {
                assert.deepEqual(Object.keys(actual.positions).sort(), Object.keys(value).map(idOf).sort(),
                    `${label} after ${step.after}: open contracts`);
                for (const [alias, [contracts, second]] of Object.entries(value)) {
                    const position = actual.positions[idOf(alias)];
                    assert.equal(position.contracts, contracts, `${label} after ${step.after}: ${alias}`);
                    const field2 = 'averagePrice' in position ? 'averagePrice' : 'remainingNetPremium';
                    near(position[field2], second, field2, `${label} after ${step.after} ${alias}`);
                }
            } else {
                near(actual[field], value, field, `${label} after ${step.after}`);
            }
        }
    }
    for (const [pathText, reason] of Object.entries(expect.reasons || {})) {
        const value = pathText.split('.').reduce((node, part) => node[part], output);
        // A reason names an event or a contract after its code; vector event
        // ids become Tokens in the graph (contract ids already are).
        const named = reason.replace(/:(.+)$/, (_match, id) => `:${tokenOf(id)}`);
        assert.equal(value.reason, named, `${label}: reason of ${pathText}`);
    }
    if (expect.order) assert.deepEqual(order, expect.order.map(tokenOf), `${label}: economic order`);
    if (expect.groups) {
        assert.deepEqual(groups, expect.groups.map((group) => group.map(tokenOf)), `${label}: groups`);
    }
    if (expect.ambiguous) {
        const flagged = problems.filter((problem) => problem.code === 'order_ambiguous')
            .flatMap((problem) => problem.contracts);
        assert.deepEqual([...new Set(flagged)].sort(), expect.ambiguous.map(idOf).sort(), `${label}: ambiguous`);
    } else {
        assert.deepEqual(problems, [], `${label}: no ordering or quantity problem`);
    }
    if (expect.rolls) {
        const actual = output.roll.groups.map((group) => ({
            evidence: group.evidence, matched: group.matchedContracts,
            legs: group.legs.map((leg) => [leg.eventId, leg.contractId, leg.contracts, leg.fees]),
        }));
        assert.equal(actual.length, expect.rolls.length, `${label}: roll groups`);
        expect.rolls.forEach((group, index) => {
            assert.equal(actual[index].evidence, group.evidence, `${label}: roll ${index} evidence`);
            assert.equal(actual[index].matched, group.matched, `${label}: roll ${index} quantity`);
            group.legs.forEach(([eventId, alias, contracts, fees], legIndex) => {
                const [aEvent, aContract, aContracts, aFees] = actual[index].legs[legIndex];
                assert.deepEqual([aEvent, aContract, aContracts], [tokenOf(eventId), idOf(alias), contracts],
                    `${label}: roll ${index} leg ${legIndex}`);
                near(aFees, fees, 'fees', `${label}: roll ${index} leg ${legIndex}`);
            });
        });
    }
    for (const [eventId, total] of Object.entries(expect.rollFeesAddUp || {})) {
        const legs = output.roll.groups.flatMap((group) => group.legs).filter((leg) => leg.eventId === tokenOf(eventId));
        assert.equal(legs.reduce((sum, leg) => sum + leg.fees, 0), total, `${label}: ${eventId} fees add back`);
    }
    return output;
}

function economics(output) {
    const { roll, ...rest } = output;
    return rest;
}

function renamed(vector, prefix) {
    const map = (id) => `${prefix}${id}`;
    const events = vector.events.slice().reverse().map((event) => ({
        ...event, id: map(event.id), ...(event.feeSource ? { feeSource: map(event.feeSource) } : {}),
    }));
    const boundaries = (vector.boundaries || []).map((boundary) => ({ ...boundary, anchor: map(boundary.anchor) }));
    return { ...vector, events, boundaries };
}

function comparable(output) {
    // The figures, without event ids (reasons and ROLL legs name events).
    return JSON.parse(JSON.stringify(economics(output), (key, value) => (
        key === 'reason' && typeof value === 'string' ? value.replace(/:.*$/, '') : value)));
}

module.exports = {
    name: 'cost_basis_fop_core',
    tests: [
        {
            name: "the buyer's options are a part of the totals, never added again, and their fees stay out of the seller lens (P5-C4)",
            run() {
                let checked = 0;
                for (const vector of DOCUMENT.vectors) {
                    if (vector.asOf || (vector.boundaries || []).length) continue;
                    const output = run(vector, { trace: false });
                    const buyer = output.buyerOptions;
                    const known = [output.totals.Co, output.sellerLens.Rs, buyer.Rb, buyer.openPremium]
                        .concat(output.options.map((row) => row.remainingNetPremium));
                    if (known.some((metric) => metric.value === null)) continue;
                    // Co is every option's cash once: settled shorts, settled longs, open shorts, open longs.
                    const openShort = output.options.filter((row) => row.contracts.value < 0)
                        .reduce((total, row) => total + row.remainingNetPremium.value, 0);
                    near(output.totals.Co.value, output.sellerLens.Rs.value + buyer.Rb.value + openShort
                        + buyer.openPremium.value, 'Co = Rs + Rb + open short + open long premium', vector.name);
                    if (buyer.openValue.value !== null && output.totals.Vo.value !== null) {
                        const shortValue = output.options.filter((row) => row.contracts.value < 0)
                            .reduce((total, row) => total + row.value.value, 0);
                        near(output.totals.Vo.value, shortValue + buyer.openValue.value, 'Vo = short + long value',
                            vector.name);
                    }
                    checked += 1;
                }
                assert.ok(checked >= 20, `${checked} vectors checked`);
                // The long-option fee of F18 is in E and in Eb, never in Es.
                const f18 = run(DOCUMENT.vectors.find((vector) => vector.name.startsWith('F18 fees, rebates')),
                    { trace: false });
                assert.deepEqual([f18.totals.E.value, f18.sellerLens.Es.value, f18.buyerOptions.Eb.value], [8.5, 4.5, 4]);
                // A long exercise fee is the buyer's; path A and path B keep one total.
                const pathA = run(DOCUMENT.vectors.find((vector) => vector.name.includes('path A')), { trace: false });
                const pathB = run(DOCUMENT.vectors.find((vector) => vector.name.includes('path B')), { trace: false });
                assert.equal(pathA.totals.economicPnl.value, pathB.totals.economicPnl.value);
                assert.deepEqual([pathA.buyerOptions.result.value, pathB.buyerOptions.result.value], [4000, 9000]);
            },
        },
        {
            name: 'every hand-worked vector gives its figures, step by step',
            run() {
                assert.ok(DOCUMENT.vectors.length >= 40, 'the vector set is loaded');
                for (const vector of DOCUMENT.vectors) checkVector(vector);
            },
        },
        {
            name: 'the P0 month-collision gold standard holds in the new engine',
            run() {
                // tests/fixtures/cost_basis_fop/month_collision.json, kept since P0
                // for this engine: two real contracts, nothing realized (F35).
                const fixture = JSON.parse(fs.readFileSync(
                    path.join(ROOT, 'tests/fixtures/cost_basis_fop/month_collision.json'), 'utf8'));
                const aliasOf = Object.fromEntries(Object.entries(DOCUMENT.catalogue)
                    .filter(([, spec]) => spec.secType === 'FUT').map(([alias, spec]) => [spec.localSymbol, alias]));
                const vector = { name: 'month_collision.json', expect: {}, events: fixture.events.map((event) => ({
                    id: event.ref, at: `${event.tradeDate}T14:00:00Z`, kind: 'futures_trade',
                    contract: aliasOf[event.localSymbol], q: event.contracts, price: event.price })) };
                for (const [symbol, contract] of Object.entries(fixture.contracts)) {
                    assert.equal(DOCUMENT.catalogue[aliasOf[symbol]].month, contract.deliveryMonth, symbol);
                }
                const output = run(vector, { trace: false });
                const rows = Object.fromEntries(output.futures.map((row) => [row.localSymbol, row]));
                assert.deepEqual(Object.keys(rows).sort(),
                    fixture.expected.positions.map((position) => position.localSymbol).sort());
                for (const position of fixture.expected.positions) {
                    const row = rows[position.localSymbol];
                    assert.equal(row.contractMonth, position.deliveryMonth);
                    assert.equal(row.contracts.value, position.contracts);
                    near(row.averagePrice.value, position.averagePrice, 'averagePrice', position.localSymbol);
                }
                assert.equal(output.totals.Rf.value, fixture.expected.futuresRealizedPnl);
                assert.notEqual(output.totals.Rf.value, fixture.legacyEngineResultForTheRecord.futuresRealizedPnl);
            },
        },
        {
            name: 'every output satisfies the frozen core output contract',
            run() {
                const checker = createChecker(OUTPUT_CONTRACT.types);
                for (const vector of DOCUMENT.vectors) {
                    const output = run(vector, { trace: false });
                    assert.deepEqual(checker.check('FopLedgerOutput', output), [], vector.name);
                    for (const gap of output.gaps) assert.ok(gap.reason, `${vector.name}: ${gap.metric}`);
                }
            },
        },
        {
            name: 'the contract examples are what the core computes from their events',
            run() {
                const examples = Object.fromEntries(OUTPUT_CONTRACT.examples.valid.map((e) => [e.name, e.value]));
                let seen = 0;
                for (const vector of DOCUMENT.vectors) {
                    const name = vector.expect.coreOutputExample;
                    if (!name) continue;
                    seen += 1;
                    const output = run(vector, { trace: false });
                    const rounded = JSON.parse(JSON.stringify(output, (key, value) => (
                        typeof value === 'number' && !Number.isInteger(value) ? Number(value.toFixed(9)) : value)));
                    assert.deepEqual(rounded, examples[name], name);
                }
                assert.equal(seen, OUTPUT_CONTRACT.examples.valid.length, 'every example has its vector');
            },
        },
        {
            name: 'ROLL groups and their query range never change a figure',
            run() {
                for (const vector of DOCUMENT.vectors) {
                    const plain = economics(run(vector, { trace: false }));
                    assert.deepEqual(economics(run(vector, { trace: false, rolls: false })), plain, vector.name);
                    assert.deepEqual(economics(run(vector, { trace: false,
                        rollRange: { fromUtc: '2026-11-18T15:00:00.500000Z', toUtc: null } })), plain, vector.name);
                }
            },
        },
        {
            name: 'the same history under other ids and entry order gives the same results',
            run() {
                for (const vector of DOCUMENT.vectors) {
                    const original = comparable(run(vector, { trace: false }));
                    const moved = comparable(run(renamed(vector, 'moved-'), { trace: false }));
                    assert.deepEqual(moved, original, vector.name);
                }
            },
        },
        {
            name: 'no step is rounded: a repeating average stays exact to 1e-9',
            run() {
                const vector = DOCUMENT.vectors.find((v) => v.name.startsWith('F47'));
                const { output } = run(vector);
                const [row] = output.futures;
                assert.ok(Math.abs(row.averagePrice.value - 211 / 3) <= 1e-9);
                assert.ok(Math.abs(70.333333 - 211 / 3) > 1e-9, 'six-decimal rounding would fail this bound');
                assert.ok(Math.abs(output.totals.Rf.value - 5000 / 3) <= 1e-7);
                const source = fs.readFileSync(path.join(ROOT, 'js/cost_basis_fop_core.js'), 'utf8');
                assert.doesNotMatch(source, /toFixed|Math\.round|_round\(/, 'the core rounds nothing');
            },
        },
        {
            name: 'the core is pure: no clock, DOM, network or randomness',
            run() {
                const source = fs.readFileSync(path.join(ROOT, 'js/cost_basis_fop_core.js'), 'utf8');
                for (const banned of [/new Date|Date\.now/, /document\./, /window\.(?!OptionCombo)/, /fetch\(|WebSocket|XMLHttpRequest/,
                    /Math\.random/, /localStorage|sessionStorage/]) {
                    assert.doesNotMatch(source, banned, String(banned));
                }
            },
        },
    ],
};
