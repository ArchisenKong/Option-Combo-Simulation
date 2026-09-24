# FOP 独立成本账本：分阶段验证记录

本文按 [实施计划](COST_BASIS_FOP_STANDALONE_PLAN.md) §13.3 的要求，逐阶段记录提交号、实际命令、通过/失败/跳过数、F 编号 → 用例 → 结果、真实样本缺项和产物位置。某一 F 项只有在其最后一个依赖阶段通过后才算完成（§14.4），下表中带括号限定的 F 项只表示该部分已覆盖。

## P0 — 基线与止损（2026-09-24）

### 环境

| 项目 | 值 |
| --- | --- |
| 分支 / worktree | `feat/cost-basis-fop-p0`，单独的 git worktree（放在 OneDrive 之外） |
| 基线提交 | `8491754`（`main` = `origin/main`） |
| 本阶段提交 | `84bdd9e`，已快进合并到本地 `main`（未推送） |
| schema | v10，P0 不改结构 |
| Python | 项目 venv（`config.local.ini`），`venv-py314` |
| Node | 系统 `node` |
| 浏览器 | Claude 桌面应用内置浏览器；本机没有 Playwright |

### 本阶段改动

- **服务端冻结**（`cost_basis_store.py`）：新增 `FROZEN_BOOK_SEC_TYPES = {'FUT'}` 与错误码 `futures_book_frozen`。`create_book` 拒绝 FUT；归档、追加、导入、拆股组追加/冲销、冲销事件、重置、重建、恢复存档/备份、保存快照共 10 条写路径都先经过 `_get_writable_book`。读取、导出和整本删除保持可用。两个后端共用同一个 store，因此都生效。
- **页面冻结**（`js/cost_basis_core.js`、`js/cost_basis.js`、`cost_basis.html`）：核心新增 `FUTURES_FROZEN_WRITE_ACTIONS` 和 `frozenFuturesWriteReason`；页面的统一请求入口在发送前拒绝这些写入；账本信息行显示停用说明；建账下拉中的 FUT 选项保留但禁用，提示文字同步更新。资源版本戳已用 `scripts/stamp_asset_versions.py` 重新生成。
- **README**：说明 FUT 账本暂停新建、现有账本只读的原因。
- **fixtures**：`cost_basis_fop_capabilities.json`（行类型能力清单初稿）、`tests/fixtures/cost_basis_fop/manifest.json`、`month_collision.json`、`legacy_fut_migration_list.json`。
- **测试**：新增 `tests/cost_basis_fop_guard.test.js`（已登记到 `tests/run.js`）、`tests/cost_basis_fop_guard_test.py`、阶段运行器 `tests/run_cost_basis_fop.js`。
- **旧测试的转换**：`FuturesLedgerStoreTests` 的 9 个写入测试已删除，其载荷改作守卫测试中的拒绝用例，经济算例存入迁移清单；v2 迁移测试只保留重建部分，建 FUT 账本改为断言拒绝；WS 同根 STK/FUT 测试改为断言 FUT 被拒；随机回归的 `verify_futures_store` 改为 `verify_futures_store_frozen`，纯核心 FUT 前缀检查照常运行；页面测试改为断言 FUT 选项被禁用。

### 命令与结果

| 标记 | 命令 | 结果 |
| --- | --- | --- |
| B 基线（改动前） | `node tests/run.js` | 1209 通过，0 失败 |
| B 基线（改动前） | `PYTHONPATH=. <venv>/python -m unittest discover -s tests -p 'cost_basis*_test.py'` | 333 个，全部通过，跳过 2 |
| B（改动后） | `node tests/run.js` | 1217 通过，0 失败（新增 8 个守卫用例） |
| B（改动后） | 同上 cost-basis Python | 333 个，全部通过，跳过 2（删 9 个旧 FUT 写入测试、加 9 个守卫测试） |
| 全量 Python（改动后） | `PYTHONPATH=. <venv>/python -m unittest discover -s tests -p '*_test.py'` | 1007 个，全部通过，跳过 2。改动前没有单独跑全量，按增删推算同为 1007 |
| P0 | `node tests/run_cost_basis_fop.js --stage P0` | 8 通过，0 失败，退出码 0 |
| P0 | `PYTHONPATH=. <venv>/python -m unittest discover -s tests -p 'cost_basis_fop_guard_test.py'` | 9 个，全部通过 |
| 资源 | `python3 scripts/stamp_asset_versions.py --check` | asset versions are current |
| 随机回归 | `PYTHONPATH=.:tests <venv>/python scripts/verify_cost_basis_randomized.py --seed 0 --cases 40 --steps 40 --store-cases 10` | 通过；`futures_store_frozen` 覆盖 5 次 |

### 守卫本身的有效性

- **运行器**：未知阶段、缺少 `--stage` 时退出码 2；清单里的用例被改名、Python 用例未登记、套件未注册到 `tests/run.js`、fixture 缺失时，都报错并以退出码 1 结束。每次都用备份逐字节恢复，并用 shasum 核对。
- **Python 变异**：把 `FROZEN_BOOK_SEC_TYPES` 置空后运行守卫测试：9 个测试里 22 个失败、6 个错误，覆盖两个建账用例和全部写路径子用例。
- **JS 变异**：临时去掉页面请求入口的拒绝分支后，“页面在发送前拦截 FUT 写入”用例失败；恢复后文件哈希一致。

### 浏览器核对

- **环境**：隔离后端 127.0.0.1:8799，使用临时库，内含一个 STK 账本和一个用原始 SQL 写入的旧 FUT 账本；静态服务 127.0.0.1:8124，只服务 worktree。`.claude/launch.json` 只临时加了两个配置，核对后已逐字节恢复。
- **结果**：
  - 建账下拉中 FUT 选项为禁用，提示文字已更新；
  - 旧 FUT 账本的账本信息行显示停用说明；
  - 在页面上点击冲销，弹出“冲销失败：FUT/FOP 账本已停用……”；
  - 核对临时库：事件未被冲销，没有快照，账本未归档；
  - 控制台唯一的错误是离开上一页面时 Chrome 的 `beforeunload` 提示。
- **过程问题**：第一次打开静态服务根路径时加载的是主页面 `index.html`，它以默认端口连到了正在运行的真实后端 127.0.0.1:8765，停留一到两分钟。期间只有页面自动加载，没有点击任何操作；发现后立即离开，并确认该连接已断开。

### F 编号 → 用例 → 结果

