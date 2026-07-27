<div align="center">
  <h1>ORG-2</h1>
  <p><strong>面向 Agent 构建软件的记录系统（System of Record）。<br />运行你的编程 Agent——回放任意会话、与团队一起审查，并把每一行代码追溯到它背后的决策。</strong></p>
  <p>基于 Rust 和 Tauri 构建，面向 local-first 执行，磁盘占用低于 100MB。支持 Agent 轨迹直播和回放，易于跟踪和审查。</p>
</div>

---

<p align="center">
  <a href="https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg"><strong>macOS Apple Silicon</strong></a>
  ·
  <a href="https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe"><strong>Windows installer</strong></a>
  ·
  <a href="https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi"><strong>Windows MSI</strong></a>
  ·
  <a href="https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.AppImage"><strong>Linux AppImage</strong></a>
  ·
  <a href="https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.deb"><strong>Linux DEB</strong></a>
  ·
  <a href="https://github.com/org2AI/ORG2/releases/latest"><strong>All latest release assets</strong></a>
</p>

---

<p align="center">
  <a href="../../README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.zh.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <a href="README.es.md">Español</a> · <a href="README.ru.md">Русский</a> · <a href="README.pt.md">Português</a> · <a href="README.de.md">Deutsch</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.vi.md">Tiếng Việt</a> · <a href="README.pl.md">Polski</a>
</p>

<p align="center">
  <video src="https://github.com/user-attachments/assets/bd4833d2-4cc4-4971-9805-84529b14d01a" controls width="720"></video>
</p>

要回答一段代码为什么存在、以及它是否真的奏效，一直都需要手动把多个系统拼接起来。Jira 只看得到工单。Codex 只看得到自己的会话。GitHub 只看得到提交的代码行。Amplitude 只看得到指标。当代码由人类编写时，这还勉强撑得住；在 Agent 的速度下则不然：周一写的代码，到周五就成了遗留代码。

ORG-2 就是你的团队运行编程 Agent 的地方——内置原生 Rust harness，外加 20+ 个 Agent CLI 的启动器——并自动构建这份记录。每个会话都会成为一条可以像视频一样回放的轨迹，队友据此审查工作究竟是如何完成的，而不只是看最终 diff，并在上下文中留下评论。在其他工具里运行的会话也会被接入，并从它们的历史中回填，因此这份记录同样覆盖从未经过本应用的工作。记录把人类提出的要求、Agent 的理解、以及它实际做了什么链接在一起，因此任何上线的代码行都能追溯到写下它的那次会话。

它不只是另一个 AI 编程工具；它是一次关于人类/Agent 组织以及组织级对齐的实验。ORG-II 把 Agent 视为结构化组织中持久、可观测的同事——可回放的执行、跨会话记忆、AI blame，以及 local-first 的 Rust runtime，让人类、Agent 和团队能够围绕共享上下文与对齐目标协作。

## 功能

<table>
<tr><td width="50%" valign="middle"><h3>内置 Rust Harness</h3><p>使用你现有的 API 密钥和 Agent 订阅，运行快速、节省 token 且可定制的原生 Agent。</p></td><td width="50%"><img src="../assets/feature-wall/rust-harness.gif" alt="使用 ORG-II Rust Harness 运行 Agent" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>管理 10 多种应用和 CLI 中的会话</h3><p>在一处加载并管理所有工具中的 Agent 会话。无需切换应用，即可扫描历史记录、检查 subagent 并控制每个来源。</p></td><td width="50%"><img src="../assets/feature-wall/session-sources.png" alt="在 ORG-II 中管理应用和 CLI 的 Agent 会话来源" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>组建团队并审查轨迹，而不只是 PR</h3><p>组建团队，在设备和队友之间共享会话。审查完整的 Agent 轨迹，而不只是最终 diff，并在上下文中留下评论。</p></td><td width="50%"><img src="../assets/feature-wall/team-trajectory-review.png" alt="在 ORG-II 中管理队友和轨迹回放权限" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>工具调用，现在可像视频一样播放</h3><p>回放原生 Rust Harness 和 15 个以上 CLI Agent 的工作。消息、工具调用、文件编辑和命令输出会同步显示在一条可审查的时间线上。</p></td><td width="50%"><img src="../assets/feature-wall/replay.gif" alt="在 ORG-II 中回放 Agent 会话" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>AI blame，而不只是 Git blame</h3><p>不要只停留在谁修改了某一行。追溯到促成该变更的 Agent 会话、工具调用和决策。</p></td><td width="50%"><img src="../assets/feature-wall/ai-blame.gif" alt="在 ORG-II 中将代码变更追溯到 Agent 会话和决策" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>保持方向</h3><p>查看时间如何分配在任务和 Agent 会话上。每日活动时间线让耗时、代码变更和优先级保持清晰可见。</p></td><td width="50%"><img src="../assets/feature-wall/work-diary.png" alt="在 ORG-II 中查看任务和 Agent 会话所花费的时间" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>完整开发工作区</h3><p>无需离开 Agent 工作区，即可使用终端、管理源代码控制、追踪 Git 历史并审查 pull request。</p></td><td width="50%"><img src="../assets/feature-wall/development-workspace.gif" alt="ORG-II 中的源代码控制、Git 历史和代码审查工具" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>设计模式</h3><p>在原生 WebKit 浏览器中检查实时页面。选择元素，将其精确页面上下文直接发送给 Agent，快速完成修复。</p></td><td width="50%"><img src="../assets/feature-wall/design-mode.gif" alt="使用 ORG-II 设计模式检查网页元素" width="100%" /></td></tr>
</table>

