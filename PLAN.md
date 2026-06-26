# PLAN.md — ORG-II ↔ Feishu 联动优化（6项 + opus-4.6）

## 总览

经过对代码库的全面调研，以下是每项任务的落点、改法和验证方案。

---

## ① 飞书 session 在 GUI 侧边栏可见

### 现状

- 后端 `agent_sessions` 表已有 `channel` 列（`Option<String>`），飞书 session 存为 `channel = "feishu"`。
- `UnifiedSessionRecord` 包含 `channel` 字段，但 **`SessionAggregateRecord`（Tauri RPC 响应）未映射 `channel`**。
- 前端 `Session` 接口和 Zod schema 均无 `channel` 字段。
- 侧边栏分组（byTime / byAgent / byWorkspace）无 channel 维度。

### 落点 & 改法

**后端（2 文件）：**

1. `src-tauri/src/agent_sessions/unified_stats/types.rs` — `SessionAggregateRecord` 加 `channel: Option<String>`
2. `src-tauri/src/agent_sessions/unified_stats/conversion.rs` — 各转换函数映射 `session.channel`

**前端（6 文件）：**

1. `src/api/tauri/rpc/schemas/sessionAggregate.ts` — Zod schema 加 `channel: z.string().optional()`
2. `src/store/session/sessionAtom/types.ts` — `Session` 接口加 `channel?: string`
3. `src/api/tauri/session/index.ts` — `toFrontendSession()` 映射 channel
4. `src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/menuSectionBuilders.ts` — 在 byAgent 模式里，将 `channel` session 独立分到 "Channels" 组顶部（不新增 groupByMode，而是在现有 byAgent 分组里插入 channel section）
5. `src/config/sessionAgentGroups.ts` — 加 channel 标签映射
6. `src/i18n/locales/{en,zh}/sessions.json` — 加 i18n key："Channels" / "频道"

**策略：** 不新增 groupByMode（最小改动），而是在 byAgent 模式的顶部增加 "Channels" 分隔符 + channel sessions。session_type="os" 且 channel 非空的归入 Channels 组，其余保持原有分组。

### 验证

飞书来一条消息后，刷新侧边栏能在 "Channels" 分组看到该 session，点击可进入对话。

---

## ② 飞书对话 → Work Item 联动

### 现状

- `manage_work_item` 工具需要 `RequiredCapability::Management`。
- 飞书 channel session 前缀 `osagent-feishu-{chat_id}` → 匹配 OS Agent 定义。
- OS Agent 的 `CapabilitySet` **已包含 `management: Some(ManagementCapability {})`**。
- 因此 `manage_work_item` **已对飞书 agent 可用**，无需修改 capability。

### 落点 & 改法

**工具别名（1 文件）：**

1. `src-tauri/crates/agent-core/src/core/tools/builtin_tools/table/agent.rs` — 为 `manage_work_item` 条目添加 `aliases: vec!["wi"]` 字段（如果 alias 机制已有）；若无 alias 机制，则在 tool name resolution 处加短名映射。

**需确认 alias 机制：** 检查 `ToolEntry` 是否有 `aliases` 字段。若无，在 tool dispatch 层（tool name → handler 的 match）加一个 `"wi" => "manage_work_item"` 的映射即可。

### 验证

飞书里让 agent "建个 work item 记录 xxx"，能成功创建并在 GUI 项目里看到。

---

## ③ 附件双向收发

### 现状

- **发（outbound）**：`api.rs` 已有 `upload_image()` + `upload_file()` + `send_media_message()`，`channel.rs` 的 `send()` 遍历 `msg.media` 调用 → **已完整实现**。
- **收（inbound）**：`event.rs` 解析 image/file 消息，存为 `feishu:image:{key}` / `feishu:file:{key}` 到 `InboundMessage.media`。但 **无下载函数**：`resolve_image_for_llm()` 不识别 `feishu:` 前缀 → 图片被静默丢弃。

### 落点 & 改法

**后端（3 文件）：**