| F 项（部分） | 用例 | 结果 |
| --- | --- | --- |
| F35（入口） | JS：核心拒绝理由、页面发送前拦截、建账选项禁用；Python：store/WS 拒绝建账与全部写路径 | 通过 |
| F38（P0 部分） | JS：动作分类、核心拒绝理由、页面拦截、只读说明；Python：store/WS 拒绝 | 通过 |
| F11（旧 FUT 账本只可导出/删除；FUT 备份不能恢复到 STK 账本） | Python：读取/导出/删除仍可用（store 与 WS）；FUT 备份恢复到 STK 账本被拒 | 通过 |
| F28（STK 写入不受影响） | Python：STK 追加/导入/冲销/快照/归档；完整 JS 与 cost-basis Python 回归 | 通过 |
| F03、F35（金标准向量） | JS：月份碰撞金标准的独立重放 | 通过 |
| P0 门槛：能力清单初稿 | JS 与 Python：格式、状态合法、没有 `real_verified` 键 | 通过 |
| P0 第 4 步：迁移清单 | JS：清单覆盖全部被转换的测试，且旧类已删除 | 通过 |

### 真实样本

无。P0 按 §9.7 不再要求真实样本；能力清单中所有键都不是 `real_verified`。

### 产物

- 基线与运行输出保存在本会话的 scratchpad，未写入仓库。
- fixtures：`tests/fixtures/cost_basis_fop/`、`cost_basis_fop_capabilities.json`。

### 未完成与后续

- P0 已完成，提交为 `84bdd9e` 并已合并到本地 `main`（未推送）。
- 计划文件随该提交入库；主工作区原先未跟踪的副本与之逐字节相同，合并时已移走。
- P1 起的工作见计划 §13.3。

## P1 — 冻结可互测的契约并完成类型骨架（2026-09-24）

### 环境

| 项目 | 值 |
| --- | --- |
| 分支 / worktree | `feat/cost-basis-fop-p1`，同一 worktree（OneDrive 之外） |
| 基线提交 | `84bdd9e`（P0 已合并到 `main`） |
| 本阶段提交 | 见 `main` 上的 P1 提交（用户确认后提交并快进合并，未推送） |
| schema | 仍为 v10；DDL 只是结构草案，P2 才迁移 |

### 本阶段改动

- **服务端显式类型**（`cost_basis_ws.py`）：`create_cost_basis_book` 必须带 `secType`；只有 STK 缺省每张 100，FUT 不给点值默认值。所有内部调用方与测试已同步。store 的 Python 接口默认值保持不变，只供内部代码使用。
- **公共层** `js/cost_basis_common.js`：
  - 动作目录，逐动作标明读/写与允许的页面；旧页面的 `ALLOWED_CLIENT_ACTIONS` 由它派生，内容与顺序和 P0 完全相同；
  - 按账本类型路由（`bookKind`、`bookUrl`、`bookIdFromSearch`、`routeForBook`）；
  - 请求客户端。

  核心脚本缺少公共层时直接报错。页面、压力 Worker 的依赖正则和测试加载器都先加载公共层。
- **旧页面**：`start()` 按 `?bookId=` 打开指定账本。链接一直挂起，直到该账本出现在列表中并被打开，或用户另选账本；期间显示“找不到链接指定的账本”，不打开任何其他账本（第二次审查第 6 条、第三次审查第 1 条）。建账表单的类型不预选（第二次审查第 5 条）。
- **FOP 页面骨架**：`cost_basis_fop.html`、`cost_basis_fop.css`、`js/cost_basis_fop.js`。
  - 只允许发送状态和账本目录两个动作，不写任何数据；
  - STK 账本在渲染前就被送回 `cost_basis.html?bookId=…`；
  - FUT 账本只显示身份，并给出"在旧页面查看、导出或删除"的链接；
  - 过期书签、后端不可用会给出说明，不做猜测。

  页面已登记到资源戳脚本和资产测试。
- **契约**（`tests/fixtures/cost_basis_fop/contract/`）：
  - `ddl_draft.sql`：书表按 §8.2 第 7 条重建，另加 10 张 FOP 表；
  - `event_columns.json`：事件表 50 列逐列处置；
  - `event_kinds.json`：8 个允许种类、5 个拒绝种类及 E 的求和口径；
  - `write_coverage.json`：13 个写动作、12 个读动作、3 个计划中的动作；
  - `protocol.json`：54 个类型、32 个正例、68 个反例，另有 `formats`（时间文本格式）、`domainRules`（12 条跨字段规则，由 P2 的服务端域校验实现）和 `domainCases`（27 个同引用重复来源的算例，P2 须在真实 store 上逐个跑通）；
  - `core_output.json`：16 个类型、4 个正例、7 个反例，示例为 §9.6 算例、缺报价、期初权利金未知、as-of 时刻落在交割时间范围内。
- **两个独立读取器**：JS 版 `tests/helpers/fop-contract-schema.js` 与 Python 版（在契约测试中），必须对每个示例报出相同的错误。
- **测试**：新增 `tests/cost_basis_fop_identity.test.js`（16 个，已登记到 `tests/run.js`）和 `tests/cost_basis_fop_contract_test.py`（18 个），测试清单登记了 P1 套件与契约文件。阶段运行器自身的测试 `tests/cost_basis_fop_runner.test.js`（4 个）登记在 P0。
- **已有测试的调整**：页面脚本清单和压力 Worker 依赖加上公共层；WS 与访问控制测试的建账请求补上 `secType`；资产测试加入新页面。
- **文档**：AGENTS.md（六个前端入口）、README。

### P1 中的决定

- 旧页面在 P1 不自动把 FUT 账本转到 FOP 页面。在 FOP 页面能导出或删除之前，旧 FUT 账本的查看、导出、删除仍只在旧页面可用；FOP 页面给出链接。
- FOP 页面用公共层的请求客户端；旧页面保留自己的 `request()`，本阶段不迁移，以免改动面过大。
- 契约读取器目前只在测试中使用。P2 的服务端域校验必须接受全部正例、拒绝全部反例。
- DDL 草案中：
  - `settlement_type` 只允许 `physical_future`，`option_strike` 必须大于 0，对应 §1.2 的首版边界；
  - `product_rules` 不设 CHECK，由代码中的支持清单校验，这样新增产品不必重建表；
  - 周期表沿用计划名 `cost_basis_fop_cycles`，只存边界；
  - 没有 ROLL 表，也没有资金对账表。

### 命令与结果

