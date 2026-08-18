# ORG2 Identity & Authentication 人工测试验收

> 对应方案：[`IdentityAuthenticationRearchitecturePlan.md`](./IdentityAuthenticationRearchitecturePlan.md)
>
> 迁移与降级：[`IdentityAuthenticationMigrationAndDowngrade.md`](./IdentityAuthenticationMigrationAndDowngrade.md)
>
> 编制日期：2026-08-18
>
> 适用范围：ORG2 Desktop、ORG2 Cloud、Hosted/GitHub/Agent 独立身份域

本文档用于验收登录重构是否达到以下目标：桌面端本地优先、Cloud 使用系统浏览器完成 Code + PKCE 登录、刷新凭证只由 Rust Identity Broker 持有、各身份域故障互不连坐、账号切换不串数据，并且开发模式不再反复触发 macOS“登录”钥匙串密码弹窗。

本文档既是执行步骤，也是验收记录。测试人员应在每个用例后填写结果，并将失败项关联到缺陷编号。

---

## 0. 当前发布门槛

### 0.1 当前环境状态

截至 2026-08-18，生产 Cloud 的只读探测结果为：

| 检查项                                                            | 当前结果                                   | 结论                                                     |
| ----------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| `GET https://org2-cloud-infra.vercel.app/api/health`              | HTTP 200                                   | Cloud 服务在线                                           |
| `GET https://org2-cloud-infra.vercel.app/api/auth/desktop/config` | HTTP 503，`ORG2_DESKTOP_OAUTH_UNAVAILABLE` | 新桌面 OAuth 尚未开放                                    |
| Desktop `ORGII_IDENTITY_OAUTH` 默认值                             | `disabled`                                 | 普通构建仍走兼容路径                                     |
| Cloud OAuth 服务端代码                                            | 已部署                                     | 仍需配置 Supabase OAuth Server/public client 与客户端 ID |

因此：

- 新 Code + PKCE 登录主流程相关用例当前应记为 `BLOCKED`，不是 `PASS`，也不是产品功能失败。
- 在配置接口返回 HTTP 200 且真实账号冒烟通过前，不得默认开启 `ORGII_IDENTITY_OAUTH`。
- 在新旧版本覆盖率和降级方案完成验收前，不得删除旧 Cloud 登录兼容路径。
- 本地优先、身份域隔离、开发模式无钥匙串弹窗等不依赖生产 OAuth 配置的用例可以先执行。

### 0.2 上线前必须解除的阻塞

- [ ] Supabase OAuth Server 已启用。
- [ ] 已创建 public desktop OAuth client，不存在客户端密钥依赖。
- [ ] authorization path 为 `/oauth/authorize`。
- [ ] 已登记精确回调地址：`https://org2-cloud-infra.vercel.app/auth/desktop/oauth/callback`。
- [ ] Cloud 生产环境已配置 `ORG2_DESKTOP_OAUTH_CLIENT_ID`。
- [ ] 配置接口返回 HTTP 200，且仅包含公开元数据。
- [ ] 使用真实 Cloud 测试账号完成一次端到端 Code + PKCE 冒烟。
- [ ] 观察期内无异常登录失败率、刷新失败率或重复授权峰值。

---

## 1. 验收记录

| 项目                    | 填写                                       |
| ----------------------- | ------------------------------------------ |
| 测试批次编号            | `AUTH-YYYYMMDD-01`                         |
| 测试日期与时区          |                                            |
| 测试人员                |                                            |
| Desktop commit / 构建号 |                                            |
| Cloud commit / 部署 URL |                                            |
| macOS 版本与 CPU 架构   |                                            |
| Windows 版本            |                                            |
| Linux 发行版与桌面环境  |                                            |
| Cloud 测试账号 A        |                                            |
| Cloud 测试账号 B        |                                            |
| Hosted 测试账号         |                                            |
| GitHub / Agent 连接     |                                            |
| 最终结果                | `PASS / CONDITIONAL PASS / FAIL / BLOCKED` |
| 关联缺陷                |                                            |

结果定义：

- `PASS`：步骤全部完成，实际结果与预期一致。
- `FAIL`：环境具备，但行为与预期不一致。
- `BLOCKED`：前置配置、账号或平台不具备，尚未真正执行。
- `N/A`：经产品/技术负责人确认，本发布不包含该路径；必须填写原因。

### 1.1 优先级与签字规则

| 优先级 | 说明                                                | 放行规则                            |
| ------ | --------------------------------------------------- | ----------------------------------- |
| P0     | 安全边界、主登录、刷新、退出、切换与身份域隔离      | 必须全部 PASS；不得豁免             |
| P1     | 重启恢复、离线恢复、多窗口、迁移/降级、主要 UI 状态 | 必须 PASS，或有负责人签字的限时豁免 |
| P2     | 跨平台补充、视觉、键盘与可访问性细节                | 未通过项必须有跟进计划              |

