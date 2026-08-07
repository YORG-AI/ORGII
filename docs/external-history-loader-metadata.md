# External history loader metadata matrix

本文档记录 ORGII 当前从各个外部 AI session loader 读取并写入统一 cache 的
metadata。它的主要用途是：

1. 判断一个 loader 能否支持 file → AI session 的 blame 查询；
2. 区分“源数据没有”与“源数据存在、但 loader 尚未归一化”；
3. 修改 loader 时同步更新 capability matrix。

最后按代码验证：**2026-07-14**。

## Scope

这里覆盖 `imported_history` 当前注册的 8 个 external loaders：

- Claude Code (`claude_code`)
- Codex (`codex_app`)
- Cursor (`cursor_ide`)
- OpenCode (`opencode`)
- Windsurf (`windsurf`)
- WorkBuddy / CodeBuddy (`workbuddy`)
- Trae (`trae`)
- Cline (`cline`)

`orgii_cli_sessions` 和 `orgii_rust_agents` 是 ORGII 自有 session source，不属于
external history loader，因此不在此表中。

## Unified cache schema

所有 loader 最终写入 `ImportedHistoryCacheInput` /
`imported_history_session_cache`。统一字段分成四组：

| 类别                    | 字段                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Identity                | `source`, `source_session_id`, `session_id`                                                                               |
| Source/change detection | `source_path`, `source_record_key`, `source_mtime_ms`, `source_size_bytes`, `source_fingerprint`, `parser_version`        |
| Session                 | `name`, `created_at_ms`, `updated_at_ms`, `model`, `input_tokens`, `output_tokens`, `repo_path`, `branch`                 |
| Impact/hierarchy        | `files_changed`, `lines_added`, `lines_removed`, `touched_files`, `listable`, `parent_session_id`, `source_metadata_json` |

注意：统一 cache 当前没有 recorded cost、estimated cost、commit 或 pull request 字段。
价格估算属于下游计算，不是 loader 原始 metadata。

## Capability matrix

图例：

- ✅：loader 当前会写入统一 cache。
- ◐：会写入，但值的语义或精度有限。
- 🟡：源 transcript/tool data 中可推导，但当前 loader 没有写入。
- ❓：产品能力存在，但当前读取的本地存储尚未验证出稳定映射。
- —：当前没有可靠来源或不支持。

所有 loader 都会写入 session id、name、created/updated time 和 source provenance；
下表只比较有差异的能力。

| Loader      | Repo path                 | Branch            | Model                                | Token split                            | Touched files                 | `+/-` lines                                | Parent/subagent                  | Source-specific metadata |
| ----------- | ------------------------- | ----------------- | ------------------------------------ | -------------------------------------- | ----------------------------- | ------------------------------------------ | -------------------------------- | ------------------------ |
| Claude Code | ✅ `cwd`                  | ✅ `gitBranch`    | ✅                                   | ✅ input/output，input 含 cache tokens | ✅                            | ✅ structured patch；旧记录启发式 fallback | ✅ sidechain → parent            | —                        |
| Codex       | ✅ turn `cwd`             | —                 | ✅                                   | ✅ input/output                        | ✅                            | ✅ successful `patch_apply_end`            | ✅ subagent thread → parent      | —                        |
| Cursor      | ✅ tracked repo/workspace | ✅ tracked branch | ✅                                   | ◐ 单一 `contextTokensUsed` 写入 input  | ✅ `originalFileStates`       | ✅ Cursor 汇总计数                         | ✅ composer child → parent       | ✅ status、agentic、mode |
| OpenCode    | ✅ `session.directory`    | —                 | ✅                                   | ✅ 含 reasoning/cache token 分类       | ✅ edit tool parts            | ◐ tool 参数/diff 启发式                    | ✅ `parent_id` child → parent    | —                        |
| Windsurf    | ✅ tracked repo/workspace | ✅ tracked branch | ✅                                   | ◐ 单一 context token total 写入 input  | ✅ tool-former edit data      | ◐ tool 参数/diff 启发式                    | ✅ `subagentInfo` child → parent | —                        |
| WorkBuddy   | ✅ `cwd`/`project`        | ✅ `gitBranch`    | ✅                                   | ✅ input/output，含 cache tokens       | ✅ edit tool 参数             | ◐ edit 参数启发式计数                      | ✅ subagent path → parent        | —                        |
| Trae        | ◐ 从 project slug 还原    | —                 | ◐ 实际为 agent label，不是 LLM model | —                                      | —                             | —                                          | —                                | ✅ agent、current、order |
| Cline       | ✅ `workspaceRoot`/`cwd`  | —                 | ✅ model，fallback provider          | ✅ input/output                        | ✅ child/root edit transcript | ◐ old/new tool 参数启发式                  | ✅ `sessions.db` child → parent  | —                        |

