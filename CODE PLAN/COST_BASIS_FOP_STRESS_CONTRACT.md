# FOP 压力分析契约（P7 设计）

> 制定：2026-09-26。状态：**设计已通过验收（2026-09-27，经一轮复核修正）；已按 §13 实施（2026-09-29，实施中的修订见 §15）；实施复核第一轮的六个问题已修正（2026-09-29，见 §15.2）；第二轮复核发现的美元范围无效输入已修正，实施复核通过（2026-09-30，见 §15.3）。** 依据 [独立 FOP 账本计划](COST_BASIS_FOP_STANDALONE_PLAN.md) §12.2 与 §13.3 P7：先单独提交压力契约，给出逐月价格与 IV 输入、模型适用范围、负 FUT 处理、到期路径、输入版本/取消协议和可手算向量，再写实施清单。本文就是这份契约；§12 的向量和独立参考模型已经可以运行，§13 是实施清单。验收通过、实施完成并经浏览器验收之前，FOP 页面不出现可用的压力按钮（计划 §14.3）。
>
> 延续的约束：[股票压力契约](STRESS_KERNEL_REFACTOR.md)中“估值不由成本反推、情景不写账”继续适用；股票的单一现价、股息、LETF 映射、按股现金公式不复用（计划 §12.2）。

## 0. 目的与边界

压力分析回答一个问题：**在同一批行情下，如果各期货月份的价格按给定假设移动、经过给定天数、隐含波动率按给定倍数变化，这个 FOP 账本的当前持仓的经济盈亏（计划 §5.2）会变成多少。**

- 只看账本当前持仓。不模拟新交易、数量试调、未来卖期权收入、滑点、保证金、融资或资金占用。
- 所有结果都是假设情景，不是概率、置信区间、保证金结论或最坏结果保证。
- 情景不写账本、不下单、不行权、不订阅行情。情景交割只在内存中存在（§6）。
- 首版只支持计划 §1.2 的范围：CL 期货与 LO 类期权，账本已有的合约、绑定与行情。

## 1. 记号与单位

| 记号 | 含义 |
| --- | --- |
| `m` | 一个真实期货合约（月份），如 CLF7 |
| `F_m(0)` | 锚点：本批行情中该期货的 mark（§2.2） |
| `F'_m` | 情景价格（§5） |
| `q_m` | 该期货在 asOf 的有符号张数 |
| `M_m` | 期货点值 `futurePointValue`（CL 1000） |
| `j` | 一张未平期权；`n_j` 有符号张数，`mult_j` 权利金乘数，`K_j` 行权价，`E_j` 到期时刻，`m(j)` 其绑定期货 |
| `V_j` | 期权每单位价格（$/bbl），模型值 |
| `τ` | 年化剩余期限，ACT/365F：`秒数 / (365 × 86400)` |
| `r` | 连续复利零息利率 |

价格以 $/bbl 计，金额以美元计，时刻为 UtcInstant。期货价格可以为零或负；行权价恒为正（计划 §6.4）。

## 2. 输入（一次计算冻结的全部内容）

### 2.1 账本

页面已读取的账本图（`export_cost_basis_backup` 的 FOP 载荷）及其 `ledgerVersion`。持仓由 FOP 核心回放得到，不另算。

- 任一合约数量未知（核心的 Count 带原因），或账本有未确定时刻的事件（`event_time_unresolved`、`delivery_time_unresolved`），整次停止：持仓本身不确定。
- 期权到期时刻已过、账本仍持有（`E_j ≤ asOf`）：停止 `option_expired_open:<id>`。先按事实记录到期/指派/行权。
- 绑定未证明或冲突：停止 `binding_unresolved:<id>`。不知道期权交割哪个月份，就无法给它定价。
- `mult_j ≠ deliverableFuturesPerOption_j × M_m(j)`：停止 `multiplier_mismatch:<id>`。这一等式是交割守恒（§7.3）的前提，CL/LO 为 1000 = 1 × 1000。

### 2.2 行情与锚点

一份经 `js/cost_basis_fop_quotes.js` 评估的行情批（`quoteBatchId`、逐合约 level 与 mark），且与所示账本同一 `ledgerVersion`。

- **需要锚点的期货** = 持有的期货 ∪ 每张未平期权的绑定期货。未持有但被绑定的期货也必须在本批行情中：`quoteTargets` 把它们列为锚点（`role: 'anchor'`），估值结果单独放在 `quoteState.anchors`，不进入账本的 mark，不影响账本视图报告的最低一级，也不参与账本报价的同步判断（账本报价只按自身的最新观察时刻判断是否同步，与没有锚点时完全相同）。缺一个：停止 `future_anchor_missing:<id>`。
- **压力视图的报价**是 `quoteState.stress`：本批全部合约（含锚点）按整批最新的实时观察时刻统一判断同步，再按 `js/cost_basis_fop_quotes.js` 的顺序定级。同步只会比账本视图更严，不会更宽：锚点比账本报价新 60 秒以上时，账本仍是 mid，压力视图里这些报价不同步，期权停止 `iv_needs_mid`，未被绑定的持有期货没有参考价时停止 `future_anchor_missing`。下面各条说的 level 都指压力视图的 level。
- **期权**：只有 level 为 `mid`（批内同步、新鲜、非交叉）的报价可以反推 IV（§4.1）。单边保守价、结算/收盘参考都不行：停止 `iv_needs_mid:<id>`。
- **期权的绑定期货**：同样必须是 `mid`，否则停止 `iv_needs_live_future:<id>`。IV 必须用同一时刻的期货价反推。
- **不被任何期权绑定的持有期货**：任何可用 level 都可作锚点，但整条曲线标注本批所用的最低一级（计划 §10.3）。
- **asOf** = 价格被观察的时刻：本批（含锚点）实时报价中最新的 `observedAtUtc`，也就是压力视图同步窗口的基准；本批没有实时报价时才用 `requestedAtUtc`。它必须晚于账本最后一个事件，否则 `ledger_changed`。（实施修订，见 §15。）