### 1.2 立即停止测试的条件

出现以下任一情况，不要继续操作：

1. 任意 URL、应用路由、日志、事件 payload、localStorage、sessionStorage 或截图中出现 access token、refresh token 或 PKCE verifier；authorization code 出现在桌面应用 URL、日志、持久化存储或截图中。系统浏览器到 Cloud 回调的查询参数可短暂包含一次性 code/state，但不得保存或传播。
2. 从账号 A 切换到账号 B 后仍能看到 A 的私有 Cloud 数据，或 A 的迟到响应写入了 B 的页面。
3. Cloud 的 401/退出导致 Hosted、GitHub、Agent 或本地工作区一并失效。
4. 应用在取消、超时、离线或拒绝授权后无限 loading，30 秒内没有可恢复状态。
5. 正常启动或普通 Cloud 请求反复要求输入 macOS“登录”钥匙串密码。

处理方式：立即退出相关账号，撤销可能泄漏的凭证，保存脱敏证据，并按 P0 缺陷上报。不要复制或发送真实凭证。

---

## 2. 测试环境与数据准备

### 2.1 构建组合

至少覆盖以下两类构建：

| 构建                                     | 用途                       | 预期凭证行为                                           |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------ |
| 开发构建，`ORGII_IDENTITY_OAUTH=enabled` | 调试新 OAuth、状态机与 UI  | 使用进程内凭证；重启后需要重新登录；不应访问系统钥匙串 |
| 签名 Release 构建，测试开关开启          | 验证生产安全存储与重启恢复 | refresh credential 存于系统安全存储；重启后可恢复      |

开发构建示例：

```bash
ORGII_IDENTITY_OAUTH=enabled npm run tauri:dev:light
```

如果开发启动脚本本身失败，应单独记录为开发工具缺陷，不要用“应用登录失败”替代它。

### 2.2 测试账号与数据

- 准备两个独立 Cloud 账号 A、B，且各自拥有容易区分的私有组织或项目。
- 准备一个 Hosted 账号、一条 GitHub 连接和一条 Agent 连接，用于身份域隔离。
- A、B 各创建一条名称带本轮批次号的私有数据，例如 `[AUTH-20260818-01] A-only`。
- 准备一个邀请链接、一个分享链接和一个需要登录后继续的创建组织动作。
- 使用专门的测试浏览器 profile，避免其他 Google/Supabase 会话干扰。
- 迁移用例必须使用可回滚的测试 profile；禁止直接清理同事或真实用户的数据。

### 2.3 证据要求

每个失败用例至少记录：构建号、平台、时间、步骤、期望、实际、状态截图或脱敏日志。证据文件名建议：

```text
AUTH-20260818-01_ID-OAUTH-002_macos_FAIL.png
```

截图前必须检查地址栏和开发者工具；若其中包含凭证，不得保存或上传。

---

## 3. 前置门槛

### PRE-001：Cloud 桌面 OAuth 配置可用（P0）

步骤：

1. 打开 `https://org2-cloud-infra.vercel.app/api/health`。
2. 打开 `https://org2-cloud-infra.vercel.app/api/auth/desktop/config`。
3. 检查响应内容，不要把响应写入公共 issue。

预期：

- [ ] health 返回 HTTP 200。
- [ ] desktop config 返回 HTTP 200，而不是 404/503。
- [ ] 配置版本受支持。
- [ ] authorization/token endpoint 均为预期 HTTPS 地址。
- [ ] redirect URI 精确等于 Cloud 桥接回调地址。
- [ ] scopes 只包含批准的最小集合。
- [ ] client ID 是 public client 标识；响应中没有 client secret、token 或用户信息。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### PRE-002：功能开关与回滚能力（P0）

步骤：

1. 确认普通生产构建的默认开关仍为 `disabled`。
2. 在专用测试构建开启新 OAuth。
3. 确认服务端失败时可以关闭开关并回到兼容路径，不需要重新发布用户数据。

预期：

- [ ] 只有测试构建/测试人群进入新路径。
- [ ] 关闭开关不清除用户本地项目或其他身份域连接。
- [ ] 回滚不要求恢复已经删除的明文凭证文件。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

---

## 4. 状态机验收基线

测试中以 Account Center 和 Cloud 功能的可见行为判断状态，不依赖内部字段：