| 标记 | 命令 | 结果 |
| --- | --- | --- |
| B（改动后） | `node tests/run.js` | 1237 通过，0 失败（P1 共新增 20 个） |
| B（改动后） | `PYTHONPATH=. <venv>/python -m unittest discover -s tests -p '*_test.py'` | 1025 个，全部通过，跳过 2（P1 共新增 18 个） |
| P1 | `node tests/run_cost_basis_fop.js --stage P1` | 28 通过（P0 的 12 个加 P1 的 16 个），0 失败 |
| P1 | `PYTHONPATH=. <venv>/python -m unittest discover -s tests -p 'cost_basis_fop_contract_test.py'` | 18 个，全部通过；两个读取器比对的测试实际运行，没有跳过 |
| 运行器 | `node tests/run_cost_basis_fop.js --stage P6` | 退出码 1，逐个列出 P2–P6 没有登记用例，不运行任何用例 |
| 资源 | `python3 scripts/stamp_asset_versions.py --check` | asset versions are current |
| 随机回归 | `PYTHONPATH=.:tests <venv>/python scripts/verify_cost_basis_randomized.py --seed 0 --cases 40 --steps 40 --store-cases 10` | 通过 |

### 守卫本身的有效性

- 契约中 68 个协议反例和 7 个核心输出反例，每个都恰好报出一个错误，而且就是预期的那个，没有连带错误。两个读取器的测试现在都按“恰好这一个错误”断言，原先只要求包含预期错误。
- 把 JS 读取器的 `exclusiveMin` 从 `<=` 改成 `<`（在草稿副本上），比对测试就会指出"零行权价"反例上两边结论不同。
- 旧写法的父表重建在开启外键时失败，已由测试复现。

### F 编号 → 用例 → 结果（P1 部分）

| F 项（部分） | 用例 | 结果 |
| --- | --- | --- |
| F01 | 服务端拒绝无类型建账、FUT 无默认点值；按后端类型路由；书签只接受合法 token；错页被送回；过期书签有说明；旧页面按链接打开账本 | 通过 |
| F02（P1 部分） | 同根的 STK 与 FUT 账本分别路由到各自页面；唯一索引在重建后保留 | 通过 |
| F27（P1 部分） | FOP 页面只加载公共层与自身控制器，只发送目录内的读取动作；旧页面动作清单不变 | 通过 |
| F37 | 书表可空乘数且 STK 仍必须有；FOP 事件身份列逐列处置；FUT 建账无默认点值 | 通过 |
| F38（P1 部分） | FOP 页面没有任何写动作；写标志与 P0 冻结清单一致 | 通过 |
| F45（P1 部分） | 文档顺序在开启外键时可用；旧写法失败 | 通过 |
| F46 | 事件列与种类无遗漏；协议反例覆盖身份列、tag、种类白名单、fee 两列计费、复合交割时间 | 通过 |
| F15、F18（P1 部分） | DDL 拒绝零/负 strike；E 的求和不含期权佣金 | 通过 |
| F01（审查修正） | 旧页面失效书签不打开其他账本；建账类型不预选，未选类型不能建账 | 通过 |
| F21、F44（P1 部分） | 写包携带来源记录及原始字段；示例的能力键都在能力清单中；报表行只能经导入提交 | 通过 |
| F22、F41（P1 部分） | 时间只有一种固定宽度写法，保留来源给出的全部精度；顺序规则只比较固定宽度字段；DDL 拒绝其他写法 | 通过 |
| F21、F24（P1 部分） | 同引用来源只有经济内容一致才跳过，价格、数量、费用、成本归属、开平标记、期初基准、交割合约、费用来源、合约、成交时刻或排序证据有变化即整批报冲突；只改时间原文、时区写法或绑定版本（交割不变）算重复并报告 | 通过 |
| F36（P1 部分） | 费用可以用包内键引用同一写包里的成交，服务端解析为事件 id 后只存 id | 通过 |
| F23、F24（P1 部分） | 每个写请求都带身份、已审阅的账本版本和幂等键 | 通过 |
| F42（P1 部分） | 未知成本、交割时刻未定都输出为空值加原因，不输出 0 | 通过 |

### 浏览器核对

- **环境**：隔离后端 127.0.0.1:8799（临时库）；静态服务 127.0.0.1:8125，服务的是临时目录，根路径是空白页，只链接所需文件；打开任何账本页之前先设定端口。
- **结果**：
  - 列表页按类型分组，链接带 `bookId`；
  - FUT 账本页显示身份和旧页面链接；
  - 在 FOP 页面打开 STK 账本，被送回旧页面，旧页面按链接选中了排在第二位的 TQQQ 账本；
  - 过期书签显示"找不到账本"；
  - 手机宽度 375 没有横向滚动，深色和浅色都正常；控制台没有错误。
- **收尾**：先关标签页，再停服务；`.claude/launch.json` 逐字节恢复；确认没有到 8765 的连接。
- **过程问题**：本阶段核对开始时发现，P0 核对遗留的旧页面标签在隔离后端停止后，按默认端口重连到了真实后端 8765。原因是 P0 收尾时先清空了该页面的端口设置、后停服务。真实后端日志 `logs/ib_server.log` 显示它只做了读取：03:48:46 读账本目录与第一个账本的事件，04:28:09 后端重启后又读了一次。P0 时误加载的主交易页 03:46:45–03:47:21 只请求了订单快照、平均成本快照和一次 SPY 行情订阅，没有发出订单。同一时段日志里的两次导入写入（02:46、03:04）早于本次会话第一次打开浏览器（03:46 之后），来自用户自己的页面会话。该标签已关闭，今后的核对顺序已记入记忆。

### 审查修正（2026-09-24，第二次审查）

用户转来的审查指出 P1 的 6 个问题，并指出 P0 验收运行器的问题仍在。先在旧版上逐条复现，全部属实：

