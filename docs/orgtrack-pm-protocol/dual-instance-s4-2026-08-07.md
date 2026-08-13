# 双机实测 — S4 工具退役（PR #737，2026-08-07）

双机协议（`.orgii/skills/dual-instance-verification/SKILL.md`）对 S4（typed 工具删除 → org2-pm CLI 唯一 agent 入口）的实测记录。发送端 instance-1 = 本分支 debug 构建（webdriver feature，真实 `~/.orgii`），接收端 instance-2 = 旧构建（ORGII-instance2，未动）。

## Cell 结果

| Cell | 内容                                                                                                | 结果                                                                                                                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | filler-via-CLI：真实 Create-with-AI 渲染 UI + deepseek-v4-flash 真 LLM 轮次（wdio，隔离 live home） | **GREEN**（13.3s）。transcript：`work show --standalone` → `work update --title … --body …` → `work show` 复核，exit code 全 0；store 标题/正文逐字一致；audit `work.create → work.patch(app) → work.patch:agent:os`；会话行 `org=bfa7b134 / build / project`                                                                   |
| B    | 双机 collab 同步：CLI 跨进程写共享 org "CU New Target 0720"                                         | **GREEN**。`WI-0013` CLI create+update → workitems 落库 → outbox 行 → watermark(2s poller) → `orgii-data-changed` → forceProjects → 云 `cloud_work_items` 行（rev2 标题，两次写合并推送）→ instance-2 拉取到本地。JWT 过期一度阻塞（GoTrue 多 client 竞态,自愈）；两端窗口失焦时按 minimize-aware 设计不推/不拉，置前后立即走通 |
| C    | 子代理 root-walk：真实 `builtin:general` delegation 跑 `org2-pm context`                            | **GREEN**。envelope `sessionRef = 顶层父会话`，exit 0。C-lite 三姿势（身份匹配 / 子会话 env 冒充 / human 冒充）分别 OK / PERMISSION_DENIED / PERMISSION_DENIED                                                                                                                                                                  |
| D    | 舰队账本（cloud_sessions 全量 1365→1368 行）                                                        | boot-1 出现 bfa7b134 org 全量 claudecodeapp epoch+1 波 + 2 行 `deleted_at→None` 复活；**boot-2 确定性 cell：0 增删、0 epoch 变**，仅本会话转录与一个活跃 codex 会话单调增长 → 定性为升级重锚定（旧 0829a9b 构建 → develop+737 序列化差异）恰好一次收敛                                                                          |
| E    | 破坏性动词审计（两实例日志，boot 窗口）                                                             | 干净：仅 disabled-tool 跳过日志与临时 scratchpad housekeeping 两条良性命中                                                                                                                                                                                                                                                      |

## 实测挖出并已修（全部进 #737）

1. **Ask/Plan 拒 shell → filler 填不了**：agent 连搜 15 次 `run_shell` 后放弃（"能动 WorkItem⟺有 shell" 未决假设第一次爆雷）。修：filler 与 Create-Project-with-AI 启动 pin `agentExecMode:"build"`（`97f67fa3e`）
2. **filler 会话不带 org → ORGII_ORG 不注入 → org-standalone 草稿 CLI 找不到**。修：launch 顶层带 `orgId`（同上）
3. **standalone 分配器按 org 计数 vs id 全局主键**：真实 home 上 `WI-0001` 跨 org 碰撞被 S0 create 守卫拦下（旧代码是静默覆盖他 org 条目）。修：分配器跳过全局占用 id（`202185e6a`）
4. **standalone patch 审计 actor 为空**。修：actor 线穿 `update_standalone_work_item_atomic_by`（`09a8e8b9a`）
5. e2e spec 三处修复（Harry launchpad 改版死 selector / org-aware 扫描 + 抖动稳定 / `readProjectOrgs` helper 注册）（`97f67fa3e` + `835d6cf19`）

## 追加发现（2026-08-07 晚,用户真机·bundled 构建）

**P0 — bundle 不带 org2-pm**：`externalBin: []`,.app 只装主二进制;PATH prepend 指向 exe 目录但 CLI 不存在 → 打包构建里 agent 对工作系统零入口（S4 后无 typed 工具兜底）。实测全绿是因为 debug 裸跑恰好同目录。修复：org2-pm 进 `externalBin` sidecar（版本锁定,与"首启下载"类 sidecar 政策区分开）,prepare-sidecars.cjs 接入 tauri:dev/tauri:build/fast-build/release CI 三平台;fast-build 复验 bundle 内 `Contents/MacOS/org2-pm context` 出合法 envelope。

## OPEN（非本 PR，已记录/挂单）

- **session memory side query 钉死 claude-haiku-4.5**：账号无此 model 时提取失败并弹 toast → 已挂单（fallback 到账号可用 model）
- **`gemini_cli` 缺席 `CliAgentTypeSchema`**：sidebar 翻页含 6 月 gemini_cli 会话行时 RPC output validation 失败 → 已挂后台任务修
- **云端删除后本地无 tombstone → 升级重推复活**：boot-1 将当日 16:49Z 云端删除的 2 行 `deleted_at` 复活（机制=本地行仍在、full re-push 重断言；已知"无 tombstone 不可证伪缺席"类；非 737 触发,737 窗口内仅因升级重锚定显形）
- **Projects-channel JWT 过期恢复慢**：多 GoTrueClient 告警 + 过期后至多约一个刷新周期不推；自愈但值得并入 token 单一持有者清理
- UNCOVERED：S3 envelope 卡片的渲染态视觉断言（store/transcript 已证,视觉未截图）；`--schedule-cron` 真机排程触发未跑

## Sub-item 与 Discussion 实测（2026-08-07 深夜，真机·真 Opus）

围绕 sub-item 与 Discussion 机制（`--parent`/`--stage`、"Post exactly ONE comment per run"、turn-end fallback、mention 副作用纪律）落地并实测三轮：

- **机械面**：`work create --parent` / `work note --standalone` / `work list --standalone` 补齐（cli_e2e 覆盖 parent 链接与 note 落 comments）
- **纪律面**：CLI brief 恢复拆分判据（"more than one independently completable step"）+ 恰好一条回执（outcome 不 process）+ blocked 转移；linked-work-item context 增 ⚠️ 交付强制块（"Chat replies are conversation, not delivery"）
- **实测轮次**：WI-0016（无强制块）＝agent 全量产出丢聊天、零 CLI 调用 → 强制块后 WI-0017＝body 填 381 字 + 恰好一条 `[progress]` 回执（Discussion UI 渲染验证）；WI-0018＝**自主拆 3 子项**（WI-0019/20/21 各 600-900 字内容,audit 8 条全带 agent:os）+ 父项闭环总览 + 恰好一条回执
- **Gap（挂单）**：详情页无 Sub-items 区块，parent 关系仅在库中，agent 只能在父 body 手写引用

## 探针清理

`WI-0013` 已在云端打 tombstone（v2, deleted_at 2026-08-07T20:50:30Z），两实例经拉取收敛删除（见任务日志）。隔离 e2e home 与 wdio shard homes 为一次性沙箱已删。真机演示数据 `WI-0015`（rail 探针）与 `WI-0017`~`WI-0021`（纪律探针,bfa7b134 org）留作用户查看,自行处置。