### 2.3 利率

用两台后端缓存的有日期贴现曲线，经 FOP 只读动作 `request_cost_basis_fop_discount_curve` 读取（两台后端都以 `refresh: False` 取缓存，按 requestId 应答；见 §15），再经 `js/market_curves.js` 的 `resolveDiscount` 取零息利率：

- 反推 IV：`r_j = −ln(DF(E_j − asOf)) / τ`；
- 情景时刻 `T_h` 估值：用同一条曲线在剩余期限 `E_j − T_h` 上的零息利率（曲线形状不随时间变化，与股票压力的做法一致）。

应答带后端给出的 `status`，压力模块据此判断曲线是否过期：

- `cached` 或 `updated`：曲线日期不早于最近的市场营业日（`yield_curve/backend_adapter.py` 的判断），可用；
- `cache_fallback`（后端只有更旧的曲线），或曲线自己标为 `stale`：不用，停止 `rate_curve_stale:<曲线日期>`；
- 其他状态、曲线读不出、币种不是 USD，或某个期限 `usable=false`：停止 `rate_unavailable`。

页面每次计算都重新读取曲线，不在页面里缓存，所以一直开着的页面不会沿用旧曲线。曲线不可用时，用户可以输入一个明确的“假设利率”，界面全程标注。两者都没有：停止。不设隐含默认值。

### 2.4 情景参数

| 参数 | 含义 | 范围/默认 |
| --- | --- | --- |
| `shift` Δ | 每个月份都加上的价格移动（$/bbl） | 扫描轴，见 §5.3 |
| `slope` s | 相对参考月每晚一个合约月再加的移动（$/bbl/月） | 默认 0 |
| 参考月 | 扫描轴所示的月份 | 默认所有锚点中最早的合约月；可改选任一锚点月份 |
| `horizonDays` N | 情景时刻 `T_h = asOf + N × 86400 秒` | 整数 0–365，默认 0 |
| `ivScale` | 每张期权的 IV 乘数 | 默认 1 |
| 区间 b | IV 水平敏感性：成员 `ivScale × (1 ± b)` | 默认 20%，范围 0–50% |
| 提前交割 | 在 `T_h` 指定交割的期权（空头指派/多头行权） | 默认无 |

## 3. 模型

### 3.1 适用范围

| 条件 | 处理 |
| --- | --- |
| `exerciseStyle = american`（LO） | 期货美式 CRR 二叉树（§3.2） |
| `exerciseStyle = european` | Black-76 闭式（§3.3） |
| `τ = 0` | 内在价值，不论 F 的符号：F = −3、K = 65 的看跌为 68，F = 0 时为 65 |
| `τ > 0` 且 `F ≤ 0` | 对数模型不适用：该期权在该点**不可用** `model_domain:<id>`，不用 epsilon |
| `σ = 0` | 美式：确定路径（期货不漂移，等于内在价值）；欧式：贴现内在价值 |

判断顺序是先 `τ = 0`，再 `F ≤ 0`。`js/american_binomial.js` 对 `F ≤ 0` 即使在 `τ = 0` 也返回 NaN，所以压力模块在调用它之前自己处理 `τ = 0`。

`K ≤ 0` 的期权账本本身不接受（计划 §6.4），这里不再出现。

### 3.2 美式（CRR，期货）

步数 `N = 201`，`Δt = τ / N`，`u = e^{σ√Δt}`，`d = 1/u`，`p = (1 − d)/(u − d)`（期货无漂移），每步贴现 `e^{−rΔt}`。每个节点取 `max(行权值, 继续持有值)`，根节点另取内在价值下限；`σ√Δt < 1e-7` 时取确定路径。这正是 `js/american_binomial.js` 在 `dividendYield = riskFreeRate` 时的算法（`τ > 0` 且 `F ≤ 0` 时它返回 NaN，正是 §3.1 的停止；`τ = 0` 按 §3.1 先处理）。二叉树的离散误差是模型定义的一部分，不另外修正。

### 3.3 欧式（Black-76）

`d1 = (ln(F/K) + σ²τ/2) / (σ√τ)`，`d2 = d1 − σ√τ`：

- `C = e^{−rτ}[F·N(d1) − K·N(d2)]`
- `P = e^{−rτ}[K·N(−d2) − F·N(−d1)]`

实施必须自带一个正态分布函数，绝对误差不超过 1e-12。**不得使用 `js/pricing_core.js` 的 `calculateBlack76Price`：它把 `F ≤ 0` 改成 1e-4，正是计划禁止的 epsilon。**

### 3.4 时钟

方差时钟与贴现时钟相同，都是 ACT/365F 的秒数比例。

到期时刻 `E_j` 取合约的 `optionExpiryAsOf`。为空时按品种规则推定为 `optionExpiry` 当日 13:30 America/Chicago，并在界面标注“到期时刻按品种规则推定”。

- 换算成 UTC 时跟随夏令时：CDT 时是 18:30Z，CST 时是 19:30Z（向量 15、16）。
- CSV 导入的合约常常只有日期，所以这个回退是常态，不是例外。

### 3.5 不建模的内容

