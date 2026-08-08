# Token Monitor vs ORGII：额度、使用量、缓存与 NO-SPIKES 路线

日期：2026-07-31

## Executive verdict

还没有“全部覆盖”，但边界已经清楚：

- Token Monitor 有 19 个 quota provider；ORGII 本轮后可直接刷新其中 12 个，剩 7 个。
- Token Monitor 有 21 个 usage client（20 个默认、MiMo opt-in）；ORGII 与其中 11 个 client 有真正 transcript importer，另有 6 个 Token Monitor 没有的 source。Antigravity 在 ORGII 目前仍只是 hook/source identity，不是历史 importer。
- ORGII 的持久化、分页 snapshot、parser-version invalidation、last-good 和 Cursor WAL 感知比 Token Monitor 更强。
- Token Monitor 的 provider breadth、today-delta anchor、watch root 选择和 self-sync cache 隔离值得学习。
- Token Monitor 的冷启动 `today + month + all-time` 三次 subprocess、全量递归 discovery、全 message-cache load，以及 5 分钟全局定时 refresh 不适合直接复制；它们会带来 CPU、RAM 和 I/O 峰值。

本轮实际扩展了 DeepSeek、OpenRouter、MiniMax、ZAI Team、Qoder、Kimi Code quota，加入 Pi、Qwen、Kimi/Kimi Code importer，把 Cursor billing 改为 streaming aggregate + bounded paging，并为 JSONL importer 建立固定 seam watermark。所有新路径都是 demand-driven，没有新增 interval、常驻 watcher 或后台 worker。

代码按单一职责拆成交付：

