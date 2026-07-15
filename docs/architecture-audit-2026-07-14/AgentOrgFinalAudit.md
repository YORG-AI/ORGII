# Agent Org #272 最终全量架构审计

日期：2026-07-14
基线：`develop`
分支：`fix/issue-272-agent-org-recovery-invariants`
范围：从 `develop` 分出后，本分支涉及 Agent Org Run、Task、Inbox、Wake、Watchdog、成员生命周期、Planner 审批、任务权限、桌面端投影和 E2E 的全部差异。

## 最终结论

本分支范围内没有遗留的 P0/P1/P2 正确性问题，可以提交。最终审计发现并处理了两类收尾问题：

1. 删除 25 个与 #272 无关的纯格式化或旧 Clippy 修写，避免把 Git、Key Vault、Provider、Session Memory 等无关代码混进提交。
2. 将本次新增的 `member_view_from_parts` 十参数接口收束为一个 identity 参数对象，消除本分支唯一新增的 Clippy 告警。

最终设计坚持：Run、Session、Task、Approval、Inbox/Delivery 是五套不同状态；Coordinator 负责明确派工，Worker 不能自动抢 ownerless task；Watchdog 只恢复真实可处理事件；Plan 审批是持久状态，不靠空 Wake 或模型猜测推进。

## 十层审计

| Layer              | Line / Element                                                | Verdict          | Reason                                                                                                                                      | Suggested change                              |
| ------------------ | ------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1 编译与警告       | Rust desktop / E2E / frontend                                 | keep with reason | `org2`、`e2e-test`、TypeScript、ESLint 均通过；本分支新增 Clippy 告警为 0。全仓严格 Clippy 仍有 develop 基线告警。                          | 基线告警另开 cleanup PR，不能混入 #272。      |
| 2 死代码与重复     | auto-claim、`find_available`、旧 blocker helpers              | fixed            | Worker 自动抢 ownerless task 的旧入口和失去调用者的 helper 已清除；全仓 sweep 没有第二套 auto-claim。                                       | 无。                                          |
| 3 命名与职责       | `RecoveryPlan` / analyzer / executor / wake outcome           | keep             | analyzer 只读并给出计划，executor 执行副作用，outcome 明确区分 queued、coalesced、paused、terminal、no-work。                               | 无。                                          |
| 4 状态维度         | Run / Session / Task / Approval / Delivery                    | keep             | 各自持久化、各自转换；Idle 不代表 Run 结束，Pending 不代表可抢，Wake 不代表消息已消费。                                                     | 新功能继续避免用一个状态推断另一个状态。      |
| 5 FSM 与默认分支   | Session status / approval policy / run finality               | keep             | 关键状态显式分类；终态、Paused、等待审批和历史兼容路径都有明确语义，没有危险的“其他都继续”。                                                | 新增 enum variant 时依赖编译器强制补齐。      |
| 6 跨域边界         | hierarchy message routing vs task authority                   | fixed            | Hierarchy Mode 只控制成员之间能否通信；Task authority 独立，Coordinator 管全局，Worker 只能推进自己的任务。                                 | 无。                                          |
| 7 新开发者可理解性 | prompt、tool schema、typed guidance                           | fixed            | Coordinator 的派工、动态依赖、Planner 执行模式、审批责任和 ownerless 处理均写入提示词与 schema；可修正输入返回 guidance 而非红色失败卡。    | 提示词契约继续保留字符串测试。                |
| 8 Wire / 数据边界  | typed inbox payload、task mutation outcome、reserved metadata | fixed            | 新写入严格校验 roster、eligibility、owner 和依赖；历史坏数据仍可读并交给 Watchdog 升级；side effect 使用事务内 outcome。                    | eligibility join table 可在后续性能 PR 评估。 |
| 9 初始化一致性     | production / test / debug / E2E DB                            | fixed            | recovery budget、plan approval 等表在各初始化路径一致；CLI Agent Org 在创建和 launch preflight 都明确拒绝。                                 | CLI parity 完整实现前不要重新开放。           |
| 10 Resolver 对称性 | run/member/session/task identity                              | keep             | member id、session id、root session 和 run id 的解析方向一致；任务展示与 Inbox 显示优先使用 member identity，不用共享 agent type 冒充成员。 | 无。                                          |

