# ORG2 2026-07-24 LLM / compaction incident：upstream code audit

- 审计时间：2026-07-25（Asia/Shanghai）
- 审计性质：只读取证；除本报告外未修改文件，未 commit / push，未执行线上 LLM、写业务数据或高成本测试。
- 目标会话：`sdeagent-cc131a1c-9f9d-42c5-a901-48d014805036`
- 代码仓：`/mnt/panshuainan/org2-unified-20260724`
- 当前 fork HEAD：`3ce09852d808fd30ec611b4fcb926b19f6b2a560`
- 事故后真实运行 binary：`/home/panshuainan/.local/opt/org2-fork/org2`，SHA-256 `59639eb042131c0703a5e7831d1ddb369f62c32ece5b38c764ea6762df9134ef`
- 该 binary 的构建 provenance：commit `4b732980f47d952d2bd147b4422e3ff79c515c4d`（不是当前文档-only HEAD `3ce09852d`）；与 artifact `tree-mindmap-feishu-head-REAL-20260725-114119/org2` byte-identical。

## 0. 证据边界与结论等级

证据源：

1. 原事故摘要：`/home/panshuainan/.orgii/personal/workspace/llm_compaction_incident_summary_2026-07-24.md`（线索源，不单独作为定案证据）。
2. 完整应用日志：`/home/panshuainan/.orgii/logs/orgii.log.2026-07-24`。
3. SQLite：`/home/panshuainan/.orgii/sessions.db`，只读 URI 打开。
4. fork Git 历史、事故时/事故后备份 binary 字符串、当前运行 binary build provenance。
5. official remote：先执行了 `git remote show official` 与 `git ls-remote --symref official HEAD`；真实默认分支为 `develop`，本次取证时 `official/develop = 325275a5d135f53bfc4cd6401059abc04f33545f`。

等级：

- **已证实**：日志/DB/源码或 binary 三者中至少有直接、相互吻合证据。
- **强推断**：源码唯一可达路径与日志高度吻合，但线上原始 SSE payload 未被记录。
- **未证实**：现有证据不能唯一确定，报告明确保留未知。

---

# 1. Normal turn 的 `Unknown streaming error`：raw 根因与 Codex native 覆盖

## 1.1 已证实的表层根因：Codex Responses 错误 envelope 被旧 parser 抹成固定文案

事故 binary 包含：

```rust
ResponseStreamEventKind::Error => {
    let message = event
        .response
        .and_then(|response| response.error)
        .and_then(|error| error.message)
        .unwrap_or_else(|| "Unknown streaming error".to_string());
    outputs.push(ResponsesStreamOutput::Error(message));
}
```

对应源码位于事故时 fork（例如 `2a704e61c`）的：

- `src-tauri/crates/agent-core/src/core/providers/responses_common/streaming_events.rs`

它只读取 `event.response.error.message`。因此以下任一 wire shape 都会丢失 raw 细节并变成同一个文案：

- official Responses 顶层错误：`{"type":"error","code":...,"message":...,"param":...}`；
- compatible 顶层嵌套：`{"type":"error","error":{...}}`；
- `response.failed`（旧枚举甚至未将其归入 Error）；
- `response.error.message` 存在但为空。

然后 `codex_native/streaming.rs` 把该字符串统一变成 `ProviderError::RequestFailed`，`ReliableProvider` 视其为可重试，于是 normal turn 每次重复相同无效请求 11 次（attempt 0..10）。日志直接证实：

- `10:34:30.566873` 至 `10:36:09.274022`：11 次 `Request failed: Unknown streaming error`，随后 message failed；
- `10:39:31.176374` 至 `10:41:04.667936`：第二组 11 次；
- `11:21:44.237707` 至 `11:23:23.362291`：第三组 11 次；
- `11:30:55.179565` 至 `11:32:37.085943`：第四组 11 次。

