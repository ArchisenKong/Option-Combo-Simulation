// P4: the FOP import pipeline as the page runs it (plan §13.3 P4 step 2).
//
// Two uses of one file:
//
// - `node tests/run.js` runs the checks below: the request the page's own
//   builders make from a synthetic statement passes the frozen contract, a
//   preview with a blocking problem yields no request, a statement without
//   trades yields a request that only registers its period, and a statement
//   split by the event limit yields requests that each pass the contract.
// - `node tests/cost_basis_fop_import_pipeline.test.js --serve` reads one JSON
//   request per line and answers one per line. tests/cost_basis_fop_import_pipeline_test.py
//   drives it: the Python side owns a real temporary store, this side runs the
//   exact functions the page runs (js/cost_basis_fop_import.js), and the
//   stored ledger is read back by js/cost_basis_fop_core.js. Nothing here
//   writes a request by hand.
//
//   ops: {op: 'plan', text, fileName, context} -> {planId, summary}
//        {op: 'request', planId, kind: 'import'|'rebuild', credentials, request, claim}
//            -> {request}
//        {op: 'split', planId, maxEvents} -> {batches: [{from, through, planId, events}]}
//        {op: 'preview', planId, graph, options} -> {output} (read-only preview)
//        {op: 'compute', graph, options} -> {output}
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const { createChecker } = require('./helpers/fop-contract-schema');
const statements = require('./helpers/cost_basis_fop_statements');

const ROOT = path.resolve(__dirname, '..');
const context = loadBrowserScripts(['js/cost_basis_import_common.js', 'js/cost_basis_fop_core.js',
    'js/cost_basis_fop_import.js']);
const Import = context.OptionComboCostBasisFopImport;
const Core = context.OptionComboCostBasisFopCore;
const CAPABILITIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'cost_basis_fop_capabilities.json'), 'utf8'));
const PROTOCOL = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tests/fixtures/cost_basis_fop/contract/protocol.json'), 'utf8'));

// Through JSON: results leave the vm realm as plain data.
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function summarize(plan) {
    return plain({
        format: plan.format, blocking: plan.blocking, problems: plan.problems, warnings: plan.warnings,
        rows: plan.rows, duplicates: plan.duplicates, supersede: plan.supersede,
        events: plan.events.length, kinds: plan.events.map((event) => event.kind),
        contracts: plan.contracts.map((record) => record.contractId),
        bindings: plan.bindings.map((record) => ({ bindingId: record.bindingId, status: record.status })),
        bindingRequests: plan.bindingRequests.map((item) => ({ bindingId: item.bindingId, option: item.option,
            future: item.future, evidence: item.evidence })),
        quantityProof: plan.quantityProof, timeZone: plan.timeZone, period: plan.period,
        eventTimes: plan.events.map((event) => event.time), coverage: plan.coverage, checks: plan.checks,
        duplicateReviews: plan.duplicateReviews, decisions: plan.decisions,
        notes: plan.events.map((event) => event.note),
    });
}

function planOf(text, fileName, planContext) {
    const statement = Import.readStatement(text, { capabilities: CAPABILITIES, fileName });
    return Import.planImport(statement, planContext);
}

function requestOf(plan, kind, credentials, request, claim) {
    let ready = Import.withCredentials(plan, credentials || {});
    if (claim) ready = Import.claimRows(ready, claim.lines, claim.attestation);
    return kind === 'rebuild' ? Import.buildRebuildRequest(ready, request) : Import.buildImportRequest(ready, request);
}

