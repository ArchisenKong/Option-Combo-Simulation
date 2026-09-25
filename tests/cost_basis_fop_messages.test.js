// P5-C6: problems in words (js/cost_basis_fop_messages.js).
//
// CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §19 P5-C6: every stable code the
// importer or the store can report has a Chinese reason, the row and contract
// it concerns and a next step; an unknown code gets a Chinese fallback that
// keeps its code; the original message stays beside it.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

const ROOT = path.resolve(__dirname, '..');
const Messages = loadBrowserScripts(['js/cost_basis_fop_messages.js']).OptionComboCostBasisFopMessages;

function read(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

module.exports = {
    name: 'cost_basis_fop_messages',
    tests: [
        {
            name: 'every code the importer or the store reports has a Chinese reason and a next step (P5-C6)',
            run() {
                const importer = read('js/cost_basis_fop_import.js');
                const codes = new Set(Array.from(importer.matchAll(/(?:fail|warn|problem|blocked)\('([a-z_]+)'/g))
                    .map((match) => match[1]));
                assert.ok(codes.size >= 40, `${codes.size} importer codes`);
                for (const code of codes) {
                    assert.ok(Messages.IMPORT[code], `importer code ${code} has no words`);
                    const [reason, next] = Messages.IMPORT[code];
                    assert.match(reason, /[一-鿿]/, code);
                    assert.match(next, /[一-鿿]/, code);
                }
                const store = read('cost_basis_store.py');
                const errors = Array.from(store.matchAll(/code = '([a-z_]+)'/g)).map((match) => match[1])
                    .filter((code) => !['cost_basis_store_error', 'book_exists', 'delete_confirmation_mismatch',
                        'reset_confirmation_mismatch', 'database_corrupt'].includes(code));
                for (const code of errors) assert.ok(Messages.SERVER[code], `store code ${code} has no words`);
                // The flows the plan names: account, timezone, opening, binding, duplicates, capability, version.
                for (const code of ['account_mismatch', 'account_confirmation_required', 'timezone_missing',
                    'baseline_price_missing', 'history_before_statement', 'binding_missing', 'binding_conflict',
                    'possible_duplicate', 'duplicate_decision_incomplete']) {
                    assert.ok(Messages.IMPORT[code], code);
                }
                for (const code of ['fop_capability_not_verified', 'ledger_changed']) assert.ok(Messages.SERVER[code], code);
            },
        },
        {
            name: 'a problem names its row, contract, next step and code, and keeps the original (P5-C6)',
            run() {
                const explained = Messages.explain({ code: 'account_confirmation_required', blocking: true, line: 7,
                    message: 'line 7: the statement account U****1111 is masked; confirm it is U1111111' },
                { contractOf: (line) => (line === 7 ? 'CLZ6' : null) });
                assert.equal(explained.text, '第 7 行 · CLZ6：报表里的账户号被遮罩，不能自动确认就是本账户。下一步：'
                    + '核对遮罩后露出的前后几位，勾选“报表中的遮罩账户就是本账本的账户”后重新预览。'
                    + '[account_confirmation_required]');
                assert.equal(explained.original, 'the statement account U****1111 is masked; confirm it is U1111111');
                assert.equal(explained.blocking, true);
                // An unknown code: Chinese, still blocking, its code kept.
                const unknown = Messages.explain({ code: 'brand_new_check', blocking: true, message: 'something new' });
                assert.match(unknown.text, /^未识别的问题（brand_new_check）。下一步：.*照样阻断/);
                assert.deepEqual([unknown.blocking, unknown.original], [true, 'something new']);
                // A server refusal, and an unknown one.
                assert.match(Messages.serverError({ code: 'ledger_changed', message: 'the ledger moved' }),
                    /^版本冲突：账本已在预览后变化。下一步：重新读取账本.*\[ledger_changed\] 原文：the ledger moved$/);
                assert.equal(Messages.serverError({ code: 'odd_code', message: 'odd' }), '服务端拒绝（odd_code）：odd');
                // Broker and quote reasons keep their codes.
                assert.equal(Messages.brokerProblem('contract_month_missing: the FUT details carry no contractMonth'),
                    '券商没有给出期货交割月（不会从最后交易日推算）（contract_month_missing: the FUT details carry no contractMonth）');
                assert.equal(Messages.quoteReason('stale'), '报价已超过 120 秒（stale）');
                assert.equal(Messages.quoteReason('market_data_type_9'), '未识别的原因（market_data_type_9）');
            },
        },
    ],
};