- [PR #611：bounded external quota and usage sync](https://github.com/org2AI/ORG2/pull/611)（Ready，CI 全绿）
- [PR #614：bounded history sync and SQL pushdown](https://github.com/org2AI/ORG2/pull/614)（Ready，CI 全绿）
- [PR #615：bounded ZAI Team limits](https://github.com/org2AI/ORG2/pull/615)（Draft，stacked on #611，check 通过）
- [PR #616：bounded Qoder credits](https://github.com/org2AI/ORG2/pull/616)（Draft，stacked on #615，check 通过）
- [PR #618：stream and page Cursor billing usage](https://github.com/org2AI/ORG2/pull/618)（Draft，stacked on #611，check 通过）
- [PR #619：resume JSONL from bounded seams](https://github.com/org2AI/ORG2/pull/619)（Draft，stacked on #614，check 通过）
- [PR #620：incremental Pi history importer](https://github.com/org2AI/ORG2/pull/620)（Draft，stacked on #619，check 通过）
- [PR #622：bounded Kimi Code quota](https://github.com/org2AI/ORG2/pull/622)（Draft，stacked on #616，check 通过）
- [PR #623：incremental Qwen history importer](https://github.com/org2AI/ORG2/pull/623)（Draft，stacked on #620）
- [PR #625：incremental Kimi/Kimi Code history importer](https://github.com/org2AI/ORG2/pull/625)（Draft，stacked on #623，check 通过）

## 覆盖记分牌

### Quota / limits

| 状态 | Provider |
|---|---|
| ORGII 已支持（12/19） | Claude OAuth、Codex OAuth、OpenCode Go、Cursor、Copilot、ZAI/GLM、DeepSeek、OpenRouter、MiniMax、ZAI Team、Qoder、Kimi Code |
| 尚未支持（7/19） | Antigravity、Grok、MiMo、Kiro、Volcengine、Ollama Cloud、third-party/NewAPI |

### Usage / history

Token Monitor 的 21 个 client：

`claude`, `codex`, `opencode`, `hermes`, `openclaw`, `cursor`, `antigravity`, `cline`, `kimi`, `qwen`, `grok`, `copilot`, `pi`, `zed`, `kilocode`, `micode`, `zcode`, `kiro`, `codebuddy`, `workbuddy`, `proma`。

ORGII 的 18 个 importer source：

`claude_code`, `codex`, `cursor_cli`, `cursor_ide`, `opencode`, `cline`, `windsurf`, `warp`, `trae`, `zcode`, `qoder`, `qoder_cli`, `mimo_code`, `omp`, `pi`, `qwen_code`, `kimi`, `workbuddy`。

两边不能只比较数字：

- Cursor CLI 和 Cursor IDE 在 ORGII 是两个独立 source；在 Token Monitor 的列表里是一个 Cursor client。
- ORGII 的 Windsurf、Warp、Trae、Qoder、Qoder CLI、OMP 是额外覆盖。
- ORGII 的 WorkBuddy 路径混入部分 CodeBuddy 语义，不能算完整 CodeBuddy 支持。
- ORGII 的 Antigravity metadata 仍只是 runtime/hook identity，不能算 usage importer。

## NO-SPIKES 硬约束

后续新增 source/provider 必须同时满足：

| 维度 | 硬约束 |
|---|---|
| Idle CPU | 没有 interval scan、目录轮询或周期性 subprocess；无事件时接近 0 |
| Hidden window | 不因 hidden 状态启动网络或 scan；reset refresh 只在 visible 时执行 |
| Network fan-out | 全进程 provider refresh 最多 3 个；同账户 single-flight |
| HTTP memory | 普通 quota body 流式读取，超过 1 MiB 前立即拒绝 |
| Cache state | quota 最多 256 个 account lane；成功 TTL 5 分钟、失败 cooldown 15 秒 |
| Retry | transient 最多重试 1 次；`Retry-After` 最多等待 5 秒 |
| History work | per-source single-flight；continuation page 不 discovery、不 rescan |
| SQLite | source/session/time 条件下推 SQL；不把 lifetime rows 拉到 Rust 再过滤 |
| File import | 先 stat/snapshot，再按 byte watermark 增量；rotation/truncation 才重建单文件 |
| Failure | 保留 last-good；旧 generation 不得覆盖新 credential/new scan |
| Self-sync data | Cursor/Antigravity 自写 cache 永不进入 watcher root |
| Large export | HTTP chunk 直接写 private staging file；aggregate 不保留 event Vec；分页最多 200 events/次 |
| Local scans | 目录、entry、file、parser state、line length 都有硬上限；默认拒绝 symlink traversal |

Cursor billing 已消除三份大对象并存：HTTP chunk 直接写入 private staged CSV，summary 逐行累计，RPC 只返回 aggregate；明细通过 snapshot-bound page 读取。它仍保持显式调用，因为 64 MiB raw export 本身依然是可观 I/O，不应挂到 dashboard interval。

## 19 个 quota provider：逐项比较

| Provider | Token Monitor 做法 | ORGII 当前状态 | NO-SPIKES 决策 |
|---|---|---|---|
| Claude | OAuth usage endpoint；limits runtime cache | 已有 OAuth quota | 保留 ORGII runtime；不加 5 分钟 timer |
| Codex | OAuth usage/rate limit | 已有 OAuth quota | 保留 credential-revision generation guard |
| OpenCode | Go subscription/cookie | 已有 | 保留 stored-account refresh |
| Cursor | dashboard/API quota | 已有；另有 streaming billing CSV aggregate/page | quota 可自动；billing export 仍显式、全局最多 1 个 |
| Copilot | GitHub/Copilot entitlement | 已有 | demand-driven，复用全局 3 并发 |
| ZAI/GLM | API quota windows | 已有 | region/base URL 由 saved key 决定 |
| DeepSeek | 1 GET `/user/balance` | 本轮新增 | 输出精确金额/currency；不伪造 percentage |
| OpenRouter | `/api/v1/key` + `/credits` 两请求 | 本轮只取 `/api/v1/key` | hard limit 可算 meter；无 hard limit 显示 Pay-as-you-go，省掉第二请求 |
| MiniMax | region/新旧 route 最坏可多次尝试 | 本轮新增 | saved base URL 锁区；正常 1 请求，只有窄兼容错误才同区 fallback，最多 2 |
| ZAI Team | 中国区 1 GET；需 key + org + project | 本轮新增 | 固定 endpoint；org/project 纳入 credential revision；稳态 1 请求、无 retry |
| Kimi | Coding API 与 web membership 多入口 | 本轮新增 Kimi Code | 仅接受显式保存且固定为 `api.kimi.com/coding` 的 API account；稳态 1 GET，不探测 cookie 或 web membership |
| Qoder | usage endpoint，可能再取 plan | 本轮新增 | cookie + region 固定；usage 为主，plan 仅缺 label 时串行 fallback；最坏 2 请求 |
| Ollama Cloud | session cookie 抓 settings HTML | 缺失 | 仅显式连接后 refresh；不扫描浏览器 cookie |
| MiMo | web cookie/API，多 managed accounts | 缺失 | 先做单 saved account；禁止启动时枚举所有 managed accounts |
| third-party | NewAPI account/token/custom balance adapter | 缺失 | 很有价值，但必须 allowlist scheme/host/path、1 MiB body、禁止 redirect/SSRF |
| Volcengine | AK/SK 签名 API；也有 Ark probe fallback | 缺失 | 只做 signed `GetCodingPlanUsage`；不通过 chat completion probe 猜 quota |
| Grok | CLI JSON-RPC，失败后 web gRPC fallback | 缺失 | 暂缓自动化；subprocess + fallback 容易出现延迟/CPU spike |
| Kiro | 启动 `kiro-cli chat --no-interactive /usage` | 缺失 | 只允许用户显式触发；20 秒 CLI timeout 不应进入 focus refresh |
| Antigravity | 探测 IDE process/port，再 RPC | 缺失 | 不进入通用 quota refresh；需要独立、显式、严格 timeout 的 adapter |

### 本轮 direct quota 的具体优化

- 共用一个 process-wide HTTP client。
- 12 秒总 deadline、4 秒 connect deadline、每 host 最多 1 个 idle connection、30 秒 idle timeout。
- 禁止 redirect，避免 bearer credential 被转发。
- body 用 `response.chunk()` 读取，每次扩容前执行 1 MiB hard cap。
- DeepSeek 稳态 1 请求。
- OpenRouter 稳态 1 请求，比 Token Monitor 的 key + credits 两请求少一半。
- MiniMax 稳态 1 请求，最坏 2 请求；不跨区探测。
- 新账户不必先有 `quota_info`：后端 `can_refresh_quota` 同时检查 provider route 与所需 credential，UI 可在 focus/manual refresh 时发现首个 quota，也不会请求不完整账户。
- UI refresh pool 最多 3 worker；后端 runtime 再提供全进程 3 并发硬上限。
- focus + visibilitychange 用 50 ms one-shot coalescer 合并；没有 mount-time network，也没有 interval。

## 21 个 usage client：cache 问题与建议

Token Monitor 的共同机制：

- full scan 建 today/month/all-time anchor。
- warm watch tick 只取 today，再用 delta 修正 month/all-time。
- anchor 写入 `collector-anchor.json`；日期或 config fingerprint 变化时失效。
- native watch 优先，只有显式配置或 `ENOSPC`/`EMFILE`/`ENFILE` 才 sticky fallback 到 2 秒 polling。
- scan single-flight、debounce、失败后扩大为 full client refresh、至少每小时 reconcile。

它的共同代价：

- tokscale 大多数 client 会先递归 discovery，再加载全 message cache；日期过滤太晚。
- 除 Codex 外，多数 changed JSONL 会整文件重 parse。
- 冷启动串行启动 today/month/all-time 三个 subprocess。
- subprocess stdout/stderr 会先完整累计为 JS string。

逐 client：

| Client | Token Monitor cache / scan | ORGII 当前状态 | 推荐策略 |
|---|---|---|---|
| Claude Code | projects/transcript JSONL；metadata cache + today anchor | 已有 importer | 保留 SQLite session cache；借鉴 today delta，不引入 full subprocess |
| Codex | JSONL；唯一较完整的 append-offset parser | 已有 importer | 继续使用持久增量 cache |
| OpenCode | shared SQLite | 已有；本轮修复 | 一次 grouped SQL 产出 per-session signature；无关 session 写入不再全失效 |
| Hermes | profile `state.db` | 缺失 | manual/scheduled DB query；不 watch 整个 Hermes home |
| OpenClaw | current + 多套 legacy JSONL，含 archive/deleted | 缺失 | 首版只读 current root；legacy 仅显式 migration |
| Cursor | 远端 sync 写 CSV cache；cache root 不 watch | 本地 CLI/IDE importer + 显式 streaming billing export | 两种 source 不相加；billing 单账户 single-flight、5 分钟 TTL、failure cooldown、全局并发 1 |
| Antigravity | IDE RPC 自写 cache + CLI conversations | 只有 hook identity | IDE sync 仅显式；自写 cache 不 watch；CLI 可独立 importer |
| Cline | VS Code globalStorage task leaves | ORGII 有不同的 Cline CLI/SQLite source | 若补 VS Code，只 discovery 精确 `tasks/*/ui_messages.json` |
| Kimi | Kimi/Kimi Code 双 JSONL root；config 参与 fingerprint | 本轮新增双 layout importer | legacy 与 Kimi Code 共用 watermark；usage 按官方 record stream 增量累计，不复算 `step.end` |
| Qwen | projects JSONL；generic full-message cache | 本轮新增 importer | byte watermark + exact-depth snapshot；`totalTokenCount` 优先，按官方规则回退 candidates/thoughts |
| Grok | updates JSONL，依赖 signals/summary/events siblings | 缺失 | session 打开/手动时 stat dependency set；不递归常驻 watch |
| Copilot | OTel JSONL + Desktop DB + VS Code chatSessions | 缺失 | 双计数和 root 数量高；首版只显式 import 单一路径 |
| Pi | `.pi` + `.omp` JSONL | 本轮新增独立 `.pi/agent/sessions` importer；OMP 保持独立 | header ID 为 canonical identity；独立 `piapp-` namespace，避免与 OMP 冲突 |
| Zed | 单个 `threads.db` + WAL | 缺失 | scheduled/manual SQLite scan；不 watch parent |
| Kilo Code | 多平台 VS Code task leaves | 缺失 | 精确 leaf scan；不扫全部 workspaceStorage |
| MiMo Code | shared DB；默认关闭防 Claude mirror 双算 | 已有 provenance 去 mirror；本轮修复 | per-session signature，保持 provenance suppression |
| ZCode | SQLite + legacy JSONL | 已有 SQLite；本轮修复 | legacy 仅显式 migration；无关 session 写入不失效 |
| Kiro | CLI/IDE/globalStorage/SQLite 混合 | 缺失 | 高风险；只显式 import，不自动 discovery 全树 |
| CodeBuddy | CLI JSONL + extension/Code logs | 部分路径混入 WorkBuddy | 拆 source；Code logs 永不常驻 watch |
| WorkBuddy | JSONL + legacy DB；有 JSONL 时抑制 DB cumulative fallback | 只有 JSONL | 补 session-level suppression，再考虑 DB fallback |
| Proma | JSONL；每次 full read/split；message.id 最大累计值 | 缺失 | byte watermark + bounded pricing cache，禁止 full-file warm scan |

### 永不常驻 watch

- Hermes profile/home root。
- Copilot `workspaceStorage` root。
- CodeBuddy 整个 `Code/logs`。
- Kiro mixed globalStorage/session tree。
- OpenCode、ZCode、MiMo、Zed 等 shared SQLite 的 parent directory。
- Cursor/Antigravity 自己写出的 sync cache。
- WSL home、网络盘和 removable volume。
- Proma root，直到 watermark/rotation 语义完成。

### 只允许显式触发

- Cursor billing export sync。
- Antigravity IDE RPC sync。
- OpenClaw/ZCode legacy migration。
- Copilot/Kiro/CodeBuddy logs 首次导入。
- WSL 全量扫描。
- full graph/history rebuild。
- Kiro/Grok/Antigravity 的 subprocess/process-probe quota。

## 本轮 cache/query 修复

### 1. Usage dashboard：1003 行降到 2 行

旧路径会把 lifetime native rows 跨 SQLite→Rust，再按 source/session/window 过滤。现在：

- 先建立 connection-local scoped-session temp table。
- native/imported SQL 都 join scope，并把 start/end 下推 SQL。
- 新增唯一必要的复合索引 `(session_id, created_at, id)`。
- native round ID 使用稳定 DB row id；imported 使用持久 `seq`，窗口变动不会重新编号。
- 示例回归中 1003 lifetime rows 只有 2 window/source candidates 跨到 Rust。
- 没有新增 cache、timer、worker 或后台队列。

首次打开 usage dashboard 的 headline + 默认展开 trends 也从两次 overview 调用合为一次；request rows 保持 collapsed/lazy。

### 2. OpenCode / ZCode / MiMo：无关 session 不再使全库 cache 失效

旧 signature 把 shared DB/WAL/SHM metadata 合进每个 session，因此任意 session 写入都会让所有 session reparse。

现在一次 grouped SQL 计算全部 session 的 activity：

- `MAX(session.time_updated, part.time_created)`
- `MAX(part.rowid)`
- `SUM(part.data bytes)`
- title/model/token/parent metadata

复杂度是一次 `O(session + part rows)`、内存 `O(session)`，避免逐 session query 在缺 index 时退化到 `O(session × part rows)`。只有目标 session 的 activity 变化才 invalidates 其 cache。

已知边界：长度、rowid、time、token 全不变的原地 JSON 改写仍不可见；正常 append/insert/provider timestamp 更新已覆盖。

### 3. Cursor billing：从 body + Vec + IPC JSON 改为 streaming + page

- HTTP chunk 直接写 private staged CSV，不先累计 response body。
- parser 逐行累计 totals/data-quality/raw-bytes，不 materialize 全量 event Vec。
- raw file 上限 64 MiB；单 record 和 metadata 各有独立上限。
- archive copy 再次执行 raw/metadata hard cap，不能绕过 download 阶段的限制。
- 明细 page 绑定 snapshot，最多 200 events、扫描最多 1000 rows / 约 2 MiB。
- raw/archive 交替 slot；单账户 single-flight、TTL、cooldown、last-good 与 credential fingerprint。
- export/validation 的全局并发从 3 降为 1。

### 4. JSONL watermark 与 Pi：warm path 只读固定 seam + delta

- watermark 保存 file identity、parser version、offset 与末尾 4 KiB seam。
- 同文件增长时只校验 seam 并从 offset 继续；不再重 hash 历史 prefix。
- shrink、rotate、same-size mutation、parser bump、seam mismatch 只冷扫受影响文件。
- 未终止尾行不提交 offset；单行在增长到 1 MiB 前拒绝。
- Pi discovery 固定两层目录，最多 20k dirs / 20k entries per dir / 20k files，不跟随 file/dir symlink。
- Pi parser state 最多 4 MiB JSON、1024 pending edits、4096 touched files；token 使用非负校验和 saturating total。

### 5. Qwen：精确两层 snapshot + 官方 token 语义

- discovery 只允许 `~/.qwen/projects/<project>/chats/*.jsonl`，不递归扫描其他目录。
- cold enumeration 与 warm snapshot reuse 共用 50,000-entry 全局预算；warm snapshot 也不能绕过预算。
- 每批最多 256 files / 64 MiB，单文件最多 64 MiB；round、tool、replay 与 parser state 都有独立硬上限。
- append 只校验 4 KiB seam；恢复顺序为 rounds → watermark → cache signature，避免 cache 标记成功但数据未持久化。
- token 优先采用 Qwen 官方的 `totalTokenCount`；缺失时 candidates 大于 thoughts 则取 candidates，否则取 candidates + thoughts。
- tool response 的 `{ "output": ... }` 正规化为文本，避免把 wrapper JSON 当作对话内容。

### 6. Kimi：双 layout、官方 usage stream 与同步/重放分离

- 只发现 legacy `~/.kimi/sessions/<group>/<session>/wire.jsonl` 和 Kimi Code `<home>/.kimi-code/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl` 两种精确 layout。
- 当前 TOML 与旧 JSON config 都能读取 `default_model`；config 最多 64 KiB，不增加 parser dependency。
- 每个非零 `usage.record` 都增量累计，包括 turn、session 与缺 scope；不复算重复的 `step.end`。legacy cumulative status 只在 `message_id` 内做差值。
- replay 支持 bounded `context.append_message` 与 step/content stream；metadata-only row 不展示，subagent 不成为顶层重复 session。
- 同步阶段不构造 replay 正文，只提取首条 user title；因此 dashboard sync 不为完整 transcript 分配大字符串。
- provider root 和每级 parent 都在 canonical external-history identity 下验证；拒绝 file/dir/root symlink replacement。
- 与 Qwen 共用 50,000-entry cold/warm 全局 snapshot 预算、256 files / 64 MiB batch、64 MiB file 和有界 replay/parser state。
- ORGII 在这里有意不照搬 Token Monitor 的旧 turn-only 判断：当前 Kimi Code 官方实现会 fold 所有 `usage.record`，scope 仅用于 turn/session 分类。

## 仍存在的热点

| 优先级 | 热点 | 当前风险 | 目标 |
|---|---|---|---|
| P0 | Member runtime 对每个 due org 重复 CPU sample、daily rollup/profile | `O(org count)` 同时到期会 spike | 一次 shared sample/rollup，按 org fan-out；stagger deadlines |
| P0 | Key Vault refresh 多次读取/解析 credentials JSON | focus/manual 多账户会重复 file work | store snapshot + mtime/revision，一次 parse 多账户复用 |
| P1 | Spotlight recent paths 绕过 history scan coordinator | 同 source 可与 dashboard 重叠 scan | 所有入口走同一 per-source lane/generation |
| P1 | External replay probe 用 full `SUM(length(...))` | 每 5 秒可能扫累计数据 | 写入时维护 aggregate/version，probe O(1) |
| P1 | Usage overview frontend in-flight map 容量满时可能逐出 active promise | duplicate backend work / waiter 增长 | active entries 不逐出；bounded waiter/coalescing |
| P1 | 15 个 source 初次启动都立即 due | cold-start I/O burst | demand priority + deterministic jitter + one scan worker |
| P2 | CLI/provider detection 在多个 surface 重复 | 重复 stat/process work | process-wide snapshot，事件/TTL invalidation |
| P2 | Kimi replay 尚未还原 tool result、undo/clear 与 compaction 语义 | transcript 是有界 append-history view，不是完整交互状态机 | 分别设计有界事件模型；不能以全量 materialization 换 fidelity |

## Top 15 执行状态

按“峰值下降 × 覆盖收益 ÷ 实现风险”排序：

1. **完成** — Cursor billing 改为 streaming parse + aggregate/page，取消大 Vec/大 IPC payload；为了避免引入常驻 DB/cache，本轮 page 直接从 bounded snapshot 流读。
2. **完成** — 建立 JSONL directory snapshot + byte watermark + rotation/truncation pipeline；append 只校验 4 KiB seam，不重 hash 旧 prefix。
3. **部分完成** — quota runtime 已有 credential fingerprint/generation guard；credentials store 的跨账户单次 parse snapshot 尚未完成。
4. **未完成** — Member runtime shared sample/rollup/profile 与 stagger deadlines。
5. **部分完成** — dashboard/history commands 已接 process-wide coordinator；Spotlight recent-paths 仍需统一。
6. **未完成** — External replay 写入时 O(1) aggregate/version。
7. **未完成** — usage overview active-promise 不驱逐与 waiter 硬上限。
8. **部分完成** — 各 source 已有 single-flight 与 continuation no-rescan；全 source cold-start priority/jitter/单 worker 尚未统一。
9. **未完成** — WorkBuddy/CodeBuddy source 拆分与 DB fallback suppression。
10. **完成** — ZAI Team quota：固定 endpoint、单请求、显式 org/project credentials。
11. **完成** — Kimi Code quota 与 Kimi/Kimi Code importer；quota 固定单 route/单 GET，history 双 layout 但无全树扫描。
12. **完成** — Pi 与 Qwen importer 都复用 watermark；Qwen cold/warm snapshot 共用全局 entry budget。
13. **按用户范围暂缓** — Proma importer；本轮不设计、不实现、不进入下一步排期。
14. **部分完成** — Qoder quota 完成；Ollama quota 尚未接入。
15. **未完成** — OpenClaw current-format 与 Hermes SQLite importer。

Grok、Kiro、Antigravity、Copilot mixed-source 和 Volcengine probe 不在这批自动化优先级里，因为它们会引入 subprocess、process scan、多 root discovery、多路 fallback 或重复计数风险。

## 已完成与未完成

### 已完成

- Cursor 精确 billing CSV parser、data quality、account/credential isolation、atomic `0600` last-good、5 分钟 success/failure throttle、最多 3 个 export。
- Process-wide quota runtime：per-account single-flight、5 分钟 success TTL、15 秒 failure cooldown、force、最多 3 并发、一次 transient retry、LRU 256、last-good/status、credential generation guard。
- Direct quota Wave 2：DeepSeek、OpenRouter、MiniMax。
- Exact monetary balance wire type/UI；unknown quota 不伪装为 0%。
- Backend quota capability + 首次 quota discovery。
- UI refresh worker pool、focus/visibility coalescing、visible reset-boundary one-shot。
- Process-wide history scan coordinator、generation guard。
- Usage initial overview 合并。
- Usage round SQL source/session/time pushdown、稳定 ID、复合索引。
- OpenCode/ZCode/MiMo per-session SQLite activity signature。
- ZAI Team 单请求 quota 与完整 org/project credential revision。
- Qoder 固定区/cookie quota；稳态 1 请求、plan label 缺失时最多 1 次串行 fallback。
- Kimi Code 固定官方 coding route quota；稳态 1 GET，不扫描 cookie、不尝试 web membership fallback。
- Cursor billing streaming download、row aggregate、snapshot paging、raw/archive slot 与全局并发 1。
- 通用 JSONL 固定 seam watermark、rotation/truncation/parser-version invalidation 与 1 MiB line cap。
- Pi 精确两层 discovery、独立 namespace、增量 cache、scan/parser-state 硬上限与 symlink deny。
- Qwen 精确两层 discovery、cold/warm 全局 snapshot budget、官方 token fallback、bounded replay/tool normalization。
- Kimi legacy/Kimi Code 双 layout、官方 usage-record 累计、sync/replay 分离、canonical root/parent 验证与独立 imported namespace。

### 未完成

- 还差 7 个 Token Monitor quota provider。
- 还差 10 个 Token Monitor usage client 的完整 importer；Proma 按当前用户范围暂缓。
- Cursor billing 未接 dashboard；即使已 streaming 化，64 MiB raw export 仍应保持显式调用。
- Cursor 本地 transcript 仍无法可靠提供 output/cache-read/cache-write/cost；billing 与 local context 也尚无安全 session join key。
- quota last-good/attempt freshness 有 API，但 UI 还没完整展示 stale/error 状态。
- 不是所有 credential delete/update 路径都已证明会精准 archive/invalidate 对应 cache。
- 没有真实 credential 的 live endpoint verification。
- 没有 WebView/runtime profile；当前性能证据来自调用次数、查询计划、候选行数、边界测试与静态生命周期审计。

## 验证

- Frontend focused tests：16 passed。
- ESLint（#611/#614 与 Cursor 变更文件）：passed。
- TypeScript：#611/#614 完整 typecheck passed；#618 本地 2 GiB 限额下 OOM，未提高到仓库 6 GiB，GitHub `check` passed。
- Key Vault lib：#611 为 317 passed；ZAI Team stack 为 324 passed；Qoder stack 为 331 passed。
- Direct quota/provider/runtime/export focused tests：通过。
- Usage dashboard：23 passed。
- OpenCode/ZCode/MiMo cache invalidation：3 passed。
- Session persistence schema/index targeted test：passed。
- Cursor streaming/export focused：13 passed；`cargo check -p org2` passed。
- JSONL watermark：9 passed；Pi focused：5 passed；`orgtrack_core` full：460 passed、7 ignored。
- Qwen importer：11 focused passed；snapshot 9 passed、1 ignored；router、desktop loader、identity、CLI contract 与 frontend 12 tests passed。
- Kimi importer：12 focused passed；snapshot 9 passed、1 ignored；router、desktop loader、identity、CLI contract 与 frontend 12 tests passed。
- Kimi quota/provider focused tests passed；固定 route、single request、base URL 与 body/parser 边界均有覆盖。
- Cargo 全程最终验证使用 `CARGO_BUILD_JOBS=1`；未并行编译。
- 没有运行全仓 workspace/typecheck、真实 home scan、Windows path 或 live credential 验证，避免制造 CPU/RAM spike；这些未验证路径已保留在各 PR risks。
- #611/#614 Ready 且全 CI 通过；新增实现保持小职责 stacked Draft。#622/#625 的当前 GitHub check 通过；#623 当前没有发布 status context。

## 主要代码位置

Token Monitor：

- `src/shared/clientTracking.js`
- `src/shared/collector.js`
- `src/shared/limitsRuntime.js`
- `src/shared/limitCollector.js`
- `src/shared/*Limits.js`
- `tokscale@4.7.0`

ORGII：

- `src-tauri/crates/key-vault/src/quota_runtime.rs`
- `src-tauri/crates/key-vault/src/providers/quota_http.rs`
- `src-tauri/crates/key-vault/src/providers/{deepseek,openrouter,minimax}.rs`
- `src-tauri/crates/key-vault/src/providers/{zai_team,qoder}.rs`
- `src-tauri/crates/key-vault/src/providers/kimi.rs`
- `src-tauri/crates/key-vault/src/providers/cursor/usage_export.rs`
- `src-tauri/crates/orgtrack-core/src/sources/imported_history/watermark.rs`
- `src-tauri/crates/orgtrack-core/src/sources/pi/`
- `src-tauri/crates/orgtrack-core/src/sources/qwen_code/`
- `src-tauri/crates/orgtrack-core/src/sources/kimi/`
- `src-tauri/crates/orgtrack-core/src/sources/imported_history/`
- `src-tauri/crates/orgtrack-core/src/usage_dashboard/rounds.rs`
- `src-tauri/src/orgtrack/history_scan_coordinator.rs`
- `src/engines/ChatPanel/StartPageQuotaGrid.tsx`
- `src/modules/shared/dataSource/SessionUsagePanel.tsx`
