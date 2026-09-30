// P7: the FOP stress module reproduces the stress contract's vectors
// (CODE PLAN/COST_BASIS_FOP_STRESS_CONTRACT.md §12, §13 item 6).
//
// Every vector of tests/fixtures/cost_basis_fop/stress_vectors.json runs through
// js/cost_basis_fop_stress.js on the ledger graph the core tests build, with the
// same tolerances the reference model is held to: prices and sigma 1e-9,
// dollars 1e-6. The expected numbers come from hand working and from the
// independent reference model tests/helpers/cost_basis_fop_stress_model.py,
// never from this module. The totals are the ledger core's own replay.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const vectors = require('./helpers/cost_basis_fop_vectors');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = ['js/cost_basis_common.js', 'js/cost_basis_import_common.js', 'js/cost_basis_fop_import.js',
    'js/cost_basis_fop_core.js', 'js/cost_basis_fop_messages.js', 'js/cost_basis_fop_forms.js',
    'js/american_binomial.js', 'js/market_curves.js', 'js/cost_basis_fop_stress.js'];
const context = loadBrowserScripts(SCRIPTS);
const Stress = context.OptionComboCostBasisFopStress;
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/cost_basis_fop/stress_vectors.json'),
    'utf8'));
const CATALOGUE = FIXTURE.contracts;
const PRICE = 1e-9;
const DOLLARS = 1e-6;

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function idOf(alias) {
    return CATALOGUE[alias].contractId;
}

/** A vector reason names contracts by alias; the module names them by contract id. */
function reasonOf(text) {
    const [code, alias] = text.split(':');
    return alias ? `${code}:${idOf(alias)}` : code;
}

function instantText(text) {
    return vectors.instant(text);
}

function inputOf(vector) {
    const quotes = {};
    for (const [alias, quote] of Object.entries(vector.quotes)) {
        const mark = quote.mark !== undefined ? quote.mark : (quote.bid + quote.ask) / 2;
        quotes[idOf(alias)] = { level: quote.level || 'mid', mark };
    }
    return {
        graph: vectors.buildGraph(vector, CATALOGUE), asOf: instantText(vector.asOf), quotes,
        rate: vector.rate === null || vector.rate === undefined ? null : { source: 'assumed', value: vector.rate },
        reference: vector.reference ? idOf(vector.reference) : undefined,
    };
}

function paramsOf(point) {
    return { shift: point.shift || 0, slope: point.slope || 0, horizonDays: point.horizonDays || 0,
        ivScale: point.ivScale === undefined ? 1 : point.ivScale, early: (point.early || []).map(idOf), totals: true };
}

function byId(map) {
    const out = {};
    for (const [alias, value] of Object.entries(map)) out[idOf(alias)] = value;
    return out;
}

function close(actual, expected, tolerance, label) {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
}

function checkPoint(compiled, point, label) {
    const got = Stress.pointOrStop(compiled, paramsOf(point));
    if (!point.available) {
        assert.equal(got.available, false, label);
        assert.equal(got.reason, reasonOf(point.reason), label);
        return got;
    }
    assert.equal(got.available, true, `${label}: ${got.reason}`);
    close(got.change, point.change, DOLLARS, `${label} change`);
    assert.deepEqual(plain(got.positions), byId(point.positions), `${label} positions`);
    assert.deepEqual(plain(got.notDelivered), point.notDelivered.map((item) => ({ option: idOf(item.option),
        why: item.why })), `${label} notDelivered`);
    assert.deepEqual(plain(got.settlements).map((item) => ({ option: item.option, action: item.action,
        contracts: item.contracts, future: item.future || null, futureContracts: item.futureContracts ?? null,
        at: item.at })), point.settlements.map((item) => ({ option: idOf(item.option), action: item.action,
        contracts: item.contracts, future: item.future ? idOf(item.future) : null,
        futureContracts: item.futureContracts ?? null, at: instantText(item.at) })), `${label} settlements`);
    assert.deepEqual(Object.keys(got.values).sort(), Object.keys(byId(point.values)).sort(), `${label} open options`);
    for (const [id, value] of Object.entries(byId(point.values))) close(got.values[id], value, PRICE, `${label} ${id}`);
    for (const [id, value] of Object.entries(byId(point.futures))) close(got.futures[id], value, PRICE, `${label} ${id}`);
    // The core's replay of the ledger plus the settlements equals the reference model's (contract §7.3).
    assert.equal(got.economicPnl.reason, null, label);
    close(got.economicPnl.value, point.economicPnlModelAnchored, DOLLARS, `${label} economicPnl`);
    for (const key of ['handChange', 'handEconomicPnl']) {
        if (point[key] === undefined) continue;
        close(key === 'handChange' ? got.change : got.economicPnl.value, point[key], DOLLARS, `${label} ${key}`);
    }
    return got;
}