## Direct metadata vs loader-derived metadata

这里的“直接”特指：源存储已经有稳定字段或结构化 map，loader 只需要读取、改名或加
session prefix。“计算”表示源里没有最终的 session-level cache 字段，需要 ORGII 遍历
event/tool records、筛选、聚合或解析 diff 后生成。“启发式”表示计算输入是 requested tool
arguments，不保证等于最终成功写入磁盘的结果。

### AI blame and subagent provenance

| Loader      | `touched_files` 来源                                                                   | `lines_added/removed` 来源                                                | Parent/subagent 来源                                              |
| ----------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Claude Code | **结构化计算**：聚合 `toolUseResult.filePath`；旧记录从 Edit/MultiEdit/Write path 聚合 | **结构化计算**：统计 `structuredPatch`；旧记录为 old/new 参数启发式       | **直接 metadata**：`isSidechain` + parent `sessionId`             |
| Codex       | **直接 structured event**：成功 `patch_apply_end.changes` 的 map keys                  | **结构化计算**：解析每个 change 的 `unified_diff`                         | **直接 metadata**：`parent_thread_id` / thread-spawn parent       |
| Cursor      | **直接 metadata + filter**：`originalFileStates` map keys                              | **直接 metadata**：`totalLinesAdded` / `totalLinesRemoved`                | **直接 metadata**：`subagentComposerIds` + `parentComposerId`     |
| OpenCode    | **需要计算**：筛选当前 session 的 write/edit/patch parts，聚合 input path              | **计算/启发式**：有 patch 时解析 diff，否则统计 old/new/content tool args | **直接 metadata**：`session.parent_id`；loader 只做循环/孤儿校验  |
| Windsurf    | **需要计算**：筛选当前 composer 的 edit/write tool-former records，聚合 params path    | **计算/启发式**：解析 patch 或统计 before/after content                   | **直接 metadata**：`subagentInfo.parentComposerId`                |
| WorkBuddy   | **需要计算**：筛选 child/root JSONL 中的 edit/write/apply-patch calls，聚合 path       | **启发式计算**：统计 old/new/content/edits tool args                      | **路径推导**：`<parent>/subagents/agent-*.jsonl`；child id 为直接 |
| Trae        | **没有可靠来源**                                                                       | **没有可靠来源**                                                          | **没有可靠来源**                                                  |
| Cline       | **需要计算**：从每个 DB row 自己的 transcript 聚合 `editor.path`                       | **启发式计算**：统计 `old_text` / `new_text`，失败 result 不计入          | **直接 DB metadata**：`is_subagent` + `parent_session_id`         |

因此，只有 Cursor 已经在 session/composer metadata 中同时提供 file/line 汇总；Codex
提供 authoritative applied-event file map，但仍需解析 diff 计算行数。Claude Code 有
authoritative structured patch，但需要跨 tool results 聚合成 session totals。OpenCode、
Windsurf、WorkBuddy、Cline 都没有现成的 session-level touched-file list，必须由 loader
从各自的 tool records 计算。

### General session metadata provenance