## 更多能力

- 集成 GUI、CLI、Terminal、Git、浏览器、LSP、Timeline 和数据库工具。
- 跨会话记忆、跨 Agent 知识共享，以及共享的 Workspace 状态。
- 资源感知执行，可根据 CPU、RAM 和人类注意力可用性做出反应。
- Agent 驱动的 GUI end-to-end 测试，用于受监督的自我演化。
- 支持调度和自动启动会话，让 Agent 可以通宵运行，或在你离开时继续工作。
- 面向组织级对齐的界面，用于协调人类、Agent、目标和责任归属（WIP）。
- 通过自托管 Supabase 支持会话协作和群组 issue 工作流（WIP）。

## 支持的 Agent

使用 ORG-II 内置的 Rust Harness，或从桌面应用启动这些受支持的 coding-agent CLI。

### GUI + TUI

<p>
  <a href="#功能"><kbd><img src="../assets/org2-icon.svg" alt="ORG-2 标志" width="22" valign="middle" /> ORG-2</kbd></a> &nbsp;
  <a href="https://cursor.com/docs/cli/overview"><kbd><img src="../../src/assets/modelIcons/cursor.svg" alt="Cursor CLI logo" width="16" valign="middle" /> Cursor CLI</kbd></a> &nbsp;
  <a href="https://code.claude.com/docs/en/configuration"><kbd><img src="../../src/assets/modelIcons/claude-code.svg" alt="Claude Code logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://developers.openai.com/codex/config-basic"><kbd><img src="../../src/assets/modelIcons/openai.svg" alt="Codex logo" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/installation"><kbd><img src="../../src/assets/modelIcons/kiro.svg" alt="Kiro CLI logo" width="16" valign="middle" /> Kiro CLI</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-in-the-cli"><kbd><img src="../../src/assets/modelIcons/copilot.svg" alt="GitHub Copilot logo" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/config/"><kbd><img src="../../src/assets/modelIcons/opencode.svg" alt="OpenCode logo" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli/getting-started"><kbd><img src="../../src/assets/modelIcons/antigravity.svg" alt="Antigravity logo" width="16" valign="middle" /> Antigravity</kbd></a>
</p>

### TUI

