# FOP 独立成本账本：分阶段验证记录

本文按 [实施计划](COST_BASIS_FOP_STANDALONE_PLAN.md) §13.3 的要求，逐阶段记录提交号、实际命令、通过/失败/跳过数、F 编号 → 用例 → 结果、真实样本缺项和产物位置。某一 F 项只有在其最后一个依赖阶段通过后才算完成（§14.4），下表中带括号限定的 F 项只表示该部分已覆盖。

## P0 — 基线与止损（2026-09-24）

### 环境

| 项目 | 值 |
| --- | --- |
| 分支 / worktree | `feat/cost-basis-fop-p0`，单独的 git worktree（放在 OneDrive 之外） |
| 基线提交 | `8491754`（`main` = `origin/main`） |
| 本阶段提交 | 未提交，等待用户确认 |
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

- P0 本身已完成；本阶段改动尚未提交，也未合并到 `main`。
- 主工作区的计划文件 `CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md` 仍未跟踪，worktree 中放的是复制件；合并时二者需要统一成一份。
- P1 起的工作见计划 §13.3。
