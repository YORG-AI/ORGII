<div align="center">
  <h1>ORG-2</h1>
  <p><strong>Agent로 만든 소프트웨어를 위한 System of Record.<br />코딩 Agent를 실행하고, 어떤 세션이든 재생하고, 팀으로 리뷰하고, 모든 라인을 그 뒤의 결정까지 추적하세요.</strong></p>
  <p>Rust와 Tauri로 구축되어 100MB 미만의 디스크 사용량으로 local-first 실행을 지원합니다. Agent trajectory livestream과 replay를 지원합니다. 따라가기 쉽고 리뷰하기 쉽습니다.</p>
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

어떤 코드가 왜 존재하는지, 그리고 그것이 실제로 효과가 있었는지 답하려면 늘 여러 시스템을 손으로 이어 붙여야 했습니다. Jira는 티켓만 봅니다. Codex는 자기 세션만 봅니다. GitHub는 커밋된 라인만 봅니다. Amplitude는 지표만 봅니다. 사람이 코드를 쓰던 시절에는 그럭저럭 버틸 만했습니다. Agent의 속도에서는 아닙니다. 월요일에 쓴 코드가 금요일이면 레거시가 됩니다.

ORG-2는 팀이 코딩 Agent를 실행하는 곳입니다. 네이티브 Rust 하네스와 20개 이상의 Agent CLI 런처를 갖추고, 그 기록을 자동으로 만들어 냅니다. 모든 세션은 동료가 영상처럼 재생할 수 있는 trajectory가 되어, 최종 diff만이 아니라 작업이 실제로 어떻게 만들어졌는지를 리뷰하고 맥락 안에서 코멘트할 수 있습니다. 다른 도구에서 실행된 세션도 수집되고 그 히스토리에서 소급해 채워지므로, 앱을 한 번도 거치지 않은 작업까지 기록에 포함됩니다. 기록은 사람이 무엇을 요청했는지, Agent가 무엇으로 이해했는지, 그리고 실제로 무엇을 했는지를 연결하므로 배포된 모든 라인은 그것을 작성한 세션까지 추적됩니다.

이것은 또 하나의 AI 코딩 도구가 아닙니다. 인간과 Agent로 이루어진 조직, 그리고 조직 수준의 alignment에 대한 실험입니다. ORG-II는 Agents를 구조화된 조직 안의 지속적이고 관찰 가능한 동료로 다룹니다. 재생 가능한 실행, 세션 간 메모리, AI blame, local-first Rust runtime을 통해 인간, Agents, 팀이 공유 컨텍스트와 aligned goals를 중심으로 협업할 수 있게 합니다.

## 기능

<table>
<tr><td width="50%" valign="middle"><h3>내장 Rust 하네스</h3><p>기존 API 키와 Agent 구독으로 빠르고 토큰 효율적이며 사용자 지정 가능한 네이티브 Agent를 실행하세요.</p></td><td width="50%"><img src="../assets/feature-wall/rust-harness.gif" alt="ORG-II Rust 하네스로 Agent 실행" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>10개 이상의 앱과 CLI 세션 관리</h3><p>모든 도구의 Agent 세션을 한곳에서 불러오고 관리하세요. 앱을 전환하지 않고 기록을 검색하고 subagent를 살펴보고 각 소스를 제어할 수 있습니다.</p></td><td width="50%"><img src="../assets/feature-wall/session-sources.png" alt="ORG-II에서 앱과 CLI의 Agent 세션 소스 관리" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>팀을 구성하고 PR뿐 아니라 궤적까지 리뷰</h3><p>팀을 구성하고 기기와 팀원 사이에서 세션을 공유하세요. 결과 diff뿐 아니라 Agent의 전체 궤적을 리뷰하고 맥락에 맞게 댓글을 남길 수 있습니다.</p></td><td width="50%"><img src="../assets/feature-wall/team-trajectory-review.png" alt="ORG-II에서 팀원과 궤적 replay 권한 관리" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Tool call을 이제 영상으로</h3><p>네이티브 Rust 하네스와 15개 이상의 CLI Agent 작업을 replay하세요. 메시지, tool call, 파일 편집, 명령 출력이 하나의 검토 가능한 timeline에 동기화됩니다.</p></td><td width="50%"><img src="../assets/feature-wall/replay.gif" alt="ORG-II에서 Agent 세션 replay" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Git blame을 넘어 AI blame</h3><p>누가 한 줄을 변경했는지만 확인하지 마세요. 변경을 만든 Agent 세션, tool call, 의사결정까지 추적할 수 있습니다.</p></td><td width="50%"><img src="../assets/feature-wall/ai-blame.gif" alt="ORG-II에서 코드 변경을 Agent 세션과 의사결정까지 추적" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>진행 방향 유지</h3><p>작업과 Agent 세션에 시간을 어떻게 쓰는지 확인하세요. 일일 활동 timeline에서 소요 시간, 코드 변경, 우선순위를 계속 파악할 수 있습니다.</p></td><td width="50%"><img src="../assets/feature-wall/work-diary.png" alt="ORG-II에서 작업과 Agent 세션에 사용한 시간 검토" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>완전한 개발 워크스페이스</h3><p>Agent 워크스페이스를 벗어나지 않고 터미널, 소스 제어, Git 기록, pull request 리뷰를 이용하세요.</p></td><td width="50%"><img src="../assets/feature-wall/development-workspace.gif" alt="ORG-II의 소스 제어, Git 기록, 코드 리뷰 도구" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>디자인 모드</h3><p>네이티브 WebKit 브라우저에서 실제 페이지를 검사하세요. 요소를 선택하고 정확한 페이지 컨텍스트를 Agent에 바로 보내 간단히 수정할 수 있습니다.</p></td><td width="50%"><img src="../assets/feature-wall/design-mode.gif" alt="ORG-II 디자인 모드로 웹 페이지 요소 검사" width="100%" /></td></tr>
</table>