这不是“网络流无缘无故断开”的可靠诊断，而是**错误序列化/分类 bug 生成的占位文案**。

## 1.2 raw provider 根因只能做强推断，不能冒充原始证据

事故日志没有记录原始 SSE `data:`，旧 parser 又恰好销毁了 `code/type/status/body`；因此无法从现存日志逐字恢复 provider payload。不能声称已看见原始 `context_length_exceeded` JSON。

但“normal turn 实际被上下文拒绝”是**强推断，置信度高**：

- 事故会话在成功阶段 provider 实测 prompt 连续为 `250971`、`251677`、`252808`、`259560`、`259793`、`260384`、`261392` tokens；
- 第一次持久 compaction 之前 DB 记录 local estimate `251897` tokens；
- failure 发生于同一 Codex native endpoint、同一长历史请求；
- 错误立即、稳定、重试不改变 request；
- 事故后 upstream 专门增加 `context_length_exceeded` / `input_too_long` → `ProviderError::ContextTooLong` 分类及相应用例。

但是，缺少 raw SSE，所以应写为：**最可能是 Codex Responses 的 context/input-too-long 类 structured error，而不是已逐字证实的 payload**。

## 1.3 Codex native 覆盖范围

事故时路径已覆盖：

- HTTP 非 2xx：读取 body并按 401/429/404/other 分类；
- stream 中 `type=error` 且 nested message 非空；
- 部分输出后的 reqwest body decode/connection error：返回 `finish_reason=stream_error`；
- 90 秒 chunk idle timeout；
- 401 before stream / in-stream auth message 的一次 refresh。

缺口：

- official 顶层 `error.code/message/param`；
- `response.failed`；
- structured error 到 `ContextTooLong/RateLimited/Auth/Overloaded/ModelNotFound` 的 typed 映射；
- empty message 时保留其他字段；
- incomplete/partial stream 不得伪装成功。

`official/develop` 已有完整 typed 修复（`cad1e88b5`, `8dc94e6af`，并入 `official/develop`，均不在 fork ancestry）：

- `StreamEvent` 支持顶层 `code/message/param/error` 和 `response.failed`；
- `ResponsesStreamOutput::Error(ResponsesError)` 保留类型；
- `ResponsesError::into_provider_error()` 映射 `context_length_exceeded` → `ContextTooLong` 等；
- Codex native 据 typed error 决定 refresh / fail-fast / retry。

当前 fork 的 `6cdb1cad6` 是本地部分修补：只对 `response.error` 序列化保留更多字段，**仍未支持 official 顶层 error 字段和 `response.failed`，也仍返回 `RequestFailed(String)`**。所以当前真实 binary 对原事故某一 nested-empty-message shape 会改善，但**未覆盖 Codex native 的完整 wire universe**。

---

# 2. 自动/边界 compaction、manual compact、以及“5 分钟边界”

## 2.1 事故序列：只有 manual durable compaction 成功；没有自动 compaction 成功证据

日志 + DB 的精确时间线：

| 时间 (UTC；日志 `Z`) | 事件 | 结果 |
|---|---|---|
| 10:34:30–10:36:09 | normal turn，11 次 unknown-streaming retry | failed |
| 10:39:31–10:41:04 | normal turn，11 次 retry | failed |
| 10:53:04.565 | `Processing Maintenance manual-compact-3f5...` | manual 开始 |
| 10:53:04.963 | compact 82 old (`130197`) + keep 84 (`121700`) | summarizer call |
| 10:57:38.821 | `Done (structured): prompt=53847, completion=15072` | summary 成功 |
| 10:57:38.937 | `166 messages (251897) -> 86 (141909)` | durable manual 成功 |
| 11:25:35.358 | `manual-compact-578...` | manual 开始 |
| 11:30:35.868 | empty structured summary | primary 失败 |
| 11:30:36.527 | invented nano model 被 Codex ChatGPT account 400 拒绝 | manual failed；未写 boundary |
| 11:35:18.775 | `manual-compact-368...` | manual 开始 |
| 11:40:19.255 | body decode error after partial output → empty structured | primary 失败 |
| 11:40:20.156 | nano 400 | manual failed；未写 boundary |

