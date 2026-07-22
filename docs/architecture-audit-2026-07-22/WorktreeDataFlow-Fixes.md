# Worktree 数据流修复记录

- 日期：2026-07-22
- 基线：`develop` @ `646bb62f0`
- 分支：`junyu/audit-worktree-data-flow`
- 对应审计：`WorktreeDataFlow.md`

## 结果

审计中的 9 个数据流问题已按同一 workspace 生命周期收敛。后续复查发现的 CLI 启动回滚、代理令牌释放和 borrowed-worktree 所有权边界也一并修复。UI 没有新增布局或视觉样式；组件侧只连接已有 worktree 选择、仓库作用域和返回结果。

## Workspace 状态机

| 模式              | 前端请求                                     | Rust agent                                     | CLI agent              | 删除所有权                            |
| ----------------- | -------------------------------------------- | ---------------------------------------------- | ---------------------- | ------------------------------------- |
| 当前仓库          | `workspacePath`                              | local workspace                                | local workspace        | 不清理 checkout                       |
| 新建隔离 worktree | `workspacePath + isolate + worktreeBaseRef?` | 创建 `agent/<session>`                         | 创建 `agent/<session>` | session 拥有；先清理 Git，成功后删 DB |
| 复用已有 worktree | `workspacePath + worktreePath`               | canonicalize 并验证 registered linked worktree | 同一验证与持久化语义   | 借用；删除 session 时不删除 worktree  |

互斥条件由 TypeScript 类型、严格 Zod schema、Rust command validation 和 CLI command validation 共同执行：`isolate` 不能与 `worktreePath` 同时出现，`worktreeBaseRef` 只允许用于 fresh isolation。

## 审计项处置

| ID    | 处置                        | 关键变化                                                                                                                |
| ----- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| WT-01 | fixed                       | worktree 列表项保留 canonical path，Session Creator 生产路径会发送 `worktreePath`；删除未接通的独立 atom                |
| WT-02 | fixed                       | CLI bridge 与 Rust result 都返回 workspace/worktree path、实际 checkout branch 和 base ref                              |
| WT-03 | fixed                       | source 绑定 repo key；repo 切换同步清理；PR、GitHub 和 branch 异步结果都有 stale-generation/identity 防护               |
| WT-04 | fixed                       | `branch` 不再承载 worktree base；新增 `worktreeBaseRef`、`worktreeBranch`、`baseRef`，前端优先消费 authoritative branch |
| WT-05 | fixed                       | 复用路径必须存在、是目录、属于目标 repo 的 `git worktree list`，且不能是 main checkout                                  |
| WT-06 | fixed                       | session-owned worktree 先做 Git-aware cleanup，再删会话记录；失败保留记录；borrowed worktree 不清理                     |
| WT-07 | fixed with bounded fallback | setup hook 有 300 秒硬 deadline，超时终止进程组/进程树并回收输出管道                                                    |
| WT-08 | fixed                       | `SessionService` 不再把普通 `repoPath` 隐式写为 worktree；调用方使用显式 `worktreePath`                                 |
| WT-09 | fixed                       | launch input 改为 strict schema，并覆盖字段互斥、未知字段和三种 workspace 模式测试                                      |

## 补充复查处置

| Finding                                                             | Verdict                     | Change                                                                                                                 |
| ------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| CLI create 后 runner 启动失败会遗留 session/worktree                | fixed                       | bridge 在 `cli_agent_run` 失败时调用完整 delete lifecycle，并把 cleanup failure 合并到原始错误                         |
| hosted-key 在 DB create/后续 launch 失败时可能遗留 proxy allocation | fixed with bounded fallback | DB row 存在时先释放 token 再删 row；DB row 尚未创建时直接使用 allocation credentials 释放；网络失败仍由服务端 TTL 兜底 |
| async create 路径直接执行同步 Git cleanup                           | fixed                       | 统一通过 `spawn_blocking` helper 执行 worktree removal，并传播 join/Git 错误                                           |
| borrowed worktree 可进入 destructive CLI lifecycle                  | fixed                       | delete、merge、discard 只允许 `base_branch` 标记的 session-owned isolation；borrowed checkout 仅随 session 解绑定      |
| Git branch verification error 被静默忽略                            | fixed                       | `rev-parse` 执行失败进入聚合 cleanup error，DB row 保留供重试                                                          |

