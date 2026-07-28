<div align="center">
  <h1>ORG-2</h1>
  <p><strong>記錄 Agent 如何構建軟體的系統（System of Record）。<br />執行你的編程 Agent——重播任意工作階段、與團隊一起審查，並把每一行程式碼追溯到它背後的決策。</strong></p>
  <p>基於 Rust 與 Tauri 建構，面向 local-first 執行，磁碟占用低於 100MB。支援 Agent 軌跡直播與重播，易於追蹤與審查。</p>
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

要回答一段程式碼為什麼存在、以及它是否真的奏效，一直都需要手動把多個系統拼接起來。Jira 只看得到工單。Codex 只看得到自己的工作階段。GitHub 只看得到提交的程式碼行。Amplitude 只看得到指標。當程式碼由人類編寫時，這還勉強撐得住；在 Agent 的速度下則不然：週一寫的程式碼，到週五就成了遺留程式碼。

ORG-2 就是你的團隊執行編程 Agent 的地方——內建原生 Rust harness，外加 20+ 個 Agent CLI 的啟動器——並自動建構這份記錄。每個工作階段都會成為一條可以像影片一樣重播的軌跡，隊友據此審查工作究竟是如何完成的，而不只是看最終 diff，並在上下文中留下評論。在其他工具裡執行的工作階段也會被接入，並從它們的歷史中回填，因此這份記錄同樣涵蓋從未經過本應用的工作。記錄把人類提出的要求、Agent 的理解、以及它實際做了什麼連結在一起，因此任何上線的程式碼行都能追溯到寫下它的那次工作階段。

它不只是另一個 AI 編程工具；它是一次關於人類/Agent 組織以及組織級對齊的實驗。ORG-II 把 Agent 視為結構化組織中持久、可觀測的同事——可重播的執行、跨工作階段記憶、AI blame，以及 local-first 的 Rust runtime，讓人類、Agent 與團隊能夠圍繞共享上下文與對齊目標協作。

## 功能

<table>
<tr><td width="50%" valign="middle"><h3>內建 Rust Harness</h3><p>使用你現有的 API 金鑰與 Agent 訂閱，執行快速、節省 token 且可自訂的原生 Agent。</p></td><td width="50%"><img src="../assets/feature-wall/rust-harness.gif" alt="使用 ORG-II Rust Harness 執行 Agent" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>管理超過 10 種應用程式與 CLI 的會話</h3><p>在同一處載入並管理所有工具的 Agent 會話。無需切換應用程式，即可掃描歷史記錄、檢查 subagent 並控制每個來源。</p></td><td width="50%"><img src="../assets/feature-wall/session-sources.png" alt="在 ORG-II 中管理應用程式與 CLI 的 Agent 會話來源" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>建立團隊並審查軌跡，而不只是 PR</h3><p>建立團隊，並在裝置與隊友之間共享會話。審查完整的 Agent 軌跡，而不只是最後的 diff，並在上下文中留下評論。</p></td><td width="50%"><img src="../assets/feature-wall/team-trajectory-review.png" alt="在 ORG-II 中管理隊友與軌跡重播權限" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>工具呼叫，現在可像影片一樣播放</h3><p>重播原生 Rust Harness 與超過 15 個 CLI Agent 的工作。訊息、工具呼叫、檔案編輯與指令輸出會同步在單一可審查的時間軸中。</p></td><td width="50%"><img src="../assets/feature-wall/replay.gif" alt="在 ORG-II 中重播 Agent 會話" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>AI blame，而不只是 Git blame</h3><p>別只停在誰改了某一行。追溯到促成該變更的 Agent 會話、工具呼叫與決策。</p></td><td width="50%"><img src="../assets/feature-wall/ai-blame.gif" alt="在 ORG-II 中將程式碼變更追溯到 Agent 會話與決策" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>保持方向</h3><p>查看時間如何分配在任務與 Agent 會話上。每日活動時間軸讓耗時、程式碼變更與優先順序保持清楚可見。</p></td><td width="50%"><img src="../assets/feature-wall/work-diary.png" alt="在 ORG-II 中檢視任務與 Agent 會話所花費的時間" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>完整開發工作區</h3><p>無需離開 Agent 工作區，即可使用終端機、管理原始碼控制、追蹤 Git 歷史並審查 pull request。</p></td><td width="50%"><img src="../assets/feature-wall/development-workspace.gif" alt="ORG-II 中的原始碼控制、Git 歷史與程式碼審查工具" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>設計模式</h3><p>在原生 WebKit 瀏覽器中檢查即時頁面。選取元素，將其精確頁面上下文直接傳送給 Agent，快速完成修正。</p></td><td width="50%"><img src="../assets/feature-wall/design-mode.gif" alt="使用 ORG-II 設計模式檢查網頁元素" width="100%" /></td></tr>
</table>

## 更多能力

- 整合 GUI、CLI、Terminal、Git、瀏覽器、LSP、Timeline 與資料庫工具。
- 跨會話記憶、跨 Agent 知識共享，以及共享的 Workspace 狀態。
- 資源感知執行，可根據 CPU、RAM 與人類注意力可用性做出反應。
- Agent 驅動的 GUI end-to-end 測試，用於受監督的自我演化。
- 支援排程與自動啟動會話，讓 Agent 可以通宵執行，或在你離開時繼續工作。
- 面向組織級對齊的介面，用於協調人類、Agent、目標與責任歸屬（WIP）。
- 透過自託管 Supabase 支援會話協作與群組 issue 工作流（WIP）。

## 支援的 Agent

使用 ORG-II 內建的 Rust Harness，或從桌面應用程式啟動這些受支援的 coding-agent CLI。

### GUI + TUI

<p>
  <a href="#功能"><kbd><img src="../assets/org2-icon.svg" alt="ORG-2 標誌" width="22" valign="middle" /> ORG-2</kbd></a> &nbsp;
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

## 下載

目前 build 版本：v1.1.24 (2026-07-16)

一鍵下載最新 ORGII 桌面應用程式：

- [macOS Apple Silicon](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg)
- [Windows x64 安裝程式](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe)
- [Windows x64 MSI](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi)
- [Linux x64 AppImage](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.AppImage)
- [Linux x64 DEB](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.deb)
- [最新版本的所有資源](https://github.com/org2AI/ORG2/releases/latest)

直接下載連結永遠指向 GitHub 的最新版本。

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

## 社群

有任何問題、意見，或想關注 ORG-2 的發展嗎？歡迎加入 Discord：

👉 **Discord：[discord.gg/tvWgAqhCzs](https://discord.gg/tvWgAqhCzs)**
👉 **WeChat：[https://github.com/org2AI/ORG2/issues/128]**

- **#how-to-use-org2** 與 **#faq** — 快速開始使用
- **#announcement** — 版本消息與更新
- **#lets-chat** — 分享你正在打造的內容並認識社群
- **#feedback** — 點子、功能建議與錯誤回報

## 授權

ORGII 使用 GNU Affero General Public License v3.0 或更新版本（`AGPL-3.0-or-later`）授權。完整授權文字請參閱 [`LICENSE`](../../LICENSE)。