| # | 问题 | 旧版复现 | 修正 | 证明 |
| --- | --- | --- | --- | --- |
| 1 | 冲销请求没有身份和版本保护 | 不带两字段通过；带上反而报 `additional` | `VoidRequest`、`SnapshotRequest` 与其他写请求一样带 `bookIdentity`、`expectedLedgerVersion` | 新测试逐个检查每个写请求的保护字段和幂等键；去掉冲销的保护字段，测试失败 |
| 2 | 原始 CSV 证据没有提交通道 | 事件来源引用不接受 `rawFields`；写包只有合约、绑定、事件 | 写包新增 `sourceRecords`（原始字段为字符串映射，报表行必须带能力键和段落）；`statement` 改为有类型的文件登记；事件的来源引用只记分配；跨字段规则写入 `domainRules` | 新增反例；新测试核对示例遵守来源规则，它当场发现旧示例用追加请求提交报表行，已改正 |
| 3 | 成本未知无法输出 | 未知成本输入通过，输出 `remainingNetPremium: null` 报 `null` | 剩余权利金、FUT 均价、基础金额、已实现盈亏改为“数值或原因”；持仓张数改为同类的 `Count`，覆盖交割时刻未定的 as-of 视图 | 新增两个正例、三个反例 |
| 4 | 时间范围比较颠倒 | `05Z → 05.1Z` 被拒，反向范围通过 | 时间统一为固定宽度格式（第三次审查后改为 6 位小数，见下节）；两个读取器只在两端都合法时比较顺序；DDL 用 GLOB 拒绝其他写法 | 新增混合精度反例和 DDL 测试；恢复旧格式或去掉 GLOB，测试失败 |
| 5 | 建账表单默认 STK | 未动类型选择时提交 STK | 新增空白占位选项且不可选回；未选类型时创建按钮禁用，处理函数也拒绝；建成后类型复位 | 行为测试；去掉检查，测试失败 |
| 6 | 过期书签静默打开其他账本 | 书签指向已删账本时打开了列表第一本（可能是另一账户） | 显式书签失效时显示说明、不打开任何账本、重连后仍等待；用户选择后恢复正常 | 行为测试；去掉判断，测试失败 |
| P0 | `--stage P6` 只跑前面阶段的用例却成功 | `--stage P6` 输出 through P6 | 从 P0 到目标阶段，任一阶段没有登记用例即报错退出；计划 §14.4 同步 | 运行器测试 4 个；去掉检查，3 个失败 |

浏览器核对（隔离后端 8799、空白首页站点 8125，打开账本页之前先设端口）：
- 失效书签：标题“找不到账本”，列出原因，下拉框停在占位项，没有打开任何账本；
- 有效书签指向另一账户的账本：打开的正是该账本；
- 建账：类型显示“请选择账本类型”，未选时创建按钮禁用；选 STK 后每张股数填 100、按钮可用；在临时库建成后类型复位为空；
- 控制台没有错误。收尾时先关标签页再停服务，`.claude/launch.json` 逐字节恢复，没有到 8765 的连接。
- 核对时真实后端已经停止：日志末尾是 SIGTERM 触发的退出，最后一次写入在 13:03，早于本轮核对（13:18 起）。TWS 从 12:43 起一直拒绝连接。本轮核对没有发出任何终止信号。

### 审查修正（2026-09-24，第三次审查）

第三次审查确认上一轮的冲销保护、原始字段通道、未知成本输出、建账类型和运行器都已修好，另指出 3 处问题，均属实：

| # | 问题 | 复现 | 修正 | 证明 |
| --- | --- | --- | --- | --- |
| 1 | 书签仍可能打开错误账本 | 第一次收到空列表时清空了 `bookId`、链接也没有保留；刷新后书签指向第二本，却打开了第一本 | 链接一直挂起，直到该账本出现在列表中并被显式选中，或用户另选；空列表或缺该账本的列表都只显示“找不到账本”并等待；标题同样显示“找不到账本” | 行为测试覆盖空列表→恢复列表、缺账本→恢复、挂起期间用户另选三种情形；撤掉显式选中，测试失败；浏览器里用首次返回空列表的隔离后端复现，刷新后打开的是书签指定的账本 |
| 2 | 时间修复丢弃了有效精度 | 上一轮规定小数秒向下取整，14:30:05.900 的成交会被 as-of 14:30:05 提前计入 | 经济和证据时间统一为 `YYYY-MM-DDTHH:MM:SS.ffffffZ`（固定 6 位小数、27 个字符），来源给出几位就保留几位，其余补零，不取整、不截断；比微秒更精细的来源不截断，改记为前后两个微秒之间的时间范围。服务器写入时刻（createdAtUtc 等）另设 `RecordedAtUtc`，沿用 store 现有的整秒写法，只作记账，不参与经济时间比较 | DDL 测试断言 as-of 14:30:05.000000 不计入 14:30:05.900000 的成交；新增短小数、无小数、纳秒、秒内倒序范围等反例；恢复整秒格式或去掉 DDL 的小数位约束，测试失败 |
| 3 | 去重规则会吞掉同引用的经济修订 | 上一轮规定来源引用已存在即视为重复、跳过 | 规则改为：同引用时比较经济内容（报表数量与费用；所分配事件的种类、合约条款、张数、价格、现金、费用、全部时间事实；分配的角色、数量、费用），一致才跳过；任何不同都使整批导入以 `import_revision_conflict` 失败，并列出所有不同字段；只在经济内容之外的原始字段不同（如描述）仍算重复，但会报告 | `domainCases` 9 个算例：原样重复、只改描述、合约记录换 id 但条款相同、改价格、改数量、改费用、改合约、改成交时间、不同命名空间；测试用参考比较逐个核对预期；把“改价格”的预期改回旧规则（重复），测试失败 |

### 审查修正（2026-09-24，经济字段去重补齐）

上一轮参考比较器只比较了通用金额、数量、合约和时间，漏掉了会改变成本口径、归属或校验结果的事件字段。本轮在 P1 契约和参考比较器中补齐：

- `includeInCost`、`openClose`、`feeCategory`、`feeIsRefund`、`feeSourceEventId`、`adjustmentScope`、`baselineKind`、`baselineAsOfUtc`、`bindingRef`（身份及版本）。同引用来源的这些字段不同，必须返回 `import_revision_conflict`，不能作为重复记录跳过。
- `domainCases` 从 9 个增加到 22 个。新增 11 个只改变一个经济字段的冲突案例，覆盖 fee、manual_adjust、futures_trade、option_trade、opening_balance、option_assignment、option_exercise；另加退款标记与现金符号同时变化的合法案例，以及只改备注仍算重复的正例。新增来源记录均为合成的比较用例，不表示真实 IBKR CSV 格式已验证。
- 新增字段覆盖检查：8 种事件的每个字段都必须明确归入直接比较、专门比较或身份/来源/备注组，组之间不得重叠。以后新增事件字段而未明确去重规则时，测试会失败。
- 新增单字段案例检查：变更前后均通过结构校验，来源记录和合约不变，只允许指定事件字段变化，并严格断言冲突字段。临时在内存中恢复旧版六字段比较后，两项新增测试合计出现 12 处失败（字段覆盖 1 处、单字段案例 11 处），证明能捕获本轮遗漏。

本轮实际验证（均在 P1 工作目录执行）：