| Loader      | 源里直接存在                                                                                               | ORGII 需要计算/归一化                                                                                    | 启发式或缺失                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Claude Code | session id、timestamp、`cwd`、`gitBranch`、model、usage、title/summary、sidechain fields                   | title fallback chain、token category 求和、turn/tool records 聚合                                        | 旧 edit 记录的 line totals                             |
| Codex       | thread id、timestamp、turn `cwd`/model、`total_token_usage`、parent thread、patch result                   | title fallback chain、选择最新 total usage、patch diff 聚合                                              | branch 缺失；旧 rollout 使用 tool-call fallback        |
| Cursor      | composer name/time/status/model/mode、context token total、repo/branch、impact totals、subagent fields     | workspace fallback、URI → path、过滤真正有 edit marker 的 file states                                    | input/output token split 缺失                          |
| OpenCode    | `session` 表的 id/title/directory/model/times/token columns/`parent_id`，以及 part tool state              | model JSON 解析、reasoning/cache token 分类求和、part impact 聚合、container/mirror 校验                 | 无 patch 时 line totals 是 tool-argument heuristic     |
| Windsurf    | composer name/time/status/model/context total/repo/branch、`subagentInfo`、bubble tool-former data         | workspace fallback、tool params/result 归一化、composer impact 聚合                                      | input/output split 缺失；无 diff 时 line totals 启发式 |
| WorkBuddy   | JSONL timestamp/model/usage/`cwd`/project/branch、child 内嵌 `sessionId`                                   | title fallback、兼容多种 token 字段并求和、tool impact 聚合、从目录布局推导 parent                       | line totals 是 requested args heuristic                |
| Trae        | summary topic/time、agent id、current/order                                                                | 从 project slug 尽力还原 repo path、把 agent id 转成显示 label                                           | model/tokens/branch/impact/parent 缺失                 |
| Cline       | DB session/parent/status/time/model/workspace/messages path，sidecar title/prompt/usage，transcript events | DB → sidecar → transcript fallback chain、aggregate usage fallback、每个 root/child transcript 的 impact | branch 缺失；line totals 是 editor args heuristic      |

## Loader details

### Claude Code

主要来源：`~/.claude/projects/**/*.jsonl`，并读取相邻 session title index。

当前归一化：

- Name：custom title → AI title → summary/index title → first prompt → id。
- Time：transcript timestamps，缺失时退回文件 mtime。
- Workspace：`cwd`、`gitBranch`。
- Usage：assistant message usage；input 包含普通、cache-read、cache-creation
  tokens，output 单独累计。
- Impact：优先使用 `toolUseResult.structuredPatch` 的结构化 diff；旧记录没有
  structured patch 时，退回 Edit/MultiEdit/Write 参数启发式。
- Hierarchy：`isSidechain=true` 且 `sessionId` 指向另一个 session 时，写入
  `parent_session_id`。因此 sidebar 可按主 session 折叠 subagent。

AI blame 状态：**可直接使用 `touched_files`**。新格式的 line stats 接近实际
applied diff；旧格式 fallback 只代表工具参数中的文本行数。

### Codex

主要来源：`~/.codex/sessions/**/*.jsonl`，标题从 `session_index.jsonl` 或
session metadata 读取。

当前归一化：

- Name：session index/thread name → session metadata title → first prompt → id。
- Time、model、repo path：rollout timestamp 和 turn context (`cwd`, `model`)。
- Usage：最新 `total_token_usage.input_tokens/output_tokens`。
- Impact：优先读取成功的 `patch_apply_end.changes[path].unified_diff`；这能覆盖
  `apply_patch`、exec 包装的 patch 等路径。旧 rollout 退回 apply-patch tool-call
  解析。
- Hierarchy：从 subagent `session_meta` 的 `parent_thread_id`、
  `source.subagent.thread_spawn.parent_thread_id` 等字段解析 parent。

AI blame 状态：**可直接使用 `touched_files`**，且当前是各 loader 中较强的
authoritative applied-patch 信号。当前没有 branch metadata。

### Cursor

主要来源：`conversation-search.db` 负责 discovery/change detection，
`state.vscdb` 的 `composerData:<id>` 负责 metadata，bubble 在打开 session 时懒加载。
更完整的存储说明见 [Cursor IDE session metadata](./cursor-ide-metadata.md)。

