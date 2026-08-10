<div align="center">
  <h1>ORG-2</h1>
  <p><strong>Agent がどのようにソフトウェアを作るかを記録する System of Record。<br />コーディング Agent を実行し、任意のセッションを再生し、チームでレビューし、あらゆる行をその背後にある意思決定まで辿れます。</strong></p>
  <p>Rust と Tauri で構築され、local-first 実行を前提とし、ディスク上のサイズは 100MB 未満です。Agent trajectory の livestream と replay に対応しています。追跡しやすく、レビューしやすい構成です。</p>
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

あるコードがなぜ存在するのか、そしてそれが実際に効果を出したのかを答えるには、常に複数のシステムを手作業でつなぎ合わせる必要がありました。Jira はチケットしか見ていません。Codex は自分のセッションしか見ていません。GitHub はコミットされた行しか見ていません。Amplitude は指標しか見ていません。人間がコードを書いていた頃はそれでも何とかなりました。Agent の速度ではそうはいきません。月曜に書かれたコードは、金曜にはもうレガシーです。

ORG-2 は、チームがコーディング Agent を実行する場所です。ネイティブ Rust ハーネスに加えて 20 以上の Agent CLI 用ランチャーを備え、その記録を自動的に構築します。すべてのセッションは動画のように再生できる trajectory になり、チームメイトは最終的な diff だけでなく、作業が実際にどう組み立てられたかをレビューし、文脈の中でコメントできます。他のツールで実行されたセッションも取り込まれ、その履歴からさかのぼって補完されるため、アプリを一度も経由していない作業も記録に含まれます。記録は、人間が何を求めたか、Agent が何を理解したか、そして実際に何をしたかを結び付けるので、出荷されたどの行も、それを書いたセッションまで辿れます。

これは単なるもう一つの AI コーディングツールではありません。人間と Agent からなる組織と、組織レベルの alignment に関する実験です。ORG-II は Agents を、構造化された組織の中の永続的で観測可能な同僚として扱います。再生可能な実行、セッション横断メモリ、AI blame、そして local-first の Rust runtime によって、人間、Agents、チームが共有コンテキストと aligned goals を中心に協働できるようにします。

## 機能

<table>
<tr><td width="50%" valign="middle"><h3>組み込み Rust ハーネス</h3><p>既存の API キーと Agent サブスクリプションを使って、高速でトークン効率が高く、カスタマイズ可能なネイティブ Agent を実行できます。</p></td><td width="50%"><img src="../assets/feature-wall/rust-harness.gif" alt="ORG-II Rust ハーネスで Agent を実行" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>10 以上のアプリと CLI のセッションを管理</h3><p>すべてのツールの Agent セッションを 1 か所で読み込み、管理できます。アプリを切り替えずに履歴をスキャンし、subagent を確認し、各ソースを制御できます。</p></td><td width="50%"><img src="../assets/feature-wall/session-sources.png" alt="ORG-II でアプリと CLI の Agent セッションソースを管理" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>チームを組み、PR だけでなく軌跡をレビュー</h3><p>チームを編成し、デバイスやチームメンバー間でセッションを共有できます。結果の diff だけでなく Agent の軌跡全体をレビューし、文脈に沿ってコメントできます。</p></td><td width="50%"><img src="../assets/feature-wall/team-trajectory-review.png" alt="ORG-II でチームメンバーと軌跡リプレイ権限を管理" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>ツール呼び出しを動画として再生</h3><p>ネイティブ Rust ハーネスと 15 以上の CLI Agent の作業を再生できます。メッセージ、ツール呼び出し、ファイル編集、コマンド出力が、レビュー可能な 1 本の timeline で同期されます。</p></td><td width="50%"><img src="../assets/feature-wall/replay.gif" alt="ORG-II で Agent セッションを再生" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Git blame だけでなく AI blame</h3><p>誰が行を変更したかだけで終わりません。その変更を生んだ Agent セッション、ツール呼び出し、意思決定まで追跡できます。</p></td><td width="50%"><img src="../assets/feature-wall/ai-blame.gif" alt="ORG-II でコード変更を Agent セッションと意思決定まで追跡" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>進捗を見失わない</h3><p>タスクと Agent セッションに時間をどう使っているかを確認できます。日次アクティビティ timeline で所要時間、コード変更、優先順位を把握できます。</p></td><td width="50%"><img src="../assets/feature-wall/work-diary.png" alt="ORG-II でタスクと Agent セッションに費やした時間を確認" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>完全な開発ワークスペース</h3><p>Agent ワークスペースを離れずに、ターミナル、ソース管理、Git 履歴、pull request レビューを利用できます。</p></td><td width="50%"><img src="../assets/feature-wall/development-workspace.gif" alt="ORG-II のソース管理、Git 履歴、コードレビュー機能" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>デザインモード</h3><p>ネイティブ WebKit ブラウザでライブページを調査できます。要素を選択し、その正確なページコンテキストを Agent に直接送って、簡単に修正できます。</p></td><td width="50%"><img src="../assets/feature-wall/design-mode.gif" alt="ORG-II デザインモードで Web ページ要素を調査" width="100%" /></td></tr>
</table>

