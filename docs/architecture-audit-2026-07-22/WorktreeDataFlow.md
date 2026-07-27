# Worktree 数据流架构审计（修复前快照）

- 日期：2026-07-22
- 基线：`develop` @ `646bb62f0`
- 审计分支：`junyu/audit-worktree-data-flow`
- 范围：Session Creator、统一 `session_launch`、Rust/CLI agent 启动、Git worktree 创建/复用/删除、worktree source 缓存
- 性质：本报告记录修复前的只读审计快照；落地结果见 `WorktreeDataFlow-Fixes.md`

## 结论

当前“创建新 worktree”的主路径基本完整，定向前端与 Rust 测试均通过；但 worktree 领域仍有 7 个高优先级断点和 2 个中优先级结构问题。最关键的问题是：

1. UI 展示了已有 worktree，却没有任何生产路径把所选路径写入 launch payload；对应能力只存在于 atom、payload helper 和单元测试中。
2. Rust agent 与 CLI agent 对同一 `session_launch` payload 的解释不一致：CLI 忽略 `worktreePath`，且创建新 worktree 后把真实路径从返回值中丢掉。
3. repo 切换不会清理或重新限定 worktree source，repo A 的 branch/SHA 可被带入 repo B 的启动请求。
4. 启动返回的 `branch` 是“基准 ref”，而实际 checkout 的分支是 `agent/<session-id>`；前端会把前者当成 session branch。
5. 删除流程先删数据库记录、后做 Git 清理，失败后失去可靠重试所需的 repo/session 映射。
6. setup hook 没有超时/取消，diff cache 没有容量上限，GitHub source cache 缺少账号/endpoint 隔离。

因此本次总评为：**数据流可运行，但跨入口、跨 agent 类型和全生命周期语义不一致，不应视为已闭环。**

## 生产数据流

### 1. 新建隔离 worktree

```text
WorktreeSourceModal
  -> worktreeLaunchSourceAtom / runningLocationAtom
  -> buildSessionLaunchPayload()
       { workspacePath, isolate: true, branch: baseRef }
  -> Tauri session_launch
       -> Rust agent: prepare_launch_workspace()
       -> CLI agent: launch_cli_agent() -> create_cli_session()
  -> git create_session_worktree()
       checkout branch agent/<session-id> from baseRef
       save workspace metadata
       run optional setup commands
  -> SessionLaunchResult
  -> buildSessionFromLaunchResult()
```

这条路径会实际创建 worktree；Git 创建与持久化失败时也有局部 rollback。主要问题在返回契约：CLI 丢失 worktree path，Rust/CLI 都没有返回实际 worktree branch。

### 2. 复用已有 worktree（设计意图）

```text
selectedWorktreePathAtom
  -> buildSessionLaunchPayload()
       { worktreePath }
  -> Rust agent: SessionWorkspace::new_worktree(root, existingPath)
  -> CLI agent: 当前忽略 worktreePath
```

该路径在生产 UI 中不可达：atom 只有清空写入，没有非空写入；modal 中归入 “Worktrees” 的 branch option 在转换成 launch source 时丢弃了 `worktreePath`。因此用户选择已存在 worktree 对应的 branch 后，实际语义仍是“从该 branch 新建 worktree”。

### 3. 管理型 linked worktree

```text
GlobalSpotlight / worktree management UI
  -> git HTTP API
  -> create_linked_worktree()
  -> git worktree add
  -> setup commands
  -> invalidate/refresh worktree map
```

这条路径与 session worktree 共用 Git 创建底层，但不共用 session launch 契约。它解释了为何 UI 能列出已有 worktree，却不能自动证明 Session Creator 已支持“复用”。

### 4. 删除与孤儿清理

```text
delete_session(sessionId)
  -> 读取 workspace path
  -> 删除 session DB row
  -> 尝试 git worktree remove / branch cleanup
  -> housekeeping 扫描残留目录
```

顺序导致 Git 清理失败时数据库上下文已经丢失；后续 housekeeping 主要删除目录，无法可靠恢复 Git worktree registration 与分支清理。

## 发现

