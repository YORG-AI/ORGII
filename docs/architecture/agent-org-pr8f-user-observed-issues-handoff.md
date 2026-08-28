# Agent Org PR8F 用户实测问题交接

> 状态：调查完成，修复尚未实施
>
> 日期：2026-08-28
>
> 对应 Issue：[org2AI/ORG2#997](https://github.com/org2AI/ORG2/issues/997)
>
> 用户复现 Session：`pr8f test 0828`
>
> 调查环境：当前 packaged Tauri App，真实 `orlando / gpt-5.6-terra`
>
> 本文范围：只记录用户亲自观察到、归属 PR8F 的问题。PR8S 的进程停止、错误取消 Tester 和 completion closure 已拆到独立 PR8S 交接文档。
>
> **交付决定：本文只保留原 PR8F 区域的根因和测试证据；本文修复与原 PR8S 区域修复统一进入一个 `PR8 Stabilization`，不再分别开修复 PR。**

## 一、最简单的结论

用户观察到的四个问题中，PR8F 自己直接造成的核心错误只有一条：

> 用户在 Team 工作时发送 Group 消息，消息虽然保存成功，却进入了 Coordinator 已经不再读取的旧收件箱。

大白话：**信送到了旧邮箱，但现在没人查那个邮箱。**

这条错误还会间接造成“所有 Task 都结束了，Overview 仍 Needs attention”，因为那条从未处理的用户消息会一直阻止 Team 正式收口。

## 二、用户看到什么

用户在 Team 正在工作时发送：

`我想要做可以任意加注任何额度的加注，现在好像只能加20`

随后观察到：

- 消息显示在 Group Chat 中；
- 界面可能显示 Coordinator 正在接收；
- Team 实际没有响应；
- 消息长期躺在那里；
- 切换 Session、刷新或状态变化后，等待提示可能消失；
- 后来所有 Task terminal，Overview 仍可能显示 Needs attention。

这不是 Terra Provider 主动忽略消息。真实证据表明 Provider 根本没有收到该消息正文。

## 三、正确设计应该怎样工作

普通 Group 消息没有点名具体 Member 时，归 Coordinator Root 处理。

Coordinator 正忙时，默认行为应该是持久 FIFO 排队：

```text
用户发送 Group 消息
        ↓
持久保存并绑定稳定 source identity
        ↓
Coordinator 正忙：排到下一个 Coordinator Turn
        ↓
精确 materialize 为 Provider 可见输入
        ↓
Provider 实际观察并回答
        ↓
只确认这一条 source 已处理
```

它不应该：

- 硬打断当前 Member Task；
- 等所有 Member Task 做完才处理；
- 只发一个没有正文的 Wake；
- 由前端内存猜测消息是否已经处理；
- 恢复 Coordinator 对全部 unread Inbox 的批量读取。

完整 `@Member` GroupMention 属于 PR9；但“无 Member target 或只发给 Coordinator”的 Root 消息路径在 PR8F 后必须仍然工作。

## 四、真实发生了什么

### 旧写入端

Group Chat 发送命令继续走旧路径：

1. 写一条普通用户 Inbox row；
2. 调用 generic Coordinator wake。

相关入口：

- `src-tauri/crates/agent-core/src/state/commands/session/org_tasks/group_chat.rs`
- `src-tauri/crates/agent-core/src/core/tools/impls/orchestration/inbox_wake.rs`

### PR8F 新读取端

PR8F 为了消除重复触发和错误批量确认，把 Coordinator 的正式输入改成只读取精确 FormalTriggerReceipt：

- `src-tauri/crates/agent-core/src/core/session/turn/processor/inbox_drain/drain.rs`
- `src-tauri/crates/agent-core/src/core/coordination/agent_inbox/store_drain.rs`

user-directed Group row 不属于 FormalTriggerReceipt，因此不会出现在新的 Coordinator input batch 中。

### 最终断链

```text
Group 消息写入普通 Inbox
        ↓
generic wake 创建 Coordinator Turn
        ↓
Coordinator 只查询 FormalTriggerReceipt
        ↓
查不到用户消息
        ↓
Turn 没有输入，很快结束
        ↓
原消息永久 unread
```

这是 PR8F 替换消费者时漏迁移旧生产者产生的兼容回归，不是 Design 要求用户消息失效。

## 五、为什么 UI 会误导用户

当前 Group Chat 的“正在接收消息”主要是 React 页面内存中的 pending 状态，不是从持久化 observation receipt 重建。

因此可能发生：

- 消息实际仍 unread，但 UI 显示正在处理；
- 切换页面后本地状态被清掉，看起来像已经处理；
- Coordinator 空 Turn 结束后，UI 无法证明 Provider 是否看过正文。

相关前端入口：

- `src/engines/ChatPanel/hooks/useAgentOrgGroupChatController.ts`

## 六、对“最后一直 Needs attention”的影响

用户最后看到所有 Task terminal，但 Team 仍 Needs attention，有两个独立 blocker：

1. 本文负责的 PR8F blocker：Group 用户消息仍 unread；
2. PR8S blocker：`Keep stopped` 后 cancelled scope 没有合法 completion closure。

所以只修本文问题，可以清掉“未处理用户消息”这一项 blocker，但不能替代 PR8S 对 episode/completion 的修复。反过来，只修 PR8S completion，也不能删除或伪装这条未读用户消息。

## 七、正确修复边界

1. Root/Group 用户消息必须复用现有 Root UserDirectedWork queue，或建立等价的精确 source receipt；
2. 每条消息保存稳定 source id、causation、目标 Coordinator、Turn identity 和 FIFO sequence；
3. 业务消息和持久 doorbell 在同一事务提交；内存 wake 只负责加速；
4. Coordinator 正忙时，消息留给下一个 Turn，不能混入已 materialize 的当前 Turn；
5. Provider 成功后只确认当前 Turn 实际观察的 source；
6. crash、restart 和 response loss 复用原消息和原身份，不能重复生成 transcript input；
7. 前端 pending/queued/observed 状态来自持久事实，不使用本地布尔值猜测；
8. 不恢复 Coordinator blanket unread drain；
9. 不把普通用户 Group 消息登记成 FormalTriggerReceipt；正式工作 trigger 和 UserDirectedWork queue 保持两条精确但不同的输入来源；
10. 普通 SDE 不增加 Agent Org receipt、query、timer 或 listener。

若实现发现必须新增第二 Coordinator dispatcher、新 Task 状态或新的通用 GroupMention 协议，应立即停线更新 Design；这些都超出本修复范围。

## 八、必须测试

### 后端 owning-boundary

- Coordinator Working、Idle 时发送 Root Group 消息；
- busy Coordinator 的 later-row 保留到 follow-up Turn；
- 每条 source 只 materialize、ack 一次；
- response loss、Turn crash、App restart 后复用同一消息身份；
- Coordinator 不顺带读取另一 Task、Direct Member 或未 materialize row；
- 消息 pending 时阻止错误 finality，observed 后 blocker 精确消失；
- 五次 Watchdog tick 不重复消息、Wake 或 Provider Turn；
- Run View/page read 前后数据库无副作用；
- 普通 SDE 路径零 Agent Org 额外工作。

### Rendered E2E

- 通过 packaged Tauri App 的真实 Group Chat 输入框和 Send 按钮发送；
- 工作中发送新要求，UI 明确显示 Queued，再显示 Observed/回答；
- Session switch、refresh、退出 App、重新启动后状态一致；
- 不允许 debug endpoint 代替输入、发送或观察 Provider 回答；
- `Command+5` 和后端证据共同证明没有请求风暴或空 Wake。

### 真实 Provider

- 固定 `orlando / gpt-5.6-terra`；
- 运行一个真实 Member Task，在其尚未完成时发送第二条 Group 要求；
- 当前 Member Task 不被硬取消；
- Coordinator 在正确的后续 Turn 读取第二条要求；
- SQLite、EventStore、source/Turn identity 和 Provider 请求次数一致；
- 重启后消息和回答仍可见。

## 九、估算

| 类别                            |       P50 |       P90 |
| ------------------------------- | --------: | --------: |
| Production：Rust、wire、React   |     1,200 |     2,800 |
| 单元、恢复、并发、E2E、真实测量 |     1,800 |     3,700 |
| UI/机械调整与证据               |       500 |     1,000 |
| **总 review lines**             | **3,500** | **7,500** |
| **实质文件**                    | **22–32** | **40–55** |

当前 PR8F 实现本体为 17,487 review lines。完成本文修复后，预计约为：

- P50：20,987 review lines；
- 本修复达到 P90：24,987 review lines。

仍低于 Design 的 36,000 review-line P90 停线阈值，但实施时必须重新统计实质文件；不得通过删减真实 Provider、packaged App、重启、并发或性能测试压缩规模。

## 十、明确不在本文中的内容

- Tester 后台进程和 handoff：归属 PR8S；
- Coordinator 工具 schema 的 `purpose` 冲突：归属 PR8S；
- `Keep stopped` 与 completion closure：归属 PR8S，并需要补 Design；
- PR9 的 `@Member` GroupMention；
- PR10 的最终 Group transcript projection；
- 外部用户数据库迁移。

## 十一、完成标准

PR8F 只有在以下条件全部成立时，才能认为用户观察到的消息问题已经修复：

- 工作中发送的 Group 消息不会丢失或空 Wake；
- Coordinator 正忙时消息持久 FIFO 排队，而不是硬打断当前 Task；
- Provider 实际看到正文后才显示 observed；
- refresh、Session switch、restart 后 pending 状态不撒谎；
- 同一消息只有一个 source、一个 materialized input 和一次有效回答；
- 修复后不恢复 blanket Inbox drain；
- 用户消息不再错误阻塞最终 completion；
- 真实 Terra + packaged App 完成完整第二消息场景；
- Rust 测试位于独立测试文件或 `tests/` 目录，TypeScript/React 测试使用独立 `.test.ts/.test.tsx`，不同功能不集中到大型总测试文件。
