<div align="center">
  <h1>ORG-2</h1>
  <p><strong>System zapisu dla oprogramowania budowanego z Agents.<br />Uruchamiaj swoje Agents do kodu — odtwórz dowolną sesję, zrób review zespołowo i prześledź każdą linię aż do decyzji, która za nią stoi.</strong></p>
  <p>Zbudowane w Rust i Tauri, przeznaczone do local-first execution i zajmujące mniej niż 100 MB na dysku. Obsługuje livestream i replay trajektorii Agents. Łatwe do śledzenia i review.</p>
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

Odpowiedź na pytanie, dlaczego dany fragment kodu istnieje — i czy zadziałał — zawsze wymagała ręcznego zszywania kilku systemów. Jira widzi tylko zgłoszenia. Codex widzi tylko własne sesje. GitHub widzi tylko zacommitowane linie. Amplitude widzi tylko metryki. Dawało się to znieść, gdy kod pisali ludzie. Przy prędkości Agents już nie: kod napisany w poniedziałek w piątek jest legacy.

ORG-2 to miejsce, w którym twój zespół uruchamia swoje Agents do kodu — natywny harness w Rust oraz launchery dla ponad 20 Agent CLI — i automatycznie buduje ten zapis. Każda sesja staje się trajektorią, którą członkowie zespołu odtwarzają jak wideo: sprawdzają, jak praca faktycznie powstała, a nie tylko diff, i komentują w kontekście. Sesje uruchomione w innych narzędziach są wciągane i uzupełniane wstecz z ich historii, więc zapis obejmuje także pracę, która nigdy nie przeszła przez aplikację. Zapis łączy to, o co poprosił człowiek, to, jak zrozumiał to Agent, i to, co faktycznie zrobił — dzięki czemu każdą wydaną linię da się prześledzić do sesji, która ją napisała.

To nie jest kolejne narzędzie do kodowania z AI; to eksperyment dotyczący organizacji ludzi i Agents oraz alignmentu na poziomie organizacji. ORG-II traktuje Agents jak trwałych, obserwowalnych współpracowników w ustrukturyzowanej organizacji — odtwarzalne wykonanie, pamięć między sesjami, AI blame i local-first Rust runtime, aby ludzie, Agents i zespoły mogli współpracować wokół wspólnego kontekstu i aligned goals.

## Funkcje

<table>
<tr><td width="50%" valign="middle"><h3>Wbudowany harness Rust</h3><p>Uruchamiaj szybkie, oszczędzające tokeny i konfigurowalne natywne Agents z istniejącymi kluczami API i subskrypcjami Agents.</p></td><td width="50%"><img src="../assets/feature-wall/rust-harness.gif" alt="Uruchamianie Agents za pomocą harnessu Rust ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Zarządzaj sesjami z ponad 10 aplikacji i CLI</h3><p>Wczytuj i zarządzaj w jednym miejscu sesjami Agent ze wszystkich narzędzi. Przeglądaj historię, sprawdzaj subagents i kontroluj każde źródło bez przełączania aplikacji.</p></td><td width="50%"><img src="../assets/feature-wall/session-sources.png" alt="Zarządzanie źródłami sesji Agent z aplikacji i CLI w ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Zbuduj zespół i przeglądaj trajektorie, nie tylko PR-y</h3><p>Zbuduj zespół i udostępniaj sesje między urządzeniami i członkami zespołu. Przeglądaj pełną trajektorię Agent, a nie tylko wynikowy diff, i dodawaj komentarze w kontekście.</p></td><td width="50%"><img src="../assets/feature-wall/team-trajectory-review.png" alt="Zarządzanie zespołem i uprawnieniami do odtwarzania trajektorii w ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Wywołania narzędzi teraz jako wideo</h3><p>Odtwarzaj pracę z natywnego harnessu Rust i ponad 15 CLI Agents. Wiadomości, wywołania narzędzi, edycje plików i wyniki poleceń są zsynchronizowane na jednej osi czasu do przeglądu.</p></td><td width="50%"><img src="../assets/feature-wall/replay.gif" alt="Odtwarzanie sesji Agent w ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>AI blame, nie tylko Git blame</h3><p>Nie kończ na osobie, która zmieniła linię. Prześledź ją do sesji Agent, wywołań narzędzi i decyzji, które doprowadziły do zmiany.</p></td><td width="50%"><img src="../assets/feature-wall/ai-blame.gif" alt="Śledzenie zmian kodu do sesji i decyzji Agent w ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Trzymaj kurs</h3><p>Sprawdzaj, jak czas rozkłada się między zadania i sesje Agent. Dzienna oś aktywności pokazuje czas trwania, zmiany kodu i priorytety.</p></td><td width="50%"><img src="../assets/feature-wall/work-diary.png" alt="Przegląd czasu poświęconego na zadania i sesje Agent w ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Pełny workspace programistyczny</h3><p>Korzystaj z terminala, zarządzaj kontrolą wersji, śledź historię Git i przeglądaj pull requesty bez opuszczania workspace Agent.</p></td><td width="50%"><img src="../assets/feature-wall/development-workspace.gif" alt="Kontrola wersji, historia Git i narzędzia code review w ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Tryb Design</h3><p>Sprawdzaj aktywne strony w natywnej przeglądarce WebKit. Wybierz element i wyślij jego dokładny kontekst strony bezpośrednio do Agent, aby łatwo go poprawić.</p></td><td width="50%"><img src="../assets/feature-wall/design-mode.gif" alt="Inspekcja elementu strony w trybie Design ORG-II" width="100%" /></td></tr>
</table>