| ID | 优先级 | 发现 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| WT-01 | 高 | “复用已有 worktree”是未接通的死路径 | `selectedWorktreePathAtom.ts:13` 定义状态；生产写入只见 `ChatPanel/index.tsx:309-337` 的清空。`WorktreeSourceModal.tsx:352-372` 展示 worktree 分组，但 `worktreeBranchSource.ts:169-195` 转换时不保留 `option.worktreePath`。只有 `launchPayload.test.ts:422` 人工覆盖非空值 | 用户看到已有 worktree，但选择后会创建新的隔离 worktree；产品语义与真实动作相反 | 将 source 建模为显式 union：`currentRepo | createFromRef | reuseWorktree`。modal 选择已有 worktree 时必须携带 canonical path，并补生产级组件/E2E 覆盖；若产品不支持复用，则删除 atom、payload 分支和误导 UI |
| WT-02 | 高 | Rust 与 CLI 对 `worktreePath` 和 launch result 不对称 | Rust `launch.rs:161-178` 把非空 `worktree_path` 识别为 Worktree；`CliLaunchParams`（`foundation/session_bridge.rs:40-69`）无该字段；`launch.rs:324-377` 构造 CLI 请求时不传，并固定返回 `worktree_path: None`。CLI 实际在 `cli/commands.rs:143-221` 创建并保存 worktree，但 bridge 在 `agent_core_bridge.rs:55-82` 只保留 session id/created_at | 同一 RPC 随 agent 类型改变语义；CLI 创建成功后，前端立即态拿不到真实路径；已有 worktree 请求可能退化为 local launch | 让 Rust/CLI 共用一个 typed workspace target 和同一 authoritative launch result；CLI bridge 返回完整 workspace metadata，不在适配层丢字段 |
| WT-03 | 高 | repo 切换后 worktree source 可跨 repo 泄漏 | `worktreeLaunchSourceAtom` 是全局、非 repo-keyed 状态；`ChatPanel/index.tsx:313-320` 只在离开 worktree 模式时清理。`useSessionCreatorChatPanelHandlers.ts:109-146` 切 repo 不清理 source。`launchPayload.ts:226-246,273-277` 最后用 source base ref 覆盖前面求得的 branch | repo A 的 SHA/ref 可发送给 repo B；不存在时启动失败，恰好同名时可能静默从错误基准启动 | source 与 `{repoId, canonicalRepoPath}` 绑定；repo/identity generation 变化时同步失效，late async result 必须带 generation guard；增加 A→B 切换回归测试 |
| WT-04 | 高 | `branch` 同时表示 base ref、展示 branch 和实际 checkout branch | UI 发送的 `branch` 可为 PR SHA；`launch.rs:141-145,238` 原样回传。`git/worktree.rs:339-340` 实际生成 `agent/<session-id>`；launch result 没有 worktree branch。`launchPayload.ts` 的 `buildSessionFromLaunchResult()` 又把 `result.branch` 写入 session branch | 新 session 的立即态可能显示 base branch/SHA，而工作目录实际位于 `agent/<id>`；刷新前后语义可能漂移 | wire result 显式返回 `baseRef`、`baseBranch`、`worktreeBranch`、`workspaceRoot`、`workingDirectory`；禁止用一个 `branch` 字段承载三个概念 |
| WT-05 | 高 | 已有 worktree path 未验证归属和有效性 | `launch_workspace.rs:56-61` 直接调用 `SessionWorkspace::new_worktree`；`workspace.rs:137-143` 仅赋值，`is_worktree()` 只比较路径。Git 删除路由在 `git/src/worktree.rs:557-581` 已有 registered-path 校验，但 launch 未复用 | 不存在目录、普通目录或其他 repo 的目录可能先被持久化并返回成功，随后首个 turn 才异步失败；错误边界过晚 | canonicalize；要求目录存在；从 `git worktree list --porcelain` 验证属于 workspace repo；校验通过后再持久化和启动 |
| WT-06 | 高 | 删除先删 DB，Git 清理失败后缺少可重试上下文 | `agent-core/.../persistence/crud/ops.rs:637-724` 先 `delete_session_cascade`，后尝试 worktree cleanup，失败只记录日志并返回成功。`housekeeping_orphans.rs:227-284` 主要直接删目录；周期 prune 又依赖仍存活的 session repo | 可永久遗留 stale worktree registration、`agent/<id>` 分支和磁盘目录；用户看不到 session，也无法从 DB 恢复 cleanup target | 清理成功后再删主记录，或写 durable cleanup tombstone（repo、path、branch、session id、attempt state）；housekeeping 必须走 Git-aware cleanup 并有有界重试 |
| WT-07 | 高 | setup command 无超时、取消与进程回收策略 | `git/src/worktree.rs:421-470,504-548` 通过 `sh -c` / `cmd /C` 调用 `.output()`；调用发生于新建 linked/session worktree 的阻塞任务内 | 任意挂起脚本会让 launch 一直等待；重复启动可积累阻塞线程/子进程 | 设置可配置硬超时和 kill-on-timeout；记录命令、耗时、退出原因；对 launch cancellation 和 app shutdown 明确处置 |
| WT-08 | 中 | `SessionService.create()` 把一般工作目录重载为 `worktreePath` | `SessionService.ts:146-169` 同时传 `workspacePath: projectRepoPath || repoPath` 与 `worktreePath: repoPath`；`services/types.ts:20-23` 又把 `repoPath` 定义为 agent working path。Rust 因非空 path 统一识别为 Worktree | 普通 cwd、alternate working dir 与 registered worktree 被压成一个概念；response 可判为 worktree，而 DB 在 root==working_dir 时保存为 local，形成瞬时 split-brain | 调用方传 discriminated workspace target；若确需 alternate cwd，单独命名，不得借用 `worktreePath` |
| WT-09 | 中 | wire schema 对 launch input 几乎不做约束 | `src/api/tauri/rpc/schemas/agentSession.ts:345-347` 使用 `z.record(z.string(), z.unknown())`；结果 schema 才显式声明 worktreePath | TS/Rust 字段遗漏、互斥条件错误和新增字段漂移无法在编译或运行时边界暴露，WT-02 因而能长期存在 | 用 discriminated Zod schema 与 Rust DTO 对齐；覆盖 unknown-key、互斥字段和 Rust/CLI parity contract tests |