以下都不建模，在界面的假设说明中列出：
- 波动率曲面随价格移动的变化：首版为 sticky-strike，每张期权保留自己的 IV；
- 期限结构变化、跳跃；
- 对手方的提前指派：只在用户明确选择时发生（§6.3）；
- 交割费用和手续费：情景交割费用为 0，标注“未计交割费用”；
- 期货最终实物交割。

## 4. 锚定：隐含波动率

### 4.1 反推

每张未平期权在 asOf 用 `F_m(j)(0)`、`τ_j`、`r_j` 和它的 mid 求 σ：

1. `V(0)` 为模型下限，`V(8)` 为上限。`mid < V(0) − 1e-7`：停止 `quote_below_model_floor:<id>`（例如美式期权报价低于内在价值）；`mid > V(8) + 1e-7`：停止 `quote_above_model_ceiling:<id>`。
2. 在 `[0, 8]` 上二分 60 次：`V(中点) < mid` 则提高下界，否则降低上界；取最终区间中点。
3. `|V(σ) − mid| > 1e-7`：停止 `calibration_failed:<id>`。
4. `F_m(j)(0) ≤ 0`：停止 `model_domain:<id>`。

锚点值 `V_j(0) = V(σ_j)`。它与 mid 的差不超过 1e-7 $/bbl，即每张不超过 $0.0001。

### 4.2 整次停止

§2 与 §4.1 的停止都作用于整次计算：部分期权缺 IV 时不输出“看似完整”的组合曲线（股票契约同样规定）。停止时列出所有原因，而不只是第一个，便于一次补齐：

- 先做所有互不依赖的检查：数量、每张期权的到期时刻与报价级别、绑定与乘数、各期货锚点、利率来源与各期限的利率，以及锚点价 ≤ 0；一项不通过不跳过其他各项；
- 这些都通过后才逐张反推 IV，反推的停止同样逐张列出；
- 提前交割的无效选择也全部列出。

## 5. 情景价格

### 5.1 期限曲线

```text
F'_m = F_m(0) + Δ + s × (k_m − k_ref)
```

`k_m` 是合约月序号（年 × 12 + 月），`k_ref` 是参考月的序号。s = 0 时保留本批行情的各月价差，不假设零换月价差（计划 §12.2）；s ≠ 0 是明确标注的曲线斜率假设。

### 5.2 路径

首版只有“立即到位并保持”：asOf 之后各月份立即变为 `F'_m`，保持到 `T_h`。到期、交割都按这个价格。

### 5.3 扫描轴

横轴是参考月的情景价 `F_ref(0) + Δ`：
- 默认 `Δ ∈ [−30%, +30%] × |F_ref(0)|`，范围百分比可在 1–90 之间调；
- 点数取奇数，11–121，默认 61；Δ = 0 始终是其中一点。
- 页面另有“美元范围”（±美元/桶，可选）：填写后取代百分比。`F_ref(0) = 0` 时百分比范围为 0，只能按美元输入范围。美元范围不是正数，或浏览器判定输入无效（数字控件的 `validity.badInput`，此时 `.value` 为空串）时，停止 `range_invalid`，不按绝对值、百分比或其他方式猜测。

某点上仍未到期的期权的绑定期货 `F' ≤ 0` 时，该点不可用（§3.1）：曲线在那里断开并注明原因，其余点照常显示。期货本身的负价一律有效。

## 6. 到期、交割与情景时刻

### 6.1 情景时刻内到期

`E_j ≤ T_h` 的期权在 `E_j` 按情景价 `F'_m(j)` 结算：

- **严格价内**（看涨 `F' > K`，看跌 `F' < K`）：按计划 §6.1 交割。空头看跌 +1、空头看涨 −1、多头看涨 +1、多头看跌 −1，每张乘 `deliverableFuturesPerOption`，以 K 进入绑定期货的持仓。
- **平价或价外**：到期作废。

价内交割时，交割到的期货在 `E_j` 必须仍在交易（§6.2）；作废的期权不需要这个检查。

情景交割不计费用，也不计权利金的再次收付。按到期时刻先后逐张处理；同一时刻按合约 id 排序，结果与顺序无关。

### 6.2 期货最后交易日

期货在时刻 t 是否仍在交易：

- 有 `futureLastTradeAsOf`：t 不晚于它；
- 只有 `futureLastTradeDate`：t 的交易所日期（America/Chicago）不晚于它。例如 2026-12-18T03:00Z 在芝加哥仍是 12-17，最后交易日为 12-17 的期货仍在交易（向量 14）；
- 两者都没有：未知。

这个判断用在两处：

- 期权在 `E_j` 价内交割时，交割到的期货在 `E_j`；
- `N > 0` 时，`T_h` 仍持有（含情景交割得到）的每个期货在 `T_h`。

不在交易：该点停止 `future_past_last_trade:<id>`；未知：该点停止 `future_last_trade_unknown:<id>`。

- 首版不自动换月、不模拟实物交割（计划 §12.1）。
- 页面显示当前持仓允许的最远天数。

### 6.3 提前交割（明确选择）

用户可以选择在 `T_h` 让某些期权提前交割：空头按指派，多头按行权。规则：

- 只接受本账本的未平期权，否则拒绝 `early_delivery_unknown:<id>`。
- 只接受美式期权。欧式期权只能到期行权，选择欧式拒绝 `early_delivery_european:<id>`。
- 只在该点**严格价内**时交割：按 `F'` 与 K 以 §6.1 的方向进入期货持仓，交割到的期货在 `T_h` 必须仍在交易（§6.2）。
- 价外或平价的点不交割：期权继续持有，点明细注明 `out_of_the_money`。不定义强制的价外交割。
- 在 `T_h` 之前已到期的期权按 §6.1 结算，这个选择在该点无效，点明细注明 `settled_at_expiry`。