## 关键不变量复核

| 不变量                                                    | 结果                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| 非 Running 的 Run 不能再创建、更新、删除、认领或重派 Task | 通过，Task mutation 与 reconcile 共用 writer lock + immediate transaction |
| Run 收尾与并发 Task create 不能同时成功                   | 通过，并发测试锁定只有一个可串行化结果                                    |
| 同一成员的并发 Wake 不得制造多个空 turn                   | 通过，确定性 idempotency key 合并请求                                     |
| Wake 只有真正被 scheduler 接受才消耗恢复预算              | 通过，coalesced / rejected / paused 不计 attempt                          |
| scheduler 真正开始 turn 前 Session 不得伪装 Running       | 通过，状态更新已移至实际执行边界                                          |
| Paused / terminal Run 的排队 Wake 不得复活 provider       | 通过，执行前重新读取 Run 并 fail closed                                   |
| Worker 不能自动认领 ownerless task                        | 通过，ownerless 只通知 Coordinator 明确指派                               |
| Worker 不能修改其他成员的任务状态                         | 通过，Coordinator 全局权限与 Worker 自有任务权限分离                      |
| Worker 输出后忘记完成 Task 不能永久卡住                   | 通过，有限自动修正；失败后通知 Coordinator，不做无限 Wake                 |
| 等待 Plan 审批时不得每分钟 Wake 或闪烁                    | 通过，pending approval 是明确 quiet state                                 |
| 失败成员任务重排不能丢 metadata 或制造半写入              | 通过，Task 与 history event 同事务                                        |
| Task 完成和 dependency unblock 不能重复发 TaskAssigned    | 通过，side effect 依赖事务内 mutation outcome                             |

## 验证结果

| 检查                                                 | 结果             | 说明                                                              |
| ---------------------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| `pnpm typecheck`                                     | 通过             | TypeScript 类型检查无错误                                         |
| `pnpm run lint`                                      | 通过             | ESLint 无错误                                                     |
| `pnpm run check:circular`                            | 通过             | 5,077 文件，无循环依赖                                            |
| 目标前端单测                                         | 25/25            | Group chat、Kanban、Task outcome                                  |
| 前端全量单测                                         | 4,071/4,076      | 5 个失败均位于未修改的 develop 基线模块                           |
| `cargo check -p org2`                                | 通过             | 桌面端完整编译                                                    |
| `cargo check -p e2e-test`                            | 通过             | Rust E2E target 编译                                              |
| `cargo test -p agent_core --lib -- --test-threads=1` | 2,984/2,986      | 沙箱外运行；剩余 2 个是未修改的 skill-content 与 search-tool 基线 |
| Agent Org / Recovery / Approval / Lifecycle tests    | 全部通过         | 包含并发、暂停、恢复、ownerless、审批与事务回滚                   |
| changed Rust `rustfmt --check`                       | 通过             | 只检查本分支修改文件，不递归污染旧基线                            |
| changed E2E `node --check`                           | 通过             | 变更的 `.mjs` 语法通过                                            |
| `git diff --check`                                   | 通过             | 无空白错误                                                        |
| `cargo clippy --all-targets -- -D warnings`          | develop 基线阻断 | 5 个无关 crate 旧告警；本分支未修改这些文件                       |
| Agent Core strict Clippy                             | develop 基线阻断 | 本次唯一新增告警已修；剩余均可在 develop 原代码复现               |

## 全量测试中明确不属于本分支的失败

- 前端：Housekeeper settings manifest、Cursor external-history、planning-meta 旧断言、editUtils null 处理。
- Rust：内置 `e2e-testing` skill 内容断言、search tool 的 `repo_path` / `repo_paths` 冲突断言。
- Clippy：`orgtrack-core`、`cursor-bridge-app` 以及 Agent Core 旧模块的既有 lint debt。

这些文件没有被本分支修改。审计没有为追求“全绿数字”而把它们顺手改进来，避免扩大 #272 的评审范围。

## 提交判断

结论：**可提交**。本次范围的架构不变量、生产路径、事务边界、恢复策略、权限模型和 UI 投影均有实现与测试对应；未发现多余的目标外代码或会阻止提交的回归。
