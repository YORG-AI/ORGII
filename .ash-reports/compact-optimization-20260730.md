# ORG2 压缩优化两项 · 2026-07-30/31

分支 `ash/org2-fixpack-20260730`，commits `63e638af5` + `3e3c749a6`。
（63e638 由子代理起草、Ash 修正缩进并验证收口；3e3c74 由 Ash 直接实现。）

## 1. Replay 压缩（63e638af5）

**目标**：摘要请求复用主请求 byte-exact 前缀 → provider prompt cache 全命中，输入按 cache-read 计价（OpenClaw 侧同方案实测 99.99% 命中）。

改动：
- `turn_executor/mod.rs`：每次主请求 stream 成功后 `record_replay_snapshot(session_id, &llm_messages)`（进程内 HashMap，Mutex，覆盖式）。
- `summarization.rs`：
  - `REPLAY_SNAPSHOTS` 注册表 + `fresh_replay_snapshot()` 新鲜度门：`<1h` 且 `snapshot 消息数*2 >= 当前消息数`，否则 None → flatten fallback。
  - `summarize_via_replay()`：snapshot + 追加一条 user 指令（SUMMARIZATION_SYSTEM_PROMPT + recompaction/prior-summary/自定义指令 + 输出要求），无 tools、无 structured output（纯文本回复即摘要）、stream 保持、`skip_cache_write: true`；LENGTH finish_reason 拒收；空摘要拒收。
  - `summarize_messages()`：state.replay_session_id 存在且 snapshot 新鲜 → replay 路径；失败/缺失 → 原 flatten 路径（未删）。oversized_notes 两条路径都保留。
  - 日志：`summarization path=replay/flatten` + `replay summary usage: prompt/completion/cache_read`。
- `compaction.rs`：`CompactionState.replay_session_id: Option<String>`（None=禁用 replay，测试默认走 flatten）。
- `processor/compaction.rs`：三个 `ContextCompactor::compact` 调用点前设置 `state.replay_session_id`。
- `side_query.rs`：`SideQueryResult.cache_read_tokens` 透出（usage_key::CACHE_READ_TOKENS）。

## 2. 加权触发（3e3c749a6）

**目标**：大窗口模型下 context 永不满 → 永不压缩 → 每轮拖巨大 cache 前缀烧钱。新增成本触发条件。

改动：
- `CompactionConfig.weighted_token_threshold`（camelCase serde，default 5_000_000，`0` 禁用）。
- 加权口径（与 OpenClaw auto-compact-cost 一致）：`uncached_input*1.0 + cache_read*0.1 + cache_write*1.25 + output*5.0`；Anthropic 计法里 prompt_tokens 即未缓存输入。
- `session_runtime.rs`：`cumulative_weighted_tokens_milli: Arc<AtomicI64>`（×1000 存，保住小数权重）。
- `processor/execute.rs`：每 turn 结束按 TurnResult 的 prompt/cache_read/cache_write/completion 累加。
- `processor/compaction.rs`：`cost_triggered = threshold>0 && cumulative>=threshold && tail>=min_messages`；`size_triggered || cost_triggered` 先到先压；仅 cost 触发时打专属日志。压缩成功后计数器清零。
- `state/commands/session/compaction.rs`：手动 /compact 同样清零。
- fork.rs 的 channel-attached fork 语义未动（触发后走原有 compact → fork/in-place 链路）。

## 验证

- Docker（org2-build:22.04-xdg，6g/2cpu/jobs=1）`cargo check -p agent_core`：**通过**（仅 7 个既有 warning）。
- `cargo test -p agent_core --lib -- weighted_token_threshold replay_session_id`：**2 passed**。
- 未做全量构建/dpkg（等下一次发版一起）。

## 后续验收（真实流量）

- 压缩日志应出现 `summarization path=replay` 且 `cache_read` 显著 >0。
- 长 session（大窗口模型）应看到 `Cost-based compaction trigger ... cumulative weighted X >= threshold 5000000`。
