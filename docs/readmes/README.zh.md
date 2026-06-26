<div align="center">
  <h1>ORG-2</h1>
  <p><strong>开源的 Cursor 风格 Agent IDE——但它为可审查性、可追踪性和创作自由而构建，而不只是为了更快写代码。</strong></p>
  <p>基于 Rust 和 Tauri 构建，面向 local-first 执行，磁盘占用低于 100MB。支持 Agent 轨迹直播和回放，易于跟踪和审查。</p>
  <p>
    <a href="../../LICENSE"><img alt="License" src="https://img.shields.io/github/license/yorgai/ORG2?style=flat-square" /></a>
    <a href="https://github.com/yorgai/ORG2/releases/latest"><img alt="Downloads" src="https://img.shields.io/github/downloads/yorgai/ORG2/total?style=flat-square&label=downloads" /></a>
    <a href="https://github.com/yorgai/ORG2/commits/develop"><img alt="Last commit" src="https://img.shields.io/github/last-commit/yorgai/ORG2?style=flat-square&label=last%20commit" /></a>
    <a href="https://github.com/yorgai/ORG2/graphs/commit-activity"><img alt="Commit activity" src="https://img.shields.io/github/commit-activity/m/yorgai/ORG2?style=flat-square&label=commit%20activity" /></a>
  </p>
</div>

---

<p align="center">
  <a href="https://github.com/yorgai/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg"><strong>macOS Apple Silicon</strong></a>
  ·
  <a href="https://github.com/yorgai/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe"><strong>Windows installer</strong></a>
  ·
  <a href="https://github.com/yorgai/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi"><strong>Windows MSI</strong></a>
  ·
  <a href="https://github.com/yorgai/ORG2/releases/latest"><strong>All latest release assets</strong></a>
</p>

---

<p align="center">
  <a href="../../README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.zh.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <a href="README.es.md">Español</a> · <a href="README.ru.md">Русский</a> · <a href="README.pt.md">Português</a> · <a href="README.de.md">Deutsch</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.vi.md">Tiếng Việt</a> · <a href="README.pl.md">Polski</a>
</p>

<p align="center">
  <video src="https://github.com/user-attachments/assets/bd4833d2-4cc4-4971-9805-84529b14d01a" controls width="720"></video>
</p>

它不只是另一个 AI 编程工具；它是一次关于人类/Agent 组织以及组织级对齐的实验。Agent 正在变得更强，但协作、可观测性、结构化流程和共享责任并没有同步提升——在某些情况下甚至变得更差。Cursor、Claude Code 和类似工具通常把 Agent 当作外包助手：它们对产出很有帮助，但很难在系统层面进行审计、协调、对齐或演进。

ORG-II 探索另一种模式：把 Agent 视为结构化组织中持久、可观测的同事。它不是无状态、难以审查的 AI IDE 会话，而是引入可回放的 Agent 执行、跨会话记忆、AI blame，以及 local-first 的 Rust runtime，让人类、Agent 和团队能够围绕共享上下文与对齐目标协作。

## 核心能力

- 支持长时间运行的会话，并提供可回放执行轨迹，用于审计、评审和调试。
- 基于 Rust 的 Agent，可使用你已有的 API keys 和 Agent 订阅。
- 集成 GUI、CLI、Terminal、Git、浏览器、LSP、Timeline 和数据库工具。
- 跨会话记忆、跨 Agent 知识共享，以及共享的 Workspace 状态。
- 资源感知执行，可根据 CPU、RAM 和人类注意力可用性做出反应。
- Agent 驱动的 GUI end-to-end 测试，用于受监督的自我演化。
- 支持调度和自动启动会话，让 Agent 可以通宵运行，或在你离开时继续工作。
- 面向组织级对齐的界面，用于协调人类、Agent、目标和责任归属（WIP）。
- 通过自托管 Supabase 支持会话协作和群组 issue 工作流（WIP）。

## 下载

从 [Releases](https://github.com/YORG-AI/ORGII/releases) 页面获取最新的 ORGII desktop app。打开最新 release，下载适合你平台的安装器或 app bundle，并按照操作系统提示安装 ORGII。

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

## 许可证

ORGII 使用 GNU Affero General Public License v3.0 或更高版本（`AGPL-3.0-or-later`）授权。完整许可证文本请参阅 [`LICENSE`](../../LICENSE)。