## Więcej możliwości

- GUI, CLI, Terminal, Git, przeglądarka, LSP, timeline i narzędzia baz danych.
- Pamięć między sesjami, wymiana wiedzy między Agents i współdzielony stan Workspace.
- Resource-aware execution, które może reagować na CPU, RAM i dostępność ludzkiej uwagi.
- Agent-powered GUI end-to-end testing dla nadzorowanej samoewolucji.
- Scheduling i auto-started sessions, aby Agents mogły działać przez noc lub kontynuować pracę podczas Twojej nieobecności.
- Powierzchnie org-level alignment do koordynacji ludzi, Agents, celów i accountability (WIP).
- Session collaboration i grupowe issue workflows przez self-hosted Supabase (WIP).

## Obsługiwane Agents

Użyj wbudowanego harnessu Rust ORG-II lub uruchom te obsługiwane CLI coding Agents z aplikacji desktopowej.

### GUI + TUI

<p>
  <a href="#funkcje"><kbd><img src="../assets/org2-icon.svg" alt="Logo ORG-2" width="22" valign="middle" /> ORG-2</kbd></a> &nbsp;
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

## Pobieranie

Bieżąca wersja buildu: v1.1.24 (2026-07-16)

Pobierz najnowszą aplikację desktopową ORGII jednym kliknięciem:

- [macOS Apple Silicon](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg)
- [Instalator Windows x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe)
- [Windows x64 MSI](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi)
- [Linux x64 AppImage](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.AppImage)
- [Linux x64 DEB](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.deb)
- [Wszystkie zasoby najnowszego wydania](https://github.com/org2AI/ORG2/releases/latest)

Bezpośrednie linki pobierania zawsze wskazują najnowsze wydanie w GitHub.

## Rozwój ze źródeł

Aby zbudować projekt lub wnieść wkład ze źródeł:

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

Więcej szczegółów dotyczących wkładu znajdziesz w [CONTRIBUTING.md](../../CONTRIBUTING.md). Prosimy wszystkich o szacunek i empatię; zobacz [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md).

## Opcjonalne natywne sidecars

Funkcje Browser Use i Computer Use zależą od opcjonalnych natywnych helpers do automatyzacji przeglądarki i automatyzacji ekranu macOS:

- `agent-browser` jest pobierany z releases `vercel-labs/agent-browser` dla bieżącego OS/CPU.
- `peekaboo` jest pobierany z releases `steipete/peekaboo` na macOS.

Computer Use jest obecnie dostępne tylko na macOS. Browser Use może używać `agent-browser` na obsługiwanych platformach.

Jeśli brakuje sidecar, Rust build tworzy mały placeholder resource, aby development builds mogły być kontynuowane. Powiązana funkcja może wrócić do `PATH` albo pozostać niedostępna do czasu uruchomienia `pnpm run download:sidecars`.

## Społeczność

Masz pytania, uwagi lub chcesz śledzić rozwój ORG-2? Dołącz do nas na Discordzie:

👉 **Discord: [discord.gg/tvWgAqhCzs](https://discord.gg/tvWgAqhCzs)**
👉 **WeChat: [https://github.com/org2AI/ORG2/issues/128]**

- **#how-to-use-org2** i **#faq** — szybki start
- **#announcement** — informacje o wydaniach i aktualizacjach
- **#lets-chat** — pokaż, co tworzysz, i poznaj społeczność
- **#feedback** — pomysły, prośby o funkcje i zgłoszenia błędów

## Licencja

ORGII jest licencjonowane na warunkach GNU Affero General Public License v3.0 lub nowszej (`AGPL-3.0-or-later`). Pełny tekst licencji znajduje się w [`LICENSE`](../../LICENSE).