| 状态             | 用户可见表现                     | 允许操作                       | 禁止表现                            |
| ---------------- | -------------------------------- | ------------------------------ | ----------------------------------- |
| LocalReady       | 本地工作区可用，Cloud 显示未连接 | 本地工作、连接 Cloud           | 全屏强制登录                        |
| CloudOnboarding  | 首次主动进入 Cloud 的单屏介绍    | 连接、暂不并返回本地           | 冷启动自动弹出、阻塞本地 shell      |
| CloudAuthBlocked | Cloud 内容区显示精简登录 Block   | 登录、返回本地、了解详情       | 全局路由跳转、反复播放 Onboarding   |
| SigningIn        | 显示正在等待浏览器授权，可取消   | 取消、返回本地工作             | 重复打开多个授权窗口                |
| Ready            | 显示当前 Cloud 身份与组织        | Cloud 读写、切换、退出         | 向 UI 暴露 refresh token            |
| OfflineDegraded  | 明确显示离线/暂不可连接          | 本地工作、查看允许的缓存、重试 | 未授权 Cloud 写入、自动退出所有账号 |
| ReauthRequired   | 当前 Cloud 连接显示需要重新连接  | 重新连接、退出 Cloud           | 无限自动重试、抹掉其他身份域        |
| Switching        | 显示正在切换，旧账号缓存先清除   | 取消或等待完成                 | A/B 数据同时出现                    |
| SigningOut       | Cloud 动作暂时禁用               | 等待完成                       | 退出后被迟到刷新“复活”              |

---

## 5. P0/P1：Onboarding、本地优先与登录入口

### ID-ONBOARD-001：首次 Cloud Onboarding 只在主动进入时出现（P0）

前置：使用无 Cloud session、无 `cloud_onboarding_version` 的全新测试 profile。

步骤：

1. 冷启动 ORG2，先打开本地项目、终端和本地 Agent。
2. 确认没有 Onboarding 后，主动进入 `设置 → 协作 → Cloud`。
3. 暂不点击任何 Onboarding 按钮。

预期：

- [ ] 冷启动和本地页面不自动显示 Cloud Onboarding。
- [ ] 首次主动进入 Cloud 后，Onboarding 只占用当前 Cloud 内容区域。
- [ ] 单屏内说明同步、协作/分享、本地优先和系统浏览器安全登录。
- [ ] 显示“暂不，继续本地使用”和“连接 ORG2 Cloud”两个清楚动作。
- [ ] 仅展示 Onboarding 不会打开浏览器，也不会被记录为已完成。
- [ ] 侧栏、本地项目和返回操作始终可用。

结果：`PASS / FAIL` 缺陷：\***\*\_\_\*\***

### ID-ONBOARD-002：暂不连接与版本持久化（P1）

步骤：

1. 在首次 Onboarding 点击“暂不，继续本地使用”。
2. 再次进入 Cloud，然后完全重启应用后第三次进入 Cloud。
3. 使用受控测试设置提高 Onboarding 版本，再进入 Cloud。

预期：

- [ ] 点击“暂不”立即返回本地，不发起登录或 Cloud 写入。
- [ ] 当前版本被记录为已确认；再次进入和重启后只显示精简登录 Block。
- [ ] 持久化内容只有版本/时间等非敏感偏好，不含账号、token、invite/share payload。
- [ ] 版本提高后可以显示“新变化”或新版 Onboarding，但不会让已登录用户退出。
- [ ] 清除普通 Cloud session 不会错误清除 Onboarding 版本。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-ONBOARD-003：业务入口使用上下文登录 Block（P0）

步骤：

1. 在未登录状态分别从邀请、分享或创建组织入口进入 Cloud。
2. 观察 Block 文案，点击“登录后继续”。
3. 一次取消登录并重试；另一次完成登录。

预期：

- [ ] 直接显示与原动作相关的精简 Block，不强迫先走多页 Onboarding。
- [ ] 提供“了解 ORG2 Cloud”，用户需要时才展开完整介绍。
- [ ] 取消后原 invite/share/form payload 仍在内存中，且没有执行 Cloud 写入。
- [ ] 成功后原 Sign-in Intent 只恢复一次。
- [ ] 返回本地后应用其他功能保持可用。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-LOCAL-001：未登录冷启动仍可本地工作

前置：清空测试 profile 的 Cloud 登录状态，但保留一个本地项目。

步骤：

1. 完全退出应用后重新启动。
2. 打开本地项目、终端和本地/BYOK Agent。
3. 暂时不点击任何 Cloud 功能。

预期：

- [ ] 应用直接进入本地 shell，不出现全局登录墙或强制登录弹窗。
- [ ] 本地项目、终端和本地 Agent 可用。
- [ ] Cloud 入口清楚显示未连接，但不阻挡其他功能。
- [ ] 启动期间不弹出 macOS 钥匙串密码框。

