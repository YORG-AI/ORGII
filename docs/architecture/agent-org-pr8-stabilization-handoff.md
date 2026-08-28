# Agent Org PR8 Stabilization 统一修复交接

> 状态：实施前交接；修复尚未开始
>
> 日期：2026-08-28
>
> 真实复现 Session：`pr8f test 0828`
>
> 真实测试环境：packaged Tauri App，`orlando / gpt-5.6-terra`
>
> 目标分支关系：在 PR8F 最终 review head 上叠加一个统一稳定化 PR；实施前必须记录准确 base SHA
>
> rollout：PR8F 与本稳定化 PR 都保持 Draft，产品 gate 保持关闭，完整验收前不能宣称 PR8F 完成

## 一、已经作出的决定

本交接记录用户与 Codex 在真实测试问题调查后的最终交付决定。

### 已确认

1. 不推倒重写整个 PR8S 或 PR8F；保留已经成立的 Coordinator 权限隔离、Plan revision、formal receipt、Watchdog repair、completion certificate 和 final summary 基础。
2. 不再把用户观察到的问题拆成多个互相依赖的小修复 PR。
3. 在 PR8F 上叠加一个统一的 **PR8 Stabilization**，一次修完、一次真实验收、不能只合一半。
4. 不创建 PR8S-H1、PR8S-H2、PR8S-H3 或任何其他 PR8S 修复 PR；“原 PR8S 区域”和“原 PR8F 区域”只表示代码/根因来源，不表示新的交付拆分。
5. 这个 PR 的唯一用户结果是：修复 `pr8f test 0828` 暴露的端到端生命周期，使消息、协调、停止和最终收口能够连成一条完整链。
6. 只修用户亲自观察到的四个问题；不顺便实现 PR9、PR10，不增加新产品功能。
7. 生产代码与测试代码继续分文件：Rust 测试进入独立测试文件或 `tests/` 目录；TypeScript/React 使用独立 `.test.ts/.test.tsx`；不同功能不集中到大型总测试文件。
8. 所有可见操作仍必须使用 Computer Use 操作真实 packaged App；debug endpoint 只能创建隔离故障前置条件或读取证据。
9. 正常情况下不让用户处理 handoff：只要系统能够证明旧 Task/Turn/进程树已经 terminal，就自动释放 replacement；只有确实无法证明、可能残留外部影响时，才显示一次用户决策。
10. 用户已确认 `Keep stopped` 采用方案 A：如果本轮没有其他 open work，当前 work episode 自动以 Cancelled 正式收口；之后的新 mission 创建新的 work episode。

### 已确认、实施前必须写入 Design 的产品语义

用户已确认以下产品语义。写生产代码前必须把它明确写入权威 Design，不能只存在于本交接：

> 用户选择 `Keep stopped` 后，当前 replacement 不再启动，旧 Task 不恢复；如果本轮没有其他 open work，则当前 work episode 以 Cancelled 正式收口。之后用户发送的新 mission 创建新的 work episode，不再混入旧 cancelled closure。

正常自动交接与例外人工决策的边界同时锁定为：

```text
旧 Task/Turn/完整进程树可以证明 terminal
→ 系统自动释放 handoff
→ replacement 自动继续
→ 不显示用户决策

旧执行超时、崩溃或外部影响确实无法证明
→ 只创建一个 typed unknown handoff
→ 才让用户选择继续接班、停止当前任务或取消整轮工作
```

## 二、为什么改成一个统一 PR

PR8S 和 PR8F 原本按代码所有权拆分：

- PR8S 管 Coordinator 安全、Task handoff 和 completion certificate；
- PR8F 管 Plan、formal trigger、Watchdog 和 final summary。

这在代码审查上有道理，但真实用户流程不会按 PR 边界运行。用户的一次操作跨越了消息入口、Coordinator、Member、进程、Task 和最终报告：

```text
用户在工作中发送新要求
        ↓
Coordinator 没有真正收到消息
        ↓
Coordinator 与 Tester 沟通时又使用了错误参数
        ↓
消息失败后，Coordinator 错误取消 Tester
        ↓
Tester 的后台进程和结果无法安全收口
        ↓
Keep stopped 留下没有正式结算的 cancelled scope
        ↓
所有 Member Idle，但 Team 一直 Needs attention
```