发生交割的点上，“提前交割”减“持有”的盈亏之差恰好是 `n_j × mult_j × (内在价值 − V_j(T_h))`。

- 原因：价内时交割部分 `δ × M × (F' − K)` 等于 `n × mult × 内在价值`，持有部分是 `n × mult × V`。
- 美式价值不低于内在价值，所以空头的差 ≥ 0（被指派时对方放弃了时间价值），多头的差 ≤ 0（自己行权放弃了时间价值）。
- 例见 §12 向量 4：空头 C80 +2506.54，多头 P65 −381.33。

**不做自动提前指派：** 实际提前指派只能来自事实事件（计划 §6.1）。

## 7. 盈亏口径

### 7.1 变化量（主输出）

```text
change = Σ_持有期货 q_m M_m (F'_m − F_m(0))
       + Σ_情景交割 δ M_m(j) (F'_m(j) − K_j)          δ = 该次交割的期货张数
       − Σ_已结算期权 n_j mult_j V_j(0)
       + Σ_仍未平期权 n_j mult_j (V_j(T_h) − V_j(0))
```

- 锚点：Δ = 0，s = 0，N = 0，ivScale = 1，且没有提前交割。此时两侧是同一次模型求值，所以 `change` **恰好为 0**，不是“近似为 0”。
- `change` 只依赖持仓数量与价格，不依赖历史均价。因此账本历史不完整（总额不可用）时，只要数量已知仍可显示。

### 7.2 总额

`情景经济盈亏 = 账本当前 economicPnl（本批 mark）+ change`

- 账本 `economicPnl` 不可用时，总额不可用，并沿用账本的原因；变化量照常。
- 锚点处，总额与账本 `economicPnl` 的差只来自 §4.1 的反推残差：每张期权不超过 $0.0001，页面按美分显示时看不到。
- 期权 mark 与模型值的残差不另行显示为盈亏。

### 7.3 守恒（验收恒等式）

把 §6 的情景交割作为内存事件（与交割预览同一构造规则：以 K 入账、费用 0）追加到账本图，用 FOP 核心按情景 mark 重放：
- 期货 mark 为 `F'`；
- 仍未平期权的 mark 为 `V(T_h)`。

得到的 `economicPnl` 减去锚点重放的 `economicPnl`，必须等于 §7.1 的 `change`，误差不超过 1e-6 美元。

这一恒等式把账本自己的记账口径（Rf 按 K、Uf、Co、Vo）与持仓公式连在一起：
- 覆盖看涨被指派时，Rf 实现、期货归零；
- 保护看跌行权时，负期货价下仍有下限。

实施时，总额由核心重放得到；测试断言两者一致。

### 7.4 IV 区间

成员为 `ivScale × (1 − b)`、`ivScale`、`ivScale × (1 + b)`，都是整组合重算，不把单腿极值相加。每点的下/上界取三个成员 `change` 的最小/最大。

- 任一成员在编译阶段失败：整条区间撤回，保留中线（与股票契约相同）。
- 在某点上不可用的原因（负价、最后交易日）与 σ 无关，所以区间与中线在同样的点上可用。
- 区间只是 IV 水平的有限假设采样，不是置信区间。

### 7.5 无未平持仓

账本没有未平的期货或期权时，没有要移动的东西：

- 不需要行情、利率或扫描轴；
- 结果为 `{available: true, empty: true}`，任何参数下 change 恰为 0，总额就是账本当前 `economicPnl`；
- 页面显示“当前没有未平持仓，情景不改变经济盈亏”，不画曲线（向量 18）。

### 7.6 首版不显示

- 情景下的卖方回本价；
- 逐月“每桶成本”；
- 未来收入；
- 数量试调。

## 8. 输出形状

```text
{
  version: 'fop-stress-v1', available, empty, reasons: [code…],   // 整次停止时 available=false；无持仓时 empty=true
  inputs: { ledgerDigest, quoteBatchId, asOf, rate:{source, asOfDate, status}|{source, value}, reference,
            horizonDays, slope, ivScale, band, points, rangePct, range /* 美元范围或 null */, early:[id…],
            modelVersion, steps:201 },
  anchor: { futures:{id:F}, levels:{id:level}, held:{id:q}, options:{id:{contracts, sigma, value, mid, rate,
            tau, expiryAt, expiryByRule, future}}, ledgerEconomicPnl:{value, reason}, anchorEconomicPnl },
  points: [{ shift, x /* 参考月情景价 */, futures:{id:F'}, available, reason?,
             change, economicPnl:{value, reason}, settlements:[{option, action, contracts, future?,
             futureContracts?, at}], values:{id:V}, positions:{id:q},
             notDelivered:[{option, why: 'out_of_the_money'|'settled_at_expiry'}] }],
  band: { available, reason?, fraction, points:[{ shift, lower, upper, lowerMember, upperMember }] },
  labels: [ 'immediate_path', 'no_delivery_fees', 'assumed_rate'?, 'expiry_time_by_rule:<id>'?,
            'reference_quotes'? … ]
}
```

每个数都能追到它的输入：点上列出各月份情景价、每张期权的模型值和每次情景交割。

## 9. 执行、版本与取消