function serve() {
    const readline = require('node:readline');
    const plans = new Map();
    let counter = 0;
    const keep = (plan) => {
        counter += 1;
        const id = `plan-${counter}`;
        plans.set(id, plan);
        return id;
    };
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
        let answer;
        try {
            const message = JSON.parse(line);
            if (message.op === 'plan') {
                const plan = planOf(message.text, message.fileName, message.context);
                answer = { planId: keep(plan), summary: summarize(plan) };
            } else if (message.op === 'request') {
                answer = { request: plain(requestOf(plans.get(message.planId), message.kind, message.credentials,
                    message.request, message.claim)) };
            } else if (message.op === 'split') {
                answer = { batches: Import.splitPlan(plans.get(message.planId), message.maxEvents).map((batch) => ({
                    from: batch.from, through: batch.through, planId: keep(batch.plan), events: batch.plan.events.length,
                })) };
            } else if (message.op === 'preview') {
                const plan = plans.get(message.planId);
                answer = { output: plain(Core.computeLedger(
                    Import.previewGraph(message.graph || null, plan, message.book), message.options || {})) };
            } else if (message.op === 'compute') {
                answer = { output: plain(Core.computeLedger(message.graph, message.options || {})) };
            } else {
                throw new Error(`unknown op ${message.op}`);
            }
        } catch (error) {
            answer = { error: String(error && error.message) };
        }
        process.stdout.write(`${JSON.stringify(answer)}\n`);
    });
}

const BOOK = { bookId: 'fopbook0001', account: statements.ACCOUNT, symbol: 'CL', currency: 'USD',
    fop: { productRules: 'NYMEX-CL-v1', historyScope: 'full_history', engineVersion: 1 } };
const OBSERVED = '2027-03-01T14:15:00.000000Z';
const REQUEST = {
    requestId: 'req-1', bookId: 'fopbook0001', expectedLedgerVersion: { eventCount: 0, liveEventCount: 0, maxSeq: 0, digest: '0'.repeat(64) },
    bookIdentity: { account: statements.ACCOUNT, symbol: 'CL', secType: 'FUT', currency: 'USD' },
    importBatchId: 'batch-0000001', clientTokenPrefix: 'import-0000001', fileSha256: 'a'.repeat(64),
    fileName: 'synthetic.csv', engineVersion: 1,
};
const FILLS = [
    { symbol: 'CLZ6', local: '2026-10-01T10:00:00', qty: 1, price: 70, commission: 0, codes: 'O' },
    { symbol: 'LOZ6 C7500', local: '2026-10-01T11:00:00', qty: -1, price: 1.2, commission: -2.5, codes: 'O' },
    { symbol: 'LOZ6 C7500', local: '2026-11-17T15:00:00', qty: 1, price: 0, commission: 0, codes: 'Ep' },
    { symbol: 'CLZ6', local: '2026-11-18T10:00:00', qty: -1, price: 68, commission: -5, codes: 'C' },
    { symbol: 'CLF7', local: '2026-11-18T10:00:01', qty: 1, price: 69, commission: -5, codes: 'O' },
];

function withCredentials(plan) {
    // Stand-in credentials: the contract checks shape only; the server issues real ones.
    const credentials = {};
    for (const item of plan.bindingRequests) credentials[item.bindingId] = 'eyJ2IjoxfQ.c2lnbmF0dXJl';
    return credentials;
}