结果：`PASS / FAIL` 缺陷：\***\*\_\_\*\***

### ID-LOCAL-002：Cloud 动作按需触发登录并可取消

步骤：

1. 在未登录状态点击一个 Cloud 专属动作。
2. 登录开始后关闭浏览器或点击取消。
3. 返回本地项目继续操作。
4. 再次触发同一 Cloud 动作。

预期：

- [ ] 只有 Cloud 动作触发登录。
- [ ] 取消后 30 秒内退出 loading，显示可重试状态。
- [ ] 本地工作未中断，输入内容未丢失。
- [ ] 再次尝试只创建一个新的登录流程。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-LOCAL-003：服务端配置不可用时安全失败

前置：配置接口返回 503，或在测试环境模拟配置不可用。

步骤：开启新 OAuth 测试开关并尝试连接 Cloud。

预期：

- [ ] 显示“Cloud 登录暂不可用/重试”一类可理解提示。
- [ ] 不静默退回到把 token 交给 renderer 的新实现。
- [ ] 不进入无限重试或无限 loading。
- [ ] 本地 shell 和其他身份域保持可用。

结果：`PASS / FAIL` 缺陷：\***\*\_\_\*\***

---

## 6. P0：Code + PKCE 主流程

> 只有 PRE-001 通过后才执行本节。系统浏览器地址栏是安全验收的一部分。

### ID-OAUTH-001：从 Account Center 完成登录

步骤：

1. 从 Account Center 点击“连接 Cloud”。
2. 观察是否打开系统默认浏览器。
3. 使用账号 A 完成授权。
4. 等待浏览器提示返回 ORG2，并切回桌面端。

预期：

- [ ] 使用系统浏览器，不使用内嵌 WebView 登录页。
- [ ] 一次用户动作只打开一个授权页。
- [ ] 浏览器回调 URL 中只能短暂出现 `code` 与 `state`；不得出现 access/refresh token。
- [ ] 桌面 loopback 使用 `127.0.0.1` 随机高位端口和固定回调路径，不占用固定端口。
- [ ] Account Center 最终显示账号 A 和 `Ready`，原 Cloud 动作只恢复一次。
- [ ] 浏览器页面和桌面端都没有无限 loading。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-OAUTH-002：拒绝授权与取消

步骤：

1. 发起登录，在授权页点击拒绝或关闭标签页。
2. 在桌面端取消等待。
3. 立即重新登录并完成授权。

预期：

- [ ] 拒绝/取消被识别为可恢复结果，不污染当前账号。
- [ ] listener、临时端口和 PKCE 上下文被释放。
- [ ] 重试不需要重启应用，且只处理新流程。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-OAUTH-003：错误 state、旧回调与重复回调被拒绝

步骤：

1. 发起一次登录后取消，再发起第二次登录。
2. 使用浏览器后退/刷新尝试重放第一次或已完成的回调。
3. 完成第二次合法授权。

预期：

- [ ] 旧 state、错误 state 和重复 code 不会改变当前会话。
- [ ] 过期流程给出有限错误，不会覆盖新流程。
- [ ] 合法的第二次流程可正常完成。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-OAUTH-004：离线、超时与浏览器启动失败

步骤：

1. 断网后发起登录。
2. 恢复网络并重试。
3. 在另一次尝试中让授权页面停留到超时。

预期：

- [ ] 失败在有限时间内结束，并说明可重试。
- [ ] listener 和端口在失败后释放。
- [ ] 网络恢复后无需重启即可成功重试。
- [ ] 不影响本地工作与其他身份域。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-OAUTH-005：登录进行中重启应用

步骤：发起登录，在浏览器授权前完全退出并重启桌面端，再尝试一次新的登录。

预期：

- [ ] 未完成流程不会在重启后被错误恢复。
- [ ] 旧浏览器回调无法登录新进程。
- [ ] 新登录流程可正常完成，不出现端口占用。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

---

## 7. P0/P1：刷新、离线、退出与重启

### ID-SESSION-001：Release 重启恢复（P1）

前置：使用签名 Release 构建登录账号 A。

步骤：完全退出应用，等待 10 秒后重新启动，然后访问一个 Cloud 页面。

预期：

- [ ] 不需要再次打开浏览器即可恢复账号 A。
- [ ] renderer、URL 和日志中没有 refresh token。
- [ ] 若安全存储暂时不可用，显示明确修复入口，而不是静默写入明文文件。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-SESSION-002：开发构建重启符合进程内凭证语义（P1）

步骤：在开发构建登录，连续完全重启应用 3 次。

预期：

