# Agent Org PR8S 用户实测问题交接

> 状态：调查完成，修复尚未实施
>
> 日期：2026-08-28
>
> 用户复现 Session：`pr8f test 0828`
>
> 调查环境：当前 packaged Tauri App，真实 `orlando / gpt-5.6-terra`
>
> 本文范围：只记录用户亲自观察到、归属 PR8S 的问题，不包含后续额外调查发现，也不记录 PR8F 的 Group 消息断链。
>
> **交付决定：不再创建任何 PR8S 修复 PR。本文只保留原 PR8S 区域的根因和测试证据；本文全部生产修复统一进入 `PR8 Stabilization`。**

## 一、最简单的结论

PR8S 当前有三处需要返修：

1. Tester 留下后台进程时，系统不能可靠自动停干净；
2. Coordinator 回复 Tester 时，系统错误地向它展示了只供“Member 向 Coordinator 报告风险”使用的 `purpose` 参数；消息被拒绝后，Coordinator 又错误取消了 Tester；
3. `Keep stopped` 之后，系统不知道当前这一轮工作怎样正式结束。

它们不代表 PR8S 整体方向错误。Coordinator 权限隔离、handoff receipt 和 completion certificate 仍可保留；需要重做的是 handoff、消息工具契约和 completion closure 这三段边界。

这里必须先澄清：**Coordinator 仍然可以正常给 Member 发消息。** 问题不是禁止 Coordinator 和 Member 对话，而是两个发送方向使用了不同规则：

| 发送方向             | 应该怎样发送                                          | `purpose` 的作用                                                                               |
| -------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Member → Coordinator | 绑定当前 `related_task_id`，并提供 `purpose`          | 证明这不是普通进度，而是确实需要 Coordinator 行动的 blocker、decision、risk 等事项             |
| Coordinator → Member | 绑定当前 `related_task_id`，发送普通 Task-scoped 消息 | **不使用 `purpose`**；Coordinator 本身已有协调权限，不需要用它证明“为什么可以唤醒 Coordinator” |

`purpose` 是限制 Member 不要随便打扰 Coordinator 的入口分类，不是所有 Agent 对话都必须填写的“消息主题”。

## 二、问题清单

| 用户看到的问题                                                     | 最早根因                                                                                     | 大白话                                                             | 性质                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------- |
| Tester 显示 Needs attention，要求用户处理停止失败                  | 旧 Tester 的后台进程没有被 Task/Turn owner 完整收走                                          | 系统停掉了工单，却没停干净工单启动的程序                           | PR8S handoff 实施不完整          |
| `Keep stopped`、`Continue replacement`、`Abandon episode` 难以理解 | UI 没在作出决定前说明每个按钮影响的范围                                                      | 用户不知道是在停一个接班任务，还是放弃整轮工作                     | PR8S UI 契约不清                 |
| Tester 已经完成测试，Overview 又 Needs attention                   | Coordinator 回复 Tester 时，工具 schema 错误暴露了只属于 Member→Coordinator 方向的 `purpose` | Coordinator 本来可以正常回复，却被系统诱导填写了一个反方向专用字段 | PR8S 工具契约自相矛盾            |
| 所有 Task 都 terminal，仍然没有 completion certificate             | `Keep stopped` 留下的 cancelled scope 没有合法 resolution closure                            | 所有人都停下了，但系统没有一张能证明“这一轮怎样结束”的结算单       | PR8S completion 设计和实现未收口 |

## 三、问题一：Tester 无法自动安全停止

### 用户看到什么

- Tester 看起来像测试失败或卡住；
- Overview 显示 Needs attention；
- 用户必须选择 `Continue replacement`、`Keep stopped` 或 `Abandon episode`；
- 用户选择 `Keep stopped` 后所有 Member 变成 Idle；后来再发消息，Team 又能继续工作。

### 实际发生了什么

Tester 当时仍有后台测试服务器。Coordinator 发起 cancel-and-replace 后，原 Task 立即进入 cancelled，Tester 的后续工具调用失去权限，但后台子进程没有被可靠证明已经停止。

