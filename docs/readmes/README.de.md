<div align="center">
  <h1>ORG-2</h1>
  <p><strong>Das System of Record für Software, die mit Agents gebaut wird.<br />Führe deine Coding-Agents aus — spiele jede Session ab, prüfe sie im Team und verfolge jede Zeile zurück bis zur Entscheidung dahinter.</strong></p>
  <p>Gebaut mit Rust und Tauri für local-first Ausführung mit weniger als 100 MB auf der Festplatte. Unterstützt Livestream und Replay von Agent-Trajektorien. Leicht zu verfolgen und zu prüfen.</p>
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

Die Frage zu beantworten, warum ein Stück Code existiert — und ob es funktioniert hat — hieß immer, mehrere Systeme von Hand zusammenzunähen. Jira sieht nur Tickets. Codex sieht nur die eigenen Sessions. GitHub sieht nur committete Zeilen. Amplitude sieht nur Metriken. Das war tragbar, solange Menschen den Code schrieben. Bei Agent-Geschwindigkeit ist es das nicht mehr: Code von Montag ist am Freitag Legacy.

ORG-2 ist der Ort, an dem dein Team seine Coding-Agents ausführt — ein nativer Rust-Harness plus Launcher für über 20 Agent-CLIs — und es baut diesen Record automatisch auf. Jede Session wird zu einer Trajektorie, die Teamkolleg:innen wie ein Video abspielen: Sie prüfen, wie die Arbeit tatsächlich entstanden ist, statt nur den Diff, und kommentieren im Kontext. Sessions aus anderen Tools werden eingelesen und aus deren Historie nachgetragen, sodass der Record auch Arbeit abdeckt, die nie durch die App lief. Er verknüpft, was der Mensch verlangt hat, was der Agent verstanden hat und was er tatsächlich getan hat — jede ausgelieferte Zeile lässt sich bis zur Session zurückverfolgen, die sie geschrieben hat.

Es ist nicht nur ein weiteres AI-Coding-Tool; es ist ein Experiment zu Mensch/Agent-Organisationen und Alignment auf Organisationsebene. ORG-II behandelt Agents als persistente, beobachtbare Kolleg:innen innerhalb einer strukturierten Organisation — wiederholbare Ausführung, sitzungsübergreifendes Gedächtnis, AI blame und eine local-first Rust Runtime, damit Menschen, Agents und Teams rund um gemeinsamen Kontext und ausgerichtete Ziele zusammenarbeiten können.

## Funktionen

<table>
<tr>
<td width="50%" valign="middle">

### Integriertes Rust-Harness

Führen Sie schnelle, tokensparende und anpassbare native Agents mit Ihren vorhandenen API-Schlüsseln und Agent-Abonnements aus.

</td>
<td width="50%">
  <img src="../assets/feature-wall/rust-harness.gif" alt="Agents mit dem ORG-II Rust-Harness ausführen" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Sessions in über 10 Apps &amp; CLIs verwalten

Laden und verwalten Sie Agent-Sessions aus allen Ihren Tools an einem Ort. Durchsuchen Sie den Verlauf, prüfen Sie Subagents und steuern Sie jede Quelle, ohne die App zu wechseln.

</td>
<td width="50%">
  <img src="../assets/feature-wall/session-sources.png" alt="Agent-Session-Quellen aus Apps und CLIs in ORG-II verwalten" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Team bilden und Trajektorien prüfen, nicht nur PRs

Stellen Sie Ihr Team zusammen und teilen Sie Sessions geräte- und teamübergreifend. Prüfen Sie die vollständige Agent-Trajektorie statt nur des resultierenden Diffs und hinterlassen Sie Kommentare im Kontext.

</td>
<td width="50%">
  <img src="../assets/feature-wall/team-trajectory-review.png" alt="Teammitglieder und Berechtigungen für Trajektorien-Replays in ORG-II verwalten" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Tool-Aufrufe, jetzt als Videos

Spielen Sie Arbeit aus dem nativen Rust-Harness und mehr als 15 CLI-Agents ab. Nachrichten, Tool-Aufrufe, Dateiänderungen und Befehlsausgaben bleiben in einer prüfbaren Timeline synchronisiert.

</td>
<td width="50%">
  <img src="../assets/feature-wall/replay.gif" alt="Eine Agent-Session in ORG-II wiedergeben" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### AI Blame, nicht nur Git Blame

Bleiben Sie nicht bei der Person stehen, die eine Zeile geändert hat. Verfolgen Sie sie bis zu den Agent-Sessions, Tool-Aufrufen und Entscheidungen zurück, die die Änderung ausgelöst haben.

</td>
<td width="50%">
  <img src="../assets/feature-wall/ai-blame.gif" alt="Codeänderungen auf Agent-Sessions und Entscheidungen in ORG-II zurückführen" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Auf Kurs bleiben

Sehen Sie, wie Ihre Zeit auf Aufgaben und Agent-Sessions verteilt ist. Eine tägliche Aktivitäts-Timeline hält Dauer, Codeänderungen und Prioritäten sichtbar.