- **纯函数：** 编译与扫描都是纯函数，输入就是 §2 的冻结内容，另加版本化的依赖脚本 URL（`?v=` 哈希）。
- **缓存键：** `ledgerDigest + quoteBatchId + 曲线日期/假设利率 + 参数 + modelVersion + 依赖哈希`。
- **Worker：** 计算全部在一个 Web Worker 中完成（二叉树成本：点数 × 3 成员 × 期权数 × 201² / 2）。
  - 请求 `{generation, key, dependencies, input}`，回复 `{generation, key, result}`。
  - 页面只接受 generation 与 key 都等于当前值、账本版本与行情批仍是所示版本的回复，其余丢弃。
- **冻结：** 一次计算在点击时读取参数、假设利率、账本图与行情批；之后只等待贴现曲线。读取曲线期间账本或行情批变了，这次计算作废。
- **取消：**
  - 参数、账本或行情批变化：递增 generation，并 `terminate()` 当前 worker。还在读取曲线、尚未进入 worker 的计算同样取消。
  - 账本变化：立即清除曲线。
  - 新的行情批：重新计算。
- **超时：** 20 秒无回复，终止 worker 并显示 `stress_timeout`，不自动重试。
- **行情过期：** 本批行情超过新鲜度门槛（计划 §10.3）后，曲线保留，但标注“基于 hh:mm:ss 的行情（已过期）”，不当作实时。
- **不写库：** 压力模块与 worker 不持有 WebSocket 客户端。压力流程只发两个只读请求：本批行情（已有）和贴现曲线。页面测试断言计算期间不发任何写动作。

## 10. 原因码

| 码 | 级别 | 含义与下一步 |
| --- | --- | --- |
| `ledger_changed` | 整次 | 账本或行情批已不是所示版本；重新读取后再算 |
| `quote_batch_unusable` | 整次 | 没有可用的行情批；先取一次行情 |
| `quantity_unknown:<id>` / `event_time_unresolved` | 整次 | 持仓不确定；先处理账本问题 |
| `option_expired_open:<id>` | 整次 | 已到期期权仍在账上；先记录到期/指派/行权 |
| `binding_unresolved:<id>` | 整次 | 期权的期货未证明；先补全绑定 |
| `multiplier_mismatch:<id>` | 整次 | 乘数与交割数量不一致；核对合约条款 |
| `future_anchor_missing:<id>` | 整次 | 绑定/持有的期货没有报价；重新取行情 |
| `iv_needs_live_future:<id>` | 整次 | 期权的期货不是同步 mid；等待实时行情 |
| `iv_needs_mid:<id>` | 整次 | 期权不是同步 mid；等待双边报价 |
| `quote_below_model_floor:<id>` / `quote_above_model_ceiling:<id>` | 整次 | 报价在模型边界之外（如低于内在价值）；核对报价 |
| `calibration_failed:<id>` | 整次 | IV 未收敛；核对报价 |
| `model_domain:<id>` | 整次/逐点 | 期货价 ≤ 0 时期权对数模型不适用；缩小范围或等期权结算 |
| `rate_unavailable` | 整次 | 无贴现曲线；输入假设利率 |
| `rate_curve_stale:<曲线日期>` | 整次 | 后端缓存的曲线已过期（`cache_fallback` 或曲线标为 stale）；输入假设利率，或等后端更新 |
| `future_past_last_trade:<id>` / `future_last_trade_unknown:<id>` | 逐点 | 交割或情景时刻时期货已过最后交易日，或最后交易日未知；缩短天数或补全合约条款 |
| `early_delivery_unknown:<id>` | 整次（选择无效） | 提前交割选了本账本没有的未平期权；重新选择 |
| `early_delivery_european:<id>` | 整次（选择无效） | 欧式期权只能到期行权；取消该选择 |
| `stress_timeout` | 整次 | 计算超时；减少点数或期权数后重试 |
| `option_expiry_unknown:<id>` | 整次 | 合约没有可用的到期日；补全合约条款 |
| `product_rules_unsupported:<rules>` | 整次 | 账本的产品规则不是 NYMEX-CL-v1 |
| `range_invalid` | 整次 | 价格范围不大于 0：美元范围不是正数，或参考月价格为 0 而没有美元范围；填写美元范围 |
| `stress_failed` / `stress_worker_unavailable` | 整次 | 后台计算失败，或当前环境不能启动 worker；刷新页面或换受支持的浏览器 |
| `fop_discount_curve_unavailable` / `fop_discount_curve_failed` | 服务端 | 后端没有缓存的贴现曲线，或读取失败；填写假设利率 |

每个码在 `js/cost_basis_fop_messages.js` 有中文说明与下一步，保留码与原文（计划 §19 P5-C6 的做法）。

## 11. 页面

- **入口：** 账本、行情与利率都就绪时压力区块可用。它只读，不受 FOP 写入开关影响。
- **显示：** 默认显示变化量曲线，可切换到总额（总额不可用时说明原因）。另有 IV 区间和逐点明细：
  - 锚定表：各期货的锚点价、报价级别与持仓；每张期权的持仓、绑定期货与其锚点价、mid、锚定模型值、σ、情景 σ（σ × IV 倍数）、利率、剩余天数与到期时刻（按规则推定时注明）；
  - 逐点表：参考月价格，各月情景价，每张期权在该点的模型值（已结算的注明到期作废、到期行权/被指派或提前行权/被指派），变化量、总额、IV 区间、情景交割与说明。
- **假设说明：** 常驻显示：立即到位并保持、sticky-strike、未计交割费用、模型与步数、利率来源、asOf、行情批时刻和最低 level；情景范围不是概率。
- **不提供：** 数量试调、未来收入、成本线；任何“确认/保存”类按钮。
- **缺项：** 列出全部停止原因及下一步，不显示部分曲线冒充完整结果。

