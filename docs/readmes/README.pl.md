<div align="center">
  <h1>ORG-2</h1>
  <p><strong>Open-source Agent IDE w stylu Cursor — ale zbudowane z myślą o łatwości review, traceability i twórczej wolności, nie tylko o szybszym kodowaniu.</strong></p>
  <p>Zbudowane w Rust i Tauri, przeznaczone do local-first execution i zajmujące mniej niż 100 MB na dysku. Obsługuje livestream i replay trajektorii Agents. Łatwe do śledzenia i review.</p>
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

To nie jest po prostu kolejne narzędzie do kodowania AI; to eksperyment dotyczący organizacji human/Agent oraz org-level alignment. Agents stają się coraz lepsze, ale collaboration, observability, struktura i wspólna accountability nie nadążają — a w niektórych przypadkach się pogarszają. Cursor, Claude Code i podobne narzędzia często traktują Agents jak zewnętrznych asystentów: przydatnych do generowania wyników, ale trudnych do audytu, koordynacji, alignmentu lub rozwoju na poziomie systemu.

ORG-II bada inny model: Agents jako trwałych, obserwowalnych współpracowników w ustrukturyzowanej organizacji. Zamiast bezstanowych i trudnych do przeglądu AI IDE sessions, wprowadza odtwarzalne wykonanie Agents, pamięć między sesjami, AI blame i local-first Rust runtime, aby ludzie, Agents i zespoły mogli współpracować wokół wspólnego kontekstu i aligned goals.

## Kluczowe możliwości

- Długotrwałe sessions z odtwarzalnymi execution traces do audytu, przeglądu i debugowania.
- Agents oparte na Rust, działające z Twoimi istniejącymi API keys i subskrypcjami Agents.
- GUI, CLI, Terminal, Git, przeglądarka, LSP, timeline i narzędzia baz danych.
- Pamięć między sesjami, wymiana wiedzy między Agents i współdzielony stan Workspace.
- Resource-aware execution, które może reagować na CPU, RAM i dostępność ludzkiej uwagi.
- Agent-powered GUI end-to-end testing dla nadzorowanej samoewolucji.
- Scheduling i auto-started sessions, aby Agents mogły działać przez noc lub kontynuować pracę podczas Twojej nieobecności.
- Powierzchnie org-level alignment do koordynacji ludzi, Agents, celów i accountability (WIP).
- Session collaboration i grupowe issue workflows przez self-hosted Supabase (WIP).

## Pobieranie

Pobierz najnowszą ORGII desktop app ze strony [Releases](https://github.com/YORG-AI/ORGII/releases). Otwórz najnowszy release, pobierz instalator lub app bundle dla swojej platformy i postępuj zgodnie z instrukcjami systemu operacyjnego, aby zainstalować ORGII.

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

## Licencja

ORGII jest licencjonowane na warunkach GNU Affero General Public License v3.0 lub nowszej (`AGPL-3.0-or-later`). Pełny tekst licencji znajduje się w [`LICENSE`](../../LICENSE).