1. `src-tauri/crates/agent-core/src/integrations/channels/feishu/api.rs` — 新增 `download_image(auth, image_key) -> Result<Vec<u8>>` 和 `download_file(auth, file_key, filename) -> Result<PathBuf>`：
   - Image: `GET {api_base}/im/v1/images/{image_key}` → 返回 bytes
   - File: `GET {api_base}/im/v1/files/{file_key}` → 返回 bytes，保存到 `session_images_dir()`
2. `src-tauri/crates/agent-core/src/integrations/channels/feishu/event.rs` — 在 `parse_feishu_event()` 中，解析到 image/file 后 **立即下载并持久化**，将 `InboundMessage.media` 存为本地文件路径而非 `feishu:` URI。这样 `resolve_image_for_llm()` 直接能用。
3. `src-tauri/crates/agent-core/src/integrations/channels/feishu/channel.rs` — 传入 `auth` 引用给 event 解析函数（当前 auth 在 channel 层，event 层可能需要访问）。

**策略：** 在 event 处理时就把媒体下载完毕存本地，而不是延迟到 LLM resolve 时。这避免修改 `resolve_image_for_llm` 的通用逻辑。

### 验证

- 发：agent 生成图片/文件 → 飞书能收到。
- 收：飞书发送图片 → agent 能在 prompt 中看到（通过 data URL）。

---

## ④ WS 重连健壮性

### 现状

- 固定 `reconnect_interval_secs`（默认 120s）重试，无指数退避。
- 无 pong 超时检测（僵尸连接不会被发现）。
- 无 reconnecting 状态区分。
- 无 fragment cache TTL。

### 落点 & 改法

**1 文件：** `src-tauri/crates/agent-core/src/integrations/channels/feishu/ws.rs`

**改动点：**

1. **指数退避重连：**
   - 新增 `reconnect_attempt: u32` 计数器
   - 新增 `compute_backoff(attempt, base_secs) -> Duration` 函数：`min(base * 2^attempt, 900)` 上限 15 分钟
   - 成功连接后重置 `reconnect_attempt = 0`
   - 替换两处 `sleep(reconnect_interval_secs)` 为 `sleep(compute_backoff(...))`

2. **Pong 超时检测：**
   - 新增 `last_pong: Arc<Mutex<Instant>>` 记录最后 pong 时间
   - 收到 pong 时更新 `last_pong`
   - ping 发送前检查 `last_pong.elapsed() > ping_interval + 30s`，超时则 break 触发重连

3. **Reconnecting 超时兜底：**
   - 在主循环开头记录 `reconnect_start = Instant::now()`
   - 若连接失败 + 已超过 10 分钟仍在重试，强制 abort 旧连接 + 重新请求 WS endpoint（彻底 reset）

4. **Fragment cache TTL：**
   - fragment 插入时记录时间戳
   - 每次循环清理超过 5 分钟的 incomplete fragments

### 验证

- 模拟断连（关闭网络）：观察日志出现指数退避重连
- 单测：`compute_backoff` 函数的退避值正确

---

## ⑤ 跨 channel learnings 融合

### 现状 — **已统一，无需改**

**证据：**

1. `learnings` 表 schema **无 session_type / channel 列**，仅有 `agent_scope`（按 agent_definition_id 分桶）和 `source_session_id`（审计用）。
2. `load_active_learnings(conn, agent_scope)` 查询 WHERE 子句只有 `agent_scope = ?1 AND status NOT IN (...)`，无 channel 过滤。
3. `search_similar()` / `rerank_candidates()` 同样无 channel 过滤。
4. 飞书 session 和本地 GUI session 使用同一个 agent definition（OS Agent, `builtin:os`），写入同一个 `agent_scope = "agent:builtin:os"` 桶。
5. 检索时从该桶取出所有 active learnings，经 embedding 相似度 + Qwen3 rerank → 返回给任意 session。

**结论：** 飞书产生的 learning 在本地 GUI session 中能被 recall，反之亦然。系统设计本就是按 agent_scope 统一的，不区分 channel。

### 落点 & 改法