DB 只存在一个 durable summary message：

- id `cb348ef9-3635-4eb5-9a59-56f5c91bcf10`
- sequence `295`
- `compact_from_sequence=99`
- `compact_tokens_before=251897`
- `compact_tokens_after=141909`
- created `2026-07-24T10:57:38.928740015+00:00`
- content 以 `[Conversation summary — 82 earlier messages compacted]` 开头。

`agent_compaction_boundaries` 对该旧式 in-place compaction 没有行；真正 durable 证据是 `agent_messages` 的 boundary system row 和 `events.function_name=context_compacted`。失败的两次没有新 summary row，符合 manual “失败不改 transcript”的语义。

日志中没有该会话的 `[unified_processor] Compacting context...`、reactive compaction 或 auto boundary 成功记录。因此不能把第一次成功说成 automatic；它明确是 scheduler 的 `Processing Maintenance manual-compact-*`。

## 2.2 automatic / boundary 的代码语义

事故/当前 fork 的自动 pre-turn 路径：

- microcompact → aggregate tool budget → context compaction；
- trigger 依据 local estimate，后来加入上一轮 provider observed fill；
- budget = context window - summary reserve (`20000`) - safety buffer (`13000`)；
- 自动 LLM compaction 失败时，fork 当前仍可能 `simple_truncate` 并持久化 boundary（危险）。

manual 路径：

- scheduler exclusive maintenance；
- 强制 `trigger_ratio=0`、较低 floor；
- success 才 `append_in_place_compact_boundary`；
- failure 返回错误，不 truncation、不持久化。

upstream `f8dfe7ef4` 已把 automatic failure 改为**历史原样返回 + `CompactionOutcome::Failed`**，不再 silent truncate，并将长期摘要从 forced structured tool call 改为 plain text、加入 fork cache reuse。当前 fork **没有**这些 commits（`f8dfe7ef4`、`aea05413e`、merge PR `0325788ac` 均不在 fork ancestry）。

## 2.3 “恰好 5 分钟”不是业务 compaction 边界，而是 HTTP overall timeout

两次失败 primary summarizer 的间隔分别为：

- `11:25:35.866401` request → `11:30:35.868094` Done：约 `300.002s`；
- `11:35:19.254150` request → `11:40:19.255431` `error decoding response body`：约 `300.001s`。

代码唯一与这两个时刻精确吻合的证据：

```rust
// codex_native/client.rs
let client = build_http_client(Duration::from_secs(300));

// foundation/utils/mod.rs
reqwest::Client::builder().timeout(timeout)
```

Codex streaming loop另有 **90 秒 per-chunk timeout**，不吻合 300 秒。日志里每分钟 consolidation tick、5 分钟状态 TTL 等均与该 summarizer request 生命周期无直接因果。

因此“5 分钟边界”应定性为：**reqwest client overall request deadline 到期，body stream 被中止，最终暴露为 `error decoding response body`（日志中的具体 reqwest Display 字符串）**；不是 auto-compaction 定时器，不是模型主动 5 分钟停止，也不是 DB boundary 规则。

---

# 3. Empty summary typed error 如何被吞没

## 3.1 事故时链路

事故 summarization 强制 `emit_summary` tool call。`side_query` 的 structured path 只要找到同名 tool call，就：

```rust
Some(tool_call.arguments.clone())
```

即使 arguments 是 `{}` 或 `{"summary":""}` 也被当成成功：

