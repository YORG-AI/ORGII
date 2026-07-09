# ORG2 150 / Docker 验证与部署清单

目标：在新设备或 150 设备上，仅凭 Git 分支 + Docker image + 手工 secrets，恢复并验证当前 ORG2 Linux 运行形态。

> 当前验证口径（2026-07-09）：
>
> - 150：`algo@10.2.248.150`
> - 验证 worktree：`/home/algo/orgii-merge-validate-20260709`
> - 线上工作目录：`/home/algo/orgii-fork`
> - 当前可合并分支：`merge/official-develop-20260709-resolved`
> - 通过验证 HEAD：`989cf42a`
> - Docker image：`orgii-build:22.04`
> - 长期容器：`orgii-app`

## 1. 获取代码

150 访问 GitHub 可能超时，优先从 Gitee 拉取；GitHub push/PR 可在有 mihomo 的 82 机器完成。

```bash
cd /home/algo
git clone git@gitee.com:simonpan_ch/orgii-fork.git orgii-merge-validate-20260709
cd orgii-merge-validate-20260709
git checkout merge/official-develop-20260709-resolved
```

不要依赖 `/work` 这个宿主路径：150 上没有 `/work`。脚本应从自身路径推导 repo root，或通过 `ORGII_WORKDIR` 显式指定。

## 2. Docker image

已验证可用 image：

```text
orgii-build:22.04
```

它包含：

- Ubuntu 22.04 base
- Node 22 + pnpm 9.15.4
- Rust toolchain
- Tauri Linux deps：webkit2gtk / gtk / libsoup / javascriptcoregtk / librsvg / openssl / ayatana appindicator / ffmpeg build deps
- Xvfb / x11vnc / websockify / noVNC
- fonts-noto-cjk

如需重建：

```bash
docker build -f Dockerfile.build -t orgii-build:22.04 .
```

如果已有可信 image，可跳过重建：

```bash
ORGII_SKIP_DOCKER_BUILD=1 ORGII_DOCKER_IMAGE=orgii-build:22.04 \
  scripts/dev/orgii_docker_validate.sh
```

## 3. 依赖 cache 规则

### 必须重建 / 重新安装的情况

- 新 clone 没有 `node_modules`
- `pnpm-lock.yaml` 或 package manifest 变化
- `src-tauri/Cargo.lock` 或 Rust crate feature 大幅变化
- 之前 Docker root 写坏了 host `node_modules`

### 可复用 cache 的情况

- 已在宿主 `algo` 用户下完成 pnpm install
- `node_modules/.bin/tsc` 存在
- 只是验证 Rust / TS 源码改动

宿主安装依赖：

```bash
export PATH="/home/algo/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm config set registry https://registry.npmmirror.com
pnpm install --no-frozen-lockfile
pnpm exec tsc --version
```

如果 Docker root 污染了 `node_modules`，不要用普通 `rm -rf` 硬删；用容器 root 删除：

```bash
docker run --rm -v "$PWD:/work" -w /work orgii-build:22.04 bash -lc 'rm -rf node_modules'
```

## 4. 一键验证

标准验证：

```bash
scripts/dev/orgii_docker_validate.sh orgii-build:22.04
```

复用现有 image + 宿主 node_modules：

```bash
ORGII_SKIP_DOCKER_BUILD=1 \
ORGII_SKIP_PNPM_INSTALL=1 \
ORGII_DOCKER_IMAGE=orgii-build:22.04 \
  scripts/dev/orgii_docker_validate.sh
```

脚本会执行：

```bash
pnpm exec tsc --noEmit
cd src-tauri
cargo test -p agent_core channel_handler::slash --lib
cargo check -p agent_core
```

2026-07-09 r5 验证已通过：

- log：`/home/hy/clawd/logs/org2_docker_validate_150_r5_20260709_20260709_021630.log`
- `pnpm exec tsc --noEmit` ✅
- `cargo test -p agent_core channel_handler::slash --lib` ✅
- `cargo check -p agent_core` ✅

## 5. 150 dev 启动

脚本：

```bash
scripts/dev/orgii_dev_run_150.sh
```

关键点：

- 会 source `/home/algo/org2-container-env.sh`（secrets / env，不提交）
- PATH 包含 `/home/algo/.nvm/versions/node/v22.22.0/bin`
- 使用 Xvfb `:99`
- noVNC：`6080`
- VNC：`5900`
- Webpack dev server：`1998`
- Agent API health：`http://127.0.0.1:13847/agent/health`
- 后端二进制：`src-tauri/target/debug/org2`

启动：

```bash
cd /home/algo/orgii-fork
ORGII_WORKDIR=/home/algo/orgii-fork scripts/dev/orgii_dev_run_150.sh
```

脚本会监控 agent API；如果 health 掉线，会按当前 workdir 精确重启 `target/debug/org2`。

## 6. 新设备 secrets / 本机状态

Git 不能也不应该包含：

- `/home/algo/org2-container-env.sh`
- OAuth / API token
- 本地数据库、用户数据、缓存目录
- 已登录浏览器/session 状态
- host-specific `~/.cargo/config.toml`

新设备恢复时，需要人工注入这些 env/secrets，再跑 Docker 验证和 dev/prod 启动验收。

## 7. 已否定路线

- 不在宿主机上临时补一堆 cargo/pnpm 依赖作为主要解法；主验证路径是 Docker。
- 不依赖 150 直连 GitHub；150 从 Gitee 拉，GitHub 操作在有 mihomo 的机器做。
- 不用 broad `pkill -f orgii_docker_validate.sh`；它会误杀当前 SSH shell。
- 不在 root-owned partial `node_modules` 上继续 cached 验证。