| 命令 | 结果 |
| --- | --- |
| `node tests/run.js` | 1237 通过，0 失败 |
| `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. <venv>/python -m unittest discover -s tests -p 'cost_basis*_test.py'` | 351 项：349 通过、2 跳过，0 失败 |
| `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. <venv>/python -m unittest discover -s tests -p 'cost_basis_fop_contract_test.py'` | 18 通过，无跳过 |
| `node tests/run_cost_basis_fop.js --stage P1` | Node 28 通过，0 失败；清单另登记 Python 守卫 9 项、契约 18 项 |
| `python3 scripts/stamp_asset_versions.py --check` | asset versions are current |
| `git diff --check` | 通过 |

本轮没有重跑全仓 Python 测试、浏览器或连接 TWS。修正范围是 P1 的协议、参考比较器与验收案例；P2 必须在真实 store 和事务路径上实现相同语义，并通过全部 22 个 `domainCases`。

### 跟进修正（2026-09-24，绑定、时间原文与包内费用来源）

审阅上一节的修复后，按用户确认再改三处：

| # | 问题 | 修正 | 证明 |
| --- | --- | --- | --- |
| 1 | 绑定按 id 和版本比较：交割期货不变、只升级证据的新绑定版本会被误判为修订，重导一份未变的报表会被挡住；合约却按条款比较，两者不一致 | 新规则 `delivery_follows_binding`：指派或行权引用的绑定，其期权与期货必须就是事件的 `contractRef` 与 `deliveredContractRef`。绑定因此按它绑定的合约对比较（已由两个合约的条款覆盖），不看 id 与版本；版本不同但交割相同算重复并报告，采纳新版本走元数据提交，不是导入的副作用 | 两个“只改绑定版本”的单字段案例改为重复并报告；新增“绑定改到另一张期货”案例，报交割合约条款冲突；把绑定改回按版本比较，6 处失败 |
| 2 | 时间原文和时区逐字比较：同一时刻换一种时区写法或文本格式会被误判为修订 | 只比较交易所交易日、成交时刻、时间范围和排序证据；`sourceTimeText`、`sourceTimezone` 的差异只报告。时间事实也纳入字段覆盖检查，每个都必须归入比较或报告之一 | 新增“换时区名称”（重复并报告）与“排序证据变化”（冲突）两个案例；把时区改为比较或把排序证据改为只报告，对应案例失败 |
| 3 | 费用只能用已入库事件 id 引用来源，全历史导入时同一写包里的成交还没有 id | 每个事件新增可选的 `packageKey`（包内唯一、不入库）；费用的 `feeSourceEventId` 改为 `feeSource`，二选一填 `eventId`（已入库、非费用事件）或 `packageKey`（同包非费用事件），服务端在同一事务里解析成 id 后只存 id（新规则 `package_keys_resolve`）；去重时按解析出的事件比较 | 新增正例“随成交一起到达的费用用包内键引用它”和“迟到费用用事件 id 引用”，反例“两种引用同时填写”“旧字段名”；新增“随已匹配成交重导的费用仍是同一笔”（重复）与“随新成交到达的费用不是原费用”（冲突）两个案例；示例写包测试检查包内键唯一且指向非费用事件；去掉匹配解析，对应案例失败 |

协议文件从此不再用临时生成脚本重建（旧脚本不含上一节的算例），改为脚本直接修改 JSON，格式与原文件一致。

| 命令 | 结果 |
| --- | --- |
| `node tests/run.js` | 1237 通过，0 失败 |
| `PYTHONPATH=. <venv>/python -m unittest discover -s tests -p '*_test.py'` | 1025 个，全部通过，跳过 2 |
| `PYTHONPATH=. <venv>/python -m unittest discover -s tests -p 'cost_basis_fop_*_test.py'` | 27 个，全部通过；两个读取器比对一致 |
| `node tests/run_cost_basis_fop.js --stage P1` | 28 通过，0 失败 |
| `python3 scripts/stamp_asset_versions.py --check` | asset versions are current |

### 未完成与后续

- P1 已提交并快进合并到本地 `main`（未推送）。
- 已在 P2 完成：`delivery_follows_binding`、`package_keys_resolve` 在写路径实现；重复来源规则在域模块实现并跑通全部 27 个 `domainCases`，导入（P4）接入。
- P2 以本阶段冻结的契约为前置：原子迁移、FOP 账本元数据与写入核对、合约/绑定/来源、只读身份解析、备份新格式。正式的 FOP 写入仍然关闭。

## P2 — 存储、版本、来源图和只读身份解析（2026-09-24）

### 环境

| 项目 | 值 |
| --- | --- |
| 分支 / worktree | `feat/cost-basis-fop-p2`，同一 worktree（OneDrive 之外） |
| 基线提交 | `330cad5`（P1 已合并到 `main`） |
| 本阶段提交 | 未提交，等待用户确认 |
| schema | v10 → v11 |

### 本阶段改动

- **schema v11**（`cost_basis_store.py`）：
  - 建表语句逐条取自 P1 冻结的 DDL 草案，测试逐条比对；
  - 书表按 §8.2 第 7 条的顺序重建（外键在 BEGIN 前关闭）；
  - 新建库先建成 v10 再走同一条迁移，所以任何 v11 库结构都相同。
- **迁移前自动备份**：已有库在第一步迁移前，先用 SQLite 备份接口在旁边写一份 `cost_basis.pre-v11-from-v10-<UTC 时间>-<随机后缀>.db`，并核验完整性、版本号和行数；备份失败则不迁移，账本保持不可用。迁移中任何一步失败都整体回滚，文件保持 v10 原样。
- **无外键的三张表**：不允许迁移新增孤儿行；更早的删除遗留的孤儿行保留并报告，不删除、不阻断升级。同时修正整本删除漏删导入登记的旧缺陷。
- **书表序列化**：股票乘数可以为空；新增 `fop`（FOP 账本元数据）和 `legacyFutures` 两个字段。没有 FOP 元数据的 FUT 账本仍只能导出和删除。
- **新模块**：
  - `cost_basis_fop_domain.py`：纯规则；
  - `cost_basis_fop_store.py`：FOP 关系图的读写，以 mixin 并入 `CostBasisStore`；
  - `cost_basis_fop_schema.py`：运行时契约读取器，由 P1 测试中的 Python 读取器迁移而来；
  - `cost_basis_fop_broker.py`：只读合约解析；
  - `cost_basis_fop_protocol.json`：契约类型的运行时副本，测试保证与冻结契约完全一致。