当前归一化：

- Name/time/status/model/mode：composer metadata；index `updated_at` 是排序时的
  authoritative recency。
- Workspace：`trackedGitRepos[0]`，fallback 到 `workspaceIdentifier`。
- Usage：`contextTokensUsed` 是单一总数，统一写入 `input_tokens`，没有可靠的
  input/output split。
- Impact：`totalLinesAdded`、`totalLinesRemoved`、`filesChangedCount`；
  `touched_files` 来自 `originalFileStates` 中带 edit marker 或 newly-created 的文件。
- Hierarchy：主 composer 的 `subagentComposerIds` 用于发现 child，child 的
  `subagentInfo.parentComposerId` 用于最终归属。child 不进入 root list，由 sidebar
  的通用 child-session flow 折叠显示。
- Extra：`source_metadata_json` 保存 `status`、`isAgentic`、`unifiedMode`。

AI blame 状态：**可直接使用 `touched_files`**。Line/file totals 是 Cursor 自己的
session 汇总；`touched_files.len()` 不应被假定永远等于 `filesChangedCount`。

### OpenCode

主要来源：OpenCode 的 `opencode.db`，读取 `session`、message 和 part 表。

当前归一化：

- Name/time/model/repo：`session.title`、`time_created/time_updated`、model JSON、
  `directory`。
- Usage：input 加上 cache read/write；output 加上 reasoning tokens。
- Hierarchy：读取 `parent_id`，但当前逻辑只将有效 container parent/mirror 关系
  映射成 `parent_session_id`，并处理循环、缺失 parent 和 ORGII-managed mirror。
- Impact：从当前 session 自己的 write/edit/patch/apply-patch tool parts 提取路径；
  patch 文本优先统计 unified diff，否则以 old/new/content 参数估算行数。失败的 edit
  不计入。

AI blame 状态：**可直接使用 `touched_files`**。`parent_id` 对应的 child run 使用自己
的 part stream 计算 impact，因此不会把 child 修改重复归到 parent。

### Windsurf

主要来源：Windsurf `User/globalStorage/state.vscdb` 的 composer/bubble 数据。

当前归一化：

- Name/time/status/model、repo、branch 和单一 `contextTokensUsed`。
- Hierarchy：`subagentInfo.parentComposerId` 写入 `parent_session_id`；child 不进入根
  list，由 sidebar 的通用 child-session flow 折叠显示。
- Impact：从每个 composer 自己的 edit/write/apply-patch `toolFormerData` 提取 path；
  可获得 before/after content 时估算行数，并忽略失败状态。

AI blame 状态：**可直接使用 `touched_files`**。Impact 按 composer 计算，subagent
修改保留在 child row。

### WorkBuddy / CodeBuddy

主要来源：`~/.workbuddy/{projects,sessions,history.jsonl}`、
`~/.codebuddy/...` 和 CodeBuddyExtension JSONL。

当前归一化：

- Name：AI title/display → first user prompt → file stem。
- Time/model/repo/branch：JSONL timestamp、message model、`cwd`/`project`、
  `gitBranch`。
- Usage：兼容 input/output、prompt/completion 和 cache token 字段。
- Impact：识别 Edit、MultiEdit、Write、edit_file、write_file、apply_patch 等 tool，
  但只有参数包含结构化 path 字段时才收集文件；line totals 通过
  old/new/content/edits 文本行数估算。
- Hierarchy：已观察到 `<parent-id>/subagents/agent-*.jsonl` 布局，目录可提供
  parent id，child JSONL 自身有独立 `sessionId`。Discovery 会导入这些 `agent-*`
  文件，优先以 child 内嵌 `sessionId` 作为 source id，并将目录 parent id 标准化为
  `parent_session_id`。

AI blame 状态：**可直接使用 `touched_files`**。文件集合通常可靠；line totals 是
requested tool arguments 的启发式统计，不等同于成功 applied diff。Child transcript
独立计算，不会与 parent 混合。

### Trae