## 12. 设计验收（已可运行）

计划 §13.3 P7 要求设计至少证明以下五点。对应关系：

| 计划要求 | 向量（`tests/fixtures/cost_basis_fop/stress_vectors.json`） | 证明方式 |
| --- | --- | --- |
| t=0 与账本估值一致 | 1 “t=0: the anchor is the ledger valuation” | 锚点 change 恰为 0；账本 economicPnl（手算 2000）与模型锚定总额之差 ≤ 残差界 |
| 无期权组合为逐月线性盈亏 | 2 “no options: …” | 手算：`change = 2000Δ − 1000(Δ + s)`，含 Δ=−100（CLF7 = −28）；另对 72 组 (Δ, s, N) 断言同一公式；时间不改变结果 |
| 到期/提前交割路径守恒 | 3 “expiry inside the horizon …”、13 “the other two deliveries …”、4 “an early delivery …” | 计划 §6.1 的四种交割方向都有；每点都用有理数账本模型重放“账本 + 情景交割”，与持仓公式一致；手算总额 −4300 / 10700 与 −6700 / 8300；提前交割 − 持有 = n × mult × (内在价值 − V)：空头 +2506.54，多头 −381.33 |
| （计划 §12.2）每张期权用自己的期货价格 | 5 “each option is priced off its own future …” | 只加曲线斜率时 CLF7 不动、CLG7 移到 74.5；变化只来自绑定 CLG7 的期权 |
| 缺报价/不支持模型停止 | 6–12 | 单边期权报价、单边期货、缺锚点、绑定未证明、无利率、过期仍持有：整次停止；CLF7 ≤ 0 且期权未平：该点 `model_domain` |
| 场景不写库 | 测试 `test_a_scenario_changes_none_of_its_inputs` | 参考模型不改输入；实施时另由 §13 的页面测试断言不发写动作 |
| （设计复核补充）日期回退与边界 | 14–18，定价用例中的到期边界 | 只有日期的最后交易日按芝加哥日期判断；只有日期的到期按 13:30 芝加哥，随夏令时；欧式不提前行权，价外不提前交割；到期时零/负期货价取内在价值；无持仓为 `empty` |

手算要点（CL 点值与权利金乘数都是 1000）：

1. **锚点：** 持有 CLF7 +1 @70、卖 LOF7 C80 @1.5、买 LOF7 P65 @0.8。mid 为 CLF7 72、C80 1.2、P65 0.5。于是 Uf = 2000，Co = +1500 − 800 = 700，Vo = −1200 + 500 = −700，`economicPnl = 2000`。
2. **线性：** CLF7 +2 @70、CLG7 −1 @71，mark 72 / 72.5，`economicPnl = 4000 − 1500 = 2500`。
3. **到期守恒：** 情景时刻为 30 天后（2026-12-16），两张期权已于 12-14 到期，CLF7 仍在交易。
   - CLF7 60：看跌行权，−1 @65 平掉多头，Rf = −5000，加 Co 700 得 −4300。
   - CLF7 65：两张作废，Uf = −5000，−4300。
   - CLF7 80：两张作废，Uf = 10000，10700。
   - CLF7 90：看涨被指派，−1 @80 平掉多头，Rf = 10000，10700。
   - CLF7 −3：看跌仍按 65 交割，不需要期权模型，−4300。
   - 另一组（向量 13，不持期货）：卖 P65 @0.8、买 A70 @2.5，锚点 `economicPnl = −1700 + 3100 = 1400`。CLF7 60：空头看跌被指派，+1 @65，Uf = −5000，得 −6700。CLF7 80：多头看涨行权，+1 @70，Uf = 10000，得 8300。
4. **提前交割（10 天后）：**
   - CLF7 82：C80 价内 2，持有时模型值 4.506545。提前指派使 change 从 6195.80 变为 8702.35，差 +2506.545 = n × mult × (内在价值 − V) = −1 × 1000 × (2 − 4.506545)。
   - CLF7 60：多头 P65 价内 5，持有时模型值 5.38133。提前行权使 change 从 −5925.87 变为 −6307.20，差 −381.33 = 1000 × (5 − 5.38133)。
   - CLF7 72：C80 价外，不交割（`out_of_the_money`），结果与持有相同。30 天后：C80 已在到期时结算（`settled_at_expiry`）。
5. **Black-76 逐步：** F 72，K 70，τ = 28.1875/365 = 0.0772260274，r 4%，σ 35%。
   - d1 = 0.3382663720，d2 = 0.2410028724，N(d1) = 0.6324187686，N(d2) = 0.5952235549；
   - 贴现 0.9969157251，看涨 3.8565709722；
   - 看跌按平价 = 3.8565709722 − 0.9969157251 × 2 = 1.8627395220。
   - 同条件美式 CRR 为 3.8617696600 ≥ 欧式。r = 0 时美式 3.8716 与欧式 3.8685 只差树的离散误差（< 0.01）。
6. **日期回退：**
   - 向量 14：CLF7 只有最后交易日 2026-12-17，P65 只有到期日，asOf 为 03:00Z（芝加哥前一晚 21:00）。
     - 29 天后 CLF7 60：看跌在 19:30Z 被指派，+1 @65，两张均价 67.5，2 × 1000 × (60 − 67.5) + 800 = −14200。
     - 31 天后：UTC 已是 12-18，芝加哥仍是 12-17，CLF7 77 仍在交易，1000 × (77 − 70) + 800 = 7800。
     - 32 天后：芝加哥 12-18，停止。
   - 向量 15（10 月，CDT）：看涨在 18:30Z 到期，19:00Z 时已按 72 行权，1000 × (72 − 70) − 2000 = 0。
   - 向量 16（12 月，CST）：19:00Z 时看涨离 19:30Z 到期还有 30 分钟，仍按模型估值。