## 더 많은 기능

- GUI, CLI, Terminal, Git, 브라우저, LSP, timeline, 데이터베이스 도구.
- 세션 간 메모리, Agents 간 지식 공유, 공유 Workspace 상태.
- CPU, RAM, 인간의 주의 가능성에 반응할 수 있는 리소스 인식 실행.
- 감독된 자기 진화를 위한 Agent-powered GUI end-to-end 테스트.
- Agents가 밤새 실행되거나 사용자가 자리를 비운 동안 계속 작업할 수 있도록 하는 scheduling 및 auto-started sessions.
- 인간, Agents, 목표, accountability를 조정하기 위한 org-level alignment surfaces (WIP).
- self-hosted Supabase를 통한 session collaboration 및 그룹 issue workflows (WIP).

## 지원되는 Agent

ORG-II의 내장 Rust 하네스를 사용하거나 데스크톱 앱에서 지원되는 coding-agent CLI를 실행하세요.

### GUI + TUI

<p>
  <a href="#기능"><kbd><img src="../assets/org2-icon.svg" alt="ORG-2 로고" width="22" valign="middle" /> ORG-2</kbd></a> &nbsp;
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

## 다운로드

현재 빌드 버전: v1.1.24 (2026-07-16)

최신 ORGII 데스크톱 앱을 한 번에 다운로드하세요:

- [macOS Apple Silicon](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg)
- [Windows x64 설치 프로그램](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe)
- [Windows x64 MSI](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi)
- [Linux x64 AppImage](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.AppImage)
- [Linux x64 DEB](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.deb)
- [최신 릴리스의 모든 에셋](https://github.com/org2AI/ORG2/releases/latest)

직접 다운로드 링크는 항상 GitHub의 최신 릴리스를 가리킵니다.

## 소스에서 개발

소스에서 빌드하거나 기여하려면:

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

기여에 대한 자세한 내용은 [CONTRIBUTING.md](../../CONTRIBUTING.md)를 참고하세요. 모든 참여자에게 존중과 공감을 요청합니다. [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md)도 참고하세요.

## 선택적 네이티브 sidecars

Browser Use와 Computer Use 기능은 브라우저 자동화 및 macOS 화면 자동화를 위한 선택적 네이티브 helpers에 의존합니다:

- `agent-browser`는 현재 OS/CPU에 맞는 `vercel-labs/agent-browser` releases에서 다운로드됩니다.
- `peekaboo`는 macOS에서 `steipete/peekaboo` releases에서 다운로드됩니다.

Computer Use는 현재 macOS에서만 사용할 수 있습니다. Browser Use는 지원 플랫폼에서 `agent-browser`를 사용할 수 있습니다.

sidecar가 없으면 Rust build는 개발 빌드를 계속할 수 있도록 작은 placeholder resource를 만듭니다. 관련 기능은 `PATH`로 폴백하거나 `pnpm run download:sidecars`를 실행할 때까지 사용할 수 없을 수 있습니다.

## 커뮤니티

질문이나 피드백이 있거나 ORG-2의 발전을 함께 보고 싶으신가요? Discord에 참여하세요:

👉 **Discord: [discord.gg/tvWgAqhCzs](https://discord.gg/tvWgAqhCzs)**
👉 **WeChat: [https://github.com/org2AI/ORG2/issues/128]**

- **#how-to-use-org2** 및 **#faq** — 빠르게 시작하기
- **#announcement** — 릴리스 소식과 업데이트
- **#lets-chat** — 만들고 있는 것을 공유하고 커뮤니티와 만나기
- **#feedback** — 아이디어, 기능 요청, 버그 리포트

## 라이선스

ORGII는 GNU Affero General Public License v3.0 이상(`AGPL-3.0-or-later`)으로 라이선스됩니다. 전체 라이선스 전문은 [`LICENSE`](../../LICENSE)를 참고하세요.