主要来源：`~/.trae-cn/memory/projects/**/session_memory_*.jsonl` 和
`~/.trae/memory/projects/**`。明文文件只有 turn summary；完整 transcript 位于
SQLCipher 加密的 `ModularData/ai-agent/database.db`，当前不解密。

当前归一化：

- Name：`topics.md` 中的 session topic → first summary intent → id。
- Time：`message_summary_time`；creation time 缺失时还可从 Mongo ObjectId-style
  session id 回退。
- Repo：从 project directory slug 尽力还原 filesystem path。
- “Model”：从 VS Code `state.vscdb` index 读取 agent id，并转换为类似
  `Solo Agent` 的 label；它不是底层 LLM model。
- Extra：`source_metadata_json` 保存 agent、是否 current、Trae list order。
- Tokens、branch、impact、parent 均为空。

AI blame 状态：**没有可靠结构化信号**。Summary 的 `actions` 可能偶尔提到文件，
但属于自然语言，不能作为稳定的 blame index。要获得可靠文件列表，需要解密完整 DB、
找到新的明文事件源，或通过 repo/time correlation 另行推断。

### Cline

主要来源：`~/.cline/data/db/sessions.db` 作为 discovery/hierarchy index，按每行的
`messages_path` 读取 root 或 child transcript；旧安装没有 DB 时，fallback 到
`~/.cline/data/sessions/<id>/<id>.messages.json`。Root 仍读取同目录 `<id>.json`
sidecar。

当前归一化：

- Name：sidecar title → DB `metadata_json.title` → sidecar/DB prompt → first user text → id。
- Time/model/repo/usage：优先 sidecar/transcript，并以 DB 的 started/updated、model、
  provider、workspace/cwd、aggregate usage 补缺。
- Hierarchy：DB 的 `is_subagent=1` + `parent_session_id` 直接建立 child relation。
- Impact：每个 DB row 指向自己的 transcript；从 `editor` old/new/path 参数生成
  `touched_files` 和启发式行数。
- Branch 为空。

AI blame 状态：**可直接使用 `touched_files`**。已用真实 Cline spawn 验证：root 与
`<root>__agent_<agent>` child 是两行独立 session，child 有独立 `messages_path` 并明确
指向 root；因此 subagent-level blame 不依赖 tool-name 推断。

## AI blame readiness and next work

如果 blame 的最小定义是“给定文件，列出修改过它的 AI sessions”，当前优先级为：

1. **Ready**：Claude Code、Codex、Cursor、OpenCode、Windsurf、WorkBuddy、Cline。
2. **Blocked on reliable source data**：Trae。

这里的 Ready 表示 loader 已经写入可查询的 `touched_files`，不代表历史记录覆盖率
或路径格式已经在所有版本、所有 edit tool 上达到 100%。

Subagent/session hierarchy 是另一条独立能力轴：

1. **已写入 parent relation**：Claude Code、Codex、Cursor、OpenCode、Windsurf、
   WorkBuddy、Cline。
2. **当前没有可靠信号**：Trae。

索引层应该以标准化后的 `touched_files` 为唯一查询接口，而不是让 blame feature
重新理解每种 transcript。每个新 collector 至少需要：

1. 只记录实际 edit/write/patch 操作，避免把 read/search 路径算作修改；
2. 路径相对 `repo_path` 归一化，并处理 URI、绝对路径和平台分隔符；
3. 对 session 内文件去重；
4. 区分 authoritative applied diff 与 tool-argument heuristic；
5. bump 对应 loader 的 metadata parser version，让旧 cache 自动重建；
6. 添加 fixture/unit test，覆盖 modified、created、deleted、rename 和 failed edit。

## Maintenance rule

修改任何 external loader 的 `session_meta_to_cache_input`、Cursor 的
`cache_input_from_raw`，或新增 `ImportedHistoryCacheInput` 字段时，应在同一个 PR 中更新：

1. 本文 capability matrix；
2. 对应 loader detail；
3. AI blame readiness 分组；
4. parser version 和 metadata/cache tests（如果字段会改变已有 cache row）。
