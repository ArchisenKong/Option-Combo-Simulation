// P7: the FOP stress worker (js/cost_basis_fop_stress_worker.js, stress contract §9).
//
// It loads the page's own versioned scripts and answers exactly what the pure
// module answers, echoing the generation and key the page sent; a missing
// dependency is a stated failure, never a result.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const vectors = require('./helpers/cost_basis_fop_vectors');

const ROOT = path.resolve(__dirname, '..');
const DEPENDENCIES = ['js/cost_basis_common.js', 'js/cost_basis_import_common.js', 'js/cost_basis_fop_import.js',
    'js/cost_basis_fop_core.js', 'js/cost_basis_fop_forms.js', 'js/american_binomial.js', 'js/market_curves.js',
    'js/cost_basis_fop_stress.js'];

function workerContext() {
    const outputs = [];
    const worker = vm.createContext({ Math, Date, Intl, JSON, Number, String, Object, Array, Map, Set, Error });
    worker.self = worker;
    worker.postMessage = (message) => outputs.push(JSON.parse(JSON.stringify(message)));
    worker.importScripts = (...files) => files.forEach((file) => {
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), worker);
    });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/cost_basis_fop_stress_worker.js'), 'utf8'), worker);
    return { worker, outputs };
}

module.exports = {
    name: 'cost_basis_fop_stress_worker',
    tests: [
        {
            name: 'the worker answers what the pure module answers, echoes its generation and key, and states a failure (P7)',
            run() {
                const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/cost_basis_fop/stress_vectors.json'), 'utf8'));
                const vector = fixture.vectors[0];
                const idOf = (alias) => fixture.contracts[alias].contractId;
                const quotes = {};
                for (const [alias, quote] of Object.entries(vector.quotes)) {
                    quotes[idOf(alias)] = { level: 'mid', mark: (quote.bid + quote.ask) / 2 };
                }
                const input = { graph: vectors.buildGraph(vector, fixture.contracts), asOf: vectors.instant(vector.asOf),
                    quotes, rate: { source: 'assumed', value: vector.rate }, ledgerDigest: 'd'.repeat(64),
                    quoteBatchId: 'quotes-1' };
                const params = { rangePct: 10, points: 11, band: 0.2, horizonDays: 5 };
                const expected = loadBrowserScripts(DEPENDENCIES).OptionComboCostBasisFopStress.run(input, params);
                const { worker, outputs } = workerContext();
                worker.onmessage({ data: { generation: 7, key: 'k-7', dependencies: DEPENDENCIES, input, params } });
                assert.equal(outputs.length, 1);
                assert.equal(outputs[0].generation, 7);
                assert.equal(outputs[0].key, 'k-7');
                assert.equal(outputs[0].result.available, true);
                assert.equal(JSON.stringify(outputs[0].result), JSON.stringify(expected));
                // A second run reuses the loaded scripts.
                worker.onmessage({ data: { generation: 8, key: 'k-8', dependencies: DEPENDENCIES, input, params } });
                assert.equal(outputs[1].generation, 8);
                assert.equal(JSON.stringify(outputs[1].result), JSON.stringify(expected));
                const broken = workerContext();
                broken.worker.onmessage({ data: { generation: 9, key: 'k-9', dependencies: ['missing.js'], input, params } });
                assert.equal(broken.outputs[0].generation, 9);
                assert.equal(broken.outputs[0].result.available, false);
                assert.deepEqual(broken.outputs[0].result.reasons, ['stress_failed']);
            },
        },
    ],
};
