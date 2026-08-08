# Phase 0 冻结决策

本文件是 Phase 0 交付的决策冻结记录。实现阶段（Phase 1-8）与此冲突时，要么改
实现，要么先修订本文件并说明理由——不允许静默偏离。

## 1. Product mode 与 resolver precedence

Product mode enum：`build | plan | ask | project`（唯一 source of truth 是
ExecutionContext 的 `mode` 字段；禁止任何 `tracking_enabled` 类影子布尔）。

Mode resolver 固定顺序：

1. 从 WorkItem detail、Routine 或 RoutineRun 启动 → `project`；
2. 用户在当前 Session 明确选择的 mode；
3. 普通新 Session → `build`。

现状注意：mode 枚举目前有四处发散清单（Rust `AgentExecMode`、
`agent_list_modes`（返回 4 项且无 UI caller）、TS `AGENT_EXEC_MODES` picker、
`MODE_LABELS`）。Phase 3 收敛为单一 source 后才允许新增 `project`。

Plan mode 有"进入时快照、退出时恢复前一 mode"状态
（`restore_mode_before_plan_entry`）：`Convert to Project` 必须失效该快照。

## 2. Mode × capability allowlist

Capability 词汇表（12 个，见 `common.schema.json#/definitions/capabilityId`）：
`work.read|create|update|claim|transition|note|relate`、
`routine.read|apply|run|cancel|set_enabled`。`context` 读取不需要 capability。

| Mode                                | allowlist          |
| ----------------------------------- | ------------------ |
| build / plan / ask / 其他 exec mode | （空——仅 context） |
| project                             | 全部 12 个         |

最终 capabilities = mode allowlist ∩ actor/org policy ∩ provider capabilities。
实现必须用现有 deny-delta 机制表达（"modes never grant tools"）：Build/Plan 等
显式 deny work/routine mutation surface，Project 不施加该 deny；授权本身只来自
actor/org policy。

术语隔离：本协议的 `runtimeExecutionMode` 对应现有 `AgentExecMode` wire
values；**不得**复用现有 Rust `ExecutionMode { Direct, WorkStation }` 类型名。
`review` 在三个域必须使用限定名：exec mode（`AgentExecMode::Review`）、agent
role（`AgentRole::Review`，orchestrator 状态机 key 的列）、orchestrator phase
（`OrchestratorPhase::Review`）。

## 3. 错误码 ↔ exit code

错误码枚举见 `envelope.schema.json`（18 个，含 `RESULT_SCHEMA_MISMATCH`）。

| exit | 错误码                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 0    | success                                                                                                      |
| 2    | INVALID_ARGUMENT / RESULT_SCHEMA_MISMATCH / DEPENDENCY_CYCLE                                                 |
| 3    | NOT_FOUND / CONTEXT_REQUIRED / ACTOR_REQUIRED                                                                |
| 4    | REVISION_CONFLICT / IDEMPOTENCY_CONFLICT / ALREADY_CLAIMED / ALREADY_EXISTS / NOT_READY / INVALID_TRANSITION |
| 5    | PROJECT_MODE_REQUIRED                                                                                        |
| 6    | PROVIDER_UNAVAILABLE / STORE_UNAVAILABLE                                                                     |
| 7    | UNSUPPORTED_CAPABILITY                                                                                       |
| 8    | PERMISSION_DENIED / SCOPE_VIOLATION                                                                          |

`PROJECT_MODE_REQUIRED`（5）与 `PERMISSION_DENIED`（8）分离：前者提示"需要用户
切换 mode"，后者是"该 actor 无权执行"。claim 竞争时 `ALREADY_CLAIMED` 优先于
`REVISION_CONFLICT`。现有 `orgtrack check` 的 0/1/2 exit 语义属于该 binary 自身，
与本表无关。

## 4. CLI 载体与 crate 命名

- 用户侧 command 名为 `org2`；由**新的独立 console binary** 提供：crate
  `orgtrack-pm-cli`，cargo bin name `org2-pm`（workspace 内唯一），distribution
  安装到 PATH 并命名/别名为 `org2`；
- 现有 GUI binary（cargo package `org2`，release 下
  `windows_subsystem = "windows"`，无 console）**不承载任何 CLI subcommand**；