module.exports = {
    name: 'cost_basis_fop_import_pipeline',
    tests: [
        {
            name: 'the page builds a request the frozen contract accepts',
            run() {
                const checker = createChecker(PROTOCOL.types);
                const text = statements.activity({ period: { from: '2026-10-01', through: '2026-11-30' },
                    fills: FILLS, openPositions: [{ symbol: 'CLF7', quantity: 1, costPrice: 69 }] });
                const plan = planOf(text, 'oct-nov.csv', { book: BOOK, graph: null, observedAtUtc: OBSERVED });
                assert.equal(plan.blocking, false, JSON.stringify(plan.problems));
                const request = plain(requestOf(plan, 'import', withCredentials(plan), REQUEST));
                assert.deepEqual(checker.check('ImportRequest', request), []);
                assert.equal(request.fopPackage.events.length, 5);
                assert.deepEqual(request.fopPackage.events.map((event) => event.kind),
                    ['futures_trade', 'option_trade', 'option_expiry', 'futures_trade', 'futures_trade']);
                assert.ok(request.fopPackage.sourceRecords.every((record) => record.capabilityKey.startsWith('activity/trades/')));
                assert.equal(request.statement.periodFrom, '2026-10-01');
                assert.equal(request.statement.checks.quantityProof, true);
                const rebuild = plain(requestOf(plan, 'rebuild', withCredentials(plan), Object.assign({}, REQUEST,
                    { confirmation: 'rebuild CL', clientToken: 'rebuild-0000001' })));
                assert.deepEqual(checker.check('FopRebuildRequest', rebuild), []);
            },
        },
        {
            name: 'a preview with a blocking problem yields no request',
            run() {
                const text = statements.activity({ period: { from: '2026-10-01', through: '2026-11-30' },
                    fills: FILLS.slice(0, 1), generated: '2027-03-01, 09:15:00 CST' });
                const plan = planOf(text, 'no-zone.csv', { book: BOOK, graph: null, observedAtUtc: OBSERVED });
                assert.equal(plan.blocking, true);
                assert.ok(plan.problems.some((item) => item.code === 'timezone_missing'));
                assert.throws(() => requestOf(plan, 'import', {}, REQUEST), /cannot be committed/);
                const stated = planOf(text, 'no-zone.csv', { book: BOOK, graph: null, observedAtUtc: OBSERVED,
                    timeZone: 'America/New_York' });
                assert.equal(stated.blocking, false, JSON.stringify(stated.problems));
            },
        },
        {
            name: 'a statement without trades builds a request that only registers its period',
            run() {
                const checker = createChecker(PROTOCOL.types);
                const text = statements.activity({ period: { from: '2026-11-01', through: '2026-11-30' }, fills: [],
                    openPositions: [] });
                const plan = planOf(text, 'november.csv', { book: BOOK, graph: null, observedAtUtc: OBSERVED });
                assert.equal(plan.blocking, false, JSON.stringify(plan.problems));
                assert.equal(plan.events.length, 0);
                const request = plain(requestOf(plan, 'import', {}, REQUEST));
                assert.deepEqual(checker.check('ImportRequest', request), []);
                assert.equal(request.fopPackage, null);
                assert.deepEqual([request.statement.periodFrom, request.statement.periodThrough],
                    ['2026-11-01', '2026-11-30']);
                assert.deepEqual(request.supersedeTwsEventIds, []);
                // The contract refuses a package-less import that registers nothing.
                assert.deepEqual(checker.check('ImportRequest', Object.assign({}, request, { statement: null })),
                    [{ path: '', code: 'rule:coverage_only_import_names_its_statement' }]);
                assert.throws(() => requestOf(plan, 'rebuild', {}, Object.assign({}, REQUEST,
                    { confirmation: 'rebuild CL', clientToken: 'rebuild-0000001' })), /no events/);
            },
        },
        {
            name: 'a statement over the event limit splits into requests the contract accepts',
            run() {
                const checker = createChecker(PROTOCOL.types);
                const fills = [];
                for (let month = 10; month <= 12; month += 1) {
                    for (let day = 1; day <= 4; day += 1) {
                        fills.push({ symbol: 'CLZ6', local: `2026-${month}-0${day}T10:00:00`, qty: 1, price: 70,
                            commission: -1, codes: 'O' });
                        fills.push({ symbol: 'CLZ6', local: `2026-${month}-0${day}T11:00:00`, qty: -1, price: 71,
                            commission: -1, codes: 'C' });
                    }
                }
                const text = statements.activity({ period: { from: '2026-10-01', through: '2026-12-31' }, fills,
                    openPositions: [] });
                const plan = planOf(text, 'q4.csv', { book: BOOK, graph: null, observedAtUtc: OBSERVED });
                assert.equal(plan.events.length, 24);
                const batches = Import.splitPlan(plan, 10);
                assert.deepEqual(plain(batches.map((batch) => [batch.from, batch.through, batch.plan.events.length])), [
                    ['2026-10-01', '2026-10-31', 8], ['2026-11-01', '2026-11-30', 8], ['2026-12-01', '2026-12-31', 8]]);
                for (const batch of batches) {
                    const request = plain(Import.buildImportRequest(batch.plan, REQUEST));
                    assert.deepEqual(checker.check('ImportRequest', request), []);
                    assert.equal(request.statement.periodFrom, batch.from);
                    assert.equal(request.statement.periodThrough, batch.through);
                }
                assert.throws(() => Import.splitPlan(plan, 5), /alone holds 8 events/);
            },
        },
    ],
};

if (require.main === module && process.argv.includes('--serve')) serve();