无代码改动。PLAN.md 和 RESULT.md 中记录证据。

### 验证

代码审查确认无 channel 隔离逻辑。运行时验证：飞书产生 learning → 本地 session recall 到（手动）。

---

## ⑥ GUI 监控面板（quota / cost / context）

### 现状

- `session_token_usage` 表有完整的 per-round token 数据（input/output/cache/context）。
- ZenMux quota 获取逻辑在 `status_bar.rs` 中（`pub(crate)`），5 分钟 TTL 缓存，当前仅供飞书 status bar 使用。
- 前端已有 `StatCard` 组件、`recharts` 图表库、`invokeTauri` 调用模式。
- **无 Tauri command 暴露 ZenMux quota 或实时 context 数据到前端**。

### 落点 & 改法

**后端（2-3 文件）：**

1. `src-tauri/crates/agent-core/src/core/session/status_bar.rs` — 将 `get_zenmux_bar_text()` 改为公开，或新增 `get_zenmux_quota_raw() -> Option<ZenmuxQuota>` 返回结构化数据（非格式化字符串）。导出 `ZenmuxQuota` 结构体。
2. `src-tauri/src/commands/` — 新增 tauri command：
   - `quota_get_zenmux_status()` → 调 status_bar 的缓存获取逻辑，返回 `{ quota_5h_pct, quota_7d_pct, resets_5h, resets_7d }`
   - `session_get_context_status(session_id)` → 查 `session_token_usage` 最新行，返回 `{ context_used, context_total, total_tokens, model }`
3. `src-tauri/src/commands/handler_list.inc` — 注册新 command

**前端（3-4 文件）：**

1. `src/modules/MainApp/QuotaMonitor/index.tsx` — 主面板组件：
   - 3 个 StatCard：ZenMux 5h%、7d%、当前 session context%
   - 简单 progress bar 显示 quota 占用
2. `src/modules/MainApp/QuotaMonitor/hooks/useQuotaData.ts` — 轮询 tauri command（10s 间隔）
3. 在 DevRecord 或 Settings 入口挂载面板

**策略：** 最小化面板，不做完整 dashboard。3 个 StatCard + progress bar，轮询刷新。

### 验证

面板能显示真实 ZenMux quota 百分比和当前 session 的 token/context 数据。

---

## opus-4.6 模型支持

### 现状 — **已支持，无需改**

**证据：**

1. `model_capabilities.rs` — `FamilyRule { pattern: "claude-opus-4", ... }` 子串匹配，覆盖 4.6/4.7/4.8。
2. `nativeHarnessAccountModels.ts` — `CLAUDE_CODE_OAUTH_MODELS` 静态列表已包含 `"claude-opus-4-6"`。
3. `modelWikiCatalog.json` — 已有 `"anthropic/claude-opus-4.6"` 完整条目。
4. `info.ts` — `MODEL_INFO_ENTRIES` 里 pattern `"claude-opus-4"` 覆盖所有 4.x。
5. Anthropic API key 用户：`GET /v1/models` 动态获取，若账户有权限则自动出现。
6. `section_builders.rs` — knowledge cutoff 已映射 `claude-opus-4-6`。
7. E2E 测试 + pricing 脚本已引用 `claude-opus-4.6`。

**结论：** GUI 能选中 opus-4.6，backend capabilities 正确解析。无需代码改动。

### 验证

GUI 模型选择列表有 opus-4.6（OAuth 用户直接可见，API key 用户取决于 Anthropic 账户权限）。

---

## 实施顺序

1. **E5**（确认无需改，写证据）→ 无 commit
2. **opus-4.6**（确认无需改，写证据）→ 无 commit
3. **E2**（工具别名，最小改动）→ 1 commit
4. **E4**（WS 重连，独立模块）→ 1 commit
5. **E1**（侧边栏，前后端联动）→ 1 commit
6. **E3**（附件收发，依赖飞书 API）→ 1 commit
7. **E6**（GUI 面板，前后端新增）→ 1 commit
8. 容器 build 验证 → RESULT.md
