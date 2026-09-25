# P5 独立收尾复核证据（2026-09-25）

被测分支 feat/cost-basis-fop-p5，基于 fcc599a；回归前后工作树摘要均为 a1799164af85dd44，与实施方记录一致。随后仅更新工程状态、签署及保存本目录证据，没有修改运行代码或测试。

## 独立回归

| 命令 | 结果 / 退出码 |
| --- | --- |
| node tests/run.js | 1306 passed, 0 failed；0 |
| node tests/run_cost_basis_fop.js --stage P5 | 97 passed, 0 failed（Node）；0 |
| PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:tests "$FOP_PY" -m unittest discover -s tests -p '*_test.py' | Ran 1199 tests；OK (skipped=2)，原有非 FOP 跳过；0 |
| "$FOP_PY" scripts/stamp_asset_versions.py --check | asset versions are current；0 |
| git diff --check | 无输出；0 |

FOP_PY 使用仓库既有可用 Python 环境。阶段 runner 的登记检查未冒充 Python 实际执行。实施方的 23/41/21 处撤守卫实验本次没有独立重复，不计入上述独立结果。

## 上轮三项的独立反例

1. C3 合约身份：账本 CLZ6 conId 555、模拟 TWS CLZ6 conId 999999。前端返回数量不一致、身份冲突；共享 WS 处理器拒绝 reconciled=true，快照列表仍为空，账本版本不变。一方缺 conId 的合法回退与同 conId 的代码格式差异由正式回归覆盖。
2. C1 同一成交：沿用上轮临时 store / 导入管线复现，构造通过协议形状校验的请求，分别将一行佣金 -1 改成 -400、价格 70 改成 100、部分开仓标记 O 改成 C；另对拆分期权成交修改 Proceeds。四类请求均被服务端拒绝，比较完整 ledger_state 确认不变；原始正确请求随后可接受，重复请求幂等。交易日、标的期货及不可读金额由新增正式回归覆盖。FUT 的 Proceeds 是名义金额，不当作经济现金；现金反例使用 FOP。
3. C3 AvgCost：持仓数量相同，一张期货 multiplier 缺失，其他期权可比且一致。前端与快照均为 partial；数量仍 matched，现金仍 not_checked。服务端拒绝把含不可比行的汇总宣称为 matched。

正式测试位置：tests/cost_basis_fop_reconcile.test.js；tests/cost_basis_fop_ws_test.py 的 test_a_conid_conflict_or_a_partial_avg_cost_is_never_saved_as_agreeing；tests/cost_basis_fop_import_pipeline_test.py 的 DuplicateDecisionTests 新增三个测试。

## 实际浏览器闭环

使用 Codex 应用内浏览器、仓库合成后端（HTTP 18823 / WS 18899）和全新临时 SQLite 库。先访问空白根入口，设置隔离端口。临时外部测试包装器只给 HTML 末尾附加仓库现有 scripts/cost_basis_fop_browser_assertions.js 和逐阶段执行按钮；未替换应用模块。通过浏览器点击按钮实际执行脚本；delivery 与 after-reload 之间真实重载页面。结果每阶段写入 JSON。没有改共享启动配置。

| 阶段 | 断言 |
| --- | ---: |
| create | 3 |
| import | 19 |
| quotes | 13 |
| delivery | 11 |
| after-reload | 3 |
| backup | 3 |
| messages | 4 |
| duplicates | 10 |
| realized | 7 |
| manual | 9 |
| binding | 8 |
| reconcile | 13 |
| actions | 3 |
| 合计 | 106 |

13 阶段、106 断言全部通过；浏览器 error/warn 日志为空。后端收到 90 个动作；白名单外动作 0，写动作 12 个，与脚本每次明确确认一致，包括同一手工确认的两次发送（一次经济效果）及三份快照。完整结果见 [browser-results.json](browser-results.json)，动作序列和计数见 [actions.json](actions.json)。

独立以只读 SQLite 连接回读三份快照，状态依次为 (reconciled=1, matched, matched)、(0, mismatch, matched)、(1, matched, partial)；三份快照的经济账本摘要相同。见 [snapshot-readback.json](snapshot-readback.json)；签名凭据已从归档副本移除。正常历史快照见 [snapshot-matched.png](snapshot-matched.png)，当前部分可比及三份保存结果见 [reconcile-partial.png](reconcile-partial.png)。

结束时先关闭测试页面，再停止合成服务，删除本轮创建的两份临时库；18823/18899 无剩余监听。生产端口另有用户 Chrome 的连接，本轮没有操作或关闭它们，未重启生产服务。真实写入默认关闭，真实 CSV 能力仍为 synthetic_only。

## 结论

上轮三个缺陷均关闭，本轮未发现新的 P5 阻断项。C1–C6 的页面闭环、相关存储与全量回归独立通过。P5 收尾通过，允许进入 P6；真实写入仍未发布。完整签署及归档后的工作树摘要见上级验证记录。
