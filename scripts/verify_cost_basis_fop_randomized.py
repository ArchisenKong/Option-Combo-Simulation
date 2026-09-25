#!/usr/bin/env python3
"""The seeded FOP ledger campaign (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §13.3 P6 step 2, §14.4).

Every seed is one generated CL futures and FOP history, held to the independent
rational model through the vector replay, the page's read-only statement
preview and, for the first --store-cases seeds, a temporary SQLite ledger
(tests/helpers/cost_basis_fop_random_campaign.py). Temporary databases only;
nothing reaches TWS.

A failure stops the run with a non-zero status. It prints the seed and stage,
writes the case and a reduced action list (the same stage still failing) to a
temporary directory, and prints the command that replays them:

    python3 scripts/verify_cost_basis_fop_randomized.py --seed 0 --cases 2000 --steps 80 --store-cases 300
    python3 scripts/verify_cost_basis_fop_randomized.py --replay /tmp/.../reduced.json
"""
import argparse
import json
import pathlib
import sys
import tempfile
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'tests'))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from helpers.cost_basis_fop_random_campaign import Campaign, load_actions, reduce, serializable  # noqa: E402


def replay(path):
    saved = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    case = {'seed': saved['seed'], 'actions': load_actions(saved['actions']), 'marks': saved['marks'],
            'shape': saved['shape']}
    campaign = Campaign()
    try:
        campaign.run(case, store=saved.get('store', True))
    finally:
        campaign.close()
    print(f'replayed seed {saved["seed"]} ({len(case["actions"])} actions): it passes now')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--cases', type=int, default=2000)
    parser.add_argument('--steps', type=int, default=80)
    parser.add_argument('--store-cases', type=int, default=300)
    parser.add_argument('--report', type=pathlib.Path)
    parser.add_argument('--replay', type=pathlib.Path, help='a failure.json or reduced.json this script wrote')
    args = parser.parse_args()
    if args.replay:
        replay(args.replay)
        return
    if args.cases < 1 or args.steps < 12 or not 0 <= args.store_cases <= args.cases:
        parser.error('cases >= 1, steps >= 12, and 0 <= store-cases <= cases are required')
    campaign = Campaign()
    start = time.monotonic()
    try:
        for index in range(args.cases):
            seed = args.seed + index
            store = index < args.store_cases
            try:
                campaign.verify_case(seed, args.steps, store=store)
            except Exception as error:
                stage = campaign.last_stage
                case = campaign.last_case
                directory = pathlib.Path(tempfile.mkdtemp(prefix='cost-basis-fop-counterexample-'))
                (directory / 'failure.json').write_text(json.dumps(dict(
                    seed=seed, steps=args.steps, stage=stage, store=store, error=str(error),
                    actions=serializable(case['actions']), marks=case['marks'], shape=case['shape']),
                    indent=2) + '\n', encoding='utf-8')
                print(f'FAILED seed={seed} stage={stage}: {error}', flush=True)
                print(f'input: {directory / "failure.json"}', flush=True)
                reducer = Campaign()
                try:
                    reduced = reduce(reducer, case, store=store)
                except Exception as reduction_error:  # noqa: BLE001 - report, keep the full case
                    reduced = None
                    print(f'Reduction unavailable: {reduction_error}', flush=True)
                finally:
                    reducer.close()
                if reduced is not None:
                    (directory / 'reduced.json').write_text(json.dumps(reduced, indent=2) + '\n', encoding='utf-8')
                    print(f'reduced to {len(reduced["actions"])} of {len(case["actions"])} actions '
                          f'(stage {reduced["stage"]}): {directory / "reduced.json"}', flush=True)
                print(f'Replay: python3 scripts/verify_cost_basis_fop_randomized.py --seed {seed} --cases 1 '
                      f'--steps {args.steps} --store-cases {1 if store else 0}', flush=True)
                raise SystemExit(1) from error
            if (index + 1) % 100 == 0:
                print(f'{index + 1}/{args.cases} seeds passed; {time.monotonic() - start:.1f}s', flush=True)
        result = dict(seed=args.seed, cases=args.cases, steps=args.steps, storeCases=args.store_cases,
                      seconds=round(time.monotonic() - start, 2), coverage=dict(sorted(campaign.coverage.items())))
        if args.report:
            args.report.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(result, indent=2))
    finally:
        campaign.close()


if __name__ == '__main__':
    main()