系统因此只能把外部影响标为 unknown，并要求用户决定是否允许 replacement 继续。这种“确实无法证明已经停干净时让用户决定”的安全原则是正确的；错误在于系统过早撤销 Task 权限，却没有先可靠收走该 Task 启动的完整进程树。

正常情况下不应该出现用户决策：如果后端能够证明旧 Task、Turn 和完整进程树已经 terminal，就自动释放 replacement 并继续。只有停止超时、崩溃或外部影响确实无法证明时，才显示一次用户 handoff。

相关生产入口：

- `src-tauri/crates/agent-core/src/core/tools/impls/orchestration/agent_org/task_update.rs`
- `src-tauri/crates/agent-core/src/state/commands/session/org_tasks/handoff.rs`
- `src-tauri/crates/agent-core/src/core/tools/impls/coding/exec/registry.rs`
- `src/engines/ChatPanel/InputArea/components/AgentOrgOverviewPanel.tsx`

### 大白话

Tester 开了一个测试服务器。Coordinator 把 Tester 的工单取消了，但测试服务器还在后台。Tester 又因为工单被取消而没有权限继续清理。系统不知道后台程序是否仍会产生影响，所以把风险丢给用户。

### `Keep stopped` 当前到底做什么

`Keep stopped` 只表示：

- 不启动这个被阻塞的 replacement；
- 不恢复旧 Task；
- 不关闭整个 Team；
- 其他 Task 和后续新消息仍可能继续。

因此“按下 Keep stopped 后，后来发消息 Team 又继续”本身不是运行时错误。错误是按钮名称和说明让用户以为它等于“取消整个任务或停止整个 Team”。

### 正确修复边界

1. 每个 TaskExecution 启动的 shell、PTY、后台 job 和子进程必须始终绑定精确 Task/Turn owner；
2. cancel-and-replace 后，后端自动停止该 owner 的完整进程树，并等待有界 terminal 证据；
3. 只有停止超时、崩溃或结果确实无法证明时，才创建一次用户 handoff；
4. 不给 Coordinator shell 或任意 kill 权限；
5. replacement 只能在旧执行确定释放后启动；
6. 三个用户选项必须在主卡片上直接说明影响范围和最终结果。

### 必须测试

- Tester 持有真实后台子进程时 cancel-and-replace，进程树自动终止；
- detached child、PTY、shell 已返回但子进程仍运行等情况；
- 停止成功时不出现 Needs attention；
- 停止结果 unknown 时只创建一个 handoff，重启后不重复；
- 三个按钮分别验证当前 Task、replacement、兄弟 Task 和整个 episode 的变化；
- 所有可见按钮和确认框通过 packaged App 的真实 UI 操作。

## 四、问题二：Coordinator 回复 Tester 时被错误诱导使用 `purpose`

### 用户看到什么

Implementer 已完成修改，Tester 也实际完成测试，但 Overview 再次显示 Needs attention，看起来像测试结果丢失。

### `purpose` 原本是做什么的

`purpose` 只服务于下面这个方向：

```text
TaskExecution Member → Coordinator
```

Member 正常开工、完成了哪些模块、下一步做什么，应该写 Task 状态或 TaskOutput，不能每次都发消息唤醒 Coordinator。只有确实需要 Coordinator 行动时，Member 才能发送消息，并填写：

- `blocker`：我被卡住了；
- `decision_required`：需要 Coordinator 做决定；
- `material_change`：任务发生重大变化；
- `risk`：发现重要风险；
- `requested_reply`：Coordinator 明确要求我回复。

Coordinator 给 Member 补充要求、追问风险或请求继续测试时，走的是反方向：

```text
Coordinator → TaskExecution Member
```

这个方向仍然允许正常对话，只需要绑定准确的 `related_task_id`，**不应该出现或填写 `purpose`**。

### 本次测试实际发生了什么

Tester 报告风险后，Coordinator 尝试向 Tester 发消息。工具 schema 向 Coordinator展示了 `purpose=material_change|blocker|...`，但后端规定 `purpose` 只允许 TaskExecution Member 向 Coordinator 使用。