- [ ] 每次重启后 Cloud 需要重新登录，这是开发模式的预期行为。
- [ ] 三次启动均不请求“登录”钥匙串密码。
- [ ] 本地项目和其他连接未被清除。

结果：`PASS / FAIL` 缺陷：\***\*\_\_\*\***

### ID-SESSION-003：过期后的并发请求只触发一次刷新（P0）

前置：使用可缩短 TTL 的测试环境，或等待 access lease 到期。

步骤：同时触发刷新 Cloud 列表、打开详情、提交一个允许的写操作等多个请求。

预期：

- [ ] 用户只看到一次短暂恢复/加载，不需要多次重新登录。
- [ ] 全部调用使用同一轮刷新结果完成。
- [ ] 不出现部分请求使用旧账号或旧 token 的情况。
- [ ] 日志中的刷新次数为 1；日志本身不包含凭证。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-SESSION-004：瞬时刷新失败进入 OfflineDegraded（P0）

步骤：保持账号 A 登录，断网后触发 Cloud 请求；观察状态，再恢复网络并聚焦应用。

预期：

- [ ] 显示离线/暂不可用状态，允许继续本地工作。
- [ ] 允许的只读缓存仍可查看，Cloud 写操作被禁用或明确排队策略。
- [ ] 不删除现有 credential，不自动退出账号。
- [ ] 恢复网络后通过重试/聚焦回到 Ready。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-SESSION-005：凭证被拒绝只进入 ReauthRequired（P0）

前置：在服务端撤销账号 A 的 refresh credential，或使用专用故障注入。

步骤：触发刷新，然后从原 Cloud 动作点击“重新连接”。

预期：

- [ ] Cloud 显示 ReauthRequired，不无限自动刷新。
- [ ] 账号元数据保留，便于用户理解哪条连接失效。
- [ ] 重新登录成功后，原安全意图只恢复一次。
- [ ] Hosted、GitHub、Agent 和本地工作不受影响。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-SESSION-006：刷新过程中退出不会复活会话（P0）

步骤：在一次慢刷新进行中点击退出 Cloud，等待慢请求完成，然后重开 Cloud 页面。

预期：

- [ ] 退出完成后状态保持未连接。
- [ ] 迟到刷新结果被 generation/CAS 拒绝，不写回凭证或 UI。
- [ ] 仅 Cloud credential 被删除。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

---

## 8. P0：登录后恢复原操作（Sign-in Intent）

对下列入口分别执行一次：邀请链接、分享链接、创建组织、打开受保护 Cloud 路由。

### ID-INTENT-001：安全意图恢复

步骤：

1. 在未登录状态触发目标动作，记录输入内容。
2. 完成登录。
3. 观察返回页面和动作执行次数。

预期：

- [ ] 登录后回到原动作，而不是统一跳到首页。
- [ ] 输入 payload 在本次流程内保留，不通过 URL 携带 token。
- [ ] 动作只执行一次，刷新页面不会重复提交。
- [ ] 外部 URL、未知 route 或过期意图被安全拒绝并回到可理解页面。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-INTENT-002：取消后保留可恢复上下文

步骤：在有未提交输入的 Cloud 动作中触发登录，然后取消；再次点击继续。

预期：

- [ ] 取消不会丢失用户本次输入。
- [ ] 不会在未授权状态执行 Cloud 写入。
- [ ] 再次完成登录后只提交一次。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

---

## 9. P0：账号切换与缓存隔离

### ID-SWITCH-001：A 切换到 B 不串数据

前置：账号 A、B 各有独立私有数据。

步骤：

1. 登录 A，打开 A-only 数据，并开始一个故意变慢的 A 请求。
2. 从 Account Center 切换到 B。
3. 在切换期间和完成后观察列表、详情、缓存和通知。
4. 等待原 A 慢请求返回。

预期：

- [ ] 切换开始时先清除/隔离 A 的账号作用域缓存，再展示 B 数据。
- [ ] 任意时刻都不会把 A 私有数据标成 B 的数据。
- [ ] A 的迟到响应被拒绝，不能写入 B 的状态。
- [ ] B 登录完成后只看到 B 有权访问的数据。
- [ ] endpoint、org、account 变化均触发新的 generation/cache key。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-SWITCH-002：取消或失败保持旧账号一致

步骤：从 A 发起切换到 B，在浏览器取消授权或模拟失败。

预期：

- [ ] A 保持可用，或进入明确的未连接状态；不得出现“头像是 B、数据是 A”的混合状态。
- [ ] 再次切换可以成功。
- [ ] 不产生重复账号记录。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

---

## 10. P0：身份域故障隔离

按表逐行测试。每次只让一个身份域返回 401/撤销凭证，然后验证其他列。