7. **无持仓（向量 18）：** 70 买入、72 卖出，Rf = 2000，没有未平持仓，任何参数下 change 都是 0。

模型数值（σ、V、含未平期权的 change）来自独立参考模型 `tests/helpers/cost_basis_fop_stress_model.py`：
- 它按本文重写定价、反推、路径和持仓算术；
- 不导入任何生产代码，测试检查它的 import 列表；
- 总额与守恒用既有的有理数账本模型 `tests/helpers/cost_basis_fop_model.py`。

**命令：**

```bash
python3 -m unittest discover -s tests -p 'cost_basis_fop_stress_contract_test.py'
node tests/run_cost_basis_fop.js --stage P7
```

**容差：** 价格与 σ 1e-9，美元 1e-6；反推残差 1e-7 $/bbl。

## 13. 实施清单（设计验收通过后执行）

1. **`js/cost_basis_fop_stress.js`（DOM-free）**
   - 导出 `VERSION`、`compile(input)`（返回已编译结果或全部停止原因）、`sweep(compiled, member)`、`band(compiled, fraction)`，以及 `black76`、`impliedSigma` 供测试。
   - 使用 `OptionComboAmericanBinomial`（`dividendYield = riskFreeRate`）、自带的 Black-76 与正态分布函数，以及 `OptionComboCostBasisFopCore.computeLedger`（§7.3 总额）。
   - 情景交割事件的构造与 `js/cost_basis_fop_forms.js` 的交割预览共用一个函数，不各写一份。
2. **`js/cost_basis_fop_stress_worker.js`：** `importScripts` 版本化依赖，按 §9 回复。
3. **行情：** `quoteTargets` 增加未持有但被绑定的期货，作为锚点；估值结果放在 `quoteState.anchors`，不进入账本的 mark、最低一级与账本报价的同步判断；压力视图读 `quoteState.stress`（整批一个同步窗口，§2.2）。
4. **利率：**
   - `js/cost_basis_common.js` 为 FOP 页登记只读 `request_cost_basis_fop_discount_curve`（`cost_basis_ws.py` 的新动作；两台后端注入 `fetch_discount_curve`，取缓存、不刷新）；协议增加 `DiscountCurveRequest` / `DiscountCurveResponse`；
   - FOP 页加载 `js/market_curves.js`，按 §2.3 取利率；
   - 另加“假设利率”输入；
   - 曲线的 `status` 随曲线传给压力模块（§2.3），每次计算重新读取。
5. **页面：**
   - `cost_basis_fop.html` 的压力区块和控件；`js/cost_basis_fop.js` 的接线（generation、取消、超时、过期标注）；
   - `js/cost_basis_fop_view.js` 的点明细与标签；`js/cost_basis_fop_messages.js` 的 §10 各码；
   - 加载 `american_binomial.js`、`market_curves.js` 和压力模块；`scripts/stamp_asset_versions.py` 更新哈希。
6. **测试：**
   - `tests/cost_basis_fop_stress.test.js`：用同一份 `stress_vectors.json` 跑 JS 模块，全部点、停止、区间和守恒都在 §12 的容差内；不改输入；模块不引用任何客户端。
   - `tests/cost_basis_fop_stress_worker.test.js`：worker 输出等于纯模块，echo generation，依赖加载失败时不可用。
   - `tests/helpers/cost_basis_fop_vectors.js` 传入 `optionExpiryAsOf`、`futureLastTradeAsOf`、`exerciseStyle`。
   - 页面测试：
     - 输入不齐时区块不可用；
     - 过期回复丢弃；账本变化立即取消；
     - 超时显示 `stress_timeout`；
     - 计算期间不发写动作；
     - 假设利率全程标注；
     - 过期曲线被拒；读取曲线期间改参数即取消；计算用开始时的参数；逐点明细与锚定表（§11）。
   - 随机性质测试：随机账本和随机情景点上，守恒恒等式、“无期权线性”和提前交割恒等式都成立（用固定种子的期末持仓生成器；见 §15）。
   - 浏览器：`scripts/cost_basis_fop_browser_assertions.js` 增加 stress 阶段，在合成后端上跑。合成后端提供缓存的贴现曲线（`POST /__synthetic/curve` 可撤下），以及被绑定期货的报价。
7. **登记：** 新套件登记到 `tests/run.js` 与 manifest 的 P7。P7 命令为 §12 的两条命令，加上 `node tests/run.js` 和 `python3 scripts/stamp_asset_versions.py --check`。
8. **文档：** README、ARCHITECTURE、DEV_HANDOVER、AGENTS 的 FOP 页描述，以及验收记录的 P7 节。

**启用门槛：** JS 模块逐项重现全部向量；页面测试与浏览器阶段通过；独立复核签署。之后才显示可用的压力按钮。

## 14. 首版之外（记录，不实施）

- **负价期货上的期权：** 正态（Bachelier）模型可以覆盖 `F ≤ 0`。CME 在 2020 年负油价期间对 CL 期权改用过正态模型（实施前核对 CME 原始公告）。需要另写反推、美式树和向量，不能与对数模型混用同一个 IV。
- **波动率曲面动态：** sticky-delta、偏度随价格变化、期限结构移动。
- **路径：** 渐进路径、到位天数、逐月不同的移动时点。
- **其他：** 数量试调、未来卖期权收入（默认关闭的显式假设）、交割费用和滑点、情景下的回本价。
- **期货最终交割：** 自动换月与实物交割。

