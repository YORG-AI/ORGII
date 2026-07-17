# 命名碰撞 / 重载词 glossary — 2026-06-10

## 跨模块同名 `pub struct`（Rust BE）

来源：`grep -rE "^pub struct " src-tauri/src src-tauri/crates --include="*.rs"` → sort | uniq -c。
仅列出 ≥ 2 次出现的（共 **23 个**）。

| Struct 名                | 出现次数 | 位置                                                                                                                           | 风险                | 修复建议                                                 |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------- | -------------------------------------------------------- |
| `ApiError`               | **3**    | `git-api/src/types.rs` + `git-api/src/error.rs`（**同 crate 内冲突**）+ `api-search/src/error.rs`                              | ❌ Critical         | git-api 内统一为一处；api-search 重命名 `ApiSearchError` |
| `ProviderConfig`         | 2        | `key-vault/src/provider_config.rs:12`（FE settings 描述）+ `agent-core/src/core/providers/traits.rs:360`（runtime credential） | ❌ Critical         | `ProviderEnvDescriptor` + `ProviderClientConfig`         |
| `SearchHit`              | 2        | `advanced-search/src/commands/stubs.rs:54` + `advanced-search/src/tantivy_index.rs:669`                                        | ❌ High（同 crate） | 删 stubs（dead code）                                    |
| `MatchingLine`           | 2        | `advanced-search/src/commands/stubs.rs:46` + `tantivy_index.rs:680`                                                            | ❌ High（同 crate） | 删 stubs                                                 |
| `IncrementalResult`      | 2        | `advanced-search/src/commands/stubs.rs:21` + `tantivy_index.rs:692`                                                            | ❌ High（同 crate） | 删 stubs                                                 |
| `TantivyIndexStats`      | 2        | `advanced-search/src/commands/stubs.rs:65` + `tantivy_index.rs:654`                                                            | ❌ High（同 crate） | 删 stubs                                                 |
| `TantivyIndexInfo`       | 2        | `advanced-search/src/commands/stubs.rs:72` + `tantivy_index.rs:662`                                                            | ❌ High（同 crate） | 删 stubs                                                 |
| `SemanticHit`            | 2        | `advanced-search/src/commands/stubs.rs:34` + 另一处                                                                            | ⚠️ Medium           | 同上                                                     |
| `SearchFilters`          | 2        | `advanced-search/src/commands/types.rs:6` + 另一处                                                                             | ⚠️ Medium           | 审计 stubs 死活                                          |
| `EmbeddingModelStatus`   | 2        | `advanced-search/src/commands/types.rs:16` + 另一处                                                                            | ⚠️ Medium           | 同上                                                     |
| `SessionEvent`           | 2        | –                                                                                                                              | ⚠️ Medium           | 需确认                                                   |
| `EffectiveToolsResponse` | 2        | –                                                                                                                              | ⚠️ Medium           | 需确认                                                   |
| `QuotaInfo`              | 2        | –                                                                                                                              | ⚠️ Low              | 需确认                                                   |
| `QueryResult`            | 2        | –                                                                                                                              | ⚠️ Low              | 需确认                                                   |
| `FileSearchResult`       | 2        | –                                                                                                                              | ⚠️ Low              | 需确认                                                   |
| `GitStatus`              | 2        | –                                                                                                                              | ⚠️ Low              | 需确认                                                   |
| `GitHubClient`           | 2        | –                                                                                                                              | ⚠️ Low              | 需确认                                                   |
| `ExecuteResult`          | 2        | –                                                                                                                              | ⚠️ Low              | 需确认                                                   |
| `DirEntry`               | 2        | –                                                                                                                              | ⚠️ Low              | 需确认                                                   |
| `ColumnInfo`             | 2        | –                                                                                                                              | ⚠️ Low              | 需确认                                                   |
| `CacheStats`             | 2        | –                                                                                                                              | ⚠️ Low              | 需确认                                                   |
| `TableInfo`              | 2        | –                                                                                                                              | ⚠️ Low              | 需确认                                                   |
| `WorkingDirectoryFile`   | 2        | –                                                                                                                              | ⚠️ Low              | 需确认                                                   |

**Sweep 命令**：

```bash
grep -rE "^pub struct " src-tauri/src src-tauri/crates --include="*.rs" \
  | sed 's/.*pub struct \([A-Za-z0-9_]*\).*/\1/' \
  | sort | uniq -c | sort -rn | awk '$1 >= 2'
```

---

## FE 跨文件同名 type（TypeScript）

| 名                               | Hit      | 位置                                                                                                                              | 修复                                     |
| -------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `SessionInfo`                    | 2        | `store/session/sessionAtom/types.ts:27` + `engines/SessionCore/services/types.ts:51`                                              | rename service 端为 `SessionServiceInfo` |
| `SessionView` vs `MessageViewer` | 命名相邻 | `store/session/viewAtom.ts:39` + `WorkStation/Chat/Communication/MessageViewer.tsx`                                               | 不是 collision 但易混                    |
| `SessionStatus`                  | 5        | `types/session/session.ts`、`WorkItems/constants.ts`、`TaskKanban/config.ts`、`AgentOrgOverviewPanel.tsx`、`AgentOrgTaskList.tsx` | 单源（见 F-CRIT-4）                      |