Coordinator 连续收到工具错误后，改用 cancel-and-replace。取消事务先提交，Tester 稍后提交完成结果时，authoritative Task 已经 cancelled，所以 TaskOutput 被拒绝。

完整错误链是：

```text
Tester 使用 purpose=risk 报告风险
        ↓
Coordinator 准备回复 Tester
        ↓
系统错误地仍向 Coordinator 展示 purpose
        ↓
Coordinator 误填 purpose=material_change / blocker
        ↓
后端按原设计拒绝这个反方向用法
        ↓
Coordinator 没有去掉 purpose 重试，而是错误取消 Tester Task
```

因此，这次测试没有证明 Coordinator 需要 `purpose`。它证明的是：**工具 schema 没有按发送者角色和发送方向裁剪，向 Coordinator 暴露了一个不属于它的参数。**

相关生产入口：

- schema：`src-tauri/crates/agent-core/src/core/tools/impls/orchestration/agent_org/send_message.rs`
- execute-time 校验：`src-tauri/crates/agent-core/src/core/tools/impls/orchestration/agent_org/send_message/persistence.rs`
- cancel-and-replace：`src-tauri/crates/agent-core/src/core/tools/impls/orchestration/agent_org/task_update.rs`

### 大白话

Tester 用一张“我为什么必须打扰 Coordinator”的理由单报告风险。Coordinator 收到后本来可以直接回复，但系统又把同一张理由单塞给 Coordinator 填。Coordinator 填完才被告知“这张单只允许 Tester 使用”。随后 Coordinator 没有正常重发回复，反而错误取消了 Tester 工单。Tester 拿着已经完成的测试报告来提交时，系统说工单已作废，不能收件。

### 正确修复边界

1. 按 caller role 和发送方向生成真实工具 schema；
2. Member→Coordinator 的 actionable fact 才出现并要求 `purpose`；
3. Coordinator→Member 保留正常 Task-scoped 消息能力，只要求准确的 `related_task_id`，schema 中不出现 `purpose`；
4. execute-time 仍保留 fail-closed 校验，防止旧调用绕过 schema；
5. 如果旧调用误带 `purpose`，错误必须明确提示“去掉 purpose 后重试”，不能诱导升级为 cancel-and-replace；
6. Coordinator 向 active worker 普通追问不能通过 cancel Task 实现；
7. cancel 与 complete 的提交顺序必须有确定测试；不得静默把迟到结果当成普通 narration；
8. Provider 看到的序列化工具 schema 必须和 Rust 执行规则完全一致。

### 必须测试

- Coordinator、TaskExecution Member、普通 SDE 各自的真实 schema snapshot；
- Coordinator→Member schema 不包含 `purpose`，但仍能发送带准确 `related_task_id` 的消息；
- Member→Coordinator 合法场景包含五种允许的 `purpose`；普通进度不能借此唤醒 Coordinator；
- Coordinator 追问 active Tester，Tester 能收到并回复，全程不取消 Task；
- 旧调用误带 `purpose` 时返回可重试的方向性提示，零 Task mutation；
- cancel 先提交和 complete 先提交两种竞态；
- 真实 Terra 场景包含 Tester 正在停止服务器时的风险报告和追问。

## 五、问题三：`Keep stopped` 后这一轮工作无法正式结束

### 用户看到什么

- 所有 Task 最后都变成 completed、failed 或 cancelled；
- 所有 Member 都是 Idle；
- Overview 仍显示 Needs attention；
- 没有最终报告。

### 本问题中属于 PR8S 的部分

PR8F 的未读 Group 消息也是一个 blocker，但它单独记录在 PR8F 交接文档中。本节只记录另一个 blocker：`Keep stopped` 取消 replacement 后，旧 cancelled scope 没有 completed descendant，也没有明确的 user-scope-removal 证明，因此 completion validator 不能签发 delivered certificate。

### 大白话

界面上所有人都停工了，不等于系统知道“这一轮是成功完成、部分取消，还是整体放弃”。当前少了一张说明 cancelled Task 怎样被合法关闭的结算单，所以系统不敢宣布完成。

### 已确认、需要写入 Design 的产品决定

用户已确认采用方案 A：