1. Codex stream 在 300 秒 deadline 处发生 partial body decode error；
2. `codex_native` 若已有 partial tool-call data，不返回 Err，而是 `finish_reason=stream_error` 的 `Ok(LLMResponse)`；
3. `side_query::is_output_truncated` **只检查 `finish_reason == length`**，不检查 `stream_error` / `stream_error_kind`；
4. 只要 pending tool call 被 flush，`extract_structured_from_response` 就接受空 args；
5. 日志打印 `Done (structured): prompt=0, completion=0`；
6. 到 `summarization.rs` 才把 missing/blank `summary` 转成 `Err("summarizer returned an empty summary")`。

所以 typed transport error 被“吞成成功”的位置是 **side_query structured extraction**；summarization 的最后一道 empty guard 反而成功避免了空 summary 持久化。

## 3.2 upstream 与当前 fork

upstream：

- `aea05413e`：empty forced-tool args 视为 empty response，进入 retry/fallback；
- `f8dfe7ef4`：compaction summary 改为 plain text，避免大 prompt 强制一个超长 JSON string/tool argument；
- `8dc94e6af`：typed stream error；
- 自动失败不 truncation。

当前 fork：

- 保留最终 empty guard；
- `6cdb1cad6` 没有 empty-structured-args guard；
- 仍用 forced structured summary；
- 仍未把 `stream_error` 在 side query 层作为 hard failure；
- 事故后移除了 invented nano retry，这是正确的 config/route 修复，但不是 transport/empty 语义的完整修复。

---

# 4. Per-key `side_query_model`：覆盖矩阵

## 4.1 当前 fork 已实现的字段和主要路由

`6cdb1cad6` 增加 `ModelKey.side_query_model`，并暴露于 KeyVault API/UI。resolver：

- 严格读取当前 `account_id`；
- explicit model 必须属于该 key 的 enabled/available 交集；
- 未配置时按名字启发式选最便宜模型（nano/haiku → mini/flash/small → others）；
- 每次新建 exact same key 的 provider，禁止跨 key fallback drift。

覆盖：

| 路径 | 当前 fork 是否用 per-key resolver | 证据 |
|---|---:|---|
| auto pre-turn LLM compaction | 是 | `processor/compaction.rs::compaction_side_query_route` |
| reactive ContextTooLong compaction | 是 | 同上 |
| skill prefetch | 是 | `processor/prefetch.rs` |
| workspace-memory prefetch | 是 | `processor/prefetch.rs` |
| session-memory extraction | 是 | `post_turn.rs::fresh_fork_provider` |
| workspace-memory extractor agent | 是 | 同一个 `fresh_fork_provider`；builtin hardcode nano 已移除 |
| auto-dream | 是 | 同一个 `fresh_fork_provider` |

## 4.2 未覆盖，故“覆盖全部路径”结论为否

以下仍直接使用 foreground/session model 或自己解析 provider：

| 路径 | 当前行为 | 结论 |
|---|---|---|
| session title | caller 传入 main provider/model 到 `session/title.rs::generate_session_title` | 未覆盖 |
| reflection | DB session model + account (`reflection/provider.rs`) | 未覆盖 |
| active observation | DB session model + account | 未覆盖 |
| consolidation batch | source session model / batch account | 未覆盖 |
| goal-loop judge | foreground `input.model` | 未覆盖 |

如果产品定义的“side query”仅限 compaction + prefetch + memory post-turn，则核心路径已覆盖；若字面要求**所有后台/辅助 LLM 调用**，当前实现不完整。

另有一个 UI/RPC 死参数：

- TS `updateKeyHealth(..., sideQueryModel?, ...)` 声明了参数；
- `UpdateKeyHealthInput` schema 也接受 `sideQueryModel`；
- 但 wrapper 发 RPC 时没有放进 payload；Rust `update_key_health` 也无该参数。

这不影响 `saveKey({side_query_model})` 的主 UI 保存路径，但说明接口覆盖没有闭合。

## 4.3 当前实际 key 配置

事故 account `d48f549a` 当前 credential row：