## 性能与隔离

| Area                | Verdict           | Change                                                                                                                                  | Verification                                                             |
| ------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| setup 子进程        | pass              | 300 秒 deadline；Unix kill process group，Windows `taskkill /T /F`；总是 reap child 与 reader threads                                   | Unix hung-command 单测通过                                               |
| diff summary cache  | pass (code/check) | TTL prune + 128 entry hard cap + oldest eviction                                                                                        | 容量单测已添加；macOS 执行被既有 Windows-only test import 阻塞           |
| GitHub source cache | pass              | key 包含 endpoint、connection id、credential source、username 与 repo；账号切换主动淘汰同 repo 的旧身份 entry；提交前重查 auth identity | auth/repo isolation 与 identity eviction 单测；generation guard 静态检查 |
| repo/branch async   | pass              | repo 切换同步 invalidate；GitHub、branch、PR resolve 的迟到结果不能写入当前选择                                                         | stale repo payload 单测；入口 guard                                      |

## 验证与剩余风险

- 前端 4 个定向测试文件、65 个测试通过，覆盖 launch payload、严格 wire schema、existing-worktree 转换、cache identity 和账号切换淘汰。
- Rust `git` 的 34 个 worktree 测试通过（包含 setup deadline）；`agent_core` 的 4 个 workspace contract 测试通过。
- `git_api` 容量测试已添加，但该 crate 的 lib-test target 在 macOS 上被既有 `extractors_tests.rs` 对 Windows-only `has_windows_users_prefix` 的无条件 import 阻塞；生产 `cargo check` 不受影响。
- 应用级 `cargo check -p org2` 通过。
- 变更文件 ESLint 与 `git diff --check` 通过。
- 全量 TypeScript typecheck 仅命中既有 `ContextInfoButton.tsx:468` 的 `string | undefined` 错误；该文件相对 `develop` 无差异。
- 仍未做真实 Tauri rendered E2E，也未模拟应用退出时的 cooperative cancellation；硬 deadline 保证 setup hook 不会无限挂起。

## 修复后 10 层检查

| 层                    | Verdict                   | Evidence                                                                                        |
| --------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| 1. 编译正确性         | pass with baseline caveat | `cargo check -p org2`、相关 Rust/前端单测与 ESLint 通过；TypeScript 仅剩未改文件的既有错误      |
| 2. 死代码/重复路径    | pass                      | 删除独立 existing-worktree atom；生产 UI、payload 与测试共用 repo-scoped source                 |
| 3. 命名一致性         | pass                      | base ref、worktree path、checkout branch 在 wire/result 中使用独立字段                          |
| 4. 语义重载           | pass                      | local、fresh isolation、reuse registered 三态互斥；普通 working path 不再冒充 worktree path     |
| 5. 默认分支           | pass                      | fresh worktree 缺省 `HEAD` 保持显式设计；base ref 在非 isolate 模式会被拒绝                     |
| 6. 跨域泄漏           | pass                      | source 绑定 repo key；GitHub cache 绑定 endpoint/connection/source/user/repo 并在身份切换时淘汰 |
| 7. 新开发者可理解性   | pass                      | TS 类型、Zod、Rust DTO 与注释共同描述三态 workspace contract 和所有权                           |
| 8. Wire protocol      | pass                      | strict input schema、互斥校验、Rust/CLI 字段 parity、authoritative launch result                |
| 9. 入口初始化一致性   | pass                      | Session Creator、SessionService、Rust agent、CLI agent 均覆盖 local/fresh/reuse 矩阵            |
| 10. Resolver symmetry | pass                      | repo/source 失效链一致；path/branch/base 从 prepared workspace/CLI persisted session 原样返回   |