- **写入闸门**：所有 FOP 写入都要求 store 以 `fop_writes_enabled=True` 构造。两个服务端默认关闭，公共入口仍报 `futures_book_frozen`；股票入口永远不写 FOP 账本。
- **写路径**：
  - 建账：FUT，股票乘数为空，同时写 FOP 元数据；
  - 每个写动作（追加、冲销、元数据提交、清空、两种恢复、重建）都在同一个写事务内依次核对：本引擎是否支持该账本的引擎版本和产品规则、请求声明的引擎版本、身份、已审阅的账本版本；
  - 请求登记表按 token 记下动作、请求摘要和首次结果：同 token 同请求返回首次结果（之后的元数据修订、清空或恢复都不影响），换动作、换内容一律拒绝；被拒绝的请求不占用 token；登记表随备份导出，以同一账本 ID 恢复（包括恢复到新库）时一并带回；
  - 共享事件表的身份列一律为空，`trade_date/broker_timestamp` 由服务端按 `[tws] timezone` 投影；
  - 合约“一份合约一条记录”：conId 冲突、同一结构身份两条记录、在写包里夹带新修订都会被拒绝；
  - 交割的方向、张数、价格（即行权价）按 §6.1 校验，绑定必须与交割的合约对一致（`delivery_follows_binding`）；
  - 费用可以用已入库事件 id 或包内键引用成交（`package_keys_resolve`）；
  - 每次写入后整本回放数量、周期锚点和费用来源；
  - 一条来源可以分配给多个事件：来源表只存一次并负责去重，这些事件的 `external_ref` 在来源键后加上各自的事件 ID；
  - 账本摘要覆盖整本内容：事件各列、FOP 细节与引用、合约和绑定每个修订的全部条款与证据、周期、来源原文与分配、元数据操作、引擎和产品规则（只排除写入时间戳和导入批次）；股票账本的摘要与 v10 完全相同。
- **元数据操作**：
  - 采纳绑定：只能是下一个版本；服务端算出受影响的事件，并核对请求的清单；已确认交割改指另一张期货属于经济更正，拒绝；
  - 修正合约：只能补充原本为空的字段或升级证据；补充后若与另一条当前记录成为同一份合约（结构身份或 conId 相同），拒绝；
  - 关闭、撤销周期边界；
  - 每个操作都有操作记录和引用修订记录。
- **整图**：
  - v2 备份导出与恢复：写入前先校验整张关系图（`check_graph`：修订链、合约身份、每条绑定的合约类型、来源分配上限、周期锚点、每个事件指明的主来源、引用修订、重建映射和请求登记，没有事件使用的记录也要校验，所有 ID 必须在本图内）；每个事件按种类规则重验，引用必须在图内解析；写入后与普通写入同样整本回放（一个事件只能关闭一个周期）；恢复采用备份的历史范围；恢复到另一账本 ID 时整图换新 ID，请求登记不带过去；
  - 重置存档与恢复；
  - 重建：旧的周期边界只映射到“同一主来源且经济内容相同”的唯一新事件，映射不了必须在同一请求中撤销，否则拒绝，并记录完整的旧→新映射；
  - 整本删除清理整张图。
- **绑定凭据**：只读解析签发带过期时间的服务端凭据（HMAC，进程内密钥，重启即失效）。浏览器自带的状态字符串、过期或篡改的凭据都会被拒绝。
- **只读解析**：交割月只取底层期货的 `ContractDetails.contractMonth`；限制单批 20 个、并发 4、单次超时 10 秒。`ib_server` 注入 `reqContractDetailsAsync` 包装；`historical_server` 没有注入，返回 `fop_contract_details_unavailable`。
- **WS**：FOP 消息先按冻结类型校验整条消息；新增 `commit_cost_basis_fop_metadata`、`request_cost_basis_fop_contract_details` 两个动作；状态响应报告 `features.fopLedger`。前端公共目录登记了这两个动作，但暂时不允许任何页面发送。
- **协议契约**：新增重置、重建、按存档恢复、按备份恢复四种 FOP 请求，以及合约解析的请求和响应；冲销、元数据提交、清空和两种恢复请求带 `engineVersion`；备份中的事件指明主来源（`primarySourceId`），备份带请求登记（`RequestRecord`）。现为 63 个类型、39 个正例、81 个反例。重复来源的比较规则在域模块实现为 `repeat_outcome`，逐个跑通 27 个算例（导入在 P4 接入）。
- **页面**：FOP 页面区分独立 FOP 账本和旧版 FUT 账本，FOP 账本不给旧页面链接；股票页账本信息在乘数为空时显示“见合约记录”。
- **测试**：新增 4 个 Python 套件（store 50、domain 10、ws 7、broker 5），已登记到测试清单 P2 阶段；JS 身份套件新增 1 个用例。几个旧迁移测试改为先撤掉 v11 新增的表再回退版本号。
- **文档**：README 的升级与回滚说明、ARCHITECTURE、DEV_HANDOVER、AGENTS。

### P2 中的决定

- FOP 存储代码放在单独的 mixin 模块，不再扩大 4700 行的股票 store。
- 服务端的形状校验直接使用契约类型（运行时副本），“接受全部正例、拒绝全部反例”由构造保证，并有测试。
- 回放顺序先用“生效起点、终点、录入顺序”的简化比较；§9.2 的歧义组判定属于 P3。
- 重建只保留能唯一映射的周期边界；费用来源由新写包自己用包内键表达。
- 协议文件改为用脚本直接修改 JSON；P1 的临时生成脚本已退役。

### 命令与结果

| 标记 | 命令 | 结果 |
| --- | --- | --- |
| B（改动后） | `node tests/run.js` | 1238 通过，0 失败 |
| B（改动后） | `PYTHONPATH=. <venv>/python -m unittest discover -s tests -p '*_test.py'` | 1097 个，全部通过，跳过 2（P2 新增 72 个） |
| P2 | `node tests/run_cost_basis_fop.js --stage P2` | node 29 通过；清单另列 Python 6 个套件共 99 个用例 |
| P2 | `PYTHONPATH=. <venv>/python -m unittest discover -s tests -p 'cost_basis_fop_*_test.py'` | 99 个，全部通过 |
| 运行器 | `node tests/run_cost_basis_fop.js --stage P6` | 退出码 1，列出 P3–P6 没有登记用例 |
| 资源 | `python3 scripts/stamp_asset_versions.py --check` | asset versions are current |

### 守卫本身的有效性

每项都在副本上撤掉修复，确认对应测试会失败：
- 恢复到另一账本时不换 ID；
- 重建时锚点映射不了也放行；
- 去掉交割方向检查（篡改的备份被周期锚点检查挡下）。

