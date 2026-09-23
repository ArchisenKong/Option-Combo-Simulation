// Stage runner for the standalone FOP ledger
// (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §14.4).
//
//   node tests/run_cost_basis_fop.js --stage P0
//
// Runs every node suite in tests/fixtures/cost_basis_fop/manifest.json up to
// the given stage. It exits non-zero on an unknown stage, a missing suite or
// fixture file, a listed case the suite lacks, a case the suite has that the
// manifest does not list, a node suite not registered in tests/run.js, zero
// selected cases, or any failure. Python suites are checked for their listed
// cases here and run with unittest (see the command printed at the end).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = 'tests/fixtures/cost_basis_fop/manifest.json';

function fail(message, code = 1) {
    console.log(`error: ${message}`);
    process.exit(code);
}

function stageArgument(argv) {
    const index = argv.indexOf('--stage');
    return index >= 0 ? argv[index + 1] : undefined;
}

function manifestProblems(manifest, selected) {
    const problems = [];
    const runJs = fs.readFileSync(path.join(ROOT, 'tests/run.js'), 'utf8');
    selected.forEach((suite) => {
        const file = path.join(ROOT, suite.file);
        if (!fs.existsSync(file)) {
            problems.push(`${suite.file}: suite file is missing`);
            return;
        }
        const listed = suite.cases.map((entry) => entry.name);
        if (new Set(listed).size !== listed.length) problems.push(`${suite.file}: duplicate case`);
        if (suite.runtime === 'node') {
            const module = require(file);
            if (module.name !== suite.name) {
                problems.push(`${suite.file}: suite is named ${module.name}, manifest says ${suite.name}`);
            }
            const actual = module.tests.map((test) => test.name);
            listed.filter((name) => !actual.includes(name)).forEach((name) => (
                problems.push(`${suite.file}: listed case is missing: ${name}`)));
            actual.filter((name) => !listed.includes(name)).forEach((name) => (
                problems.push(`${suite.file}: case is not in the manifest: ${name}`)));
            const requireName = `require('./${path.basename(suite.file, '.js')}')`;
            if (!runJs.includes(requireName)) {
                problems.push(`${suite.file}: not registered in tests/run.js`);
            }
        } else if (suite.runtime === 'python') {
            const source = fs.readFileSync(file, 'utf8');
            listed.forEach((name) => {
                const [className, method] = name.split('.');
                const classFound = new RegExp(`^class ${className}\\b`, 'm').test(source);
                const methodFound = new RegExp(`^    (async )?def ${method}\\(`, 'm').test(source);
                if (!classFound || !methodFound) {
                    problems.push(`${suite.file}: listed case is missing: ${name}`);
                }
            });
            const actual = Array.from(source.matchAll(/^    (?:async )?def (test_\w+)\(/gm))
                .map((match) => match[1]);
            actual.filter((method) => !listed.some((name) => name.endsWith(`.${method}`)))
                .forEach((method) => problems.push(
                    `${suite.file}: case is not in the manifest: ${method}`));
        } else {
            problems.push(`${suite.file}: unknown runtime ${suite.runtime}`);
        }
    });
    manifest.fixtures.forEach((fixture) => {
        if (!fs.existsSync(path.join(ROOT, fixture.file))) {
            problems.push(`${fixture.file}: fixture is missing`);
        }
        if (!manifest.sources.includes(fixture.source)) {
            problems.push(`${fixture.file}: unknown source ${fixture.source}`);
        }
    });
    return problems;
}

async function main() {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST), 'utf8'));
    const stage = stageArgument(process.argv.slice(2));
    if (!stage) fail('usage: node tests/run_cost_basis_fop.js --stage <P0..P6>', 2);
    const limit = manifest.stages.indexOf(stage);
    if (limit < 0) fail(`unknown stage ${stage}; expected one of ${manifest.stages.join(', ')}`, 2);

    const selected = manifest.suites.filter((suite) => {
        const index = manifest.stages.indexOf(suite.stage);
        if (index < 0) fail(`${suite.file}: unknown stage ${suite.stage}`);
        return index <= limit;
    });
    const problems = manifestProblems(manifest, selected);
    if (problems.length) {
        problems.forEach((problem) => console.log(`error: ${problem}`));
        process.exit(1);
    }

    let passed = 0;
    let failed = 0;
    for (const suite of selected.filter((entry) => entry.runtime === 'node')) {
        const module = require(path.join(ROOT, suite.file));
        console.log(`\n# ${suite.stage} ${suite.name}`);
        for (const entry of suite.cases) {
            const test = module.tests.find((candidate) => candidate.name === entry.name);
            try {
                await test.run();
                passed += 1;
                console.log(`ok - ${entry.name} [${entry.requirements.join('; ')}]`);
            } catch (error) {
                failed += 1;
                console.log(`not ok - ${entry.name}`);
                console.log(error.stack);
            }
        }
    }
    if (passed + failed === 0) fail(`no node cases selected for ${stage}`);

    const pythonSuites = selected.filter((entry) => entry.runtime === 'python');
    console.log(`\n${passed} passed, ${failed} failed (node, through ${stage})`);
    if (pythonSuites.length) {
        console.log('python suites for this stage (run separately):');
        pythonSuites.forEach((suite) => console.log(
            `  python -m unittest discover -s tests -p '${path.basename(suite.file)}'`
            + `  # ${suite.cases.length} cases`));
    }
    if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
    console.log(error.stack);
    process.exitCode = 1;
});
