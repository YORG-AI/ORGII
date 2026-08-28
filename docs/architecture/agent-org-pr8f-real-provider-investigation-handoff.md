# Agent Org PR8F 真实 Provider 调查与修复交接

> 调查状态：已完成 packaged Tauri App、真实 Provider、SQLite、EventStore 和代码写入路径的交叉核对；**尚未实施本文件中的修复**
>
> 调查日期：2026-08-28
>
> 对应 Issue：[org2AI/ORG2#997](https://github.com/org2AI/ORG2/issues/997)
>
> 调查分支：`codex/issue-997-formal-convergence`
>
> 调查时 HEAD：`182bd899361e1bcbac7f7140f43e77191acd4272`
>
> 用户复现 Session：`pr8f test 0828`
>
> 真实 Provider：account label `orlando` / `gpt-5.6-terra`；未读取或记录凭据
>
> 当前结论：PR8F 还不能宣告完成或 Ready。用户报告的四个问题全部有真实持久化证据，其中两个是 PR8F 直接回归，一个是 PR8S/PR8F 的交叉竞态，一个需要补充 episode 收敛设计。此外，本次继续操作又发现 Pause/Resume 会切断完成证明、Direct 回复泄漏到 Group Chat、以及 UI 暴露了后端尚不支持的 `@Member` 入口。

## 一、先用大白话理解结论

这次不是模型能力不够，也不是 Terra Provider 没有响应。正常的 Direct Member 消息可以在约 6 秒内得到真实 Terra 回复，说明账号、模型和基础运行通道都能工作。

真正的问题是系统里的几张“交接单”没有对齐：

```text
用户在 Group Chat 发了新要求
→ 消息确实写进数据库
→ Coordinator 也被叫醒了
→ 但醒来时没有拿到那条消息
→ 消息一直未读，界面却可能装作已经处理
```

```text
Tester 还在停止测试服务器、准备提交结果
→ Coordinator 先把它的 Task 取消并创建替补
→ Tester 立刻失去清理和提交权限
→ 它虽然完成了测试，系统却拒绝接收结果
→ 后台进程可能没停干净，只能让用户决定风险
```

```text
所有 Task 都变成 completed 或 cancelled
→ 但 cancelled 的旧工作没有可证明的交付结果
→ 新任务又混在同一个 episode 里继续成功
→ 系统既不能证明“全部交付”，也不能正确说“整个 episode 已取消”
→ 最后只能显示 Needs attention
```

更直白地说：**Agent 做了活不等于系统能证明这份活属于哪个任务、结果是否保存、旧工作是否安全停止，以及整个 episode 是否真的结束。** PR8F 的目标本来就是补齐这种正式结果链，所以这些失败不能被当成普通文案问题或偶发现象。

## 二、调查边界与权威依据

本调查遵守以下边界：

- Design 文档是最高权威：`docs/architecture/agent-org-long-lived-team-session-design.md`。
- Issue #997 和 PR8F 计划用于解释交付目标，但不能覆盖 Design 不变量。
- UI 现象只作为入口；根因必须追到真实持久化事实和最早的生产写入边界。
- Debug endpoint 只用于读取证据或创建隔离故障前置条件，不能代替真实按钮、输入框、确认框和 Session 切换。
- 本次调查没有修改产品代码，也没有清理用户正常 `ORGII_HOME`。

本次最相关的 Design 规则：

| Design 位置                         | 规则                                                     | 对本次调查的意义                                                        |
| ----------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| 不变量 11，约第 355 行              | 未 mention 的 Group Chat 用户消息归 Coordinator          | 普通 Group Chat 消息不能只写入 Inbox 后永远无人读取                     |
| 不变量 48，约第 392 行              | 旧执行可能有未知外部影响时，必须由用户决定 handoff       | Needs attention 本身有安全理由，但 worker 必须先保有清理能力            |
| 不变量 50–55，约第 394 行           | Plan、正式 trigger 和 final summary 必须有唯一持久化身份 | PR8F 不能用空 Wake、UI 猜测或 Task 数量代替正式结果链                   |
| Activation generation，约第 1256 行 | generation 是工作授权 epoch                              | Pause/Resume 不能把它误当成新的交付 episode 身份                        |
| §25.11B PR8F，约第 2621 行          | PR8F 负责 Plan → formal event → final report             | Group 用户事实进入 Coordinator、TaskOutput 保存和最终报告都属于验收主链 |

## 三、真实测试环境与可复核证据

### 3.1 Packaged App

| 项目            | 值                                                                 |
| --------------- | ------------------------------------------------------------------ |
| App bundle      | `<repo>/src-tauri/target/dev-build/bundle/macos/ORG2.app`          |
| 可执行文件      | `.../Contents/MacOS/org2`                                          |
| SHA-256         | `934f78cb4298a078b60907f06b71b93f0813b8d589c7d358e66c2f3c64f6678d` |
| Build 时间      | `2026-08-28 08:14:06 +0800`                                        |
| Binary 大小     | `167524048` bytes                                                  |
| 隔离 ORGII_HOME | `<isolated-orgii-home>`                                            |
| SQLite          | `<isolated-orgii-home>/sessions.db`                                |

这意味着本次证据来自当前分支构建的真实 macOS App，不是浏览器 dev server，也不是 `/Applications` 下的旧安装包。

### 3.2 复现对象

| 对象         | ID                                                        |
| ------------ | --------------------------------------------------------- |
| Root Session | `sdeagent-agent-org-ee007dfa-c0d4-4251-80e3-5cc272431dae` |
| Run          | `agent-org-run-ec5d40d6-6808-4936-97bf-9568d35eb22e`      |
| Session 名称 | `pr8f test 0828`                                          |

调查结束时的持久化状态：

- Run 仍是 `running`，所有 Member 在 UI 中为 Idle。
- 共 8 个 Task：5 个 completed、3 个 cancelled。
- completion certificate 不存在。
- FinalSummaryReceipt 不存在，因此最终总结从未开始。
- FormalTriggerReceipt 共 18 条，全部 resolved，0 条 pending。
- 原用户 Group Chat 消息仍 unread；本次诊断新增的 Group Chat 消息也仍 unread。
- Pause/Resume 后 Run 的 `activation_generation` 从 1 变成 3，但全部 8 个 Task 仍属于 generation 1。

“FormalTriggerReceipt 全部 resolved”很重要：它证明最后卡住不是“还有一条 PR8F 正式 trigger 没处理”，而是用户消息路由、Task episode closure 和 completion candidate 的契约本身不成立。

## 四、用户报告问题的时间线

以下时间为 SQLite/EventStore 中记录的 UTC 时间。

| 时间               | 发生的事                                                        | 结果                                                                    |
| ------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 02:25:21           | 用户发“我想要做可以任意加注任何额度的加注，现在好像只能加20”    | Inbox 成功写入，但一直 unread                                           |
| 02:25:21 左右      | Coordinator 被普通 Wake 唤醒                                    | Turn 很快空跑结束，没有 materialize 用户消息                            |
| 02:25:58           | Coordinator 对仍在清理测试环境的 Tester 执行 cancel-and-replace | 原 Tester Task 立即失去权限                                             |
| 02:26:11–02:26:59  | Tester 继续调用 task、terminal、message、await 工具             | 全部因 Turn context 已失效而被拒绝                                      |
| 02:27:05           | Tester Turn 因后台工作未收敛而 failed                           | external effect 标成 unknown，出现 Needs attention                      |
| 02:27:28           | 用户选择 Keep stopped                                           | 只取消 replacement Task，不是停止整个 Team                              |
| 02:30:39           | 用户通过 Root composer 再发一次需求                             | 这次进入 EventStore 的 Root user message 路径，Coordinator 正常建新任务 |
| 02:39:37、02:39:46 | Coordinator 尝试向 Tester 发 material_change/blocker 消息       | 两次都因非法 `purpose` 被后端拒绝                                       |
| 02:40:13           | Coordinator 再次 cancel-and-replace                             | Tester 稍后完成，但 TaskOutput 提交被拒绝                               |
| 02:40:22           | Tester 调用 task complete                                       | 因 Task 已 cancelled 而失败                                             |
| 后续               | replacement 完成，所有 Task terminal                            | 没有 completion certificate，Overview 仍 Needs attention                |

## 五、问题 1：Tester 需要用户手动处理，Keep stopped 含义不清

### 5.1 用户看到什么

- Tester 像是测试失败或卡住。
- Overview 显示 Needs attention。
- 用户必须在 Continue replacement、Keep stopped、Abandon episode 等选项中做决定。
- 用户选择 Keep stopped，以为是在“取消这个 Task”，随后看到 failed/idle；再发消息后 Team 又继续工作。

### 5.2 真实发生了什么

第一轮 Tester Task：`11f522...`。

Tester 仍有后台测试服务器进程 `PID 36050`，正在读取结果和停止环境。Coordinator 在 `02:25:58` 先执行了 cancel-and-replace。原 Task 立即 cancelled 后，Tester 的后续调用全部被 `agent_org_turn_context_invalid` 拒绝：

- `task_get`：02:26:11；
- `inspect_terminals`：02:26:37；
- `org_send_message`：02:26:46；
- `await_output`：02:26:59。

Tester 明确报告无法再终止 PID 36050。随后 Turn `7ac6f210...` 在 02:27:05 failed，原因是 Agent Org Turn 在后台工作收敛前尝试结束。

系统因此创建 handoff receipt `2214fdaa...`，其中：

- `external_effect_unknown = 1`；
- `local_effect_count = 0`。

这代表“系统无法证明旧执行有没有在外部留下仍在运行的效果”。根据 Design 不变量 48，这种情况下要求用户决定是正确的安全行为。

### 5.3 根因

问题不是“为什么安全系统需要用户确认”，而是顺序错了：

```text
正确顺序：先撤销新工作权限 → 保留有限的 cleanup 权限 → 证明旧进程已停止 → 再交接
当前顺序：取消 Task → 立刻撤销所有工具权限 → worker 连 cleanup 都做不了 → 只能报告 unknown
```

Coordinator 不应该直接获得 shell/kill 权限。它是调度者，不是执行者。真正应该做 cleanup 的仍是原 TaskExecution worker，但只能使用被严格限定的清理工具，不能继续开展新业务工作。

生产行为入口：

- `src-tauri/crates/agent-core/src/state/commands/session/org_tasks/handoff.rs:445`
- `src/engines/ChatPanel/InputArea/components/AgentOrgOverviewPanel.tsx:835`
- 同一 Overview 组件约第 1275 行附近的确认警告

### 5.4 三个选项到底是什么意思

| 选项                 | 实际行为                                                   | 大白话                                     |
| -------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| Continue replacement | 接受或确认旧执行已经停止，然后让 replacement 继续          | “我确认旧人不会再产生影响，让接班人继续。” |
| Keep stopped         | 取消 replacement，旧 Task 也不重启；其他兄弟 Task 仍可继续 | “这一个交接先别做了”，不是“停止整个 Team”  |
| Abandon episode      | 取消这个 episode 中全部 open Task，结果为 Cancelled        | “这一轮工作整体放弃。”                     |

当前主卡片只显示短标签，解释主要藏在下一层确认框里。用户在作出高风险选择前无法理解作用范围，这是独立的 UX 缺陷。

### 5.5 必须怎样修

1. 原 worker 在 cancel-and-replace 后进入 cleanup-only 阶段。
2. cleanup-only 只能停止/读取它自己拥有的 terminal、process、job 和必要结果，不能继续修改产品或创建新任务。
3. cleanup 成功且外部效果可证明 terminal 后，系统自动完成 handoff，不应打扰用户。
4. 只有 cleanup 超时、崩溃或结果确实不可证明时，才显示 Needs attention。
5. Overview 在主卡片上直接说明每个按钮会影响“当前 replacement”还是“整个 episode”。
6. `Keep stopped` 完成后必须显示被取消的确切 Task、仍会继续的兄弟 Task，以及它是否阻塞最终交付。

### 5.6 强制回归测试

- worker 持有真实子进程时 cancel-and-replace，验证原 worker 只能 cleanup 且能停止进程。
- cleanup 成功：不创建 unknown-effect handoff，不需要用户确认。
- cleanup 失败：才创建一次 handoff receipt，重启/五次 Watchdog 后仍只有一次。
- 三个按钮分别验证 Task 范围、episode 范围和最终状态，不能只验证按钮可点击。
- Rust 测试放在 handoff 对应的独立测试文件或 `tests/` 目录，不把大段测试塞回生产文件。

## 六、问题 2：Team 工作时发 Group Chat 消息，消息躺着不动

### 6.1 用户看到什么

用户在 Group Chat 发了新要求，界面一度显示“Coordinator is picking up your message”，但 Team 没有响应。切换页面、Pause 或重启后，提示可能又消失，让人以为消息已经处理。

### 6.2 原始消息证据

Inbox row 25：

- 时间：`2026-08-28T02:25:21.423384+00:00`；
- sender：`_user`；
- recipient：Coordinator；
- 正文：`我想要做可以任意加注任何额度的加注，现在好像只能加20`；
- 调查结束时仍 unread。

Coordinator resume Turn `4583907f...` 在消息写入后约 0.1 秒启动，约 0.3 秒结束，但没有 materialized input，也没有对应 EventStore message。

用户后来通过普通 Root composer 重发，消息以 `user_submit` 进入 EventStore。Coordinator 在 02:30:55 正常创建 Task graph，团队才继续工作。

### 6.3 本次真实 UI 二次复现

通过 packaged App 的真实 Group Chat 输入框和 Send 按钮发送：

`【PR8F诊断-0828-A】请只回复“收到”，不要创建任务。`

结果：

- 新增 Inbox row 41；
- Coordinator Turn `fcfca73e...` 在 03:20:50.655 创建；
- 03:20:50.830 完成，约 175 ms；
- row 41 仍 unread；
- 没有对应 EventStore input 或回复；
- UI 的 picking-up 提示持续存在，直到状态切换后消失。

这不是“模型决定忽略消息”。Provider 根本没拿到正文。

### 6.4 根因

Group Chat 的生产命令仍使用旧通道：

- 先写普通用户 Inbox：`src-tauri/crates/agent-core/src/state/commands/session/org_tasks/group_chat.rs:303`；
- 再发送 generic wake：同文件约第 364 行。

PR8F 已把 Coordinator 的生产 drain 从“批量读取所有 unread Inbox”改成“只读取精确 FormalTriggerReceipt”：

- `src-tauri/crates/agent-core/src/core/session/turn/processor/inbox_drain/drain.rs:154`
- formal drain 明确排除 user-directed row：`src-tauri/crates/agent-core/src/core/coordination/agent_inbox/store_drain.rs:348`

generic wake 又没有 formal receipt 可绑定：

- `src-tauri/crates/agent-core/src/core/coordination/orchestration/inbox_wake.rs:98`

因此当前链路是：

```text
消息持久化成功
→ generic wake 成功
→ Coordinator 创建一个没有输入的空 Turn
→ Turn 立即结束
→ 原消息永远 unread
```

### 6.5 为什么 UI 还会误导

Group Chat 的 pending 状态只是 React 内存中的本地布尔值：

- `src/engines/ChatPanel/hooks/useAgentOrgGroupChatController.ts:138`
- Session/toggle 切换时约第 142、163 行会清掉。

它不是从 unread Inbox 或正式 observation receipt 重建的。所以同一条未处理消息可能先显示“正在处理”，稍后又无提示，看起来像已完成。

### 6.6 必须怎样修

不能恢复 Coordinator 的 blanket unread drain。那会重新引入 PR8F 要消灭的“顺手读掉另一 Task 或 user-directed 消息”的问题。

正确方向是给 Root/Group 用户消息一条精确通道：

```text
user source id
→ 精确绑定一个 Coordinator Turn
→ 稳定 materialized EventStore input
→ Provider 实际观察
→ 只确认这一个 source
```

也可以复用已存在且能工作的 Root user queue，但必须保留来源身份、去重、重启恢复和精确 acknowledgement。

前端 pending 必须来自持久化 observation 状态，而不是页面内存猜测。

### 6.7 强制回归测试

- Coordinator Working 时通过真实 Group Chat Send 发送，消息只 materialize 一次并被精确 ack。
- Coordinator Idle 时发送，行为相同。
- 消息到达正在运行的 Turn：保留到 follow-up，不能混进当前已 materialize batch。
- refresh、Session switch、App restart 后 pending/observed 状态一致。
- 五次 Watchdog 后仍只有一个 source、一个 materialized input、最多一个 active attempt。
- Coordinator 不得顺带读取另一 Task、Direct Member 或尚未 materialize 的 row。
- E2E 必须操作 packaged App 的真实输入框和按钮；数据库读取只能用来证明结果。

## 七、问题 3：Tester 已经测完，但 Overview 又 Needs attention

### 7.1 用户看到什么

第二轮任务中，Implementer 完成了任意额度加注，Tester 也实际完成测试，但 Overview 再次 Needs attention，像是 Tester 的结果丢了。

### 7.2 真实发生了什么

第二轮 Tester Task：`8dd5...`。

Tester 在 02:39:26 报告 all-in 风险。Coordinator 随后两次尝试向 Tester 发消息：

- 02:39:37，`purpose=material_change`；
- 02:39:46，`purpose=blocker`。

两次都被后端拒绝：

`purpose is valid only for a TaskExecution member's plain message to the Coordinator`

Provider 在连续两次工具错误后，于 02:40:13 选择 cancel-and-replace。Tester 此时仍在完成测试、停止服务器。它在 02:40:22 调用 task complete，但 Task 已经 cancelled，因此结果提交被拒绝。

最后出现的事实是：

- Tester 的 Turn 可以 terminal；
- Tester 事实上做完测试；
- 但 authoritative Task 是 cancelled；
- 没有合法绑定该 Task 的 Completed TaskOutput。

Handoff receipt `2288ca34...` 记录：

- old Task：`8dd5...`；
- replacement：Implementer Task `566648...`；
- external effect：unknown；
- 用户后来选择 Continue replacement；
- replacement 最终 completed。

### 7.3 根因一：工具 schema 对 Coordinator 暴露了后端必定拒绝的参数

PR8F 增加的 `purpose` 本来只允许 TaskExecution Member 向 Coordinator 报告结构化 actionable fact。后端按这个规则拒绝 Coordinator 使用是正确的：

- schema 暴露：`src-tauri/crates/agent-core/src/core/tools/impls/orchestration/agent_org/send_message.rs:192`
- persistence 拒绝：`src-tauri/crates/agent-core/src/core/tools/impls/orchestration/agent_org/send_message/persistence.rs:52`

错误在于 Coordinator 仍看得到这个参数。模型像拿到一个界面上存在、但点击后永远报错的按钮。

### 7.4 根因二：Coordinator 用 cancel-and-replace 代替普通追问

在发消息失败后，Coordinator 为了联系 worker 直接取消了正在收尾的 Task。这制造了 cancel/complete race：取消先提交，worker 的完成结果后到，系统只能拒绝结果。

### 7.5 大白话

Tester 已经跑到终点，手里拿着测试报告。Coordinator 本来只想问一句话，却因为消息工具用错，直接把 Tester 的工单作废。Tester再递交报告时，柜台告诉它“这张工单已经取消，不能收件”。所以用户看到“人明明做完了，系统却说没完成”。

### 7.6 必须怎样修

1. 根据 caller role 动态生成 `org_send_message` schema：Coordinator 根本看不到 `purpose`。
2. 即使旧客户端或模型硬传 `purpose`，错误也要明确提示“去掉 purpose 后重试”，不能诱导升级为 cancel-and-replace。
3. Coordinator policy/prompt 明确：向 active worker 追问或补充信息不能通过取消 Task 实现。
4. cancel 与 task complete 并发时必须有确定规则和测试；不能让已成功产生的结果变成无主 narration。
5. 如果 cancellation 已提交，迟到结果必须形成 typed late-result evidence，供 handoff/用户判断，而不是静默丢失。

### 7.7 强制回归测试

- Coordinator 的工具 schema snapshot 不包含 `purpose`；TaskExecution Member 的 schema 包含允许值。
- Coordinator 普通追问可送达，不创建 FormalTriggerReceipt 自唤醒。
- active Tester 上报 risk 后，Coordinator 追问、Tester 回复、Task complete，全程不 cancel。
- cancel 与 complete 两种提交顺序都覆盖，最终只有一种 authoritative resolution。
- 真实 Terra 场景必须包含仍在运行测试服务器时的风险报告和追问。

## 八、问题 4：全部 Task 已结束，Overview 仍 Needs attention

### 8.1 真实状态

调查时 8 个 Task 全部 terminal：

- 5 completed；
- 3 cancelled；
- 0 in_progress；
- 0 pending。

但是：

- 没有 completion certificate；
- 没有 FinalSummaryReceipt；
- Run 仍 `running`；
- UI 显示 Needs attention。

UI 的直接投影在：

- `src-tauri/crates/agent-core/src/state/commands/session/org_tasks/run_view.rs:406`
- `src/engines/ChatPanel/InputArea/components/AgentOrgOverviewPanel.tsx:343`

当前逻辑把“全部 Task terminal 但没有 certificate”的不同根因统一压成 Needs attention，所以 UI 没有告诉用户究竟是哪一条 closure 失败。

### 8.2 阻塞 completion 的第一条事实：未读用户消息

Quiescence 把用户 Group Chat unread row 视为 blocking work：

- `src-tauri/crates/agent-core/src/core/coordination/agent_org_runs/quiescence.rs:618`
- blocking predicate 约第 631 行。

这是问题 2 的后果：消息永远 unread，Run 就永远无法证明安静收敛。

### 8.3 阻塞 delivered completion 的第二条事实：无成功后代的 cancelled scope

Keep stopped 取消了 replacement Task `b06e...`，它没有 completed descendant，取消原因也不是明确的 `user_scope_removed`。

completion validator 的相关位置：

- `src-tauri/crates/agent-core/src/core/coordination/agent_org_run_completion.rs:1021`
- cancellation 规则约第 1060 行以后；
- delivered 检查约第 1110 行以后。

因此 Delivered outcome 不成立，这是 validator 的正确拒绝。

但同一个 activation 中后来又成功完成了用户的第二项需求：

- 如果判整个 episode Cancelled，会把后续成功也说成取消；
- 如果判 Delivered，旧 cancelled leaf 没有交付证明；
- 如果判 Failed，又没有 authoritative Task status 为 Failed，只有一个 Turn failed。

系统没有合法 certificate，所以 final summary 也不能启动。这里不是 FinalSummaryReceipt FSM 卡住，而是它从未获得创建前提。

### 8.4 大白话

用户第一次说“这个接班任务先停”，系统把它记成取消；后来用户又布置新活，而且新活做成功了。两批工作却被装在同一个结算单里。结账时系统无法回答：这张单到底是“已全部交付”还是“整单取消”？于是它一直要求注意，却没有告诉用户缺哪一张收据。

### 8.5 需要先确认的产品/Design 决定

推荐设计方向：

- Keep stopped 后，如果当前没有其他 open work，关闭当前 episode，结果为 Cancelled；
- 用户以后发的新 mission 创建新的 episode；
- 如果当时仍有兄弟 Task 在工作，Overview 必须显示哪个 cancelled scope 正在阻塞 delivered，并提供精确的 scope resolution；
- 允许用户明确移除 scope 时，必须写 auditable `user_scope_removed` 事实，不能只改 UI 或伪造 completed。

这超出“保持 PR8S handoff/certificate validator 不变”的原 PR8F 边界，需要先更新 Design/Issue 后实施，不能暗改 completion 语义。

### 8.6 强制回归测试

- Keep stopped 且无其他 open work：episode 有确定 Cancelled certificate 或明确的 terminal resolution。
- Keep stopped 但兄弟 Task 继续：UI 显示准确阻塞 scope，不显示笼统 Needs attention。
- 旧 episode 关闭后新 mission：使用新 episode identity，旧取消不污染新交付。
- all terminal + no certificate 的每一种原因都有 typed reason 和对应操作，不能统一猜测。
- completion certificate 创建后才允许 FinalSummaryReceipt；receipt active 时才显示 Finalizing。

## 九、继续操作发现的额外问题

### 9.1 Pause/Resume 把完成证明切断

本次通过 packaged App 的真实 Pause 和 Resume 控件操作：

- pause episode：`e87b...`；
- pause 后 generation：2；
- resume 后 generation：3；
- Run 当前 `activation_generation = 3`；
- 全部 8 个 Task 仍是 generation 1。

问题在于两套代码对 generation 的理解不同：

- Quiescence 和 Run View 统计整个 Run 的 Task：`quiescence.rs:556` 等；
- completion candidate 只查当前 generation，并在 Task 数为 0 时返回 NotApplicable：`agent_org_run_completion.rs:376`。

Design 约第 1256 行明确说 activation generation 是工作授权 epoch，也就是“这次 Resume 后谁还有资格继续工作”的版本号，不是“这一批交付”的 episode identity。

大白话：Pause/Resume 本来只是换了一把新门禁卡，系统却把它当成换了一张新订单。旧 Task 明明还摆在 Overview 上，结账程序却只看新门禁卡名下的 Task，于是什么都看不到，也不出 certificate。

现有 Pause 测试在 `src-tauri/crates/agent-core/src/state/commands/session/org_tasks/tests.rs:1880` 附近，主要通过直接更新表来完成 Task，没有验证 Resume 后 Task generation、episode identity 和最终 certificate。这就是为什么按钮级测试可以通过，真实结算仍失败。

必须修复：completion graph/evidence 不能把 authority epoch 当 episode discriminator。应引入或复用真正的 episode/work-scope identity，或者证明跨授权 epoch 的同一 Task graph 如何收敛。不能简单把旧 Task 的 generation 全量改写，因为那会破坏历史授权证据。

### 9.2 Direct Member 的 assistant 回复泄漏到 Group Chat

通过 Planner 的真实 Direct 页面发送：

`PR8F-DIAG-0828-C Reply only ACK. Do not create or edit anything.`

结果：

- 后端正确记录 `turn_kind=user_directed_work`；
- source 正确是 `direct_member`；
- Planner 使用真实 Terra 回复 ACK；
- Task board 和 `work_revision` 没有变化，证明 Direct 通道本身工作正常。

但切回 Coordinator Group Chat 后，界面出现 Planner 的 `@Coordinator ACK`，用户发给 Planner 的 Direct 原文没有显示，只有 assistant 回复被错误混入 Group Chat。

根因在前端投影：

- `src/engines/ChatPanel/hooks/useGroupChatMergedEvents.ts:195` 合并所有 Member Session 的 EventStore stream；
- `src/engines/ChatPanel/utils/groupChatUtils.ts:484` 把任何非 Coordinator 的 `agent_message` 默认解释为发给 Coordinator，约第 493–494 行。

这违反 Design 的可见性规则：Direct 用户消息及其回复不能泄漏到 Group transcript。

大白话：用户在 Planner 私聊室里问了一句话，Planner 的回答却被系统贴到了群公告墙上，而且还伪装成 Planner 主动 @Coordinator。后端其实知道它来自 Direct，前端在展示时把来源丢了。

正确修复边界是 authoritative projection：Group feed 只接收有 typed group/root-group provenance 的事件，不能靠“发送者不是 Coordinator”或时间接近来猜。该项更接近 PR8/PR9 的 transcript projection 边界，但会阻塞 PR8F 的真实端到端验收。

### 9.3 UI 允许选择 `@Planner`，后端却明确不支持

在 Group Chat 的真实 `@` 菜单选择 Planner，发送诊断消息 B。UI 返回：

`agent_org_turn_context_invalid: PR3 does not admit legacy Member group/inbox producer "sde-planner" without typed authority`

数据库没有新增 Inbox row，说明后端原子拒绝，没有产生半条消息。

契约冲突：

- 前端在 `useAgentOrgGroupChatController.ts:242` 向用户展示全部 members；
- 后端在 `group_chat.rs:375` 明确拒绝任何非 Coordinator recipient；
- Design 把 Group mention 的 UserDirectedWork 放在 PR9，而不是 PR8F。

在 PR9 typed routing 真正完成前，当前 UI 应隐藏/禁用 `@Member`，并用大白话说明“目前群聊消息由 Coordinator 接收；请进入 Member Session 私聊”。不能让用户先选中再收到内部架构错误。

现有 E2E 也互相矛盾：

- `tests/e2e/specs/core/agent-org-group-chat-ui.spec.mjs:734` 附近存在 Planner mention 场景；
- 约第 807–857 行预期 Planner 可以持久化/读取/回复；
- 约第 862–902 行的 Coordinator 部分只断言 row 被写入，没有断言实际读取和回复。

因此当前没有证据证明这份 Group Chat E2E 在本构建上通过完整用户链。

### 9.4 正常用户数据库启动报 canonical schema 不完整

Computer Use 直接重新打开 App 时，没有继承原终端的隔离 `ORGII_HOME`，因此误开了用户正常数据库，并显示：

`partial Agent Org runtime schema: found 14 of 27 canonical tables; only an empty namespace or the complete current manifest is accepted`

随后已停止该进程，并用同一个隔离 `ORGII_HOME` 重新启动；隔离数据库成功恢复，问题状态也完整保留。

这次**不把它记为新的 PR8F bug**，因为已锁定的产品决定是不做外部用户数据迁移，只在全新隔离数据库验证 canonical DDL。它仍是测试环境的重要提醒：手工重启 packaged App 必须保留同一隔离环境，不能双击后误以为打开的是同一测试数据。

## 十、哪些东西确实工作了

为避免把所有现象都归咎于 Provider，本次也做了正向控制：

- packaged App 能从隔离数据库启动和重启；
- `orlando / gpt-5.6-terra` 能完成真实 Direct Member Turn；
- Planner Direct 回复约 6 秒返回 ACK；
- Direct 消息没有修改 Task graph 或 `work_revision`；
- FormalTriggerReceipt 18 条全部 resolved，没有重复 pending；
- `@Planner` 的非法 Group 写入在持久化前原子拒绝，没有制造脏 Inbox row；
- FinalSummary 没有在无 certificate 时错误启动。

这些正向证据说明当前主要故障集中在“消息路由、角色工具契约、取消/完成竞态、episode closure 和前端来源投影”，不是基础 Provider lane 全面失效。

## 十一、为什么之前的“全场景真机实测”结论不成立

此前真实 Terra 测试实际覆盖的是较短的 happy path：不可变 Plan、正常 Task 完成、Final Summary 和重启读取。故障路径主要依赖 fake provider 或隔离 fixture。

它没有覆盖以下真实组合：

- Coordinator Working 时发送默认 Group Chat；
- Tester 持有真实后台服务器时报告 material change/risk；
- Coordinator 向 worker 发消息时错误使用 `purpose`；
- cancel 与 task complete 同时发生；
- Keep stopped 后再布置第二项 mission；
- cancelled scope 与后续成功 work 混在同一 episode；
- Pause/Resume 后再生成 completion certificate；
- Direct assistant 回复是否泄漏到 Group Chat；
- Idle 状态下真实选择 `@Member`；
- UI picking-up 状态是否能跨刷新和重启重建。

因此，把此前结果称为“全场景真实 Provider 测试通过”是不准确的。当前 PR 必须保持 Draft；在以下修复和真实复测完成前，不能写 `Performance verdict: pass`，也不能声称 Issue #997 已闭环。

## 十二、性能与生命周期结论

本次没有仅凭代码形状推断性能，通过真实数据库和 Turn 记录已经确认一个确定的生命周期失败：

| 检查                    | 实际结果                                                 | 用户影响                                   |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------ |
| Group Chat 每次发送     | 写一条 durable unread row，并启动一个空 Coordinator Turn | 消息越发越多，Provider/Turn 调度做无效工作 |
| unread acknowledgement  | 永不发生                                                 | 数据长期增长，Quiescence 长期阻塞          |
| UI pending              | 只存在页面内存                                           | 切换/重启后状态与数据库不一致              |
| Group transcript        | 合并多个 Member stream 后猜来源                          | Direct 回复泄漏，数据量越大投影越重        |
| Watchdog/Formal receipt | 本次 18/18 resolved                                      | 不是当前重复唤醒的主因                     |

**Performance verdict: fail。** 这里不是因为尚未测出一个漂亮的 CPU 数字，而是已经观察到每条消息产生持久化积压和空 Turn；按性能守门规则，只要存在确定的无界积压或无效后台工作，就不能判通过。

后续仍需补做 5 分钟 CPU/RSS、SQL counter、rows visited 和 `Command+5` 请求数量测量，但这些测量不能推翻当前 correctness/lifecycle fail，只能帮助量化影响。

## 十三、建议修复顺序与归属

| 顺序 | 修复项                                                   | 建议归属                      | 为什么先做                                                |
| ---- | -------------------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| 1    | Group 用户消息精确 materialize/ack，不恢复 blanket drain | PR8F                          | 这是 Issue #997 正式结果链的直接缺口，也会阻塞 Quiescence |
| 2    | Coordinator 动态 message schema，移除非法 `purpose`      | PR8F                          | 当前会直接诱发 cancel-and-replace 和结果丢失              |
| 3    | cancel/complete race 与 cleanup-only authority           | PR8S 叠加修复 + PR8F 集成测试 | 旧 worker 必须能安全收尾，Coordinator 不能获得执行工具    |
| 4    | Keep stopped / 新 mission 的 episode closure             | 先更新 Design/Issue，再实现   | 目前缺少唯一正确的产品语义，不能靠改 validator 猜         |
| 5    | Pause/Resume 的 generation 与 completion evidence 解耦   | PR8S/PR8F 集成修复            | 当前一按 Resume 就可能永远没有 certificate                |
| 6    | Group feed 使用 typed provenance，隔离 Direct            | PR8/PR9 projection            | 后端已有来源，前端不能继续猜测                            |
| 7    | PR9 完成前隐藏/禁用 `@Member`                            | 当前 UI 契约修复              | 不能向用户暴露后端必定拒绝的入口                          |
| 8    | Needs attention typed reason 和按钮大白话                | 与 owning fix 同批 UI         | 让用户知道缺哪张收据、按钮影响什么范围                    |

不要用以下方式“快速修好”：

- 不要恢复 Coordinator blanket unread drain；
- 不要在 UI 里隐藏 cancelled Task 来伪造 delivered；
- 不要把 cancelled Task 直接改成 completed；
- 不要给 Coordinator shell/process kill 权限；
- 不要全量改写历史 Task 的 activation generation；
- 不要仅清掉 unread row 或用户数据库来让本次 Session 看起来正常；
- 不要用 debug endpoint 代替真实 Group Chat、Pause、Resume、handoff 和 Retry 按钮。

## 十四、实施前需要锁定的决定

### 决定 A：Keep stopped 的 episode 语义

需要在 Design 中明确：当用户 Keep stopped 且没有其他 open work 时，是立即关闭当前 episode 为 Cancelled，还是保留一个可由用户明确移除的 scope。推荐前者，新 mission 必须创建新 episode。

### 决定 B：同一 Root Session 如何表示多轮 mission

Activation generation 只能表达授权 epoch，不能继续兼任 episode id。需要选定真正的 episode/work-scope identity，并说明 Pause/Resume 是否跨 episode（通常不应跨）。

### 决定 C：PR9 前的 `@Member`

在 typed UserDirectedWork group routing 上线前，建议 UI 不展示不可用的 Member mention，只保留 Coordinator，并引导用户进入对应 Direct Session。

## 十五、修复后的真实验收脚本

必须重新构建当前分支 packaged App，记录 branch、HEAD、bundle、binary SHA-256，使用全新隔离 `ORGII_HOME` 和临时 git workspace。Provider 固定为 `orlando / gpt-5.6-terra`。

### 主场景

1. 新建 Team，要求规划、实现、运行并验证本地 Texas Hold’em 游戏，并要求独立、持久的实现报告和测试报告 TaskOutput/Artifact。
2. 通过真实 Plan 卡片覆盖 Request Changes 和 Approve；批准后 Planning Task 必须 Completed，不能 Cancelled。
3. Implementer 启动真实本地服务器；Tester 在服务器仍运行时报告 material change/risk。
4. Coordinator 使用合法普通消息追问 Tester，不 cancel Task；Tester 回复、停止服务器并保存 Completed TaskOutput。
5. Team Working 时通过 Group Chat 发送“加注支持任意额度”；消息必须被 Coordinator 恰好读取一次并创建/调整工作。
6. 切换 Coordinator/Planner/Implementer/Tester Session；Direct Planner 对话不能出现在 Group transcript。
7. 若 PR9 尚未实现，Group Chat 不得展示 `@Planner` 等不可用入口；若已实现，必须验证 typed authority、读取和回复完整链。
8. 通过真实 Stop/handoff 制造一次 cleanup：worker 应先停止自己的后台进程；只有无法证明时才显示用户决策。
9. 覆盖 Continue replacement、Keep stopped 和 Abandon episode 的独立 focused run，验证每个按钮的实际范围和大白话说明。
10. 通过真实 Pause、Resume 后继续完成同一 Task graph，最终必须仍能生成正确 completion certificate。
11. 全部 Task terminal 后，只有 active FinalSummaryReceipt 时显示 Finalizing；最终报告持久化后进入 Idle。
12. 退出并用同一隔离环境重启 App；Plan、TaskOutput、certificate、final summary、message observation 和 episode 结果全部可见。

### 必须读取的后端证据

- 每条 Group 用户 source 对应一个 materialized EventStore input 和精确 ack；
- 不存在永久 unread 用户 row；
- 不存在空 Coordinator resume Turn；
- cancel/complete 竞态只有一个 authoritative resolution；
- cleanup 后进程树真实 terminal；
- Pause/Resume 前后的 Task graph 仍能被 completion validator 看见；
- 每个 episode 有且只有一个有效 completion outcome；
- FinalSummaryReceipt 只在 certificate 后创建；
- failed summary 不自动 retry，真实 Retry 按钮才创建下一 attempt；
- Direct source 不进入 Group projection；
- 五次 Watchdog 后 receipt/materialized input/Turn 数量不增加。

### 测试代码组织要求

- Rust 测试放在对应模块的独立测试文件或 `tests/` 目录；生产文件内不堆大段 `#[cfg(test)]` 总测试。
- TypeScript/React 测试使用独立 `.test.ts` / `.test.tsx`。
- Group routing、handoff cleanup、completion episode、Pause/Resume、transcript projection 和 final summary 分开成小型 owning-boundary suites，不集中到一个大型总测试文件。
- E2E 优先扩展职责匹配的 spec；若必须新增 formal-convergence spec，也要按场景拆分，避免一个超长脚本同时负责所有状态机。

## 十六、调查留下的诊断变化

为使接手人不会把诊断数据误当成用户原始操作，隔离数据库中新增了以下可识别事实：

1. Group Chat 诊断 A：
   - 正文：`【PR8F诊断-0828-A】请只回复“收到”，不要创建任务。`
   - Inbox row 41；
   - 仍 unread；
   - 触发空 Turn `fcfca73e...`。
2. `@Planner` 诊断 B：
   - 在后端持久化前被拒绝；
   - 没有 Inbox row。
3. Planner Direct 诊断 C：
   - 正文：`PR8F-DIAG-0828-C Reply only ACK. Do not create or edit anything.`
   - 得到真实 Terra ACK；
   - assistant 回复错误泄漏到 Group Chat。
4. 一次真实 Pause/Resume：
   - activation generation 从 1 增至 3；
   - 用于证明 completion generation 不一致。

这些变化仅存在于 `<isolated-orgii-home>` 隔离环境。没有修改用户正常 ORGII_HOME，没有删除任何 Team/Session，也没有修改代码。

## 十七、交接完成条件

接手修复不能只以编译、单元测试或 happy path 为完成标准。以下全部成立后，PR8F 才能重新评估 Ready：

- [ ] Group Chat 用户消息有精确 source-to-observation-to-ack 链；
- [ ] Coordinator 不再获得后端必定拒绝的 `purpose` schema；
- [ ] active worker 可以在取消后完成受限 cleanup；
- [ ] cancel/complete 竞态不会丢 TaskOutput；
- [ ] Keep stopped 和新 mission 有明确、可审计的 episode 边界；
- [ ] Pause/Resume 不会让 completion candidate 看不到旧 Task graph；
- [ ] Direct 回复不会出现在 Group Chat；
- [ ] PR9 前不再暴露不可用的 `@Member`；
- [ ] Needs attention 显示具体原因、受影响范围和按钮后果；
- [ ] 真实 Terra + packaged App 完成上述主场景；
- [ ] 重启、五次 Watchdog、故障和 Retry 均保持唯一 receipt/input/attempt；
- [ ] 5 分钟性能测量、SQL/query plan 和请求计数完成，且不再有 unread 积压或空 Wake；
- [ ] 所有新增 Rust/TypeScript/E2E 测试按功能拆分，生产代码与测试代码分文件。

在这些条件完成前，应维持以下公开结论：

```text
PR8F status: Draft / not ready
Real-provider verdict: fail
Performance verdict: fail
User data migration: intentionally not covered
Destructive cleanup: not performed
```
