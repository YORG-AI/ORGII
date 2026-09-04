# Mobile Remote 开发与生产体验指南

> **日常使用（生产 PWA + 公网 Relay）：** 请先阅读 [同事体验指南](./mobile-remote-colleague-guide.md)。  
> 本文面向 **本地开发、Relay 部署与排障**。  
> 相关 PR：[#1150](https://github.com/org2AI/ORG2/pull/1150)（分支 `junyu/mobile-remote-control`）

Mobile Remote 让手机通过 PWA 遥控桌面 ORG2 上的 Agent 会话。桌面通过 **出站 WebSocket** 连接 Relay，手机经 Relay 与桌面通信，无需在路由器上开放入站端口。

---

## 架构概览

```mermaid
flowchart LR
  subgraph phone["手机（浏览器 PWA）"]
    PWA["/orgii/mobile"]
  end

  subgraph relay["orgii-mobile-relay"]
    WS["/v1/mobile/ws"]
    DB[("~/.orgii/mobile-relay.sqlite3")]
  end

  subgraph desktop["桌面 ORG2（Tauri）"]
  Settings["设置 → 移动遥控"]
  Agent["Agent 会话"]
  end

  PWA -->|"wss/ws + 配对"| WS
  Settings -->|"出站 WSS + ORG2 Cloud JWT"| WS
  WS --> DB
  Settings --> Agent
  PWA -.->|"OAuth（GitHub）"| Cloud["ORG2 Cloud / Supabase"]
```

**三端职责：**

| 组件                            | 作用                                                |
| ------------------------------- | --------------------------------------------------- |
| **前端 dev server**（:1998）    | 提供桌面 UI 与 Mobile PWA（`/orgii/mobile`）        |
| **orgii-mobile-relay**（:8787） | 配对、设备授权、手机↔桌面消息转发（payload-opaque） |
| **Tauri 桌面**                  | 连接 Relay、生成配对码、执行 Agent 操作             |

**认证方式：**

| 场景                  | 桌面侧认证                       | 手机侧认证        |
| --------------------- | -------------------------------- | ----------------- |
| **生产 / 公网 Relay** | ORG2 Cloud 登录（每用户 JWT）    | GitHub OAuth 登录 |
| **本地 Relay 开发**   | 共享 `ORGII_RELAY_DESKTOP_TOKEN` | dev session stub  |

---

## 前置条件

| 工具                             | 说明                                               |
| -------------------------------- | -------------------------------------------------- |
| [pnpm](https://pnpm.io/) 9.15    | `npm install -g pnpm@9.15`                         |
| [Rust](https://rustup.rs/) 1.85+ | `rustup toolchain install stable`                  |
| Node.js 20+                      | 与 [CONTRIBUTING](../.github/CONTRIBUTING.md) 一致 |
| **不需要 Xcode**                 | Mobile Remote 是浏览器 PWA，不是原生 iOS 应用      |

```bash
# 仓库根目录
pnpm install
```

---

## 本地开发（Development）

### 方式 A：一键启动（推荐初次体验）

```bash
pnpm run tauri:dev
```

`tauri:dev` 会启动前端 dev server 并打开 Tauri 桌面。macOS / Linux 默认使用 **rspack** bundler；Windows 默认 webpack。可用 `pnpm run tauri:dev:webpack` 强制 webpack。

### 方式 B：分终端启动（调试 Relay 时更清晰）

适合需要单独观察 relay 日志、或避免 Tauri 重复拉起 dev server 的场景。

**终端 1 — 前端 dev server：**

```bash
pnpm run dev:frontend
# 或 rspack：pnpm run dev:frontend:rspack
```

**终端 2 — 本地 Relay：**

```bash
cd src-tauri
# Local dev legacy fallback (shared secret, optional):
export ORGII_RELAY_DESKTOP_TOKEN_FALLBACK=true
ORGII_RELAY_DESKTOP_TOKEN=123456789012345678901234 cargo run -p orgii-mobile-relay
```

Production path uses per-user ORG2 Cloud JWT (same as mobile PWA); the shared token is accepted only when `ORGII_RELAY_DESKTOP_TOKEN_FALLBACK=true`.

Relay 默认监听 `127.0.0.1:8787`，数据库写入 `~/.orgii/mobile-relay.sqlite3`（避免写在 `src-tauri/` 内触发 Tauri dev 文件监听导致桌面退出——此问题已在 PR 中修复）。

**终端 3 — 仅 Tauri 桌面（`beforeDevCommand` 置空模式）：**

```bash
pnpm run tauri:dev:only
```

`tauri:dev:only` 不会再次启动 webpack/rspack，需确保终端 1 的 dev server 已在运行。

### 访问 URL

| 用途                           | URL                                 |
| ------------------------------ | ----------------------------------- |
| 桌面 Web UI                    | http://localhost:1998/              |
| Mobile PWA（本机浏览器）       | http://localhost:1998/orgii/mobile  |
| Mobile PWA（手机，同一 Wi-Fi） | http://\<mac-ip\>:1998/orgii/mobile |

查看 Mac 局域网 IP：

```bash
ipconfig getifaddr en0   # Wi-Fi
# 或：系统设置 → 网络
```

> **提示：** dev server 默认绑定 `localhost`。若手机无法访问 Mac IP，可尝试在前端启动时增加 host 绑定（例如 webpack-dev-server 的 `--host 0.0.0.0`），并确认 Mac 防火墙允许入站 1998。

---

## 桌面配置（设置 → 移动遥控）

### 本地 Relay 开发（预设「本地」）

1. 打开 **设置 → 移动遥控**
2. 开启 **移动遥控**
3. 在 **户外连接** 区域：
   - 开启 **连接公网 Relay**（本地开发时也通过 relay 走完整配对流程）
   - 选择预设 **「本地」** → Relay 地址应为：
     ```
     ws://127.0.0.1:8787/v1/mobile/ws
     ```
   - **桌面访问密钥** 填写：
     ```
     123456789012345678901234
     ```
     必须与 relay 启动时的 `ORGII_RELAY_DESKTOP_TOKEN` **完全一致**（至少 24 字符）
4. 确认 **Relay 状态** 为「已连接」或「正在连接」
5. 点击 **生成户外配对码**，出现 QR 码与配对载荷文本

预设 URL 定义见 `src/config/mobileRemoteRelay.ts`。

### 生产 / 自定义公网 Relay

1. 先在 **设置 → 通用** 登录 **ORG2 Cloud**（与云同步、邀请等同一路径）
2. **设置 → 移动遥控** → 开启移动遥控与 **连接公网 Relay**
3. 选择 **「生产」** 或填写自定义 `wss://` Relay 地址
4. 确认 **ORG2 Cloud 登录** 行显示已登录账号（未登录时先登录）
5. 确认 **Relay 状态** 已连接后 **生成户外配对码**

生产预设不再使用「桌面访问密钥」；Relay 通过桌面出站连接携带的 ORG2 Cloud JWT 识别用户。

---

## 手机端流程

### 1. 打开 PWA

在手机浏览器（Safari / Chrome）打开：

```
http://<mac-ip>:1998/orgii/mobile
```

本机调试可用 `http://localhost:1998/orgii/mobile`。

### 2. GitHub 登录

首次进入会要求 **使用 GitHub 继续**（ORG2 Cloud / Supabase OAuth）。

本地 dev 时，`scripts/dev/webpack-server.js`（及 `rspack-server.js`）内置了 `/v1/mobile/auth/session` stub，对 `POST` / `DELETE` 返回 `204`，无需真实后端即可完成登录流程调试。

### 3. 配对

1. 在欢迎页点击 **扫描或粘贴配对码**
2. 扫描桌面设置中的 QR，或粘贴 **配对载荷** 文本
3. 核对 **安全短语**（SAS）与桌面一致后，在桌面点击 **短语一致，确认配对**
4. 配对成功后，手机可查看会话列表并发送消息

---

## 快速上手 Checklist

### 本地 Relay

- [ ] `pnpm install` 完成
- [ ] 前端 dev server 运行于 **:1998**（`pnpm run dev:frontend` 或 `pnpm run tauri:dev`）
- [ ] Relay 已启动，`ORGII_RELAY_DESKTOP_TOKEN` 已设置
- [ ] 桌面 **设置 → 移动遥控**：已开启、预设「本地」、桌面访问密钥与 relay 一致、Relay 已连接
- [ ] 桌面已 **生成户外配对码**
- [ ] 手机打开 `http://<host>:1998/orgii/mobile`，完成 GitHub 登录
- [ ] 手机扫码/粘贴配对码，桌面确认 SAS 短语
- [ ] 手机会话列表可见桌面 session

### 生产 Relay

- [ ] 桌面 **设置 → 通用** 已登录 ORG2 Cloud
- [ ] 桌面 **设置 → 移动遥控**：预设「生产」、Relay 已连接
- [ ] 手机打开 Workers PWA URL，GitHub 登录
- [ ] 配对 → SAS 确认 → 会话列表 → 发消息

---

## 常见问题与排查

| 现象                                  | 可能原因                                     | 处理                                                                                                                       |
| ------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Connection refused` / 无法连接 Relay | dev server 或 relay 未启动                   | 确认终端 1（:1998）和终端 2（:8787）均在运行                                                                               |
| `invalid desktop token`（本地预设）   | 桌面密钥与 relay 不一致                      | 检查「桌面访问密钥」与 `ORGII_RELAY_DESKTOP_TOKEN` 完全相同                                                                |
| 生产预设 Relay 401 / `auth_required`  | 未登录 ORG2 Cloud 或会话过期                 | 在 **设置 → 通用** 登录 ORG2 Cloud，回到移动遥控刷新 Relay 状态                                                            |
| 选择「生产」预设后连接失败            | Relay 未连通或未登录 ORG2 Cloud              | 确认预设地址为下文生产 URL；确认通用设置中已登录                                                                           |
| 配对后桌面意外退出                    | 旧版 relay DB 写在 `src-tauri/` 触发文件监听 | 已修复：DB 默认在 `~/.orgii/mobile-relay.sqlite3`；拉取最新分支即可                                                        |
| `/orgii/mobile` 显示桌面 UI           | dev bundler 未加载 mobile 入口               | 确认使用 webpack/rspack 配置（含 `mobile` entry 与 `/orgii/mobile` → `mobile.html` rewrite）；勿用仅编译 `main` 的简化配置 |
| 手机打不开 Mac IP:1998                | dev server 只监听 localhost                  | 尝试 host `0.0.0.0` 绑定；检查防火墙与同一 Wi-Fi                                                                           |
| OAuth 登录卡住                        | dev stub 未生效                              | 确认通过 `webpack-server.js` / `rspack-server.js` 启动，而非静态文件服务                                                   |

---

## 生产环境（Production）

### 当前已部署实例（Cloudflare Workers）

团队已在 Cloudflare Workers 上部署 `orgii-mobile-relay`，同时托管 **Mobile PWA** 静态资源与 **Relay WebSocket**。

| 用途                                | URL                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------- |
| 健康检查                            | https://orgii-mobile-relay.superficial-jasper.workers.dev/healthz      |
| Mobile PWA（手机浏览器）            | https://orgii-mobile-relay.superficial-jasper.workers.dev/orgii/mobile |
| Relay WebSocket（桌面「生产」预设） | `wss://orgii-mobile-relay.superficial-jasper.workers.dev/v1/mobile/ws` |

探测结果（供参考）：

- `/healthz` 返回 `{"ok":true,"protocolVersion":1}`
- `/orgii/mobile` 返回 **200 `text/html`**，为打包后的 Mobile PWA 壳（`ORG2 Mobile Remote`），非重定向
- `/v1/mobile/ws` 在无会话时返回 **401** `auth_required`（说明 WebSocket 路径正确，需 ORG2 Cloud JWT / 手机 OAuth 后建连）

> **`relay.orgii.ai`** 仍为规划中的自定义域名，当前未作为默认预设；代码默认生产主机见 `src/config/mobileRemoteRelay.ts` 中的 `MOBILE_REMOTE_RELAY_PRODUCTION_HOST`。

### 桌面使用「生产」预设

1. **设置 → 通用** 登录 ORG2 Cloud
2. **设置 → 移动遥控** → 开启移动遥控与 **连接公网 Relay**
3. 预设选择 **「生产」** → Relay 地址应为：
   ```
   wss://orgii-mobile-relay.superficial-jasper.workers.dev/v1/mobile/ws
   ```
4. 确认 **ORG2 Cloud 登录** 状态为已登录
5. **生成户外配对码**，手机打开上表中的 **Mobile PWA** URL，GitHub 登录后扫码/粘贴配对

本地联调仍请用 **「本地」** 预设与自启 relay，不必走 Workers。

### 发布 / 更新生产 Workers（维护者）

> **重要：** 生产环境的 Relay + Mobile PWA **不在本仓库（ORG2）发布**。  
> 实际部署在独立基础设施仓库 **[ORGII-cloud-infra](https://github.com/org2AI/ORGII-cloud-infra)** 的 **`mobile-relay-worker/`** 子目录，通过 **Wrangler** 发布到 Cloudflare Workers。  
> 本仓库的 `src-tauri/crates/mobile-relay-server/` 是本地开发用的 Rust relay，**不是**线上 Workers 实现。

**本仓库没有** `wrangler.toml`、`stage-mobile-assets` 脚本，也没有 GitHub Actions 自动发布 mobile-relay。更新生产需按下列步骤手动执行。

#### 前置条件

| 项                  | 说明                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare 账号     | 已 `npx wrangler login`（当前实例在 **Superficial Jasper** 账号下的 `workers.dev`）                                          |
| Wrangler            | ≥ 4.102（`mobile-relay-worker` 内 `npm install` 会安装）                                                                     |
| Supabase Auth       | 回调 URL 须包含 `https://orgii-mobile-relay.superficial-jasper.workers.dev/orgii/mobile/auth/callback`（换域名后须同步更新） |
| Cookie 签名（可选） | **`MOBILE_AUTH_SECRET`**；生产建议单独配置                                                                                   |

> 生产 Relay 桌面认证已迁移为 **ORG2 Cloud JWT**（每用户）。`DESKTOP_TOKEN` / wrangler secret 仅为历史本地 dev 或过渡部署保留，不再作为桌面「生产」预设的配置项。

#### 标准发布流程

```bash
# 1. 在 ORG2 仓库构建前端（含 mobile 入口）
cd /path/to/ORG2
pnpm build

# 2. 将 PWA 静态资源复制到 Worker 的 public/
cd /path/to/ORGII-cloud-infra/mobile-relay-worker
npm install
npm run stage:mobile -- /path/to/ORG2/build

# 3. 发布到 Cloudflare Workers
npx wrangler deploy
```

`stage:mobile` 会从 `build/` 解析 `mobile.html` 及其引用的 JS/CSS，写入 `mobile-relay-worker/public/`（约 20+ 个文件）。**发布用的是本地 build 产物，不依赖 PR 是否已 merge 到 main**——但维护者应确保 build 来自已验证的分支/提交。

#### 首次部署（可选密钥）

```bash
cd /path/to/ORGII-cloud-infra/mobile-relay-worker

# 可选：手机 OAuth cookie 签名
npx wrangler secret put MOBILE_AUTH_SECRET
```

也可在 `mobile-relay-worker/` 下创建 **`.deploy-secrets.json`**（参考 `.env.example` 字段名），用于临时账号首次发布：

```bash
npx wrangler deploy --temporary --secrets-file .deploy-secrets.json
```

临时部署会打印 `workers.dev` URL 与 claim 链接，须在 **60 分钟内** claim 账号，否则部署与配对数据会被删除。

#### 发布后验证

```bash
curl https://orgii-mobile-relay.superficial-jasper.workers.dev/healthz
# 期望：{"ok":true,"protocolVersion":1}

curl -sI https://orgii-mobile-relay.superficial-jasper.workers.dev/orgii/mobile | head -5
# 期望：HTTP 200，Content-Type 为 text/html
```

桌面 **设置 → 通用** 登录 ORG2 Cloud，**设置 → 移动遥控** 选「生产」预设，确认 Relay 已连接后走一遍配对 → SAS 确认 → 会话列表 → 发消息。

本地集成测试（需有效 Supabase access token）：

```bash
cd /path/to/ORGII-cloud-infra/mobile-relay-worker
SUPABASE_ACCESS_TOKEN=... \
  npm run test:integration -- https://orgii-mobile-relay.superficial-jasper.workers.dev
```

更完整的 Worker 生命周期说明见 **`ORGII-cloud-infra/mobile-relay-worker/README.md`**。

### 自托管 Relay

Relay 实现位于 `src-tauri/crates/mobile-relay-server/`（crate 名 `orgii-mobile-relay`）。

**1. 构建并运行（需 TLS 终止，生产用 wss://）：**

```bash
cd src-tauri

# Local dev legacy fallback (shared secret, optional):
export ORGII_RELAY_DESKTOP_TOKEN_FALLBACK=true
export ORGII_RELAY_DESKTOP_TOKEN="<your-secret-token>"

# 可选
export ORGII_RELAY_LISTEN="0.0.0.0:8787"
export ORGII_RELAY_PUBLIC_WS_URL="wss://relay.example.com/v1/mobile/ws"
export ORGII_RELAY_PUBLIC_APP_URL="https://relay.example.com/orgii/mobile"

cargo run -p orgii-mobile-relay --release
```

通常在前置反向代理（Caddy / nginx）后终止 TLS，对外暴露 `wss://`。

**2. 部署 Mobile PWA**

将包含 `mobile` entry 的前端构建产物部署到 HTTPS 域名，路径需支持 `/orgii/mobile`（与 `public/mobile.html` + history fallback 一致）。

**3. 桌面连接**

- **公网 / 每用户 Relay（推荐）：** 桌面在 **设置 → 通用** 登录 ORG2 Cloud，Relay 地址填 `wss://<host>/v1/mobile/ws`
- **本地 Rust relay dev：** 预设「本地」+ 桌面访问密钥与 `ORGII_RELAY_DESKTOP_TOKEN` 一致

**4. 覆盖默认生产 Relay URL（构建时）**

若需指向其他 relay 主机（非默认 Workers 实例），在构建前端时设置：

```bash
REACT_APP_MOBILE_RELAY_PRODUCTION_URL=wss://your-relay.example.com/v1/mobile/ws pnpm build
```

定义见 `src/config/mobileRemoteRelay.ts`，rspack/webpack 均已透传该环境变量。

### 正式上线 checklist（Workers 路径）

- [ ] `pnpm build`（ORG2）→ `npm run stage:mobile` → `npx wrangler deploy`（`ORGII-cloud-infra/mobile-relay-worker`）
- [ ] （推荐）独立配置 **`MOBILE_AUTH_SECRET`**
- [ ] Supabase Auth 回调 URL 已登记（见上文 `auth/callback` 路径）
- [ ] `/healthz` 与 `/orgii/mobile` 返回正常
- [ ] （可选）自定义域名 CNAME 到 Workers（例如未来的 `relay.orgii.ai`）
- [ ] 配置 `REACT_APP_MOBILE_RELAY_PRODUCTION_URL`（仅当默认 Workers URL 需覆盖时；见 `config/rspack.config.js` / `config/webpack.config.js`）
- [ ] 端到端验证：桌面 ORG2 Cloud 登录 → Relay 连接 → 配对 → SAS 确认 → 会话列表 → 发消息 / 停止 session

### 自托管 Rust Relay checklist（非 Workers）

若不用 Cloudflare Workers，而是自建 `cargo run -p orgii-mobile-relay`：

- [ ] TLS 终止（Caddy / nginx）与持久化 `~/.orgii/` 或 `ORGII_RELAY_DATABASE`
- [ ] `ORGII_RELAY_DESKTOP_TOKEN` 与桌面「本地」预设访问密钥一致（仅本地 dev 路径）
- [ ] 单独部署 HTTPS 版 Mobile PWA（`/orgii/mobile`）

---

## 相关代码路径

| 路径                                                                    | 说明                                      |
| ----------------------------------------------------------------------- | ----------------------------------------- |
| `src/modules/MobileRemote/`                                             | Mobile PWA UI                             |
| `src/mobileRemoteEntry.tsx`                                             | PWA 入口（独立于桌面 `src/index.tsx`）    |
| `src/config/mobileRemoteRelay.ts`                                       | 本地/生产 Relay URL 预设                  |
| `src/modules/MainApp/Settings/sections/MobileRemoteSettingsSection.tsx` | 桌面设置 UI                               |
| `src/features/Org2Cloud/`                                               | ORG2 Cloud 登录与会话                     |
| `src-tauri/crates/mobile-relay-server/`                                 | 本地 Relay 服务                           |
| `config/webpack.config.js` / `config/rspack.config.js`                  | `mobile` entry 与 `/orgii/mobile` rewrite |
| `scripts/dev/webpack-server.js`                                         | dev auth session stub                     |

---

## 参考

- PR：[#1150 — Mobile Remote control](https://github.com/org2AI/ORG2/pull/1150)
- 生产 Workers 部署：[ORGII-cloud-infra/mobile-relay-worker](https://github.com/org2AI/ORGII-cloud-infra/tree/main/mobile-relay-worker)（`README.md`、`wrangler.toml`）
- 通用开发环境：[CONTRIBUTING.md](../.github/CONTRIBUTING.md)
