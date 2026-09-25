/**
 * Chinese reasons and next steps for the FOP page's problems (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md
 * §19 P5-C6). DOM-free and Node-testable; the page loads it before
 * js/cost_basis_fop_view.js.
 *
 * The importer, the store, the broker resolver and the quote valuation report
 * stable codes with an English message. This module turns each code into what
 * the user reads: the reason, the row and contract it concerns and what to do
 * next. The code and the original message stay with it, so a problem can be
 * traced; statement fields and broker evidence are never rewritten. An
 * unknown code gets a Chinese fallback and keeps its code: nothing a problem
 * blocks is ever hidden or softened.
 */
(function attachCostBasisFopMessages(globalScope) {
    'use strict';

    // Problems of a statement preview (js/cost_basis_fop_import.js).
    const IMPORT = Object.freeze({
        account_missing: ['报表没有写明账户', '确认选的是 IBKR 的 Activity 或 Flex 报表；报表开头应有账户信息'],
        account_mismatch: ['报表属于另一个账户', '换成本账本账户的报表，或到那个账户的账本导入'],
        account_confirmation_required: ['报表里的账户号被遮罩，不能自动确认就是本账户',
            '核对遮罩后露出的前后几位，勾选“报表中的遮罩账户就是本账本的账户”后重新预览'],
        account_unchecked: ['没有账本可对照，报表账户未核对', '只读预览不写入；要导入请在对应账户的账本中进行'],
        several_accounts: ['一份报表里有多个账户', '按账户分别导出报表后逐个导入'],
        timezone_missing: ['报表没有给出唯一可识别的时区，本地成交时间无法换成 UTC',
            '在“账户时区”填写 IANA 时区（如 America/New_York）后重新预览'],
        timezone_unknown: ['无法识别的时区名', '改用 IANA 时区名，如 America/New_York、Asia/Shanghai'],
        time_invalid: ['成交时间无法读取，或在时区里不存在', '检查该行的日期/时间；夏令时切换当天请确认账户时区'],
        period_missing: ['报表没有写明期间', '导出带期间的报表（Activity 首段的 Period）'],
        period_from_rows: ['Flex 报表没有期间行，按行的日期推定覆盖期间', '如需完整覆盖，另导入带期间的 Activity 报表'],
        product_rules_unknown: ['账本的产品规则不受支持', '新建 NYMEX-CL-v1 规则的账本'],
        format_unknown: ['不是可识别的 IBKR Activity 或 Flex CSV', '从 IBKR 重新导出 CSV（不要用 Excel 另存）'],
        file_damaged: ['文件损坏或编码无法读取', '重新下载原始 CSV'],
        row_without_header: ['有数据行没有对应的表头', '重新导出完整报表'],
        row_unreadable: ['该行的数量、价格或费用无法读取', '核对原始 CSV 该行；不要手工改报表'],
        row_currency: ['该行币种与账本不同', '本账本只记该币种；其他币种不导入'],
        row_unsupported: ['这类行首版不支持（例如现金交割或非正行权价期权）', '这类合约不能导入本账本，也不能人工认领'],
        row_kind_unknown: ['无法判断这一行是订单、成交还是明细', '重新导出带 DataDiscriminator 的报表'],
        capability_unknown: ['这类行不在已知行类型清单中', '确认报表格式；未知行不会写入'],
        contract_conflict: ['该行合约与账本或报表其他部分的条款冲突', '核对合约的月份、行权价与乘数；不要在报表外手改'],
        contract_month_missing: ['无法确定期货交割月（不从最后交易日推算）',
            '导出包含 Delivery Month 或期货本地代码（如 CLZ6）的报表'],
        delivery_leg_missing: ['行权/指派只有一边：缺期权行或它交割的期货行', '导出包含同一时刻两行的报表后重新预览'],
        binding_missing: ['期权交割到哪张期货尚未证明', '在“期权绑定证据”向券商查询并采纳，或导入包含标的期货的报表'],
        binding_conflict: ['报表写的标的期货与账本中的绑定不同', '先在“期权绑定证据”核实并采纳正确绑定，再重新预览'],
        baseline_price_missing: ['“自基线起”的账本缺少期初参考价', '在“期初参考价”按 合约=价格 逐行填写后重新预览'],
        history_before_statement: ['报表之前还有持仓历史没有导入', '先导入更早期间的报表；或新建“自基线起”账本'],
        quantity_proof_failed: ['期初数量加期间净变动不等于报表期末持仓', '检查是否缺行、缺更早的报表或混入其他账户'],
        no_quantity_proof: ['报表没有持仓段，无法证明期初数量', '导出包含 Open Positions 的 Activity 报表'],
        position_unreadable: ['持仓段有一行无法读取', '核对原始报表的 Open Positions 段'],
        coverage_gap: ['已登记的报表期间之间有缺口', '导入缺口期间的报表，完整历史的结果才可信'],
        coverage_unknown: ['无法判断报表覆盖期间', '导入带期间的报表'],
        tws_not_in_statement: ['报表期间内有一笔 TWS 成交，报表里却没有', '核对报表是否完整，或冲销那笔 TWS 成交'],
        possible_duplicate: ['可能与已记账的成交重复，但没有证据证明是同一笔还是另一笔',
            '在“疑似重复”逐行认定（同一笔 / 另一笔）并写明核对依据，再重新预览'],
        duplicate_decision_incomplete: ['疑似重复的认定不完整：缺核对依据或没有覆盖全部候选',
            '补全依据；认定“另一笔”要与每个候选都比对过'],
        duplicate_decision_conflict: ['认定为同一笔的行与该成交对不上（数量、均价、费用或其他内容）',
            '改为“另一笔”，或检查是否漏选了同一订单的其他行'],
        duplicate_conflict: ['同一笔成交已以另一来源记账，但内容不同', '用冲销或重建更正已记账的成交，不要导入改动过的行'],
        import_revision_conflict: ['这一行以前导入过，但内容与已存的不同', '用冲销或重建更正，不要导入改动过的行'],
        order_ambiguous: ['同一时刻的成交顺序未知且会改变结果', '导出带成交编号或精确时间的报表'],
        order_fills_differ: ['同一订单的成交与订单行对不上', '核对订单行与成交行的数量和均价'],
        position_overdraw: ['平仓超过当时持仓', '先导入更早的历史或补记缺失的开仓'],
        cycle_boundary_violated: ['这批成交落在已结束的记账周期里，会破坏周期边界', '先撤销该周期边界，或核对成交日期'],
    });

    // Codes the store answers with (cost_basis_store error classes).
    const SERVER = Object.freeze({
        ledger_changed: ['版本冲突：账本已在预览后变化', '重新读取账本、重新预览后再确认'],
        fop_capability_not_verified: ['报表的这类行尚未经真实样本验收（能力未验收）',
            '逐行核对后勾选“人工认领”并写明核对说明；认领不会把行类型变成已验收'],
        fop_unsupported_row: ['首版不支持这类报表行', '这类合约不能导入，也不能认领'],
        fop_identity_conflict: ['合约或账本身份冲突', '核对合约条款与账本账户；需要改条款时走重建'],
        fop_binding_evidence_invalid: ['绑定证据无效或已过期', '重新向券商查询或重新预览报表'],
        fop_reference_revision_conflict: ['引用的合约、绑定或周期修订已变化', '重新读取账本并重新预览'],
        fop_ordering_ambiguous: ['同一时刻的成交顺序未知且会改变结果', '补充成交编号或精确时间'],
        fop_cycle_boundary_violated: ['会破坏已结束的记账周期边界', '先撤销该边界或核对事件时间'],
        fop_engine_version_mismatch: ['页面与后端的计算引擎版本不同', '刷新页面'],
        futures_book_frozen: ['FOP 写入尚未发布', '当前只读；正式写入在 P6 开放'],
        position_overdraw: ['平仓超过当时持仓', '先补记更早的开仓'],
        import_revision_conflict: ['已导入的行内容与本次不同', '用冲销或重建更正'],
        event_already_voided: ['事件已经冲销过', '刷新流水'],
        event_not_found: ['找不到这笔事件', '刷新流水'],
        book_not_found: ['找不到账本', '回到账本列表'],
        invalid_request: ['请求被服务端拒绝', '按原文核对；多数情况重新预览即可'],
        fop_contract_details_unavailable: ['这个后端不能向券商查询合约', '在连接 TWS 的后端（ib_server）上查询'],
        fop_positions_unavailable: ['这个后端没有 TWS 持仓', '在连接 TWS 的后端上读取；不会声称已对账'],
        fop_market_snapshot_unavailable: ['这个后端不能取报价', '在连接 TWS 的后端上取报价'],
        database_busy: ['数据库正忙', '稍后重试'],
        store_unavailable: ['账本存储不可用', '检查后端日志'],
    });

    // What the broker resolver says about an option (cost_basis_fop_broker.py).
    const BROKER = Object.freeze({
        not_found: '券商没有找到这张期权',
        ambiguous: '券商返回了多张候选合约，不能自动选择',
        no_underlying: '券商没有给出这张期权的标的期货（underConId）',
        contract_month_missing: '券商没有给出期货交割月（不会从最后交易日推算）',
        timeout: '向券商查询超时',
        broker_error: '券商返回错误',
    });

    // Why a quote is not a current price (js/cost_basis_fop_quotes.js).
    const QUOTE = Object.freeze({
        not_quoted: '未取到这张合约的报价',
        no_data: '券商没有可用价格',
        failed: '取价失败',
        identity_conflict: '返回的报价属于另一张合约',
        stale: '报价已超过 120 秒',
        out_of_sync: '与同批其他报价相差超过 60 秒',
        no_observation_time: '报价没有观察时刻',
        crossed_bbo: '买价高于卖价（交叉盘）',
        no_bid_or_ask: '没有有效的买价和卖价',
        only_the_opposite_side: '只有与平仓方向相反的一边',
        market_data_type_unknown: '行情类型未知，不算实时',
        market_data_type_2: '冻结行情，不算实时',
        market_data_type_3: '延迟行情，不算实时',
        market_data_type_4: '延迟冻结行情，不算实时',
        short_uses_ask: '空头按卖价（单边保守估值）',
        long_uses_bid: '多头按买价（单边保守估值）',
    });

    const LINE = /^line \d+: /;

    /**
     * One problem as the page shows it: {code, blocking, line, contract,
     * reason, next, original, text}. context.contractOf(line) names the
     * contract of a statement row, when there is one.
     */
    function explain(problem, context = {}) {
        const code = String(problem.code || '');
        const known = IMPORT[code] || SERVER[code];
        const contract = problem.contract || (problem.line && context.contractOf ? context.contractOf(problem.line) : null);
        const reason = known ? known[0] : `未识别的问题（${code || '无问题码'}）`;
        const next = known ? known[1] : '按下面的原文处理；这个问题照样阻断，不会被略过';
        const where = [problem.line ? `第 ${problem.line} 行` : '', contract || ''].filter(Boolean).join(' · ');
        const original = String(problem.message || '').replace(LINE, '');
        return {
            code, blocking: Boolean(problem.blocking), line: problem.line || null, contract: contract || null,
            reason, next, original,
            text: `${where ? `${where}：` : ''}${reason}。下一步：${next}。[${code || '—'}]`,
        };
    }

    /** A refusal the server answered with, for a status line. */
    function serverError(error) {
        const code = String((error && error.code) || '');
        const known = SERVER[code];
        const original = String((error && error.message) || '');
        if (!known) return code ? `服务端拒绝（${code}）：${original}` : original;
        return `${known[0]}。下一步：${known[1]}。[${code}] 原文：${original}`;
    }

    /** What the broker resolver said about an option, in words (the code stays). */
    function brokerProblem(text) {
        const value = String(text || '');
        const code = value.split(/[:\s]/)[0];
        if (BROKER[code]) return `${BROKER[code]}（${value}）`;
        if (/^the broker terms differ in /.test(value)) {
            return `券商条款与账本不同：${value.replace('the broker terms differ in ', '')}`;
        }
        if (/^underConId \d+ is not exactly one FUT/.test(value)) return `标的不是唯一的一张期货（${value}）`;
        if (/^the underlying differs from the option in /.test(value)) return `标的期货与期权的交易所或币种不同（${value}）`;
        return value;
    }

    function quoteReason(code) {
        return QUOTE[code] ? `${QUOTE[code]}（${code}）` : (code ? `未识别的原因（${code}）` : '—');
    }

    globalScope.OptionComboCostBasisFopMessages = Object.freeze({
        IMPORT, SERVER, BROKER, QUOTE,
        explain,
        serverError,
        brokerProblem,
        quoteReason,
    });
})(typeof window !== 'undefined' ? window : globalThis);