## 10 层架构检查

| 层 | 结论 | 说明 |
| --- | --- | --- |
| 1. 编译正确性 | 定向通过 | 64 个前端单元测试与 33 个 Rust worktree 单元测试通过。此分支只新增文档，未做全量 app 编译、clippy 或 rendered E2E |
| 2. 死代码/重复路径 | 失败 | existing-worktree payload 分支无生产写入；`RunningLocationPill.tsx` 无生产引用；diff summary 未发现前端调用 |
| 3. 命名一致性 | 失败 | `branch`、`repoPath`、`worktreePath` 在 UI、RPC、session service、Git 层含义不同 |
| 4. 语义重载 | 失败 | base ref / session display branch / checkout branch 共用 `branch`；alternate cwd / registered worktree 共用 `worktreePath` |
| 5. 默认分支 | 风险 | worktree 模式在 source 缺失时默认 current HEAD；CLI 缺失 worktree_path 字段时静默走 local/fresh 逻辑，而不是拒绝不支持的请求 |
| 6. 跨域泄漏 | 失败 | SessionService 的一般 working path 被解释为 Git worktree；UI source 状态跨 repo 泄漏 |
| 7. 新开发者可理解性 | 失败 | “Worktrees” 分组看似代表复用，实际只选 branch；同一 launch result 的 branch/path 含义依 agent 类型不同 |
| 8. Wire protocol | 失败 | 输入为任意 record；CLI 适配层丢 `worktreePath` 和实际创建结果；未返回 authoritative worktree branch |
| 9. 入口初始化一致性 | 失败 | Rust agent、CLI agent、Session Creator、SessionService 对 local/fresh/reuse 三种 workspace 模式支持矩阵不一致 |
| 10. Resolver symmetry | 失败 | repo/source 没有同一 fallback/失效链；路径、branch 和 metadata 在 result、DB、WebSocket 间来源不对称 |

## 入口一致性矩阵