凡是经过 FOP 写入闸门的存储方法，都必须在写路径覆盖表中登记，由契约测试检查。

### 真实账本副本上的迁移演练

用 SQLite 备份接口从只读连接复制真实 `cost_basis.db` 到临时目录，只在副本上迁移，结果：
- 5 个股票账本、478 条事件、28 份重置存档等各表逐行不变；
- 每个账本的摘要和事件列表与迁移前完全一致；
- 外键检查为空，完整性检查正常；
- 迁移前备份自动生成。

核对后已删除副本，真实数据目录没有任何改动。合并后实盘后端下一次重启时会在真实库上执行同样的迁移，并在旁边留下备份文件。

### F 编号 → 用例 → 结果（P2 部分）

| F 项（部分） | 用例 | 结果 |
| --- | --- | --- |
| F03、F04、F05 | 交割月取自 `contractMonth`；周期权跟随 `underConId`；conId 冲突、同一合约两条记录（新增或修正后）、多个候选都报告不猜 | 通过 |
| F11 | 外来旧 FUT 账本只能导出和删除；v1 备份不能恢复到 FOP 账本 | 通过 |
| F23、F24 | 每个写动作在写事务内核对支持的引擎、声明的引擎、身份、版本，逐项拒绝后整库不变；同版本并发只成功一个；同 token 不同请求拒绝、同请求返回首次结果（含之后的元数据修订）；一条来源分配给多个事件；内容不同的恢复使旧预览失效；各处注入故障后所有表不变 | 通过 |
| F25 | 迁移前备份、迁移失败保持 v10、股票行不变、v2 备份整图往返（含历史范围、主来源、请求登记）、重置存档往返、新库恢复后原请求可重试、整本删除 | 通过 |
| F26（P2 部分） | 两个后端共用协议；没有解析器的后端明确报错；单个请求出错按请求 ID 回复 | 通过 |
| F34、F46 | 身份列、股票字段、白名单外种类、带数量事件排除出成本都被拒绝；服务端生成交易日投影 | 通过 |
| F37、F45 | 书表可空乘数；迁移在开启外键的连接上完成；外键检查为空；无外键表的孤儿行处理 | 通过 |
| F38（P2 部分） | 默认后端 FOP 写入关闭，测试 store 显式打开；引擎版本不受支持的账本只能导出和删除 | 通过 |
| F39（P2 部分） | 恢复到另一账本整图重映射；重建的边界映射或显式撤销；悬空绑定、跨账本的锚点和分配、断开的修订链、超额分配、没有事件使用的来源都在写入前拒绝 | 通过 |
| F40（P2 部分） | 伪造、过期、他账本、他期货的凭据拒绝；采纳新绑定只改预览列出的引用，摘要改变 | 通过 |

### 审查修正（2026-09-24，P2 第一轮审查）

审查意见见 `CODE PLAN/COST_BASIS_FOP_P2_REVIEW_20260924.md`（R1–R7）。7 项先用审查附带的探测脚本在本分支复现，全部成立；修复后逐项转为正式测试。

| 编号 | 问题 | 修正 | 正式测试 |
| --- | --- | --- | --- |
| R1 | 账本摘要只含引用和修订号，内容不同的恢复版本不变 | FOP 账本摘要改为覆盖整本内容；同内容同版本，内容不同版本必变 | `GraphTests.test_the_version_is_the_whole_content_so_a_changed_restore_expires_old_previews`：点值、价格、成交时间、绑定证据、来源原文各改一项后恢复，版本改变，持旧版本的写入被拒；恢复原内容后版本复原 |
| R2 | 恢复只校验事件用到的关系 | 新增 `check_graph`，写入前在同一事务内校验整张图 | `GraphTests.test_a_restore_proves_every_relation_before_it_writes`：9 种坏图全部拒绝，所有表、版本不变，token 未被占用，原备份随后可用同一 token 恢复 |
| R3 | 合约修正只查 conId | 修正与新增共用“一份合约一条当前记录”的检查（结构身份和 conId） | `MetadataTests.test_a_correction_cannot_make_two_records_of_one_contract`：FUT、FOP 各一例，拒绝后无残留，正常补全仍可提交 |
| R4 | 一条来源分给多个事件被旧唯一索引挡住 | 来源去重由来源表负责；共用主来源的事件在键后加各自事件 ID；股票账本的索引和规则不变 | `GraphTests.test_one_source_may_feed_several_events`：1 → 2 分配成功；数量或费用超额拒绝；重试不新增；来源不能再次使用；作废后来源和分配保留；中途故障整批回滚；备份往返版本不变 |
| R5 | 恢复重试不核对请求内容 | 新增请求登记表 `cost_basis_fop_requests`（DDL 草案第 9 节）：记下动作、请求摘要和首次结果；清空、恢复、重建不删除，整本删除才删除 | `GraphTests.test_a_graph_request_token_is_bound_to_what_it_asked`：换备份、换存档、换动作、换原因、换批次都拒绝；同请求返回首次结果且不再存档；之后整图被替换仍能正确重试；被拒绝的请求不占用 token |
| R6 | 引擎版本只在追加和重建检查 | 写入闸门在写事务内检查本引擎是否支持该账本；冲销、元数据提交、清空、两种恢复的请求增加 `engineVersion` 字段，缺失或不符都拒绝；归档也在事务内检查 | `WriteGuardTests` 两个用例：7 个写动作 × 缺版本、错版本、错身份、旧预览全部拒绝且整库不变，各动作在副本上正常执行可成功；引擎不受支持的账本 7 个写动作和归档都拒绝，仍可读取、导出、删除；WS 层 `test_every_fop_write_names_the_engine_it_was_prepared_for` |
| R7 | 追加重试按当前关系图重验 | 由请求登记表按首次请求摘要识别重试，不再依赖之后可变的关系 | `MetadataTests.test_a_retried_request_is_the_same_request_after_later_metadata_commits`：绑定采纳后、合约补全后，原请求重试都返回首次结果且不新增事件；同 token 改包仍拒绝 |

契约随之修订（P2 尚未发布）：DDL 草案加第 9 节请求登记表；协议 5 种请求加 `engineVersion`，新增 4 个反例，`write_guard` 规则写明引擎核对和请求登记；`event_columns.json` 写明 `external_ref` 在来源拆分时的形式。契约测试新增一条：每个 FOP 写请求都要带引擎版本（请求本身或它携带的写包）。

撤掉修复的检查（每次只撤一处，在工作区原地修改后还原）：摘要只含引用、恢复跳过整图校验、修正只查 conId、拆分事件共用一个键、重试不比摘要、闸门不查账本引擎、缺引擎版本也放行、已登记的 token 重新校验。8 处中对应测试都失败。