function compiled(vector) {
    return Stress.compile(inputOf(vector));
}

function vectorNamed(name) {
    return FIXTURE.vectors.find((vector) => vector.name === name);
}

module.exports = {
    name: 'cost_basis_fop_stress',
    tests: [
        {
            name: 'the pricers reproduce every pricer case, stop at F <= 0 before expiry and are intrinsic at it (P7)',
            run() {
                for (const item of FIXTURE.pricers) {
                    const tau = (Date.parse(item.expiryAt) - Date.parse(item.asOf)) / (365 * 86400 * 1000);
                    const pricer = item.model === 'american' ? Stress.american : Stress.black76;
                    const value = pricer(item.right, item.future, item.strike, tau, item.rate, item.sigma);
                    if (item.expect.value === null) {
                        assert.equal(value, null, item.name);
                        continue;
                    }
                    close(value, item.expect.value, PRICE, item.name);
                    if (item.expect.Nd1 !== undefined) {
                        close(Stress.normalCdf(item.expect.d1), item.expect.Nd1, 1e-12, `${item.name} N(d1)`);
                        close(Stress.normalCdf(item.expect.d2), item.expect.Nd2, 1e-12, `${item.name} N(d2)`);
                    }
                }
                // The normal distribution function to 1e-12 (contract §3.3), against known values.
                for (const [x, expected] of [[0, 0.5], [1, 0.8413447460685429], [-1.96, 0.02499789514822043],
                    [3.5, 0.9997673709209645], [-6, 9.865876450377014e-10], [8.5, 1]]) {
                    close(Stress.normalCdf(x), expected, 1e-12, `N(${x})`);
                }
            },
        },
        {
            name: 'implied volatility round-trips a mid and stops outside the model bounds (P7)',
            run() {
                for (const item of FIXTURE.calibration) {
                    const spec = CATALOGUE[item.option];
                    const option = { right: spec.right, strike: spec.strike, style: spec.exerciseStyle };
                    const tau = (Date.parse(spec.expiryAt) - Date.parse(item.asOf)) / (365 * 86400 * 1000);
                    if (item.expect.stop) {
                        assert.throws(() => Stress.impliedSigma(option, item.future, tau, item.rate, item.mark),
                            (error) => error.reason === item.expect.stop, item.name);
                        continue;
                    }
                    const sigma = Stress.impliedSigma(option, item.future, tau, item.rate, item.mark);
                    close(sigma, item.expect.sigma, PRICE, item.name);
                    close(Stress.price(option, item.future, tau, item.rate, sigma), item.mark, 1e-7, item.name);
                }
            },
        },
        {
            name: 'every stress vector reproduces: its stops, anchors, points, settlements and totals (P7)',
            run() {
                for (const vector of FIXTURE.vectors) {
                    const expect = vector.expect;
                    const result = compiled(vector);
                    if (expect.stop) {
                        assert.equal(result.available, false, vector.name);
                        assert.ok(result.reasons.includes(reasonOf(expect.stop)), `${vector.name}: ${result.reasons}`);
                        continue;
                    }
                    assert.equal(result.available, true, `${vector.name}: ${result.reasons}`);
                    assert.equal(Boolean(result.empty), Boolean(expect.empty), vector.name);
                    if (!result.empty) {
                        assert.equal(result.reference, idOf(expect.anchor.reference), vector.name);
                        for (const [alias, sigma] of Object.entries(expect.anchor.sigma)) {
                            close(result.options[idOf(alias)].sigma, sigma, PRICE, `${vector.name} sigma ${alias}`);
                            close(result.options[idOf(alias)].value0, expect.anchor.value[alias], PRICE,
                                `${vector.name} value ${alias}`);
                        }
                        close(result.ledgerEconomicPnl.value, expect.anchor.ledgerEconomicPnl, DOLLARS,
                            `${vector.name} ledger`);
                    }
                    for (const point of expect.points) {
                        checkPoint(result, point, `${vector.name} ${JSON.stringify(paramsOf(point))}`);
                    }
                    for (const item of (expect.band && expect.band.points) || []) {
                        const params = Stress.normalize({ band: expect.band.fraction, points: 11, rangePct: 1 });
                        const center = Stress.pointOrStop(result, { shift: item.shift || 0,
                            horizonDays: item.horizonDays || 0, totals: false });
                        const band = Stress.band(result, Object.assign(params, { horizonDays: item.horizonDays || 0 }),
                            [center]);
                        close(band.points[0].lower, item.lower, DOLLARS, `${vector.name} band lower`);
                        close(band.points[0].upper, item.upper, DOLLARS, `${vector.name} band upper`);
                    }
                }
            },
        },
        {
            name: 't=0 is exactly the anchor, and without options every month moves linearly (P7)',
            run() {
                const anchor = compiled(vectorNamed('t=0: the anchor is the ledger valuation'));
                const zero = Stress.point(anchor, { totals: true });
                assert.equal(zero.change, 0, 'the anchor point is the same evaluation on both sides');
                assert.equal(anchor.ledgerEconomicPnl.value, 2000);
                // The model-anchored total differs from the ledger only by the calibration residual.
                assert.ok(Math.abs(zero.economicPnl.value - 2000) <= 2 * 1000 * 1e-7);
                const linear = compiled(vectorNamed('no options: every futures month moves linearly, negative prices included'));
                for (const shift of [-150, -100, -72, -10, 0, 0.25, 5, 40]) {
                    for (const slope of [-1, 0, 0.5]) {
                        for (const horizonDays of [0, 1, 20]) {
                            const got = Stress.point(linear, { shift, slope, horizonDays, totals: true });
                            close(got.change, 2000 * shift - 1000 * (shift + slope), DOLLARS, `${shift}/${slope}/${horizonDays}`);
                            close(got.economicPnl.value, 2500 + got.change, DOLLARS, 'the core replay agrees');
                        }
                    }
                }
            },
        },
        {
            name: 'the whole run: the curve, the band, the labels, and early choices the contract refuses (P7)',
            run() {
                const vector = vectorNamed('t=0: the anchor is the ledger valuation');
                const result = Stress.run(inputOf(vector), { rangePct: 10, points: 11, band: 0.2 });
                assert.equal(result.available, true, String(result.reasons));
                assert.equal(result.points.length, 11);
                assert.equal(result.points[5].shift, 0);
                assert.equal(result.points[5].change, 0);
                close(result.points[0].x, 72 - 7.2, PRICE, 'the axis is the reference month price');
                assert.ok(result.band.points.every((item) => item.lower <= item.upper));
                // C80 and P65 carry exact expiry instants, so no expiry is inferred.
                assert.deepEqual(plain(result.labels), ['immediate_path', 'sticky_strike', 'no_delivery_fees',
                    'assumed_rate']);
                assert.equal(result.inputs.modelVersion, Stress.MODEL_VERSION);
                // An emptied field keeps its default; values are bounded as the contract fixes them.
                assert.deepEqual(plain(Stress.normalize({ points: '', rangePct: '', horizonDays: '', ivScale: '', band: '' })),
                    { rangePct: 30, range: null, points: 61, slope: 0, horizonDays: 0, ivScale: 1, band: 0.2, early: [],
                        reference: null });
                assert.deepEqual([Stress.normalize({ points: 12 }).points, Stress.normalize({ points: 500 }).points,
                    Stress.normalize({ rangePct: 200 }).rangePct, Stress.normalize({ horizonDays: -3 }).horizonDays],
                [13, 121, 90, 0]);
                const european = Stress.run(inputOf(vectorNamed('a European option is exercised only at its expiry')),
                    { early: [idOf('E70')] });
                assert.deepEqual(plain(european.reasons), [`early_delivery_european:${idOf('E70')}`]);
                const unknown = Stress.run(inputOf(vector), { early: [idOf('A70')] });
                assert.deepEqual(plain(unknown.reasons), [`early_delivery_unknown:${idOf('A70')}`]);
                const flat = Stress.run(inputOf(vectorNamed('a flat ledger has nothing to move')), {});
                assert.equal(flat.available, true);
                assert.equal(flat.empty, true);
                assert.equal(flat.anchor.ledgerEconomicPnl.value, 2000);
            },
        },
        {
            name: 'every stop is listed, a date-only expiry is labelled, and a discount curve gives the rate (P7)',
            run() {
                const vector = vectorNamed('an option past its expiry that the ledger still holds must be settled first');
                const both = Stress.compile(inputOf(vector));
                assert.deepEqual(plain(both.reasons).sort(), [`option_expired_open:${idOf('C80')}`,
                    `option_expired_open:${idOf('P65')}`].sort(), 'every reason, not only the first');
                const dated = Stress.run(inputOf(vectorNamed('a date-only expiry is 13:30 Chicago: 19:30Z in December (CST)')),
                    { points: 11 });
                assert.ok(dated.labels.includes(`expiry_time_by_rule:${idOf('W80')}`));
                assert.equal(dated.anchor.options[idOf('W80')].expiryAt, '2026-12-14T19:30:00.000000Z');
                // A flat 4% curve (canonical snapshot) gives the same numbers as the assumed 4%.
                const curve = { schemaVersion: 2, curveAsOf: '2026-11-16', currency: 'USD', source: 'test',
                    points: [7, 30, 90, 365].map((tenorDays) => ({ tenorDays, zeroRate: 0.04,
                        discountFactor: Math.exp(-0.04 * tenorDays / 365) })) };
                const anchorVector = vectorNamed('t=0: the anchor is the ledger valuation');
                const assumed = Stress.compile(inputOf(anchorVector));
                const withCurve = (rate) => Stress.compile(Object.assign(inputOf(anchorVector), { rate }));
                const fromCurve = withCurve({ source: 'curve', curve, status: 'cached' });
                assert.equal(fromCurve.available, true, String(fromCurve.reasons));
                close(fromCurve.options[idOf('C80')].sigma, assumed.options[idOf('C80')].sigma, 1e-9, 'sigma');
                assert.equal(withCurve({ source: 'curve', curve, status: 'updated' }).available, true);
                const noCurve = withCurve({ source: 'curve', curve: {}, status: 'cached' });
                assert.deepEqual(plain(noCurve.reasons), ['rate_unavailable']);
            },
        },
        {
            name: 'an out-of-date curve is refused, and a stop never hides another one (P7 review)',
            run() {
                const curve = { schemaVersion: 2, curveAsOf: '2026-11-16', currency: 'USD', source: 'test',
                    points: [7, 30, 90, 365].map((tenorDays) => ({ tenorDays, zeroRate: 0.04,
                        discountFactor: Math.exp(-0.04 * tenorDays / 365) })) };
                const anchorVector = vectorNamed('t=0: the anchor is the ledger valuation');
                const withRate = (vector, rate) => Stress.compile(Object.assign(inputOf(vector), { rate }));
                // The backend answers an older curve as cache_fallback (yield_curve/backend_adapter.py): not used.
                assert.deepEqual(plain(withRate(anchorVector, { source: 'curve', curve, status: 'cache_fallback' }).reasons),
                    ['rate_curve_stale:2026-11-16']);
                const old = Object.assign({}, curve, { curveAsOf: '2020-01-02' });
                assert.deepEqual(plain(withRate(anchorVector, { source: 'curve', curve: old, status: 'cache_fallback' })
                    .reasons), ['rate_curve_stale:2020-01-02']);
                // A curve that marks itself stale is refused whatever the status; an unknown status is no rate.
                assert.deepEqual(plain(withRate(anchorVector, { source: 'curve', curve: Object.assign({ stale: true }, curve),
                    status: 'cached' }).reasons), ['rate_curve_stale:2026-11-16']);
                assert.deepEqual(plain(withRate(anchorVector, { source: 'curve', curve }).reasons), ['rate_unavailable']);
                const run = Stress.run(Object.assign(inputOf(anchorVector),
                    { rate: { source: 'curve', curve: old, status: 'cache_fallback' } }), {});
                assert.equal(run.available, false);
                assert.deepEqual(plain(run.inputs.rate), { source: 'curve', asOfDate: null, status: 'cache_fallback' });
                // Every stop that stands on its own is listed together (contract §4.2, §11).
                const oneSided = vectorNamed('a one-sided option quote cannot give an implied volatility');
                assert.deepEqual(plain(withRate(oneSided, null).reasons).sort(),
                    [`iv_needs_mid:${idOf('C80')}`, 'rate_unavailable'].sort());
                assert.deepEqual(plain(withRate(oneSided, { source: 'curve', curve: old, status: 'cache_fallback' }).reasons)
                    .sort(), [`iv_needs_mid:${idOf('C80')}`, 'rate_curve_stale:2020-01-02'].sort());
                const noFutureInput = inputOf(vectorNamed('the future an option is bound to needs its own quote'));
                noFutureInput.quotes[idOf('C80')] = { level: 'settlement_reference', mark: 1.2 };
                noFutureInput.rate = null;
                assert.deepEqual(plain(Stress.compile(noFutureInput).reasons).sort(), [`future_anchor_missing:${idOf('F7')}`,
                    `iv_needs_mid:${idOf('C80')}`, 'rate_unavailable'].sort());
                const unbound = vectorNamed('an option whose future is not proven cannot be priced');
                const unboundInput = inputOf(unbound);
                unboundInput.quotes[idOf('U80')] = { level: 'one_sided_conservative', mark: 1.21 };
                assert.deepEqual(plain(Stress.compile(unboundInput).reasons).sort(), [`binding_unresolved:${idOf('U80')}`,
                    `iv_needs_mid:${idOf('U80')}`].sort());
                const expired = vectorNamed('an option past its expiry that the ledger still holds must be settled first');
                const expiredInput = inputOf(expired);
                expiredInput.quotes[idOf('P65')] = { level: 'close_reference', mark: 0.5 };
                expiredInput.rate = null;
                assert.deepEqual(plain(Stress.compile(expiredInput).reasons).sort(), [`iv_needs_mid:${idOf('P65')}`,
                    `option_expired_open:${idOf('C80')}`, `option_expired_open:${idOf('P65')}`, 'rate_unavailable'].sort());
                // Every early choice the contract refuses is listed, not only the first.
                const european = Stress.run(inputOf(vectorNamed('a European option is exercised only at its expiry')),
                    { early: [idOf('E70'), idOf('A70')] });
                assert.deepEqual(plain(european.reasons), [`early_delivery_european:${idOf('E70')}`,
                    `early_delivery_unknown:${idOf('A70')}`]);
            },
        },
        {
            name: 'a dollar range replaces the percentage and is the only range at a zero reference price (P7 review)',
            run() {
                const linear = vectorNamed('no options: every futures month moves linearly, negative prices included');
                const input = inputOf(linear);
                input.quotes[idOf('F7')] = { level: 'mid', mark: 0 };
                // At F_ref(0) = 0 a percentage gives no range (contract §5.3).
                assert.deepEqual(plain(Stress.run(input, { points: 11 }).reasons), ['range_invalid']);
                const dollars = Stress.run(input, { points: 11, range: '10' });
                assert.equal(dollars.available, true, String(dollars.reasons));
                assert.deepEqual(plain(dollars.points.map((point) => point.x)), [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10]);
                assert.equal(dollars.inputs.range, 10);
                for (const point of dollars.points) close(point.change, 2000 * point.shift - 1000 * point.shift, DOLLARS, 'linear');
                // A dollar range replaces the percentage where the reference price is not zero, too.
                const priced = Stress.run(inputOf(linear), { points: 11, rangePct: 30, range: 5 });
                assert.deepEqual([priced.points[0].shift, priced.points[10].shift], [-5, 5]);
                // Anything but a positive number stops the run; it is never read as another range.
                for (const range of ['0', '-5', 'abc', 'Infinity']) {
                    assert.deepEqual(plain(Stress.run(input, { points: 11, range }).reasons), ['range_invalid'], range);
                }
                assert.equal(Stress.normalize({ range: ' ' }).range, null, 'a blank field is no dollar range');
            },
        },
        {
            name: 'every stop the stress module or the page reports has a Chinese reason and a next step (P7)',
            run() {
                const Messages = context.OptionComboCostBasisFopMessages;
                const codes = new Set();
                for (const file of ['js/cost_basis_fop_stress.js', 'js/cost_basis_fop.js']) {
                    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
                    const patterns = [/stop\([`'"]([a-z_]+)/g, /add\([`'"]([a-z_]+)/g, /reasons: \[[`'"]([a-z_]+)/g,
                        /_stressStop\(job, '([a-z_]+)'\)/g, /\? `(early_delivery_[a-z_]+):/g];
                    for (const pattern of patterns) {
                        for (const match of source.matchAll(pattern)) codes.add(match[1]);
                    }
                }
                assert.ok(codes.size >= 20, [...codes].join(', '));
                for (const code of codes) {
                    const known = Messages.STRESS[code];
                    assert.ok(known && known[0] && known[1], `${code} has no Chinese reason and next step`);
                }
                assert.equal(Messages.stressReason(`iv_needs_mid:${idOf('C80')}`, () => 'LOF7 C8000'),
                    '期权不是同步的实时中间价，不能反推 IV（LOF7 C8000）。下一步：等待双边报价后重新取价。[iv_needs_mid]');
                assert.match(Messages.stressReason('something_new'), /未识别的原因（something_new）/);
            },
        },
        {
            name: 'on random ledgers and scenario points the core replay keeps the change, and futures alone move linearly (P7)',
            run() {
                // A seeded generator of end positions (the stress view needs only those): futures in two
                // months, American and European options on each, option quotes priced from a random sigma so
                // every mid is inside the model's bounds. Every available point must satisfy the contract's
                // identities (§7.1, §7.3, §6.3); no expected number comes from the module itself.
                let seed = 20260929;
                const random = () => {
                    seed = (seed * 1103515245 + 12345) % 2147483648;
                    return seed / 2147483648;
                };
                const pick = (low, high) => low + (high - low) * random();
                const whole = (low, high) => Math.floor(pick(low, high + 1));
                const aliases = ['F7', 'G7', 'C80', 'P65', 'A70', 'E70', 'G85'];
                const asOf = '2026-11-16T15:00:00Z';
                const counts = { checked: 0, linear: 0, early: 0 };
                for (let ledgerIndex = 0; ledgerIndex < 20; ledgerIndex += 1) {
                    const events = [];
                    const quantities = {};
                    for (const alias of aliases) {
                        const spec = CATALOGUE[alias];
                        const q = whole(-3, 3);
                        // Every fifth ledger holds futures only.
                        if (q === 0 || (ledgerIndex % 5 === 0 && spec.secType === 'FOP')) continue;
                        quantities[alias] = q;
                        events.push({ id: `e${events.length + 1}`,
                            at: `2026-11-02T15:${String(events.length).padStart(2, '0')}:00Z`,
                            kind: spec.secType === 'FUT' ? 'futures_trade' : 'option_trade', contract: alias, q,
                            price: Math.round(pick(...(spec.secType === 'FUT' ? [60, 80] : [0.2, 4])) * 100) / 100 });
                    }
                    if (!events.length) continue;
                    const f7 = Math.round(pick(62, 82) * 100) / 100;
                    const futures = { F7: f7, G7: Math.round((f7 + pick(-2, 2)) * 100) / 100 };
                    const quotes = { F7: { mark: futures.F7, level: 'mid' }, G7: { mark: futures.G7, level: 'mid' } };
                    for (const alias of ['C80', 'P65', 'A70', 'E70', 'G85']) {
                        const spec = CATALOGUE[alias];
                        const tau = (Date.parse(spec.expiryAt) - Date.parse(asOf)) / (365 * 86400 * 1000);
                        const option = { right: spec.right, strike: spec.strike, style: spec.exerciseStyle };
                        quotes[alias] = { level: 'mid',
                            mark: Stress.price(option, futures[spec.future], tau, 0.04, pick(0.2, 0.9)) };
                    }
                    const run = compiled({ events, asOf, quotes, rate: 0.04 });
                    if (!run.available) continue;
                    const anchor = Stress.point(run, { totals: true });
                    assert.equal(anchor.change, 0, 'the anchor');
                    const optionsHeld = Object.keys(quantities).some((alias) => CATALOGUE[alias].secType === 'FOP');
                    const americans = Object.keys(quantities).filter((alias) => CATALOGUE[alias].secType === 'FOP'
                        && CATALOGUE[alias].exerciseStyle === 'american').map(idOf);
                    for (let pointIndex = 0; pointIndex < 8; pointIndex += 1) {
                        const chosen = americans.filter(() => random() < 0.4);
                        const params = { shift: pick(-25, 25), slope: pick(-1, 1),
                            horizonDays: [0, 3, 10, 30][whole(0, 3)], ivScale: pick(0.5, 1.5), early: chosen, totals: true };
                        const got = Stress.pointOrStop(run, params);
                        if (!got.available) {
                            assert.ok(/^(model_domain|future_past_last_trade):/.test(got.reason), got.reason);
                            continue;
                        }
                        // §7.3: the ledger core's replay moves from the anchor by exactly the position change.
                        assert.equal(got.economicPnl.reason, null);
                        close(got.economicPnl.value - anchor.economicPnl.value, got.change, DOLLARS,
                            `ledger ${ledgerIndex} point ${pointIndex}`);
                        counts.checked += 1;
                        if (!optionsHeld) {
                            // §7.1 without options: q x M x (shift + slope x months after the reference month).
                            const monthIndex = (month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(4, 6));
                            const base = monthIndex(run.records.get(run.reference).futureContractMonth);
                            let expected = 0;
                            for (const [alias, q] of Object.entries(quantities)) {
                                const months = monthIndex(CATALOGUE[alias].month) - base;
                                expected += q * 1000 * (params.shift + params.slope * months);
                            }
                            close(got.change, expected, DOLLARS, 'futures alone move linearly');
                            counts.linear += 1;
                        }
                        // §6.3: each early delivery moves the P&L by n x mult x (intrinsic - V) against holding.
                        const horizon = Stress._internal.instantOf(Stress._internal.millis(vectors.instant(asOf))
                            + params.horizonDays * 86400000);
                        const earlyDeliveries = got.settlements.filter((item) => chosen.includes(item.option)
                            && item.action !== 'expire' && item.at === horizon);
                        if (earlyDeliveries.length) {
                            const hold = Stress.point(run, Object.assign({}, params, { early: [] }));
                            let expected = hold.change;
                            for (const settlement of earlyDeliveries) {
                                const option = run.options[settlement.option];
                                const inner = Stress.intrinsic(option.right, got.futures[option.futureId], option.strike);
                                expected += option.n * option.multiplier * (inner - hold.values[settlement.option]);
                            }
                            close(got.change, expected, DOLLARS, 'early deliveries move by their time value');
                            counts.early += 1;
                        }
                    }
                }
                // With this seed: 152 points, 24 of them futures-only, 45 with early deliveries.
                assert.ok(counts.checked >= 120, JSON.stringify(counts));
                assert.ok(counts.linear >= 15, JSON.stringify(counts));
                assert.ok(counts.early >= 20, JSON.stringify(counts));
            },
        },
        {
            name: 'a scenario changes none of its inputs and the module holds no client (P7)',
            run() {
                const vector = vectorNamed('expiry inside the horizon: a delivery keeps the economic P&L');
                const input = inputOf(vector);
                const before = JSON.stringify(input);
                const result = Stress.compile(input);
                for (const point of vector.expect.points) Stress.pointOrStop(result, paramsOf(point));
                Stress.run(input, { horizonDays: 30, points: 11 });
                assert.equal(JSON.stringify(input), before);
                const source = fs.readFileSync(path.join(ROOT, 'js/cost_basis_fop_stress.js'), 'utf8');
                for (const word of ['WebSocket', 'createRequestClient', 'request(', 'fetch(', 'XMLHttpRequest',
                    'localStorage', 'document.']) {
                    assert.ok(!source.includes(word), `the stress module must not use ${word}`);
                }
            },
        },
    ],
};
