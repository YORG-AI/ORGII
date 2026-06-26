<div align="center">
  <h1>ORG-2</h1>
  <p><strong>開源的 Cursor 風格 Agent IDE——但它為可審查性、可追蹤性與創作自由而建構，而不只是為了更快寫程式。</strong></p>
  <p>基於 Rust 與 Tauri 建構，面向 local-first 執行，磁碟占用低於 100MB。支援 Agent 軌跡直播與重播，易於追蹤與審查。</p>
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

它不只是另一個 AI 程式開發工具；它是一次關於人類/Agent 組織與組織級對齊的實驗。Agent 正在變得更強，但協作、可觀測性、結構化流程與共享責任並沒有同步跟上——在某些情況下甚至變得更差。Cursor、Claude Code 與類似工具通常把 Agent 當成外包助手：它們對產出很有幫助，但很難在系統層級進行稽核、協調、對齊或演進。

ORG-II 探索另一種模式：把 Agent 視為結構化組織中持久且可觀測的同事。它不是無狀態、難以審查的 AI IDE 會話，而是引入可重播的 Agent 執行、跨會話記憶、AI blame，以及 local-first 的 Rust runtime，讓人類、Agent 與團隊能圍繞共享上下文和對齊目標協作。

## 核心能力

- 支援長時間執行的會話，並提供可重播執行軌跡，用於稽核、審查與除錯。
- 基於 Rust 的 Agent，可使用你既有的 API keys 與 Agent 訂閱。
- 整合 GUI、CLI、Terminal、Git、瀏覽器、LSP、Timeline 與資料庫工具。
- 跨會話記憶、跨 Agent 知識共享，以及共享的 Workspace 狀態。
- 資源感知執行，可根據 CPU、RAM 與人類注意力可用性做出反應。
- Agent 驅動的 GUI end-to-end 測試，用於受監督的自我演化。
- 支援排程與自動啟動會話，讓 Agent 可以通宵執行，或在你離開時繼續工作。
- 面向組織級對齊的介面，用於協調人類、Agent、目標與責任歸屬（WIP）。
- 透過自託管 Supabase 支援會話協作與群組 issue 工作流（WIP）。

## 下載

從 [Releases](https://github.com/YORG-AI/ORGII/releases) 頁面取得最新 ORGII desktop app。開啟最新 release，下載適合你平台的安裝程式或 app bundle，並依照作業系統提示安裝 ORGII。

## 從原始碼開發

若要從原始碼建置或貢獻：

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

更多貢獻資訊請參閱 [CONTRIBUTING.md](../../CONTRIBUTING.md)。我們希望所有人保持尊重與同理心；請參閱 [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md)。

## 可選原生 sidecars

Browser Use 與 Computer Use 功能依賴可選原生 helper，用於瀏覽器自動化與 macOS 螢幕自動化：

- `agent-browser` 會從適配目前 OS/CPU 的 `vercel-labs/agent-browser` releases 下載。
- `peekaboo` 會在 macOS 上從 `steipete/peekaboo` releases 下載。

Computer Use 目前僅支援 macOS。Browser Use 可在受支援平台上使用 `agent-browser`。

如果缺少 sidecar，Rust build 會建立一個小型 placeholder resource，讓開發建置可以繼續。相關能力可能回退到 `PATH`，或在你執行 `pnpm run download:sidecars` 前保持不可用。

## 授權

ORGII 使用 GNU Affero General Public License v3.0 或更新版本（`AGPL-3.0-or-later`）授權。完整授權文字請參閱 [`LICENSE`](../../LICENSE)。