| 用例         | 故障域 | 预期该域        | Cloud | Hosted | GitHub | Agent | 本地项目 | 结果 |
| ------------ | ------ | --------------- | ----- | ------ | ------ | ----- | -------- | ---- |
| ID-REALM-001 | Cloud  | ReauthRequired  | 失效  | 保持   | 保持   | 保持  | 保持     |      |
| ID-REALM-002 | Hosted | 仅 Hosted 重连  | 保持  | 失效   | 保持   | 保持  | 保持     |      |
| ID-REALM-003 | GitHub | 仅 GitHub 重连  | 保持  | 保持   | 失效   | 保持  | 保持     |      |
| ID-REALM-004 | Agent  | 仅该 Agent 重连 | 保持  | 保持   | 保持   | 失效  | 保持     |      |

每行共同预期：

- [ ] 错误被归属到正确 provider/realm/endpoint。
- [ ] 不执行全局 `logout` 或清空所有 credential。
- [ ] 未故障域正在进行的任务不中断。
- [ ] 修复入口位于对应连接，而不是全局登录弹窗。

任一非故障域被退出，整项按 P0 FAIL 处理。

---

## 11. P1：Account Center 与交互状态

### ID-ACCOUNT-001：统一账号状态与操作

步骤：依次查看未连接、登录中、Ready、OfflineDegraded、ReauthRequired、切换中和退出中的 Account Center。

预期：

- [ ] 每条连接显示 provider、身份、endpoint/环境和当前状态。
- [ ] 只显示适用于该状态的连接、重新连接、切换、退出动作。
- [ ] 提交期间按钮 loading/disabled，连续点击不会重复操作。
- [ ] Reauth 使用独立登录意图，不伪装成“重命名账号”。
- [ ] 错误提示可操作，重试不会生成重复会话。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-ACCOUNT-002：视觉、键盘与可访问性（P2）

覆盖浅色/深色主题、窄窗口、200% 缩放、中文/英文、仅键盘操作。

预期：

- [ ] 状态、按钮和错误文本不截断、不重叠。
- [ ] 焦点顺序合理，Enter/Space/Escape 行为符合预期。
- [ ] loading、错误和成功不只依赖颜色表达。
- [ ] 屏幕阅读器能读出连接名称、状态和按钮用途。

结果：`PASS / FAIL / N/A` 缺陷：\***\*\_\_\*\***

---

## 12. P0/P1：钥匙串与安全存储

### ID-STORE-001：开发模式不触发 macOS 钥匙串（P0）

步骤：使用开发构建登录/退出 Cloud，并连续重启 3 次；每次进行数个 Cloud 与本地操作。

预期：

- [ ] 全过程不出现“ORG2 想要使用你储存在钥匙串中的机密信息”弹窗。
- [ ] Activity Monitor 中没有因 ORG2 反复唤起的 SecurityAgent 异常。
- [ ] 重启后需要重新登录符合 MemoryCredentialStore 设计。

结果：`PASS / FAIL` 缺陷：\***\*\_\_\*\***

### ID-STORE-002：Release 安全存储与正常重启（P0）

步骤：在签名 Release 中首次登录，允许一次合理的系统授权；随后正常退出/启动 3 次。

预期：

- [ ] credential 持久化到平台安全存储，不写入 renderer storage 或明文 JSON。
- [ ] 普通重启不反复要求输入系统钥匙串密码。
- [ ] 退出 Cloud 后对应 Cloud credential 被删除，其他 provider 保留。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-STORE-003：安全存储锁定或不可用（P1）

前置：使用测试 profile 模拟 keychain/credential manager/secret service 不可用。

预期：

- [ ] 显示明确的修复或重试状态。
- [ ] 不静默降级为明文持久化。
- [ ] 可选择本次进程内登录时，UI 明确说明重启后需要重连。
- [ ] 恢复安全存储后可正常重试。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

---

## 13. P1：迁移与降级

> 仅使用测试 profile。执行历史清理前先备份并确认目标；不得对真实用户数据做批量删除。

### ID-MIGRATE-001：旧版本已登录用户升级

步骤：

1. 使用旧版登录 Cloud/Hosted，并创建一项本地数据。
2. 升级到新版本并启动。
3. 分别访问本地、Cloud、Hosted、GitHub 与 Agent。

预期：

- [ ] 本地项目与设置不丢失。
- [ ] 允许迁移的 Cloud 连接按方案迁移或明确要求一次重连。
- [ ] Hosted 若需重连，只影响 Hosted。
- [ ] 旧 secret key/文件在成功迁移后按窄范围清理，不影响无关凭证。
- [ ] 清理后读回权威存储，确认没有残留或误删。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-MIGRATE-002：新版本登录后降级

