# ORG2 Cloud 可扩展性审计 — 2026-07-23

Branch: `codex/reclaim-cloud-realtime-connections` (rebased onto develop `a14bb4def`, epic commit `fd41d508c`).
三个独立审计（服务端 schema / 客户端用量 / realtime 租约对抗审查）的完整报告见同目录三个文件；本文件是合并后的优先级视图。

## 高杠杆修复排序（合并三方结论）

> **进度 2026-07-23 晚**：客户端 P0 1–5 已全部落地在本分支（`d344f3b06` 租约宽限期+hash 种子、`d5850cd40` 断连门控+评论 force+抖动+hidden outbound、`ea3344388` 全量 listing 收敛到活跃 org、`bd0b444f4` 下拉滚动条样式冲突）。服务端 P0 的 0001 就地编辑 + 线上 delta 正在起草，验证基建（disposable Postgres + A/B 协议冒烟）已就绪。
> 另：早前的「侧栏 roster 3 vs 7」已定性为纯 UI 裁剪问题（数据管线健康），见 branch 记忆。
>
> **进度 2026-07-24**：服务端 P0 1–4 已通过 cloud-infra `0003_scalability_p0.sql` 上线并零漂移核验；P0 5 的事件分页由用户的 `0002_bounded_session_event_pages.sql` 覆盖。后续批 `0004_roster_and_listing_scalability.sql`（cloud-infra `a45adcd`，待线上粘贴）一次性收编：B1 批量 entitlement、C2 sessions keyset 分页、H3 collab-state 统一 cursor 分页 + tombstone GC、M1 工作项稳态编辑不再锁 project 行、M4 评论 `p_since` delta、L2 bookkeeping GC。客户端配套（entitlement 种子 + sessions/collab 分页走查，全部向后兼容 PGRST202 回落）在 PR #509。仍未动的平台级方向：Broadcast-from-Database（H4）、Storage payload 外移（H5）——各需独立迁移与客户端订阅重写；`org_change_signals` 去抖后仍是 org 内写串行点（C1 残余）。

### P0 — 客户端（本分支范围内可修）

1. **租约释放加宽限期（30–60s）**：blur 立即释放改为延迟释放（hidden/pagehide 仍立即释放），refocus 取消定时器。消灭 alt-tab 级别的整套 socket 拆建 + 恢复风暴（~9 RPC/次，含 2–3 个全量 listing），同时保留 peak-connection 计费收益，并顺带修复 presence 「viewer chip 每次失焦消失」的回归（旧代码注释里明确记录过这个教训）。
2. **元数据 hash 种子永不匹配 bug**：`seedFromRemoteSummary` 存的是 stripped-payload hash，`upsertMetadataIfChanged` 比的是 full-payload hash（含 `id`/`ownerMemberId`）→ 每次重启对每个已推送 session 重发一次字节相同的 `cloud_upsert_session_metadata` + 广播。一行级修复：种子时额外存 full-payload hash。
3. **断连时长门控恢复**：SUBSCRIBED 边沿记录断连时长，< 阈值（如 5min）走 delta（serverCursor 都在），只有长断连才走全量 listing + 免 TTL 的 comments 强制刷新（30s TTL 会吞掉短暂失焦期间错过的评论——已确认路径）。
4. **重试加 jitter**：supabase-js `reconnectAfterMs` 无抖动 + `fetchWithTransportRetry` 零延迟立即重发 + comments 10s 平坦无上限错误循环 + `online` 全 org 全量 → 灾后惊群。全部加随机抖动/指数退避。
5. **隐藏窗口停推**：设计声称 hidden 继续推，代码里 `scheduleActivityPass`/projects outbox 都被 hidden 门拦住 → agent 跑一小时任务队友看不到任何进度。修法：turn-terminal 和 outbox-write 这两个具体事件即使 hidden 也触发一次 pass（仍然是事件驱动，不是轮询）。

### P0 — 服务端（cloud-infra 仓库）

1. **`org_change_signals` 单行热点**：per-org 单行 + FOR EACH ROW 触发器 + append 路径双写 `cloud_sessions` → org 内所有写互相串行、每次 push 两条 realtime 广播。改 statement-level 触发器 + 250ms 去抖 + 消掉 quota 函数里的第二次 update。
2. **`cloud_list_org_sessions` 无界 + per-row LATERAL 评论计数**：付费 org 无保留窗，全量拉取扫全史 + 每行评论 COUNT。加 keyset 分页（`(org_id, updated_at)` 索引已在）+ 把评论计数物化成 `cloud_sessions` 列。
3. **`enforce_stored_bytes_quota` O(N) 扫描**：每次 segment push 求和整个 org 的全部 session 行。改增量维护的字节计数器 + 夜间对账。
4. **`usage_monthly` ↔ signal 行锁序倒置**：新建 session（A→B）与 push（B→A）并发即 40P01 死锁窗口。一行重排修复。
5. **`cloud_get_session_events` 单值返回整个 replay** + segment 存 Postgres base64 text（+33%）且 team 计划 100GB 配额 → 按 seq 分页 + 中期把 payload 移到 Storage。

### 平台配额（最先撞到的墙）

- Realtime `postgres_changes` 对每 change × 每 subscriber 做 RLS 评估，且全部 org 共享一个 signals 表的单线程 WAL poller；20 人 org × 2k 写/天 ≈ 2.4M msg/月，先于任何 Postgres 瓶颈撞上 message 配额。**方向：迁移到 Broadcast from Database（join 时鉴权一次）**。
- 计费维度已核实：连接按 billing cycle 的峰值并发（Pro 含 500，$10/1000 超额），消息 $2.50/M 超 5M。租约在连接维度的收益是真实的；宽限期方案两头都保。

## 双机冒烟实测发现（2026-07-23）

- 双实例构建走 `pnpm run tauri:build:fast:dual`（同 repo 双身份、独立 target，产物都在 `src-tauri/target/dev-build/bundle/macos/`）。
- 租约 acquire 侧验证通过：instance 2 聚焦 + 云 org scope → `realtime: subscribed inbound planes` 即时出现。
- **未决 bug（待 A/B develop 构建定位）**：instance 1 boot 后侧栏 org selector 只显示 3 个 0720 时代的云 org（服务端 `list_my_orgs` 实际返回 7 个）；管理 ORG 页自己的 picker 拉到全部 7 个，但侧栏 selector 在其 refetch 后依旧 3 个 → roster 陈旧且写不进侧栏读取的状态（疑似双 jotai store 或 boot 竞态）。instance 2 重新登录后 roster 正常。
- instance 2 的 refresh token 过期（400）后，用 `tests/e2e/.env` 的 service key 走 admin magiclink → `orgii-instance2://auth/callback#...` deep link 注入恢复登录，无需 GitHub OAuth。