</td>
<td width="50%">
  <img src="../assets/feature-wall/work-diary.png" alt="Zeitaufwand für Aufgaben und Agent-Sessions in ORG-II prüfen" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Vollständiger Entwicklungs-Workspace

Nutzen Sie das Terminal, verwalten Sie Source Control, verfolgen Sie den Git-Verlauf und prüfen Sie Pull Requests, ohne Ihren Agent-Workspace zu verlassen.

</td>
<td width="50%">
  <img src="../assets/feature-wall/development-workspace.gif" alt="Source Control, Git-Verlauf und Code-Review-Werkzeuge in ORG-II" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Design-Modus

Untersuchen Sie Live-Seiten im nativen WebKit-Browser. Wählen Sie ein Element aus und senden Sie dessen exakten Seitenkontext direkt an den Agent, um es unkompliziert zu korrigieren.

</td>
<td width="50%">
  <img src="../assets/feature-wall/design-mode.gif" alt="Ein Webseitenelement mit dem ORG-II Design-Modus untersuchen" width="100%" />
</td>
</tr>
</table>

## Weitere Funktionen

- GUI, CLI, Terminal, Git, Browser, LSP, Timeline und Datenbankwerkzeuge.
- Sitzungsübergreifendes Gedächtnis, Wissensaustausch zwischen Agents und geteilter Workspace-Zustand.
- Ressourcenbewusste Ausführung, die auf CPU, RAM und Verfügbarkeit menschlicher Aufmerksamkeit reagieren kann.
- Agent-powered GUI end-to-end Tests für überwachte Selbstevolution.
- Scheduling und automatisch gestartete Sessions, damit Agents über Nacht laufen oder während Ihrer Abwesenheit weiterarbeiten können.
- Oberflächen für org-level Alignment zur Koordination von Menschen, Agents, Zielen und Verantwortlichkeit (WIP).
- Session-Zusammenarbeit und Gruppen-issue-workflows über selbst gehostetes Supabase (WIP).

## Unterstützte Agents

Verwenden Sie das integrierte Rust-Harness von ORG-II oder starten Sie diese unterstützten Coding-Agent-CLIs aus der Desktop-App.

### GUI + TUI

<p>
  <a href="#integriertes-rust-harness"><kbd><img src="../assets/org2-icon.svg" alt="ORG-2-Logo" width="22" valign="middle" /> ORG-2</kbd></a> &nbsp;
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

## Download

Aktuelle Build-Version: v1.1.24 (2026-07-16)

Laden Sie die neueste ORGII-Desktop-App mit einem Klick herunter:

- [macOS Apple Silicon](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg)
- [Windows-x64-Installer](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe)
- [Windows-x64-MSI](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi)
- [Linux-x64-AppImage](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.AppImage)
- [Linux-x64-DEB](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.deb)
- [Alle aktuellen Release-Assets](https://github.com/org2AI/ORG2/releases/latest)

Die direkten Download-Links verwenden immer den GitHub-Zeiger auf das neueste Release.

## Aus dem Quellcode entwickeln

Zum Bauen oder Beitragen aus dem Quellcode:

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

Weitere Details zum Beitragen finden Sie in [CONTRIBUTING.md](../../CONTRIBUTING.md). Wir bitten alle, respektvoll und empathisch zu sein; siehe [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md).

## Optionale native sidecars

Browser Use und Computer Use hängen von optionalen nativen helpers für Browser-Automatisierung und macOS-Bildschirmautomatisierung ab:

- `agent-browser` wird aus den `vercel-labs/agent-browser` releases für das aktuelle OS/CPU heruntergeladen.
- `peekaboo` wird unter macOS aus den `steipete/peekaboo` releases heruntergeladen.

Computer Use ist derzeit nur unter macOS verfügbar. Browser Use kann `agent-browser` auf unterstützten Plattformen verwenden.

Wenn ein sidecar fehlt, erstellt der Rust build eine kleine placeholder resource, damit Development-builds fortgesetzt werden können. Die zugehörige Funktion kann auf `PATH` zurückfallen oder nicht verfügbar bleiben, bis Sie `pnpm run download:sidecars` ausführen.

## Community

Sie haben Fragen, Feedback oder möchten die Entwicklung von ORG-2 verfolgen? Besuchen Sie uns auf Discord:

👉 **Discord: [discord.gg/tvWgAqhCzs](https://discord.gg/tvWgAqhCzs)**
👉 **WeChat: [https://github.com/org2AI/ORG2/issues/128]**

- **#how-to-use-org2** und **#faq** — schnell loslegen
- **#announcement** — Release-Neuigkeiten und Updates
- **#lets-chat** — zeigen Sie, woran Sie arbeiten, und lernen Sie die Community kennen
- **#feedback** — Ideen, Funktionswünsche und Fehlerberichte

## Lizenz

ORGII ist unter der GNU Affero General Public License v3.0 oder später (`AGPL-3.0-or-later`) lizenziert. Den vollständigen Lizenztext finden Sie in [`LICENSE`](../../LICENSE).