- enabled = true
- available：`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, ...
- enabled：`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`
- `side_query_model` 未配置。

按当前 resolver，自动选择 `gpt-5.5`（这些 enabled 名字均不命中 cheap tier；长度/字典序使它胜出），与 `2026-07-25T04:15:28` 后日志的 `[side-query] model=gpt-5.5` 吻合。

事故时日志出现 `openai/gpt-5.4-mini:openai` / `nano` 直接传给 Codex ChatGPT account，均被 HTTP 400 “model is not supported” 拒绝，这是事故 fork 的 hardcoded/invented model config bug，而不是 provider outage。

---

# 5. 与 official 最新默认分支的逐文件 / commit 对比

## 5.1 remote 与分叉事实

- official remote HEAD：`refs/heads/develop`，不是 `main`。
- official snapshot：`325275a5d135f53bfc4cd6401059abc04f33545f`。
- fork HEAD：`3ce09852d...`。
- merge-base：`7607f19d2b7365189f96e826e534f1e7d636624f`。
- fork 没有包含 upstream fixes `cad1e88b5`, `8dc94e6af`, `aea05413e`, `f8dfe7ef4`；它们都在 official ancestry。

## 5.2 关键逐文件差异

| 文件 | 事故 fork / 当前 fork | official/develop | 归因 |
|---|---|---|---|
| `responses_common/streaming_events.rs` | 事故：只读 nested message；当前：nested empty 可序列化，但无 official top-level / `response.failed` typed support | 支持 top-level + nested + `response.failed`，输出 typed `ResponsesError` | 原始 bug 来自共同旧基线；upstream 已修，fork 漏合并/部分重造 |
| `responses_common/types.rs` | 当前 `code: Value/status/body`，无 typed classifier | `code/type/param` + `into_provider_error()` | fork 当前仍不完整 |
| `codex_native/streaming.rs` | string error → `RequestFailed` | typed error → `ContextTooLong`/429/auth/etc | fork bug（相对 latest upstream） |
| `side_query.rs` | 支持 streaming；但 empty structured args、stream_error 都可被当成功 | empty structured args guard；non-streaming side query | empty swallow 为 upstream 已修、fork 漏合并；streaming 300s 是 fork feature 与共同 300s client timeout 交互 |
| `summarization.rs` | forced `emit_summary` tool + streaming | plain text summary；shared validator；fork-cache path | fork 保留 upstream 已废弃设计，直接触发 empty tool-call 类问题 |
| `compaction.rs` | 当前 auto failure 仍可 truncation；事故还 invented nano fallback（后已删） | failure keeps history unchanged；no silent truncation；fork summary cache reuse | nano 是 fork config bug；silent truncation/forced tool 是 upstream 已修但 fork 未纳入 |
| `processor/{mod,prefetch,compaction}.rs` | per-key resolver + exact-key new provider | foreground model + provider side-query execution strategy | per-key 是 fork-only feature；核心覆盖见 §4 |
| `post_turn.rs` | memory post-turn 使用 per-key resolver | foreground model | fork-only feature；但未覆盖 title/reflection 等 |
| `key-vault/{types,crud}.rs` | 有 `side_query_model` | 无 | fork-only config/UI；不是 upstream bug |

## 5.3 归因分类

### A. Upstream-origin bug（共同旧基线已有，latest upstream 已修）

1. Responses SSE structured error 被抹成 `Unknown streaming error`。
2. structured empty tool args 被 side query 当成功。
3. forced structured tool call 不适合超长 compaction summary。
4. automatic compaction failure silent truncation 的危险语义。

### B. Fork bug / fork divergence

1. fork 在 upstream 修复已存在后继续运行旧 parser / old summarizer design，且事故后只做部分 string serialization patch，没有合入 typed error stack。
2. `stream: true` + 全局 reqwest 300s deadline：长 summary 恰好 5 分钟被截断。
3. primary summary 失败后构造 `openai/gpt-5.4-nano:openai`，却继续走 Codex ChatGPT account；必然 400。
4. per-key resolver 只覆盖一组核心 side-query callsites，不覆盖 title/reflection/active observation/consolidation/goal-loop。
5. TS `updateKeyHealth.sideQueryModel` 参数未透传，接口不闭合。

### C. Configuration / workload

1. 会话实际 prompt 已到约 250k–261k tokens，触发 provider input limit 是根本工作负载条件；parser bug只把可诊断错误变成 unknown，并造成 11 次浪费重试。
2. 事故 account 的 Codex OAuth 模型集合不接受带 ZenMux-style `openai/...:openai` slug；这不是暂时故障。
3. 当前 account 没有 explicit `side_query_model`，只能依赖 heuristic；目前选到 `gpt-5.5`，但并非显式策略。

---

# 6. 当前真实 binary 的无损复现 / 验证设计

目标：验证真实运行 binary（commit `4b732980f` build），不写生产 DB、不消费线上 LLM、不碰 credential store。

## 6.1 先决隔离

1. 不对当前 PID `1118322` 注入请求。
2. 复制 `sessions.db`、credentials/settings 到临时目录（只复制；生产保持只读）；或用编译期 unit/integration harness，不启动完整 app。
3. mock HTTP server 绑定 loopback 临时端口；fixture 不含真实 token。
4. provider config 指向 mock endpoint；reliability retries 设 0，避免等待/成本。
5. 每个 case 比对：returned typed error、retry count、DB temp copy hash/row count、boundary rows。

## 6.2 无网络 deterministic fixtures

### Case A：official top-level context error

SSE：

```text
data: {"type":"error","code":"context_length_exceeded","message":"Your input exceeds the context window.","param":"input"}\n\n
```

期望（正确实现）：`ProviderError::ContextTooLong`，单次 fail-fast，触发 reactive compaction arm。

当前真实 binary 预计：仍不能读取顶层字段，返回 generic `Streaming error (event payload:...)` / `RequestFailed`；用实际输出定案。

### Case B：nested empty-message error

```text
data: {"type":"error","response":{"output":[],"usage":null,"error":{"message":"","status":400,"code":"context_length_exceeded","type":"invalid_request_error","body":{"detail":"maximum context length"}}}}\n\n
```

期望：至少保留 code/status/body；当前 `6cdb1cad6` 应通过。

### Case C：`response.failed`

```text
data: {"type":"response.failed","response":{"output":[],"usage":null,"error":{"code":"context_length_exceeded","type":"invalid_request_error","message":"too long"}}}\n\n
```

期望：typed ContextTooLong。当前 binary 预计按 unknown frame 忽略，必须验证是否最终伪造 stop/empty success。

### Case D：partial empty structured call + transport abort

先发送 `emit_summary` function-call started、arguments `{}`，随后 mock server reset connection。

正确期望：side query hard error，不能 `Done (structured)`，不能返回空 structured success。

当前 binary 预计：flush pending tool call → structured success → summarization empty guard；这正是事故链路的无成本复现。

### Case E：300s deadline（不建议实际等待）

无需真等 5 分钟：源码/构造参数已经确定 `ClientBuilder.timeout(300s)`。若必须 black-box 验证，应给 test-only client timeout 注入（例如 300ms），证明比例等价行为；不要对真实 binary 等 300 秒做昂贵测试。真实日志已有两次约 300.00 秒直接证据。

## 6.3 Temp DB compaction invariants

在临时 DB 构造小型 transcript + mock summary response：

1. manual success：exactly one boundary，old rows不删除，`compact_tokens_after < before`。
2. manual empty/transport fail：零新 boundary，所有原 row hash不变。
3. auto summarizer fail：**要求 history unchanged**；当前 fork若产生 simple truncation/boundary，测试应红灯。
4. structured empty `{}`：不得持久化空 summary。
5. per-key route：两个 fake account、不同 model catalog；每条核心 path 记录 mock endpoint/model/key-id，不允许跨 key。

## 6.4 Binary provenance check

每次验证前固定输出：

- `/proc/<pid>/exe` resolved path；
- binary SHA-256；
- artifact `BUILD_PROVENANCE.txt` commit；
- `cmp` artifact 与 installed binary；
- Git working tree tracked-dirty count。

当前已证实：installed binary 与 commit `4b732980f` artifact byte-identical；不要用当前 `3ce09852d` 源码状态冒充正在运行的 build。

---

# 7. 结论矩阵

| 问题 | 结论 | 等级 | upstream / fork / config |
|---|---|---|---|
| normal turn `Unknown streaming error` 是什么 | 旧 Responses parser 丢弃非 `response.error.message` 的 structured error，固定 fallback 文案；Reliable 又重试 11 次 | 已证实 | upstream-origin，latest upstream 已修；fork 漏合入 |
| raw provider code 是否就是 `context_length_exceeded` | 高概率是 context/input-too-long；但原 SSE 未落盘，不能逐字定案 | 强推断 | workload + parser evidence loss |
| Codex native 是否全覆盖错误形态 | 事故否；当前 fork仍否；official latest 基本覆盖 top-level/nested/failed + typed mapping | 已证实 | fork divergence |
| 自动 compaction 是否成功过 | 此事故会话没有日志/DB证据 | 已证实（否定性限于现有记录） | — |
| 第一次成功 compact 类型 | manual maintenance；166/251897 → 86/141909，82 old summarized | 已证实 | manual path 正常 |
| 后两次 manual 结果 | 均失败；未写新 durable boundary | 已证实 | fork streaming/empty + invalid nano fallback |
| 5 分钟来源 | Codex reqwest overall timeout `300s`，不是 compaction timer | 已证实 | common client setting + fork streaming usage |
| empty summary 是否被持久化 | 没有；最终 guard 阻止。被吞的是 transport/structured failure，到 summarization 才恢复成 empty error | 已证实 | old upstream design + fork divergence |
| per-key side_query_model 是否全部路径覆盖 | 否。核心 compaction/prefetch/memory paths覆盖；title/reflection/active observation/consolidation/goal-loop未覆盖 | 已证实 | fork-only feature incomplete |
| 当前真实 binary commit | artifact provenance `4b732980f`，SHA `59639e...`；当前 Git HEAD `3ce09852d` 只是后续 docs commit | 已证实 | provenance |
| upstream latest 是否仍有同一 bug | official `develop` 已含 typed stream error、empty args guard、plain-text summary、failure-keeps-history | 已证实 | upstream fixed |
| 当前 fork是否可宣称彻底修复 | 不可。只修了 nested empty payload可见性、invalid nano fallback/per-key核心路由；仍缺 typed/full-wire、empty args、plain-text summary、auto no-truncate | 已证实 | fork remaining defects |

## 最短行动建议（不在本次只读审计中执行）

1. 优先移植 upstream `8dc94e6af` typed Responses error stack及测试，而不是继续加字符串 heuristic。
2. 移植 `aea05413e` + `f8dfe7ef4`：empty args guard、plain-text compaction、failure keeps history、fork cache reuse。
3. 给 side query 明确处理 `finish_reason=stream_error` / `stream_error_kind`，不得把 partial transport failure当 structured success。
4. 区分 streaming idle timeout 与 overall request deadline；长 summary 不应被硬编码 300s 总 deadline截断。
5. 产品上明确“side query”边界；若要求所有辅助 LLM，统一 resolver 到 title/reflection/active observation/consolidation/goal-loop，并补 route matrix tests。
6. 显式设置事故 key 的 `side_query_model=gpt-5.5`（或用户指定的同-key enabled model），不要依赖名字 heuristic。