步骤：在新版本完成登录并退出应用，安装允许降级测试的旧版本，启动并访问本地与各连接。

预期：

- [ ] 本地数据保持可用。
- [ ] 旧版本无法理解新凭证时只要求相关域重新登录，不崩溃、不清空其他域。
- [ ] 不把新安全存储内容复制回旧明文存储。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-MIGRATE-003：迁移中断后重试

步骤：在测试环境模拟迁移中途断电/强退，再启动新版本。

预期：

- [ ] 迁移可幂等重试，不产生重复 identity/session。
- [ ] 未验证新存储写入成功前，不删除旧数据。
- [ ] 最终状态只有一个权威凭证来源。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

---

## 14. P1：多窗口、生命周期与资源占用

### ID-LIFE-001：聚焦、隐藏与多窗口一致性

步骤：

1. 打开两个应用窗口，同时显示 Account Center/Cloud 页面。
2. 在窗口 1 登录、切换或退出。
3. 反复聚焦、最小化、隐藏和恢复窗口。

预期：

- [ ] 两个窗口最终收敛到相同身份状态。
- [ ] 聚焦或 remount 不会重复打开浏览器、重复刷新或重复注册 listener。
- [ ] 关闭一个窗口不会让另一个窗口失去有效会话。
- [ ] 最后一个窗口关闭/应用退出后，临时 listener 和端口被释放。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-LIFE-002：暖机后的空闲资源

步骤：启动后等待 3 分钟完成初始化，记录前台空闲、后台隐藏、网络断开/恢复各 5 分钟的 CPU、内存和网络活动。

预期：

- [ ] 暖机后空闲 CPU 接近 0%，没有持续轮询尖峰。
- [ ] 内存趋于稳定，重复打开/关闭 Account Center 不持续增长。
- [ ] 隐藏状态没有无边界刷新、重试或网络风暴。
- [ ] 网络恢复只触发受控恢复，不为同一会话并发刷新多次。

记录：

| 场景                      | CPU 范围 | RSS 起点/终点 | 网络请求数 | 备注 |
| ------------------------- | -------- | ------------- | ---------- | ---- |
| 前台空闲 5 分钟           |          |               |            |      |
| 后台隐藏 5 分钟           |          |               |            |      |
| 断网/恢复                 |          |               |            |      |
| Account Center 开关 20 次 |          |               |            |      |

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

---

## 15. P0：安全边界人工检查

### ID-SEC-001：URL、Web Storage 与本地文件

检查位置：

- 系统浏览器授权与回调地址栏。
- Desktop renderer 的 localStorage、sessionStorage、IndexedDB。
- `shared-service-auth.json` 及同类旧凭证文件。
- 应用日志、崩溃日志、前后端事件 payload。

预期：

- [ ] 不存在 access token、refresh token、authorization code 或 PKCE verifier 持久化；一次性 authorization code 只允许短暂经过系统浏览器到 Cloud 的 HTTPS 回调。
- [ ] renderer 只获得必要的短期能力/脱敏身份投影，不获得 refresh token。
- [ ] 旧凭证文件不再作为新登录的权威来源。
- [ ] 日志仅保留 provider、realm、状态、错误码和脱敏 correlation ID。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

### ID-SEC-002：公开事件与错误报告

步骤：分别触发登录失败、刷新失败、切换失败和退出失败，检查 UI、事件与日志。

预期：

- [ ] 错误报告不包含 secret、完整授权 URL 或用户私密数据。
- [ ] correlation ID 可用于排查，但不能反推出凭证。
- [ ] renderer 不能通过调试事件订阅拿到 refresh token。

结果：`PASS / FAIL / BLOCKED` 缺陷：\***\*\_\_\*\***

---

## 16. P1/P2：平台矩阵

| 平台                  | 系统浏览器 + PKCE | 随机 loopback | 安全存储           | 重启恢复 | 无重复系统授权 | 结果/缺陷 |
| --------------------- | ----------------- | ------------- | ------------------ | -------- | -------------- | --------- |
| macOS Apple Silicon   |                   |               | Keychain           |          |                |           |
| macOS Intel（如支持） |                   |               | Keychain           |          |                |           |
| Windows 11            |                   |               | Credential Manager |          |                |           |
| Ubuntu LTS            |                   |               | Secret Service     |          |                |           |

平台未执行时必须填写 `BLOCKED` 或 `N/A + 原因`，不得留空后宣称全平台通过。

---

## 17. 建议执行顺序

### 17.1 15 分钟本地冒烟