> 用户选择 `Keep stopped`，并且已经没有其他 open work 时，立即把当前工作轮次结束为 Cancelled；之后用户发送的新 mission 自动开始新的工作轮次。

`Keep stopped` 关闭当前被停止的 scope；如果本轮仍有其他 open work，它们继续；如果本轮不再有其他工作，则本轮以 Cancelled 收口。之后的新 mission 创建新的 work episode，不能继续混在旧的 cancelled closure 中。实施前必须把该语义写入权威 Design。

### 正确修复边界

1. 定义贯穿 Task、replacement、handoff、completion certificate 的稳定 work episode identity；
2. `activation_generation` 继续只表示工作授权版本，不能兼任 episode identity；
3. `Keep stopped` 必须产生明确、可验证的 scope resolution；
4. 新 mission 必须绑定明确的当前或新 episode，不能靠 Root Session 和时间猜测；
5. Run View 返回 typed blocker，不能把所有原因都压成泛化的 Needs attention；
6. completion certificate 只在完整 resolution closure 成立时签发，不允许 UI 推断成功。

### 必须测试

- Keep stopped 后仍有兄弟 Task；
- Keep stopped 后没有任何 open Task；
- Keep stopped 后用户发送第二个 mission；
- replacement completed、replacement cancelled、abandon episode 三种 closure；
- 全 terminal 但 closure 不完整时显示具体原因和真实解决按钮；
- closure 完整时只签发一张 certificate，并允许后续 final summary 收口；
- refresh、Session switch 和 App restart 后 episode、Task 与 certificate 一致。

## 六、Stabilization 内部工作流与估算

以下只是同一个 `PR8 Stabilization` 内部的三个 workstream，用于实现和 review 组织；它们不是三个 PR，也不能单独合入或宣告完成：

| 修复                                                 | P50 / P90 review lines | 实质文件 P50 / P90 |
| ---------------------------------------------------- | ---------------------: | -----------------: |
| H1：精确进程树停止、handoff 与按钮说明               |          3,200 / 6,500 |      18–28 / 35–50 |
| H2：按角色和发送方向生成消息工具 schema              |            800 / 1,800 |       6–10 / 12–18 |
| H3：Keep stopped / work episode / completion closure |          5,000 / 9,000 |      28–40 / 50–65 |

上述估算包含独立 Rust 测试、独立 TypeScript/React 测试、rendered E2E、真实 Provider 和 packaged App 验收。13 个 locale 文件另算；不同 workstream 之间存在文件重叠，不能直接把文件数相加。统一 PR 的去重总预算和范围闸门以 `agent-org-pr8-stabilization-handoff.md` 为准。

若 H3 发现必须同时重写其他生命周期的 episode 语义，应先更新 Design 和预算，不能边写边扩大范围。

## 七、明确不在本文中的内容

- Group Chat 用户消息无人读取：归属 PR8F；
- PlanRevision、FormalTriggerReceipt、Watchdog、FinalSummaryReceipt 的一般实现审查；
- PR9 的 `@Member` GroupMention；
- PR10 的 Group transcript projection；
- 用户正常数据库迁移。

## 八、完成标准

`PR8 Stabilization` 中原 PR8S 区域的修复只有在以下条件全部成立时才算完成：

- 可自动安全停止的 Tester 不再要求用户处理；
- 正常自动交接完全不显示用户决策；
- 确实 unknown 的外部影响只产生一个 typed handoff；
- Coordinator→Member 仍可正常发送 Task-scoped 消息，但不会看到 Member→Coordinator 专用的 `purpose`；
- Member→Coordinator 只有真正需要协调时才携带 `purpose`；
- Coordinator 普通追问能够送达，不会取消 active Tester；
- `Keep stopped` 的影响范围对用户清楚可见；
- 每轮工作都能形成明确的 Delivered、Cancelled、Failed 或 typed blocker；
- 真实 Terra + packaged App 覆盖后台进程、handoff、第二个 mission 和最终 certificate；
- Rust 测试位于独立测试文件或 `tests/` 目录，TypeScript/React 测试使用独立 `.test.ts/.test.tsx`，不同功能不集中到大型总测试文件。