如果继续按 PR8S/PR8F 文件归属分别交付，很容易再次出现“每段单独通过，拼起来断链”。因此本次把它们定义成一个端到端稳定化问题：

> **用户在 Agent Org 工作期间追加要求、Member 报告风险、Coordinator 协调或停止执行后，系统必须安全、可恢复、可解释地结束当前工作轮次。**

“一个 PR 一起交付”不等于“把所有逻辑写在一个模块”。每条权威事实仍有自己的单一写入者，只是它们必须在同一个 PR 和同一条真实验收旅程中共同成立。

## 三、统一 PR 要修的四个用户问题

| 用户观察                                          | 最早根因                                                                                                | Stabilization 必须达到的结果                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Tester 显示 Needs attention，需要人工处理停止失败 | Task 取消后，后台子进程没有被精确 Task/Turn owner 完整收走                                              | 可自动证明 terminal 的执行自动停止；只有确实 unknown 时才询问用户一次                           |
| Team 工作时发送 Group 消息没有作用                | Group 消息写进旧 Inbox，PR8F Coordinator 只读取新精确输入，写入端和读取端断开                           | 消息持久 FIFO 排队，Provider 实际观察后才确认；不硬打断当前 Member                              |
| Tester 已完成测试，却再次 Needs attention         | Coordinator 回复 Tester 时看到了只属于 Member→Coordinator 的 `purpose`；错误后升级为 cancel-and-replace | 两个发送方向 schema 正确；普通追问能送达，不取消 active Tester                                  |
| 所有 Task terminal，Overview 仍 Needs attention   | 未读 Group 消息加上 `Keep stopped` 的 cancelled scope 都在阻止 completion certificate                   | 每个 blocker 有明确身份；消息观察后解除消息 blocker；episode closure 完整后签发唯一 certificate |

## 四、四条必须同时成立的用户契约

### 4.1 Group 消息：默认排队，不硬打断

未点名具体 Member 的 Group 用户消息归 Coordinator Root。

```text
发送
→ 持久 source / FIFO sequence
→ Coordinator 正忙则等待下一 Turn
→ 精确 materialize
→ Provider 实际观察
→ 精确 acknowledgement
```

禁止：

- 只写普通 Inbox 再创建空 Wake；
- 恢复 Coordinator blanket unread drain；
- 用前端本地布尔值猜消息已处理；
- 为处理普通 Group 消息取消正在运行的 Member Task；
- 把本修复扩大成 PR9 的完整 `@Member` GroupMention。

### 4.2 Coordinator 与 Member：允许对话，但方向规则不同

`purpose` 不是所有消息的通用“主题”，而是限制 Member 不要用普通进度反复唤醒 Coordinator 的入口分类。

| 方向                 | 合法输入                               | 说明                                                                             |
| -------------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| Member → Coordinator | 精确 `related_task_id` + `purpose`     | 只有 blocker、decision_required、material_change、risk、requested_reply 才能发送 |
| Coordinator → Member | 精确 `related_task_id`，不带 `purpose` | Coordinator 可以正常追问、补充要求和回应风险                                     |

Provider 看到的 schema 必须按 caller role 和发送方向生成；执行端仍需 fail closed。旧调用误带反方向参数时，只返回清楚、可重试的方向性错误，零 Task mutation，不能诱导 cancel-and-replace。

### 4.3 Task 停止：必须停止完整执行，不给 Coordinator 工作工具

Coordinator 负责调度，不获得 shell、process kill、测试或文件修改权限。

TaskExecution 启动的 shell、PTY、后台 job 和子进程必须始终绑定精确 Task/Turn owner。cancel-and-replace 的顺序是：

```text
提交取消 fence / handoff receipt
→ 精确停止旧 owner 的完整进程树
→ 等待有界 terminal 证据
→ released 后才允许 replacement
→ 只有 unknown 才显示用户 handoff
```