1. PRE-001、PRE-002。
2. ID-ONBOARD-001～003。
3. ID-LOCAL-001～003。
4. ID-STORE-001。
5. ID-REALM-001。
6. ID-LIFE-002 的 3 分钟简版。

### 17.2 新 OAuth 发布前完整验收

1. PRE-001/002 必须先 PASS。
2. 完成全部 P0 用例。
3. 完成签名 Release 的 ID-SESSION-001、ID-STORE-002。
4. 完成账号 A/B 切换、四身份域隔离、迁移/降级。
5. 至少完成 macOS + 一个 Windows/Linux 平台。
6. 保存脱敏证据并完成签字。

### 17.3 删除旧兼容路径前

- [ ] 新 OAuth 已在真实用户小流量中稳定运行一个约定观察期。
- [ ] 旧客户端最低支持版本和回滚窗口已经确认。
- [ ] 迁移、降级和断网路径均已通过。
- [ ] 仓库中旧 credential importer、fragment token 和旧 key 名只剩明确允许的迁移/文档引用。
- [ ] 删除兼容路径后重新执行所有 P0 与 secret-boundary 检查。

---

## 18. 自动检查与人工验收的关系

人工测试完成后，记录本构建实际运行过的检查。自动检查通过不能替代真实浏览器、系统安全存储和账号切换验收。

| 检查                     | 命令/方式                                  | 结果 |
| ------------------------ | ------------------------------------------ | ---- |
| Identity secret boundary | `npm run check:identity-secret-boundaries` |      |
| Cloud i18n               | `npm run check:i18n:cloud`                 |      |
| TypeScript               | 记录项目实际命令                           |      |
| Frontend unit tests      | 记录项目实际命令                           |      |
| Identity Broker tests    | 记录项目实际命令                           |      |
| Cloud server tests/build | 记录 Cloud 仓库实际命令                    |      |
| Release 签名与安装       | 记录构建产物                               |      |

已知但不应混入本次验收结论的问题，也应单独记录。例如全 workspace lint 若只被无关既有问题阻塞，应写明准确文件与错误，但不得因此声称身份重构已经全量 lint 通过。

---

## 19. 缺陷记录模板

```text
缺陷 ID：
严重级别：P0 / P1 / P2
用例 ID：
构建与 commit：
平台与系统版本：
发生时间与时区：
权威状态来源：Cloud / Identity Broker / secure store / renderer projection
前置条件：
复现步骤：
期望结果：
实际结果：
是否可稳定复现：
影响的身份域：
脱敏证据：
临时恢复方式：
```

若 UI 出现错误账号、陈旧数据或重复数据，缺陷必须继续追到最早产生无效状态的写入边界；仅用 UI 过滤隐藏现象不算修复完成。

---

## 20. 最终签字

### P0 汇总

| 范围                |  用例数 | PASS | FAIL | BLOCKED | 结论 |
| ------------------- | ------: | ---: | ---: | ------: | ---- |
| Onboarding/本地优先 | 5 个 P0 |      |      |         |      |
| Code + PKCE         |       5 |      |      |         |      |
| 刷新/离线/退出      | 4 个 P0 |      |      |         |      |
| Sign-in Intent      |       2 |      |      |         |      |
| 账号切换            |       2 |      |      |         |      |
| 身份域隔离          |       4 |      |      |         |      |
| 安全存储            | 2 个 P0 |      |      |         |      |
| 安全边界            |       2 |      |      |         |      |

### 放行结论

- [ ] PRE-001 与 PRE-002 已 PASS。
- [ ] 所有 P0 均 PASS，无 BLOCKED。
- [ ] Cloud Onboarding 只 block Cloud 内容，“暂不”与返回本地已验证。
- [ ] P1 未通过项均有书面豁免、负责人和截止日期。
- [ ] 没有凭证出现在 URL、renderer storage、日志或公开事件中。
- [ ] 账号切换和身份域 401 隔离已用真实 A/B 账号验证。
- [ ] 签名 Release 的安全存储与重启恢复已验证。
- [ ] 回滚开关与兼容路径已验证。
- [ ] 已记录所有未执行的平台和原因。

| 角色                  | 姓名 | 结论 | 日期 | 签字/链接 |
| --------------------- | ---- | ---- | ---- | --------- |
| 测试负责人            |      |      |      |           |
| Desktop 负责人        |      |      |      |           |
| Cloud/Identity 负责人 |      |      |      |           |
| 发布负责人            |      |      |      |           |

最终结论：`PASS / CONDITIONAL PASS / FAIL / BLOCKED`

备注：当前生产 desktop config 为 503 时，最终结论最多只能是 `BLOCKED`；不能以旧登录兼容路径可用代替新 Code + PKCE 验收。