审查探测脚本在修复后的结果（只为已必填的调用补上 `engine_version=1`，每个场景单独运行以免前一个被拒后中断）：

```text
SOURCE SPLIT: accepted, 2 events
DIGEST: point value 1000 -> 500, version unchanged = False
DIGEST stale write: REFUSED LedgerChangedError
RESTORE DANGLING: REFUSED FopIdentityConflictError binding ... names missing-future-0001, which is not a FUT contract of this ledger
RESTORE TOKEN: REFUSED InvalidRequestError clientToken was already used for a different restore_backup request (price still 70.12)
ENGINE: REFUSED FopEngineVersionMismatchError this ledger uses FOP engine version 2
APPEND RETRY AFTER CORRECTION: replay = True, events = 1
RESTORE ALLOCATION: REFUSED InvalidRequestError tws_exec:exec-review-001 allocates 99 of 1 stated contracts
CORRECTION IDENTITY: REFUSED FopIdentityConflictError contracts fut-clz6-0001 and future-duplicate-001 are the same contract
```

### 审查修正（2026-09-24，P2 第二轮复核）

复核结论写在同一份审查文档的第 7–11 节：R1–R7 通过，另提出 R8–R11 四项备份恢复问题。4 项先用复核附带的脚本在本分支复现（文件指纹与复核记录一致），全部成立；修复后原脚本不加改动重跑，4 项均符合要求，并逐项转为正式测试。

| 编号 | 问题 | 修正 | 正式测试 |
| --- | --- | --- | --- |
| R8 | 恢复忽略备份的历史范围 | 恢复在同一事务内采用备份的 `historyScope`（范围描述的是这批事件，属于整图内容）；范围相同时不改动该行。选择“采用”而不是“拒绝”，是因为灾后在新库恢复时，账本只能先建好再恢复，拒绝会要求用户删掉重建 | `test_a_restore_takes_the_history_scope_of_its_backup`：两个方向都在新库、跨账本 ID 恢复原样备份，范围与备份一致，再导出一致；恢复前的图（含原范围）可从存档还原；同范围恢复照常 |
| R9 | 恢复可写入两个当前 closed 周期共用一个锚点 | “一个事件只关闭一个周期”移入 `check_cycle_anchors`，每次写入和每次恢复都走这一处；只对当前且 closed 的记录检查。`close_cycle` 原有的单独 SQL 检查删去 | `test_one_event_closes_one_cycle_on_every_path`：普通入口和恢复都拒绝，拒绝后表、版本、token 不变；已撤销的旧修订与新周期共用锚点、两个锚点各一个周期的合法图可以往返 |
| R10 | 原样往返按排序重选主来源，namespace 改变 | 备份中每个事件用 `primarySourceId` 指明主来源记录；导出从 `external_ref` 精确解析（含 namespace，去掉拆分后缀），恢复按该 ID 排在首位，不再按字母顺序推断；`check_graph` 要求它是该事件分配的来源之一，且与显示的 externalRef 一致 | `test_a_round_trip_keeps_each_events_primary_source`：同一文本在 `tws_exec`、`ib_exec` 两个 namespace 下，主来源先后两种顺序，外加其中一条来源拆给两个事件；原样往返后每个事件的 `external_ref`、全部分配和账本版本都不变 |
| R11 | 请求登记不在备份里，新库恢复后原请求重试被拒 | 备份带请求登记（`RequestRecord`：token、动作、请求摘要、首次结果）；以同一账本 ID 恢复时并入登记表，已有同 token 的记录必须是同一请求，否则整个恢复拒绝；恢复到另一账本 ID 时不带过去（那里所有 ID 和 token 都是新的，不会把旧账本的结果交给新账本）；`check_graph` 检查 token 不重复、结果是关于本账本的 | `test_a_restored_ledger_answers_retried_requests`：新库、同账本 ID 恢复后，重建、追加、元数据提交、清空、按存档恢复、冲销六种请求原样重试都返回首次结果且整库不变，同 token 改包拒绝；跨账本 ID 恢复后新账本的登记只有这次恢复本身，旧请求按旧版本重试被拒；登记被改而未重算校验和、结果指向别的账本、token 重复，都拒绝 |

请求登记的恢复语义：备份导出之前已完成的请求，在恢复后的账本上重试，得到当时的首次结果，不再执行（清空的结果里的 `resetId` 指原库的存档，重置存档不在备份范围内）；备份之后才发出的请求，恢复后的库里没有登记，按普通请求处理，旧的账本版本会使其被拒。

契约随之修订：协议新增 `RequestRecord` 类型，`BackupPayloadV2` 增加 `requests`，`StoredFopEvent` 增加 `primarySourceId`，新增 2 个反例；DDL 草案第 9 节注释改为“随备份导出、同 ID 恢复时带回”（表结构不变）。

撤掉修复的检查（同样每次一处、原地修改后还原）：恢复保留目标原范围、锚点可重复、主来源按排序推断、恢复不带回登记、不检查登记结果所属账本。5 处中对应测试都失败；第一轮的 8 处重跑仍全部被发现。

复核脚本修复后的原样输出：

```text
NEW-DB RETRY: replay accepted
Unmodified backup historyScope: since_baseline
Restore success: 1 events; remapped: True
Restored book historyScope: since_baseline
NORMAL DUPLICATE CYCLE: FopCycleBoundaryViolatedError
RESTORED DUPLICATE CYCLE: FopCycleBoundaryViolatedError cycle boundaries cycle-review-001 and cycle-review-002 both close a cycle at <锚点事件 ID>; one event closes one cycle
NAMESPACE ROUND TRIP: tws_exec:shared-reference-001 -> tws_exec:shared-reference-001 same version: True
```

### 未完成与后续

- P2 改动尚未提交。
- 浏览器核对本阶段没有做：页面改动只有 FOP 账本的说明文字和股票页的空乘数显示，都由单元测试覆盖。FOP 账本在真实后端上无法创建（写入关闭），页面整体验收在 P5。
- `ib_server` 注入的合约详情函数没有接真实 TWS 测试（测试纪律不连接 TWS），由假服务覆盖解析逻辑。
- 留给后续阶段：
  - §9.2 歧义组排序和完整时间线（P3）；
  - 导入接入重复来源规则和能力清单（P4）；
  - 股票页把 FOP 账本转到 FOP 页面，FOP 页面的流水、导出、删除和快照（P5）；
  - 写入发布（P6）。