正常可证明 terminal 的路径必须完全自动化，不向用户显示 Continue replacement、Keep stopped 或 Abandon episode。不得通过隐藏 unknown、自动假定停止成功或给 Coordinator 任意 kill 权限来伪造收敛。

### 4.4 工作轮次：必须知道这一轮怎样结束

Root Session 可以承载多轮 mission，但每轮 mission 必须有稳定 work episode identity。

- `activation_generation` 只表示当前工作授权版本，不能兼任 work episode；
- Task、replacement、handoff、scope removal、completion certificate 必须能追溯到同一 episode；
- `Keep stopped` 必须产生明确、可验证的 scope resolution；
- 新 mission 不能继续混在上一轮 cancelled closure 中；
- Run View 返回 typed blocker，不再把不同原因全部压成泛化 Needs attention；
- FinalSummaryReceipt 只能消费已经签发的 completion certificate，不能替代缺失 closure。

## 五、权威状态和单一写入者

统一 PR 不得建立第二套平行事实。

| 事实                            | 唯一权威                                               | 不允许的替代                                  |
| ------------------------------- | ------------------------------------------------------ | --------------------------------------------- |
| Group 用户消息是否排队/被观察   | 持久 source、FIFO/Turn binding、EventStore observation | React 本地 pending、空 Wake、时间猜测         |
| Member→Coordinator 是否值得唤醒 | Task binding + typed `purpose` + exact receipt         | 正文关键词、普通 narration                    |
| Coordinator→Member 消息是否合法 | Coordinator Turn authority + related Task binding      | 复用 Member-only `purpose`                    |
| 旧执行是否释放                  | Task/Turn/process owner 的 terminal evidence           | Task status 已 cancelled、固定等待时间        |
| replacement 是否可启动          | committed handoff release gate                         | UI 点击、Coordinator 自由文本                 |
| cancelled scope 是否关闭        | work episode resolution link                           | 把 cancelled 改成 completed、隐藏 Task        |
| Run 是否可完成                  | completion validator 签发的 certificate                | all-terminal Task 数量、Member Idle、前端推断 |
| 最终报告是否完成                | active FinalSummaryReceipt + EventStore event          | typing atom、timer、自由文本                  |

## 六、一个 PR 内的实施顺序

这些是 review commits / workstreams，不是可单独宣告完成的 PR：

1. **Design 与 episode contract**
   - 把 `Keep stopped`、新 mission、work episode 和 certificate 规则写入 Design；
   - 更新状态/唯一键/索引影响和失败语义。
2. **按方向生成消息工具 schema**
   - 分离 Member→Coordinator 和 Coordinator→Member；
   - 修复错误引导与 cancel 升级；
   - 加真实序列化 schema snapshot。
3. **Group→Coordinator Root FIFO**
   - 把旧 Group producer 接入精确 Root UserDirectedWork queue；
   - 加稳定 source、Turn、观察和恢复；
   - 删除空 Wake 和本地 pending 猜测的权威语义。
4. **Task/Turn/process 精确停止**
   - 进程树 owner、释放 gate、unknown handoff；
   - 改清三个 handoff 按钮的影响范围。
5. **Work episode 与 completion closure**
   - Task/replacement/resolution/certificate 统一 episode；
   - typed Needs attention blocker；
   - certificate 与 final summary 接线复核。
6. **Wire、UI、locale 与完整验收**
   - Rust DTO、Tauri command、TypeScript 类型和真实 wire 一致；
   - 13 locale；
   - 独立 E2E、故障、重启、性能证据；
   - 同一个真实 Terra Session 完整跑通。

任何 workstream 都不能通过在 UI 隐藏错误状态或直接修改测试数据库来制造通过。

## 七、明确不做什么

本 PR 不包括：

- PR9 的完整 `@Member` GroupMention、Linked Inbox 或多人 fan-out；
- PR10 的最终 Group transcript projection 和默认 rollout；
- 普通 SDE Plan mode 重写；
- 第二个 Coordinator dispatcher 或第二条 Provider lane；
- 新 Task 状态；
- 给 Coordinator shell、文件、测试、browser 或外部 mutation 工具；
- 外部用户数据库 migration；
- unrelated cleanup、格式化或顺手重构；
- 仅为让本次 Session 看起来正常而删除 unread row、cancelled Task 或历史证据。