---

## 跨层重复定义（FE + BE 都有）

| 概念                                                                             | FE                                    | BE                                    | 单源                                              |
| -------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------- | ------------------------------------------------- |
| `SessionStatus` 16 / 12 / 6 / 5 变体                                             | 1 处                                  | 3 处                                  | 应从 `agent-core::session::SessionStatus` 生成 TS |
| `AgentExecMode` 6 变体                                                           | `sessionCreatorConfig.ts:70`          | `enums.rs:172`                        | 手工双写 — 应生成                                 |
| `CancelReason` 4 变体                                                            | `api/tauri/agent/session.ts:42-48`    | `state/control_flow.rs::CancelReason` | 手工双写                                          |
| 事件名 `agent:* / code_session.*`                                                | `cliAdapter.ts:858+`                  | agent-core / cli emitter              | 手工双写                                          |
| Session ID 前缀 `cliagent- / sdeagent- / osagent- / wingman- / agent- / shadow-` | `src/util/session/sessionCategory.ts` | `crates/types/src/session.rs:7-32`    | 手工双写                                          |

---

## 语义重载词 glossary

### `session`（FE 3 含义 / BE 8 含义 = 11 含义）

FE：

1. `activeSessionIdAtom` — pipeline 订阅的 session
2. `workstationActiveSessionIdAtom` — UI 记忆 session
3. `sessionCreatorDraftListAtom` — pre-launch session draft

BE：

1. CLI agent 子进程 session（`agent_sessions/cli/`）
2. Rust agent session（`agent_core::session::*`）
3. Tauri IPC subscription session（`websocket_handler::register_channel`）
4. PTY session（`terminal::pty::PtySession`）
5. LSP language-server session
6. wingman observation session
7. cursor-bridge probe session
8. browser webview session

**统一 dispatcher**：`session_launch`（`launch.rs:111`）按 `category` 字符串 dispatch。

### `agent`（FE 3 / BE 8 含义）

FE：

1. `api/tauri/agent/` — Rust IPC layer
2. `modules/MainApp/AgentOrgs/` — 多 agent org 配置
3. `osagent/useBrowserAutomation` — OS browser 驱动

BE：

1. `AgentDefinition`（config）
2. `ResolvedAgent`（runtime）
3. `AgentAppState`（Tauri singleton）
4. `AgentSession`（`session_runtime.rs:105`）
5. `AgentRunTarget`
6. "CLI agent" 子进程
7. `AgentKind` enum
8. `AgentOrg`（org of agents）

**最易混淆三元组**：`AgentSession` vs `AgentAppState` vs `AgentDefinition`。

### `tab`（FE 8 套并行 tab 系统）

按 memory `workspace_tab_systems_inventory.md`：WorkStation TabBar / PrimarySidebarLayout / EditorBottomPanel / Communication / SessionReplay / SidebarModules / TabPill / WorkItem detail。`PanelTabBar`（前 SecondaryPanelHeader）桥接 ①↔③。

### `mode`（3 套状态机）

1. `agentExecMode`（build / ask / plan / debug / review / wingman）
2. `stationMode`（workstation surface mode：agent-station / my-station / work-management 等）
3. `chatPanelContentModeAtom`（哪个 content view 显示）

### `pill`（3 个 UI primitive）

1. `ModePill`（agent-exec-mode selector）
2. `SidebarTabButton`（segmented control chrome）
3. `ComposerPill`（@file / context pill in composer）

### `panel`、`event`、`block`、`creator`、`bridge`、`manager`、`handler`、`broadcast`、`gateway`、`provider`、`runtime`、`config`

见 [be-audit.md](./be-audit.md) 层 4 表 + [fe-audit.md](./fe-audit.md) 层 4 表。

---

## 鬼影命名（已被部分清理但残留）

| 词                                                                   | 残留位置                                          | 状态                             |
| -------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------- |
| `osagent`                                                            | `coding_agent/mod.rs:180`、`lib.rs:476` EnvFilter | 整 module 死，可一并清           |
| `sdeagent-`                                                          | 6 处 agent-core 字面量                            | 应 lift 到 `core-types::session` |
| `SDE Agent` 显示标签                                                 | 多处                                              | 部分已 lift                      |
| `secondary-panel`                                                    | –                                                 | `PanelTabBar` rename 完成        |
| `setup-repo` skill 默认 pin                                          | 已 migrate 清理                                   | memory STALE                     |
| `forceSendPendingQueueAtom` / `holdForStop` / `markQueueTurnSettled` | 不存在                                            | memory STALE                     |
