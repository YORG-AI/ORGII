<div align="center">
  <h1>ORG-2</h1>
  <p><strong>Open-source Cursor-style agent IDE<br />— but built for reviewability, traceability, and creative freedom, not just faster coding.</strong></p>
  <p>
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/yorgai/ORG2?style=flat-square" /></a>
    <a href="https://github.com/yorgai/ORG2/releases/latest"><img alt="Downloads" src="https://img.shields.io/github/downloads/yorgai/ORG2/total?style=flat-square&label=downloads" /></a>
    <a href="https://github.com/yorgai/ORG2/commits/develop"><img alt="Last commit" src="https://img.shields.io/github/last-commit/yorgai/ORG2?style=flat-square&label=last%20commit" /></a>
    <a href="https://github.com/yorgai/ORG2/graphs/commit-activity"><img alt="Commit activity" src="https://img.shields.io/github/commit-activity/m/yorgai/ORG2?style=flat-square&label=commit%20activity" /></a>
    <a href="https://discord.gg/tvWgAqhCzs"><img alt="Discord" src="https://img.shields.io/badge/Discord-join%20chat-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  </p>
  <p>
    <a href="https://trendshift.io/repositories/56464?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-56464" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/56464/daily?language=TypeScript" alt="yorgai%2FORG2 | Trendshift" width="250" height="55" /></a>
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
  <a href="README.md">English</a> · <a href="docs/readmes/README.fr.md">Français</a> · <a href="docs/readmes/README.zh.md">简体中文</a> · <a href="docs/readmes/README.zh-Hant.md">繁體中文</a> · <a href="docs/readmes/README.es.md">Español</a> · <a href="docs/readmes/README.ru.md">Русский</a> · <a href="docs/readmes/README.pt.md">Português</a> · <a href="docs/readmes/README.de.md">Deutsch</a> · <a href="docs/readmes/README.ja.md">日本語</a> · <a href="docs/readmes/README.ko.md">한국어</a> · <a href="docs/readmes/README.tr.md">Türkçe</a> · <a href="docs/readmes/README.vi.md">Tiếng Việt</a> · <a href="docs/readmes/README.pl.md">Polski</a>
</p>

<p>Built with Rust and Tauri for local-first execution under 100MB on disk. Supports agent trajectory livestream and replay. Easy to follow and review.</p>

<p align="center">
  <video src="https://github.com/user-attachments/assets/bd4833d2-4cc4-4971-9805-84529b14d01a" controls width="720"></video>
</p>

It is not just another AI coding tool; it is an experiment in human/agent organizations and org-level alignment. Agents are getting better, but collaboration, observability, structure, and shared accountability are not keeping up — and in some cases are getting worse. Cursor, Claude Code, and similar tools often treat agents as outsourced assistants: useful for output, but hard to audit, coordinate, align, or evolve at a system level.

ORG-II explores a different model: agents as persistent, observable colleagues inside a structured organization. Instead of stateless, hard-to-review AI IDE sessions, it introduces replayable agent execution, cross-session memory, AI blame, and a local-first Rust-based runtime so humans, agents, and teams can collaborate around shared context and aligned goals.

## Key capabilities

- Long-running sessions with replayable execution traces for auditing, review, and debugging.
- Rust-based agents that work with your existing API keys and agent subscriptions.
- GUI, CLI, terminal, Git, browser, LSP, timeline, and database tooling.
- Cross-session memory, cross-agent knowledge sharing, and shared workspace state.
- Resource-aware execution that can react to CPU, RAM, and human attention availability.
- Agent-powered GUI end-to-end testing for supervised self-evolution.
- Scheduling and auto-started sessions so agents can run overnight or continue work when you are away.
- Org-level alignment surfaces (issues/projects management) for coordinating humans, agents, goals, and accountability (WIP).
- Session collaboration and group issue workflows via self-hosted Supabase (WIP).

## Download

Current build version: v1.1.3 (2026-06-25)

Download the latest ORGII desktop app with one click:

- [macOS Apple Silicon](https://github.com/yorgai/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg)
- [Windows x64 installer](https://github.com/yorgai/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe)
- [Windows x64 MSI](https://github.com/yorgai/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi)
- [All latest release assets](https://github.com/yorgai/ORG2/releases/latest)

The direct download links always resolve through GitHub's latest release pointer.

## Develop from source

To build or contribute from source:

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

For more contribution details, see [CONTRIBUTING.md](CONTRIBUTING.md). We ask everyone to be respectful and empathetic; see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Optional native sidecars

Browser Use and Computer Use features rely on optional native helpers for browser automation and macOS screen automation:

- `agent-browser` is downloaded from `vercel-labs/agent-browser` releases for the current OS/CPU.
- `peekaboo` is downloaded from `steipete/peekaboo` releases on macOS.

Computer Use is currently available on macOS only. Browser Use can use `agent-browser` on supported platforms.

If a sidecar is missing, the Rust build creates a small placeholder resource so development builds can continue. The related capability may fall back to `PATH` or remain unavailable until you run `pnpm run download:sidecars`.

## Community

Have questions, feedback, or want to follow along as ORG-2 evolves? Join us on Discord:

👉 **Discord: [discord.gg/tvWgAqhCzs](https://discord.gg/tvWgAqhCzs)**
👉 **WeChat: [https://github.com/yorgai/ORG2/issues/128]**

- **#how-to-use-org2** and **#faq** — get up and running
- **#announcement** — release news and updates
- **#lets-chat** — share what you're building and meet the community
- **#feedback** — ideas, feature requests, and bug reports

## License

ORGII is licensed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`). See [`LICENSE`](LICENSE) for the full license text.