后续额外发现的问题继续留在原调查文档，不自动扩大本 PR 范围。

## 八、测试组织

### 8.1 Owning-boundary 测试

Rust：

- process owner 与完整子进程树停止；
- handoff/release/replacement 的并发、timeout、restart；
- 两种消息方向的 schema、execute、Store authority；
- Group source/FIFO/materialize/ack/replay；
- work episode、Keep stopped、第二 mission、completion closure；
- certificate 与 final summary 的唯一性和顺序；
- 所有未知 enum/status fail closed。

TypeScript/React：

- queued/observed 状态来自持久 projection；
- Coordinator/Member 消息 UI 不泄漏内部参数；
- 三个 handoff 操作显示准确影响范围；
- typed Needs attention 原因和可执行动作；
- refresh、Session switch、restart 后 projection 一致。

测试文件规则：

- Rust 大段测试不得写在生产文件；
- 不同 Rust 功能使用独立测试文件或对应 `tests/` 目录；
- TypeScript/React 使用独立 `.test.ts/.test.tsx`；
- rendered E2E 按 Group FIFO、handoff、episode/finality 分开，不能继续扩成一个大型总 spec。

### 8.2 真实 packaged App：两轮德州扑克主场景

固定使用全新隔离 `ORGII_HOME`、临时 git workspace 和当前分支 BuildFast App，记录 branch、HEAD、bundle path 和 executable SHA-256。Provider 固定 `orlando / gpt-5.6-terra`。

所有可见操作都由 Computer Use 完成，不通过 debug endpoint 代替发消息、批准计划、切换 Session、停止、确认或 Retry。

#### 第一轮：从零完成 Texas Hold'em 游戏

1. 在真实 Group Chat 提出：“规划、实现、运行并验证一个本地 Texas Hold'em 游戏”，并明确要求独立、持久的实现报告和测试报告 TaskOutput/Artifact；
2. 真实经历 Planner 提交计划、用户原样批准、Implementer 实现、Tester 运行应用和测试；
3. Tester 必须启动真实测试服务器或等价后台子进程，证明进程 owner 和正常 terminal 路径；
4. Coordinator 与 Member 的风险报告和回复使用正确的双向消息规则；
5. 正常可以自动停止的执行不显示 handoff 用户决策；
6. 所有 Task terminal 后生成唯一 completion certificate；
7. Finalizing 只覆盖 active FinalSummaryReceipt，最终报告持久进入 Coordinator EventStore；
8. 刷新、切换 Planner/Implementer/Tester/Coordinator Session、退出并重启 App，第一轮计划、TaskOutput、Artifact、certificate 和最终报告仍然可见；
9. 只有确认第一轮已经完整收口，才能发送第二轮修改。

#### 第二轮：在同一 Session 完成“任意额度加注”修改

1. 通过真实 Group 输入框发送：“我想要做可以任意加注任何额度的加注，现在好像只能加20”；
2. 验证系统创建新的 work episode，而不是重新打开或混入第一轮已经完成的 closure；
3. Coordinator 实际观察这条消息并创建本轮修改/测试工作；消息不能只躺在旧 Inbox，也不能产生空 Wake；
4. Implementer 真实修改游戏，使合法加注不再固定为 20，并保留扑克规则约束；
5. 第二轮工作进行期间，再通过真实 Group 输入框发送一条与当前修改相关的补充说明，验证它显示 Queued、进入 FIFO，并且不取消正在工作的 Member；
6. Tester 使用 `purpose=risk` 或另一种确实需要 Coordinator 行动的合法原因报告一次风险；Coordinator 不带 `purpose` 正常回复 Tester；
7. Tester 真实验证任意额度、最小合法加注、all-in、非法输入和关键回归，并提交独立测试 TaskOutput/Artifact；
8. 第二轮所有 Task terminal 后签发属于第二个 episode 的唯一 completion certificate，并生成第二份持久最终报告；
9. 切换 Session、刷新、退出并重启 App，两个 episode 的计划、Task、结果和最终报告保持分离且都可读取。

