<div align="center">
  <h1>ORG-2</h1>
  <p><strong>Open-source Agent IDE в стиле Cursor — но созданная для удобной проверки, трассируемости и творческой свободы, а не только для более быстрого кодинга.</strong></p>
  <p>Построена на Rust и Tauri для local-first выполнения и занимает менее 100 МБ на диске. Поддерживает livestream и replay траекторий Agents. Легко отслеживать и проверять.</p>
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

Это не просто еще один инструмент AI-кодинга; это эксперимент в области человеческо-Agent организаций и выравнивания на уровне организации. Agents становятся сильнее, но collaboration, observability, структура и разделяемая ответственность не успевают за ними — а в некоторых случаях становятся хуже. Cursor, Claude Code и похожие инструменты часто относятся к Agents как к внешним ассистентам: они полезны для результата, но их сложно аудитировать, координировать, выравнивать или развивать на системном уровне.

ORG-II исследует другую модель: Agents как постоянные и наблюдаемые коллеги внутри структурированной организации. Вместо stateless и трудных для ревью AI IDE sessions он вводит воспроизводимое выполнение Agents, межсессионную память, AI blame и local-first Rust runtime, чтобы люди, Agents и команды могли сотрудничать вокруг общего контекста и согласованных целей.

## Ключевые возможности

- Долгоживущие sessions с воспроизводимыми traces выполнения для аудита, ревью и отладки.
- Agents на основе Rust, работающие с вашими существующими API keys и подписками Agents.
- GUI, CLI, Terminal, Git, браузер, LSP, timeline и инструменты баз данных.
- Межсессионная память, обмен знаниями между Agents и общее состояние Workspace.
- Ресурсно-осознанное выполнение, реагирующее на CPU, RAM и доступность внимания человека.
- Agent-powered GUI end-to-end тестирование для контролируемой самоэволюции.
- Scheduling и auto-started sessions, чтобы Agents могли работать всю ночь или продолжать работу, пока вас нет.
- Поверхности org-level alignment для координации людей, Agents, целей и ответственности (WIP).
- Collaboration sessions и групповые issue workflows через self-hosted Supabase (WIP).

## Скачать

Загрузите последнюю desktop app ORGII со страницы [Releases](https://github.com/YORG-AI/ORGII/releases). Откройте последний release, скачайте установщик или app bundle для вашей платформы и следуйте подсказкам операционной системы для установки ORGII.

## Разработка из исходного кода

Чтобы собрать проект или внести вклад из исходного кода:

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

Подробнее о вкладе см. [CONTRIBUTING.md](../../CONTRIBUTING.md). Мы просим всех быть уважительными и эмпатичными; см. [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md).

## Опциональные нативные sidecars

Функции Browser Use и Computer Use зависят от опциональных нативных helpers для автоматизации браузера и автоматизации экрана macOS:

- `agent-browser` скачивается из releases `vercel-labs/agent-browser` для текущей OS/CPU.
- `peekaboo` скачивается из releases `steipete/peekaboo` на macOS.

Computer Use сейчас доступен только на macOS. Browser Use может использовать `agent-browser` на поддерживаемых платформах.

Если sidecar отсутствует, Rust build создает небольшой placeholder resource, чтобы dev-сборки могли продолжаться. Связанная возможность может откатиться к `PATH` или оставаться недоступной до запуска `pnpm run download:sidecars`.

## Лицензия

ORGII распространяется по лицензии GNU Affero General Public License v3.0 или более поздней версии (`AGPL-3.0-or-later`). Полный текст лицензии см. в [`LICENSE`](../../LICENSE).