## 15. 实施记录与修订（2026-09-29）

### 15.1 实施中的修订

按 §13 实施时，有四处与验收时的文字不同，都在这里说明原因；正文已同步：

1. **利率动作。** 两台后端的 `request_discount_curve` 应答不带 `requestId`，不带 `refresh: false` 时还可能触发收益率曲线的联网更新；FOP 页的请求客户端按 `requestId` 配对、只发目录内的动作。因此新增 FOP 只读动作 `request_cost_basis_fop_discount_curve`：`cost_basis_ws.py` 校验请求（协议类型 `DiscountCurveRequest` / `DiscountCurveResponse`）、只接受 FOP 账本，调用两台后端注入的 `fetch_discount_curve`（`ib_server.py` 与 `historical_server.py` 都以 `refresh: False` 取缓存），没有缓存时应答 `fop_discount_curve_unavailable`。状态的 `fopLedger.discountCurve` 说明后端是否提供。
2. **asOf 取价格的观察时刻。** 反推 IV 的期限必须从价格被观察的时刻算起。`requestedAtUtc` 是服务器发出请求的时刻，实盘里与观察时刻只差几秒；在合成环境里两者可以相差数周，会使 asOf 落在账本事件之前。因此 asOf 取本批可用报价的最新 `observedAtUtc`，没有时才用 `requestedAtUtc`。曲线的“已过期”标注也按这个时刻计算，与报价新鲜度同一口径。
3. **锚点单独存放。** 锚点期货的估值放在 `quoteState.anchors`，不放进 `quotes` 和 `marks`：账本视图、对账快照和最低一级都与原来一样。
4. **随机性质测试的生成器。** 压力视图只需要期末持仓；P6 的生成器生成的是完整成交历史，且在 Python 一侧。JS 测试用固定种子的期末持仓生成器（两个月份的期货、美式与欧式期权），期权报价按随机 σ 定价以保证在模型边界内。

§10 另补了实施中出现的原因码（`option_expiry_unknown`、`product_rules_unsupported`、`range_invalid`、`stress_failed`、`stress_worker_unavailable` 与两个服务端码）；每个码在 `js/cost_basis_fop_messages.js` 都有中文说明与下一步，测试从源码收集后逐一检查。`event_time_unresolved` 不会出现：压力重放不带查询时点，账本已存的事件都算已发生。

### 15.2 实施复核第一轮的修正（2026-09-29）

实施复核提出四个 P2、两个 P3 问题。逐条核对属实，修正如下，正文已同步：

1. **过期曲线仍被使用（P2）。** 页面只把 `curve` 传给压力模块，丢了后端的 `status`；真实后端用 `cache_fallback` 表示曲线过期，并不设置 `curve.stale`。页面还按账本缓存曲线，一直开着的页面会一直用第一次读到的曲线。现在 `status` 随曲线传入，只有 `cached`/`updated` 可用，`cache_fallback` 或曲线自身标为 stale 时停止 `rate_curve_stale:<曲线日期>`（§2.3、§10）；页面每次计算都重新读取曲线。
2. **读取利率期间改参数没有取消（P2）。** 控制器只取消“已有 worker”或“已有结果”的计算，读取曲线的准备阶段两者都没有；参数也是在曲线返回后才读，所以返回后会按新参数、旧利率来源计算。现在一次计算在点击时冻结参数、假设利率、账本图与行情批，任何参数变化都取消尚无结果的计算，包括准备阶段（§9）。
3. **锚点改变了账本报价的可用性（P2）。** 账本报价的同步判断用的是整批（含锚点）的最新观察时刻，所以一个更新的锚点会把原本同步的账本报价全部打成 `out_of_sync`，账本 mark 变空。现在账本报价只按自身判断同步，与没有锚点时完全相同；压力视图另用整批一个同步窗口（`quoteState.stress`，§2.2），asOf 取这个窗口的基准时刻。
4. **参考月价格为零时没有扫描范围（P2）。** 模块支持美元范围，页面没有输入。现在页面有“美元范围”，填写后取代百分比；非正数停止 `range_invalid`，不再按绝对值读取（§5.3）。
5. **停止原因没有列全（P3）。** 编译在锚点检查后遇到任何原因就返回，跳过了期权报价检查；缺利率和缺期权 mid 同时存在时只报 `rate_unavailable`。现在先做所有互不依赖的检查、全部列出，都通过后才反推 IV；提前交割的无效选择也全部列出（§4.2）。
6. **逐点明细缺逐合约数据（P3）。** 逐点表只有参考月价格、盈亏与交割说明。现在逐点表列出各月情景价与每张期权的模型值（已结算的注明怎样结算），另有锚定表给出每张期权的 mid、锚定模型值、σ、情景 σ、利率、剩余天数与到期时刻（§8、§11）。

以上每条都有对应测试，并逐条做了变异守卫（改回复核指出的写法，测试必须失败），见验收记录。

### 15.3 实施复核第二轮（2026-09-30）

第二轮复核重放了第一轮的六个反例，都通过。另在真实浏览器里发现一个边界：数字控件输入 `1e` 这类无效内容时，`validity.badInput` 为真而 `.value` 是空串，页面把它当作“美元范围留空”，按百分比计算。复核方按用户要求直接修复：页面在读取曲线或启动 worker 之前检查美元范围控件的 `badInput`，无效时停止 `range_invalid` 并清除旧曲线；真正清空才按百分比计算（§5.3）。回归测试见验收记录。实施复核通过。