#### 聚焦异常场景

主场景必须自然完成，不为制造 handoff 故意破坏第一轮或第二轮。另建隔离 focused run 覆盖：

1. 一次 cancel-and-replace，旧进程可证明 terminal 时自动交接，零用户决策；
2. 只用隔离 fault fixture 制造确实 unknown 的旧执行，验证只出现一个决策卡；
3. 使用真实按钮分别验证 Continue replacement、Keep stopped、Abandon episode 的准确影响范围；
4. 选择 Keep stopped 且无其他 open work，当前 episode 自动 Cancelled；随后发送新 mission，验证进入新 episode；
5. 现有 PR8F 要求的 Stop、Pause、Resume、Archive、Delete、Retry 回归仍需执行；Delete 最终确认继续遵守 Computer Use 安全确认规则。

必须同时读取 SQLite、EventStore、source/receipt ids、Task/Output digest、Turn/process owner、certificate 和 Provider/runtime 请求数。Debug endpoint 不能代替上述 UI 路径。

### 8.3 失败和恢复

- Group commit 后 wake 丢失；
- Provider response loss；
- Coordinator/Tester Turn crash；
- detached child 或停止 timeout；
- cancel 与 complete 两种提交顺序；
- App 在 queued/running/persisting 阶段重启；
- completion/EventStore/final summary failure；
- 五次 Watchdog tick 不重复 source、handoff、certificate 或 Provider Turn。

## 九、性能与生命周期要求

- 没有新消息或 trigger 时，不增加逐 Team timer、Provider wake、shell/process 或业务 Inbox 写入；
- Group 消息每个 source 只有一个 materialized input；
- Coordinator active Turn 期间到达的 later row 只触发至多一个 follow-up；
- 无 missing doorbell 时 Watchdog 仍是有索引支持的只读 no-op；
- handoff timeout/restart 不保留重复 runtime、job 或 replacement；
- failed/Idle 后五分钟内零自动 Provider retry；
- 普通 SDE 的 listener、timer、请求和消息持久化与基线一致；
- `Command+5`、后端计数和真实 CPU/RSS/请求数据共同给出性能结论，不能用代码形状代替测量。

## 十、保守估算和范围闸门

本估算是相对 PR8F 最终 head 的增量，review lines 按 additions + deletions 计算。

| 类别                                    |        P50 |         P90 |
| --------------------------------------- | ---------: | ----------: |
| Production：Rust、SQL、wire、React      |      5,900 |      12,250 |
| 单元、并发、恢复、E2E、真实测量         |      7,650 |      14,850 |
| locale、机械调整、Design/audit/evidence |      1,450 |       2,700 |
| **总 review lines**                     | **15,000** |  **29,800** |
| **实质文件**                            | **70–100** | **120–165** |

13 个 locale 和 evidence 文档另行明确列出；不同 workstream 会触达同一核心文件，文件数不能机械相加。

范围闸门：

- 到 10,500 review lines（P50 70%）重新统计；
- 预测超过 29,800 review lines 或 165 个实质文件时暂停，更新 Design、Issue 和预算；
- 预测超过 44,700 review lines（P90 × 1.5）时重新评估是否需要切分，但不能交付一条不可运行的半链；
- 新增第二 dispatcher、新 Task 状态、完整 PR9/PR10 source/projection、外部 migration 或 Coordinator 工作工具时立即停线确认；
- 不得删减真实 Provider、packaged App、进程、重启、并发、故障或性能测试来压缩规模。

## 十一、架构审查门槛

本 PR 最终交付前必须逐层给出证据：