- PM 协议 DTO crate 命名为 `orgtrack-pm-protocol`——注意 `orgtrack-protocol`
  已被 session provenance wire contracts 占用（设计文档 §19 的建议名与之冲突，
  以本条为准）；同理后续 domain/application/store crates 使用 `orgtrack-pm-*`
  前缀；
- 现有 `orgtrack` binary（外部会话历史索引）不变；`packages/orgtrack` npm
  stub 在 Phase 1 删除。

## 5. Provider ID 命名空间

SessionRef.provider / ProviderBinding.provider 使用以下冻结 registry：

- `org2` —— 一切 ORG2 拥有/托管的 session（内部 canonical source
  `orgii_rust_agents` / `orgii_cli_sessions` / `orgii_cloud_replay` 一律对外
  呈现为 `org2`；底层 harness 记录在 SessionRef.metadata.nativeHarness）；
- 外部 provider 使用 importer 端 canonical source id：`claude_code`、
  `codex_app`、`cursor_ide`、`cursor_cli`、`opencode`、`cline`、`copilot`、
  `kimi`、`qwen_code`、`droid`、`antigravity`、`zcode`、`warp`、`trae`、
  `qoder`、`windsurf` 等（以 `orgtrack-core` source registry 为准）；
- hook 端短名映射到 canonical id，不对外出现：`claude→claude_code`、
  `codex→codex_app`、`cursor→cursor_ide`、`qwen→qwen_code`、其余同名直映；
- planning provider id：`linear`、`github`（现有 adapter registry id 不变）。

## 6. Session 生命周期 hook 命名

协议 canonical hook 名：`session.started`、`session.completed`、
`work.claimed`、`work.transitioned`、`routine.invoked`、`routine.completed`、
`artifact.produced`。

现状三套命名的映射（Phase 5 落地时接线，不新增第四套）：

| 现状                                                                 | canonical                                           |
| -------------------------------------------------------------------- | --------------------------------------------------- |
| WS wire `session.completed` / `session.failed` / `session.cancelled` | `session.completed`（payload 携带 terminal status） |
| Tauri 内部 `session-status-changed`                                  | 内部信号，驱动 canonical hooks，不直接暴露          |
| agent 流 `session_start` / `session_end`                             | `session.started` / `session.completed`             |

`session.started` 现状不存在，为新增。`session.completed` 默认只附加
SessionRef；orchestrator 场景的自动完成改写为显式默认 completion policy（走
canonical `work.transition`，带 attempt/session identity）。

## 7. Workspace manifest 与 env

- Manifest 文件：`.orgii/orgtrack.json`，最小 shape
  `{ "version": 1, "scopeId": "...", "orgId": "..." }`；
- `is_initialized(workspace)` = 该文件存在且 `version` 受支持。`.orgii/` 目录
  存在本身**不**代表已初始化（现状该目录树由 git-folder sync 等副作用创建）；
- trusted local resolver 顺序：explicit CLI flags → `ORGII_*` env →
  manifest。冻结 env 名：`ORGII_MODE`、`ORGII_ACTOR`、`ORGII_SCOPE`、
  `ORGII_SESSION_REF`（沿用现有 `ORGII_` 前缀惯例；不新增 `ORG2_*`）。

## 8. 跨进程 wake（pm_change_seq）

- `projects.db` 新增单行表 `pm_change_seq(id INTEGER PRIMARY KEY CHECK(id=1),
seq INTEGER NOT NULL)`；
- 每个 PM mutation 在同一 transaction 内 `seq = seq + 1`；
- 桌面 host 低频轮询（或 db 文件 watch 触发）读取 seq，变化时做增量
  reconciliation；进程内 mutation 直接内存通知；
- readiness / RoutineRun 投影 / output 绑定在 mutation 事务内同步完成，CLI
  写入不依赖 host 在线。

## 9. 列表分页与 list 返回形状

- list 类 data 形状固定为 `{ "items": [...] }`；
- `--cursor <token>` 请求下一页；`meta.nextCursor` 存在表示还有后续页；
- cursor 是 opaque token，实现可变，语义不进协议。

## 10. Claim 与既有锁的边界

- claim record 收编本地 `execution_lock`（CAS session 执行锁）职责；
- 云端 `orgii_acquire_work_item_lock` 保持为 human 协作**编辑锁**：编辑锁 ≠
  工作 claim，两者并存但互不代理；Phase 2a 落地时在 service 层写清依赖关系
  （持有编辑锁不阻止 claim，claim 不授予编辑权）。