<p>
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/configuration-files.html"><kbd><img src="../../src/assets/modelIcons/kimi.svg" alt="Kimi Code CLI logo" width="16" valign="middle" /> Kimi Code CLI</kbd></a> &nbsp;
  <a href="https://aider.chat/docs/config.html"><kbd><img src="../../src/assets/modelIcons/aider.svg" alt="Aider logo" width="16" valign="middle" /> Aider</kbd></a> &nbsp;
  <a href="https://goose-docs.ai/docs/category/getting-started/"><kbd><img src="../../src/assets/modelIcons/goose.svg" alt="Goose logo" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual"><kbd><img src="../../src/assets/modelIcons/amp.svg" alt="Amp logo" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cli/cli-reference"><kbd><img src="../../src/assets/modelIcons/cline.svg" alt="Cline logo" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="../../src/assets/modelIcons/kilo.svg" alt="Kilo Code logo" width="16" valign="middle" /> Kilo Code</kbd></a> &nbsp;
  <a href="https://docs.x.ai/build/overview"><kbd><img src="../../src/assets/modelIcons/grok.svg" alt="Grok CLI logo" width="16" valign="middle" /> Grok CLI</kbd></a> &nbsp;
  <a href="https://docs.devin.ai/cli"><kbd><img src="../../src/assets/modelIcons/devin.svg" alt="Devin logo" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/user-guide/configuration"><kbd><img src="../../src/assets/modelIcons/hermes.svg" alt="Hermes logo" width="16" valign="middle" /> Hermes</kbd></a> &nbsp;
  <a href="https://docs.openclaw.ai/cli/config"><kbd><img src="../../src/assets/modelIcons/openclaw.svg" alt="OpenClaw logo" width="16" valign="middle" /> OpenClaw</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs"><kbd><img src="../../src/assets/modelIcons/infinity-agent.svg" alt="Codebuff logo" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/"><kbd><img src="../../src/assets/modelIcons/qwen.svg" alt="Qwen Code logo" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/mimocode/config-files"><kbd><img src="../../src/assets/modelIcons/xiaomimimo.svg" alt="Mimo Code logo" width="16" valign="middle" /> Mimo Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/cli/configuration"><kbd><img src="../../src/assets/modelIcons/continue.svg" alt="Continue logo" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/byok/overview"><kbd><img src="../../src/assets/modelIcons/droid.svg" alt="Droid logo" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://docs.mistral.ai/vibe/code/cli/install-setup"><kbd><img src="../../src/assets/modelIcons/mistral.svg" alt="Mistral Vibe logo" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://docs.autohand.ai/integrations/ai-model-providers"><kbd><img src="../../src/assets/modelIcons/autohand.svg" alt="Autohand logo" width="16" valign="middle" /> Autohand</kbd></a> &nbsp;
  <a href="https://github.com/open-horizon-labs/oh-omp"><kbd><img src="../../src/assets/modelIcons/omp.svg" alt="OMP logo" width="16" valign="middle" /> OMP</kbd></a> &nbsp;
  <a href="https://pi.dev/docs/latest/providers"><kbd><img src="../../src/assets/modelIcons/pi.svg" alt="Pi logo" width="16" valign="middle" /> Pi</kbd></a>
</p>

## 下载

当前 build 版本：v1.1.24 (2026-07-16)

一键下载最新 ORGII 桌面应用：

- [macOS Apple Silicon](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg)
- [Windows x64 安装程序](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe)
- [Windows x64 MSI](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi)
- [Linux x64 AppImage](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.AppImage)
- [Linux x64 DEB](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.deb)
- [最新版本的所有资源](https://github.com/org2AI/ORG2/releases/latest)

直接下载链接始终指向 GitHub 的最新版本。

## 从源码开发

如需从源码构建或贡献：

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

更多贡献信息请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md)。我们希望所有人保持尊重与同理心；请参阅 [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md)。

## 可选原生 sidecars

Browser Use 和 Computer Use 功能依赖可选原生 helper，用于浏览器自动化和 macOS 屏幕自动化：

- `agent-browser` 会从适配当前 OS/CPU 的 `vercel-labs/agent-browser` releases 下载。
- `peekaboo` 会在 macOS 上从 `steipete/peekaboo` releases 下载。

Computer Use 目前仅支持 macOS。Browser Use 可在受支持平台上使用 `agent-browser`。

如果缺少 sidecar，Rust build 会创建一个小的 placeholder resource，以便开发构建继续进行。相关能力可能回退到 `PATH`，或在你运行 `pnpm run download:sidecars` 前保持不可用。

## 社区

有任何问题、反馈，或想关注 ORG-2 的发展吗？欢迎加入 Discord：

👉 **Discord：[discord.gg/tvWgAqhCzs](https://discord.gg/tvWgAqhCzs)**
👉 **WeChat：[https://github.com/org2AI/ORG2/issues/128]**

- **#how-to-use-org2** 和 **#faq** — 快速开始使用
- **#announcement** — 版本新闻和更新
- **#lets-chat** — 分享你正在构建的内容并认识社区成员
- **#feedback** — 想法、功能请求和错误报告

## 许可证

ORGII 使用 GNU Affero General Public License v3.0 或更高版本（`AGPL-3.0-or-later`）授权。完整许可证文本请参阅 [`LICENSE`](../../LICENSE)。