| 层               | 必须回答的问题                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------- |
| 1 编译与告警     | Rust、TypeScript、Tauri wire 和 E2E target 是否全部通过？                                 |
| 2 重复与死代码   | 旧 Group Inbox+generic wake、错误 schema 和平行 episode 语义是否删除，而非旁挂第二套？    |
| 3 命名           | `activation_generation`、work episode、purpose、source receipt 是否各表达一个概念？       |
| 4 状态维度       | Team、Task、handoff、message observation、episode 和 final summary 是否分离？             |
| 5 穷举与默认值   | 未知 status/kind/reason 是否 fail closed，而非默认 Pending/Idle/成功？                    |
| 6 作用域隔离     | 普通 SDE、PR9/PR10 未上线入口是否零额外工作？                                             |
| 7 单一写入者     | 消息观察、process release、scope resolution、certificate 是否各有唯一 transaction owner？ |
| 8 数据契约       | Provider schema、Rust DTO、Tauri command、TypeScript 类型和真实 wire 是否一致？           |
| 9 初始化对称     | fresh DB、restart、recovery、fault fixture 是否使用同一 canonical schema 和 resolver？    |
| 10 Resolver 对称 | 正常、重启和故障路径是否得到相同 post-condition？                                         |

## 十二、交付和合并策略

1. 当前 PR8F 保持 Draft，不以“主体代码已经完成”为由先合并；
2. PR8F 工作树先整理成可复核的最终 review head，并记录 SHA；
3. 从该 head 创建 `codex/agent-org-pr8-stabilization` 或等价分支；
4. Stabilization PR 的 base 指向 PR8F 分支，所有 workstream 在一个 PR 内 review；
5. PR8F 与 Stabilization 作为同一 release train 验收，前者不能脱离后者宣称用户链已完成；
6. 完整验收通过后，再根据 reviewer 需要决定保持 stacked merge，或把修复折回 PR8F；无论哪种方式，最终主分支不能停留在已知断链且 gate 打开的状态；
7. PR 描述必须以 `Problem`、`Solution`、`Potential risks` 三节开头，并列出实际运行的命令、真实 UI 证据、未运行项和回滚方式；
8. 发布前检查 secrets、个人路径、隔离测试目录、debug log、构建产物和无关格式化，任何一项不得进入 PR。

## 十三、完成定义

只有以下条件全部成立，PR8 Stabilization 才能 Ready：

- 工作中发送 Group 消息能够持久排队并被 Coordinator 精确观察；
- Coordinator 与 Member 双向对话规则正确，Provider 看不到反方向非法参数；
- 普通消息失败不会升级为取消 active Tester；
- 可自动停止的 Tester 进程树不再要求人工处理；
- 确实 unknown 时只出现一个可解释、可恢复的 handoff；
- 正常自动交接路径完全不显示用户决策；
- `Keep stopped` 的影响范围在点击前清楚可见；
- Keep stopped 且没有其他 open work 时，当前 episode 自动 Cancelled；
- 同一 Session 中第一轮完整 Texas Hold'em 交付和第二轮“任意额度加注”修改都能独立完成并持久保存；
- 第二个 mission 不再混入第一轮 closure；
- 每轮工作得到唯一 Delivered、Cancelled、Failed 或 typed blocker；
- completion certificate 与 final summary 顺序正确且重启可恢复；
- 用户最初观察到的四个问题全部在同一真实 Terra packaged App 场景中不再复现；
- owning tests、完整回归、性能和普通 SDE 隔离证据齐全；
- 没有把 PR9、PR10 或其他额外发现偷偷并入范围。

## 十四、详细证据索引

- 原 PR8S 区域的详细根因和测试证据（不是独立修复 PR）：`docs/architecture/agent-org-pr8s-user-observed-issues-handoff.md`
- 原 PR8F Group FIFO 区域的详细根因和测试证据（不是独立修复 PR）：`docs/architecture/agent-org-pr8f-user-observed-issues-handoff.md`
- 完整真实 Provider 调查时间线：`docs/architecture/agent-org-pr8f-real-provider-investigation-handoff.md`
- 权威设计：`docs/architecture/agent-org-long-lived-team-session-design.md`
- Issue：[org2AI/ORG2#997](https://github.com/org2AI/ORG2/issues/997)

如果详细文档与 Design 冲突，以更新后的 Design 为最高权威；如果本交接与真实生产证据冲突，必须先停线调查最早写入边界，不能用 UI 过滤或删除历史数据绕过。