| 入口/模式 | Local | 新建隔离 worktree | 复用已有 worktree | 返回真实 path | 返回真实 checkout branch |
| --- | --- | --- | --- | --- | --- |
| Session Creator → Rust agent | 支持 | 支持 | helper 支持，但 UI 不可达 | 是 | 否 |
| Session Creator → CLI agent | 支持 | 支持 | 不支持且未显式报错 | 否 | 否 |
| `SessionService.create()` → Rust agent | 支持语义模糊 | 可触发 | 任意 `repoPath` 被当作 worktree path | 调用方丢弃 | 否 |
| `SessionService.create()` → CLI agent | 支持 | 由 isolate 决定 | `worktreePath` 被忽略 | 调用方丢弃 | 否 |

## 性能与生命周期检查

| Area | Verdict | Evidence | Change or reason kept | Verification |
| --- | --- | --- | --- | --- |
| Background work | fix | setup hook 由 worktree create 拥有，但 `.output()` 无 deadline/cancel；挂起时 launch 与 blocking worker 无终止态 | 增加 timeout、kill、cancellation 与可观测状态 | 需补“永久等待脚本”单测和真实进程回收测试 |
| Memory | fix | `git-api/routes/worktrees.rs:24-39,194-252` 的 app-lifetime `HashMap<(path, headSha), DiffCacheEntry>` 只在 lookup 检查 TTL，无 cap/全局 prune | 删除未使用 diff summary，或改 bounded LRU/TTL 并在 repo/worktree 删除时 eviction | 当前仅确认 endpoint 无前端调用；尚无容量/淘汰测试 |
| Scope/isolation | fix | `worktreeSourceCache.ts:38-51` 只用 repo id/path；GitHub PR/issue cache 未包含 endpoint + authenticated user，旧请求也无 identity generation guard | key 加 endpoint/user/resource；登录态切换清空；提交结果前比较 generation | 需补 account/endpoint switch 与 stale completion rejection 测试 |
| Rendering/hot path | keep | worktree map cache cap=16；source cache cap=8；同 key 请求有 in-flight single-flight；branch 与 GitHub 数据并行加载 | 现有有界/并发结构可保留，修复 identity key 即可 | 相关 64 个前端单元测试通过；未做 rendered profiling |

**Performance verdict: fail** — 仍存在无上限缓存、不可终止的后台子进程，以及跨身份缓存命中/旧请求回写路径。

## 已确认保留的设计

- 新建 session worktree 使用 `spawn_blocking` 承载 Git/文件系统工作，避免直接阻塞 async executor。
- worktree 数量存在默认上限（默认 8）。
- PR base ref 解析有 90 秒超时，并设置 `GIT_TERMINAL_PROMPT=0`。
- Rust fresh-create 在 workspace metadata 持久化失败时会尝试移除刚创建的 worktree。
- 前端 branch/GitHub source fetch 并行，常用 source cache 已有 entry cap 与 single-flight。

## 建议落地顺序

1. 定义唯一的 `WorkspaceLaunchTarget` union：`local`、`createIsolated { baseRef }`、`reuseRegistered { path }`；TS、Zod、Rust、CLI 共用同一模式矩阵。
2. 让 launch result 返回 authoritative workspace metadata：root、working directory、base ref、实际 worktree branch；前端只消费结果，不从输入反推。
3. 选择产品方向：真正接通 existing-worktree UI，或删除死能力与误导性分组；不要保持半接通状态。
4. source 状态按 repo + identity 定界，并在 repo/account/endpoint 切换时 generation-invalidated。
5. 统一复用路径校验，并把删除改成可重试的 Git-aware lifecycle。
6. 给 setup hook 设置超时/取消；删除或限制 diff cache；补身份切换和缓存淘汰测试。

## 验证记录

- Frontend：`vitest` 定向运行 `launchPayload`、`worktreeBranchSource`、`worktreeSourceCache`、`worktreeSourceResolve`，**4 files / 64 tests passed**。
- Rust：`cargo test -p git worktree --lib`，**33 passed / 0 failed / 94 filtered out**。
- 未执行：全量 TypeScript typecheck、全 workspace clippy、真实 Tauri rendered E2E、账号切换与 hung setup 进程测量。它们是修复阶段的验收项，不影响本报告对现有静态数据流断点的判断。
