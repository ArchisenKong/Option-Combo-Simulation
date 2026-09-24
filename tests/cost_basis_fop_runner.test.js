// The stage runner itself (tests/run_cost_basis_fop.js, plan §14.4).
//
// A stage that has no registered case is not implemented, so asking for it,
// or for any later stage, must fail instead of passing on the earlier stages'
// cases alone.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');

const { selectSuites } = require('./run_cost_basis_fop');

const ROOT = path.resolve(__dirname, '..');
const STAGES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

function suite(stage, cases = 1, runtime = 'node') {
    return {
        stage, runtime, file: `tests/${stage}.test.js`,
        cases: Array.from({ length: cases }, (_, index) => ({ name: `${stage} case ${index}` })),
    };
}

function manifest(suites) {
    return { stages: STAGES, suites };
}

function runStage(stage) {
    return childProcess.spawnSync(process.execPath,
        [path.join(ROOT, 'tests/run_cost_basis_fop.js'), '--stage', stage],
        { cwd: ROOT, encoding: 'utf8' });
}

module.exports = {
    name: 'cost_basis_fop_runner',
    tests: [
        {
            name: 'a stage with no registered case fails, and so does every later stage',
            run() {
                const done = manifest([suite('P0'), suite('P1', 2, 'python')]);
                const p1 = selectSuites(done, 'P1');
                assert.deepEqual(p1.errors, []);
                assert.deepEqual(p1.selected.map((entry) => entry.stage), ['P0', 'P1']);

                const p2 = selectSuites(done, 'P2');
                assert.equal(p2.usage, false);
                assert.equal(p2.errors.length, 1);
                assert.match(p2.errors[0], /stage P2 has no registered case/);

                const p6 = selectSuites(done, 'P6');
                assert.deepEqual(p6.errors.map((error) => error.split(' ')[1]),
                    ['P2', 'P3', 'P4', 'P5', 'P6']);
            },
        },
        {
            name: 'a gap before the target stage fails even when the target has cases',
            run() {
                const gap = manifest([suite('P0'), suite('P2')]);
                const errors = selectSuites(gap, 'P2').errors;
                assert.equal(errors.length, 1);
                assert.match(errors[0], /stage P1 has no registered case/);
                const empty = manifest([suite('P0'), suite('P1', 0)]);
                assert.match(selectSuites(empty, 'P1').errors[0], /stage P1 has no registered case/);
            },
        },
        {
            name: 'an unknown stage is a usage error',
            run() {
                const result = selectSuites(manifest([suite('P0')]), 'P9');
                assert.equal(result.usage, true);
                assert.match(result.errors[0], /unknown stage P9/);
                const stray = selectSuites(manifest([suite('P0'), suite('P7')]), 'P0');
                assert.match(stray.errors[0], /unknown stage P7/);
            },
        },
        {
            name: 'the real runner refuses a stage beyond the implemented ones',
            run() {
                const registered = require('./fixtures/cost_basis_fop/manifest.json');
                const last = STAGES.filter((stage) => registered.suites.some(
                    (entry) => entry.stage === stage && entry.cases.length > 0)).pop();
                const next = STAGES[STAGES.indexOf(last) + 1];
                assert.ok(next, 'every stage is registered; pick a new refusal case');
                const refused = runStage('P6');
                assert.equal(refused.status, 1, refused.stdout);
                assert.match(refused.stdout, new RegExp(`stage ${next} has no registered case`));
                assert.doesNotMatch(refused.stdout, /passed/);
                const unknown = runStage('P9');
                assert.equal(unknown.status, 2, unknown.stdout);
            },
        },
    ],
};