## その他の機能

- GUI、CLI、Terminal、Git、ブラウザ、LSP、timeline、データベースツール。
- セッション横断メモリ、Agents 間の知識共有、共有 Workspace 状態。
- CPU、RAM、人間の注意力の可用性に反応できるリソース認識実行。
- 監督付き自己進化のための Agent-powered GUI end-to-end テスト。
- Agents が夜間に実行したり、不在中に作業を継続したりできる scheduling と auto-started sessions。
- 人間、Agents、目標、accountability を調整する org-level alignment surfaces（WIP）。
- self-hosted Supabase による session collaboration とグループ issue workflows（WIP）。

## 対応 Agent

ORG-II の組み込み Rust ハーネスを使うか、デスクトップアプリから対応する coding-agent CLI を起動できます。

### GUI + TUI

<p>
  <a href="#機能"><kbd><img src="../assets/org2-icon.svg" alt="ORG-2 ロゴ" width="22" valign="middle" /> ORG-2</kbd></a> &nbsp;
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

## ダウンロード

現在のビルドバージョン：v1.1.24 (2026-07-16)

最新の ORGII デスクトップアプリをワンクリックでダウンロードできます：

- [macOS Apple Silicon](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg)
- [Windows x64 インストーラー](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe)
- [Windows x64 MSI](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi)
- [Linux x64 AppImage](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.AppImage)
- [Linux x64 DEB](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.deb)
- [最新リリースのすべてのアセット](https://github.com/org2AI/ORG2/releases/latest)

直接ダウンロードリンクは常に GitHub の最新リリースを参照します。

## ソースから開発

ソースからビルドまたはコントリビュートするには：

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

コントリビューションの詳細は [CONTRIBUTING.md](../../CONTRIBUTING.md) を参照してください。すべての参加者に敬意と共感を求めます。[CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md) も参照してください。

## オプションのネイティブ sidecars

Browser Use と Computer Use は、ブラウザ自動化および macOS 画面自動化のためのオプションのネイティブ helpers に依存します：

- `agent-browser` は現在の OS/CPU 向けに `vercel-labs/agent-browser` releases からダウンロードされます。
- `peekaboo` は macOS で `steipete/peekaboo` releases からダウンロードされます。

Computer Use は現在 macOS のみで利用できます。Browser Use は対応プラットフォームで `agent-browser` を使用できます。

sidecar がない場合、Rust build は開発ビルドを継続できるように小さな placeholder resource を作成します。関連機能は `PATH` にフォールバックするか、`pnpm run download:sidecars` を実行するまで利用できない場合があります。

## コミュニティ

質問やフィードバックがありますか？ ORG-2 の進化をフォローしたいですか？ Discord にご参加ください：

👉 **Discord：[discord.gg/tvWgAqhCzs](https://discord.gg/tvWgAqhCzs)**
👉 **WeChat：[https://github.com/org2AI/ORG2/issues/128]**

- **#how-to-use-org2** と **#faq** — 利用開始のサポート
- **#announcement** — リリースニュースと更新情報
- **#lets-chat** — 作っているものを共有し、コミュニティと交流
- **#feedback** — アイデア、機能リクエスト、バグ報告

## ライセンス

ORGII は GNU Affero General Public License v3.0 以降（`AGPL-3.0-or-later`）でライセンスされています。完全なライセンス本文は [`LICENSE`](../../LICENSE) を参照してください。
