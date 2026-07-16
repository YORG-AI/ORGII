# ORG-II ↔ Feishu 联动优化任务（6项 + opus-4.6）

分支：`simon/orgii-fork`。容器 `orgii-app`（已常驻，Up）内 build 验证。

## 🚫 硬约束（违反即失败）

- 不改动与本任务无关的功能；最小改动原则。
- 不引入新依赖除非必要（必要时先在 commit message 说明理由）。
- 飞书发文件/图片走飞书 API（已有 codec/api.rs），不要绕路。
- 每完成一项，单独 commit，message 用 `feat(E#): ...` 或 `fix(E#): ...`。
- 不删除现有测试；新功能补单测。
- 容器内 build：`docker exec orgii-app bash -lc 'cd /work/src-tauri && cargo build 2>&1 | tail -30'`（仅编译 agent-core/相关 crate 即可，全量太慢时用 `-p agent-core`）。
- 前端改动后 webpack dev server 会热重载（容器内 :1998）。

## 工作流程

**先调研产出 PLAN.md（每项落点+改法），再逐项实现。** 不要一上来就写代码。

---

## ① 飞书 session 在 GUI 侧边栏可见

- 现状：session schema 已有 `session_type`/`channel`/`chat_id`/`project_id` 列（见 `src-tauri/crates/agent-core/src/core/session/persistence/crud/record.rs`），飞书 session 已落库，但侧边栏不显示。
- 落点：`src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/`（menuSectionBuilders / sessionGroupHelpers / menuItemBuilders）。
- 目标：侧边栏新增 "Channels"（或 "飞书"）分组，列出 channel-originated（`session_type` = channel）的 session，可点进去查看/续接对话。i18n 各语言补 key（至少 zh/en）。
- 验证：飞书来一条消息后，刷新侧边栏能看到该 session。

## ② 飞书对话 → Work Item 联动（轻量方案 A）

- 不自动创建。让飞书 channel 跑的 agent **能自主调用** work item 工具。
- 落点：work item 工具已存在（`src-tauri/crates/agent-core/src/core/tools/impls/project/manage_work_item.rs`，tool name 见 `tools/names`）。检查飞书 channel 绑定的 agent 是否已具备 ManagementCapability / work item 工具；没有则补上。
- **要求：工具/命令名简短**。如果现有 tool name 冗长，加一个简短别名（如 `wi` 或 `task`）。
- 验证：飞书里让 agent "建个 work item 记录 xxx"，能成功创建并在 GUI 项目里看到。

## ③ 附件双向收发（飞书 ↔ workspace）

- 发：workspace/agent 产物（图片/文件）→ 飞书，做成 channel 原生 outbound（参考 `api.rs` 已有发送能力 + codec）。
- 收：飞书发来的图片/文件 → 下载到 session workspace，agent 可访问。
- 落点：`integrations/channels/feishu/{api.rs,codec.rs,event.rs,channel.rs}`。
- 验证：双向各跑通一次。

## ④ WS 重连健壮性

- 已知 bug（实测）：暂停/恢复后 reconnecting 状态卡住，不真重连，需重启 org2。
- 落点：`integrations/channels/feishu/ws.rs`（已有 initial ping 修复 commit a8c378d3）。
- 改法：指数退避重连 + 暂停恢复（如系统 resume / 长时间无 pong）后强制销毁旧连接重建；reconnecting 状态加超时兜底，超时强制 reset。
- 验证：模拟断连/卡死后能自动恢复（可在测试里模拟，或说明手动验证步骤）。

## ⑤ 跨 channel learnings 融合

- 先**验证**：learnings recall 检索是否已跨 session_type 统一（飞书 session 产生的 learnings 与本地 GUI session 的 learnings 是否互相可被检索/引用）。
- 落点：`src-tauri/crates/agent-core/src/core/definitions/learnings_lookup.rs` + embeddings/rerank（B1 已接 qwen3 本地 embedding 127.0.0.1:9876 / rerank :9877）。
- 若已统一：在 PLAN.md 说明证据，无需改。若按 channel/session 隔离了：改成统一检索（仍可带 channel 标签，但不应因 channel 不同而漏检）。
- 验证：飞书产生一条 learning，本地 session 能 recall 到（反之亦然）。

## ⑥ GUI 监控面板（quota / cost / context）

- 数据源：E3/E5 ops 脚本已迁移（见 commit af10dc81，`integrations/ops` 或 ops tools）。ZenMux quota 通过 management API；session cost 来自 `session_token_usage` 表（状态栏 A1 已用，见 `core/session/status_bar.rs`）。
- 目标：GUI 里一个小面板/卡片展示：ZenMux 5h/7d quota %、PAYG 余额、当前 session 的 token/cost、context 占用。
- 落点：前端新增组件 + 后端 tauri command 暴露数据（若 ops 已有 command 直接复用）。
- 验证：面板能显示真实数字（哪怕轮询刷新）。

## opus-4.6 模型支持

- `model_capabilities.rs` 的 `claude-opus-4` pattern 已覆盖 4.6/4.7/4.8 能力 → capabilities 无需改。
- 需确认：GUI 模型选择列表能否选到 `claude-opus-4.6`。检查模型列表来源（`src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette/sourceItems.tsx` 及后端 key-vault/anthropic provider 暴露的 model 列表）。
- 若列表是动态从 provider 拉的且 opus-4.6 已在内 → 无需改，PLAN.md 说明。
- 若是静态列表 → 把 `claude-opus-4.6` 加进去。
- 注意 ZenMux 的 `:anthropic` slug 习惯（见 clawd/TOOLS.md），但本任务是 ORG-II 原生 anthropic provider，按 ORG-II 既有约定来。
- 验证：GUI 能选中 opus-4.6 并成功发一条消息。

---

## 交付

1. `PLAN.md`（每项落点+改法+验证结论）
2. 逐项 commit 实现
3. 容器内 build 通过
4. 最后写 `RESULT.md`：每项做了什么、改了哪些文件、怎么验证、还剩什么没验证。
