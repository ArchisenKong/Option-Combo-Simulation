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
            name: 'every stage through P6 is registered, and the real runner refuses P7, which has no command',
            run() {
                // P6 registered its suites (plan §13.3 P6), so no stage up to it is empty. P7
                // has no frozen contract and no command (plan §14.4): the runner does not know it.
                // (Running --stage P6 here would run this case again, so the refusal is P7's.)
                const registered = require('./fixtures/cost_basis_fop/manifest.json');
                assert.deepEqual(STAGES.filter((stage) => registered.suites.some(
                    (entry) => entry.stage === stage && entry.cases.length > 0)), STAGES);
                assert.equal(STAGES[STAGES.length - 1], 'P6');
                const p7 = runStage('P7');
                assert.equal(p7.status, 2, p7.stdout);
                assert.match(p7.stdout, /unknown stage P7/);
                assert.doesNotMatch(p7.stdout, /passed/);
                const unknown = runStage('P9');
                assert.equal(unknown.status, 2, unknown.stdout);
            },
        },
    ],
};
