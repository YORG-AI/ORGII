<div align="center">
  <h1>ORG-2</h1>
  <p><strong>Система записи того, как Agents создают программное обеспечение.<br />Запускайте свои Agents для кода — воспроизводите любую сессию, проводите ревью командой и отслеживайте каждую строку до решения, которое её породило.</strong></p>
  <p>Построена на Rust и Tauri для local-first выполнения и занимает менее 100 МБ на диске. Поддерживает livestream и replay траекторий Agents. Легко отслеживать и проверять.</p>
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

Чтобы ответить, почему существует тот или иной кусок кода — и сработал ли он, — всегда приходилось вручную сшивать несколько систем. Jira видит только тикеты. Codex видит только собственные сессии. GitHub видит только закоммиченные строки. Amplitude видит только метрики. Это было терпимо, пока код писали люди. На скорости Agents — уже нет: код, написанный в понедельник, к пятнице становится legacy.

ORG-2 — это место, где ваша команда запускает свои Agents для кода: нативный Rust-харнесс и лаунчеры более чем для 20 Agent CLI, — и он строит эту запись автоматически. Каждая сессия становится траекторией, которую коллеги воспроизводят как видео: они смотрят, как работа была на самом деле сделана, а не только итоговый diff, и оставляют комментарии в контексте. Сессии, запущенные в других инструментах, подхватываются и достраиваются из их истории, поэтому запись покрывает и ту работу, которая никогда не проходила через приложение. Запись связывает то, что попросил человек, то, как это понял Agent, и то, что он действительно сделал, — поэтому любую выпущенную строку можно проследить до написавшей её сессии.

Это не просто ещё один инструмент для написания кода с ИИ; это эксперимент об организациях из людей и Agents и о согласованности на уровне организации. ORG-II относится к Agents как к постоянным и наблюдаемым коллегам внутри структурированной организации — воспроизводимое выполнение, межсессионная память, AI blame и local-first Rust runtime, чтобы люди, Agents и команды могли работать вокруг общего контекста и согласованных целей.

## Возможности

<table>
<tr><td width="50%" valign="middle"><h3>Встроенный Rust-харнесс</h3><p>Запускайте быстрых, экономных по токенам и настраиваемых нативных Agents с вашими существующими API-ключами и подписками Agents.</p></td><td width="50%"><img src="../assets/feature-wall/rust-harness.gif" alt="Запуск Agents с помощью Rust-харнесса ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Управляйте сессиями из более чем 10 приложений и CLI</h3><p>Загружайте и управляйте сессиями Agent из всех ваших инструментов в одном месте. Просматривайте историю, изучайте subagents и контролируйте каждый источник без переключения приложений.</p></td><td width="50%"><img src="../assets/feature-wall/session-sources.png" alt="Управление источниками сессий Agent из приложений и CLI в ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Соберите команду и проверяйте траектории, а не только PR</h3><p>Соберите команду и делитесь сессиями между устройствами и коллегами. Проверяйте всю траекторию Agent, а не только итоговый diff, и оставляйте комментарии в контексте.</p></td><td width="50%"><img src="../assets/feature-wall/team-trajectory-review.png" alt="Управление командой и правами на replay траекторий в ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Вызовы инструментов теперь как видео</h3><p>Воспроизводите работу нативного Rust-харнесса и более 15 CLI Agents. Сообщения, вызовы инструментов, правки файлов и вывод команд синхронизированы в единой доступной для ревью timeline.</p></td><td width="50%"><img src="../assets/feature-wall/replay.gif" alt="Воспроизведение сессии Agent в ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>AI blame, а не только Git blame</h3><p>Не останавливайтесь на том, кто изменил строку. Проследите её до сессий Agent, вызовов инструментов и решений, которые привели к изменению.</p></td><td width="50%"><img src="../assets/feature-wall/ai-blame.gif" alt="Связь изменений кода с сессиями и решениями Agent в ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Не сбивайтесь с курса</h3><p>Смотрите, как ваше время распределяется между задачами и сессиями Agent. Ежедневная timeline активности показывает длительность, изменения кода и приоритеты.</p></td><td width="50%"><img src="../assets/feature-wall/work-diary.png" alt="Анализ времени на задачи и сессии Agent в ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Полный workspace для разработки</h3><p>Используйте терминал, управляйте исходным кодом, изучайте историю Git и проверяйте pull requests, не покидая workspace Agent.</p></td><td width="50%"><img src="../assets/feature-wall/development-workspace.gif" alt="Управление исходным кодом, история Git и code review в ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Режим Design</h3><p>Исследуйте живые страницы во встроенном браузере WebKit. Выберите элемент и отправьте его точный контекст страницы прямо Agent для простого исправления.</p></td><td width="50%"><img src="../assets/feature-wall/design-mode.gif" alt="Исследование элемента веб-страницы в режиме Design ORG-II" width="100%" /></td></tr>
</table>

## Дополнительные возможности

- GUI, CLI, Terminal, Git, браузер, LSP, timeline и инструменты баз данных.
- Межсессионная память, обмен знаниями между Agents и общее состояние Workspace.
- Ресурсно-осознанное выполнение, реагирующее на CPU, RAM и доступность внимания человека.
- Agent-powered GUI end-to-end тестирование для контролируемой самоэволюции.
- Scheduling и auto-started sessions, чтобы Agents могли работать всю ночь или продолжать работу, пока вас нет.
- Поверхности org-level alignment для координации людей, Agents, целей и ответственности (WIP).
- Collaboration sessions и групповые issue workflows через self-hosted Supabase (WIP).

## Поддерживаемые Agents

Используйте встроенный Rust-харнесс ORG-II или запускайте эти поддерживаемые CLI coding Agents из desktop app.

### GUI + TUI

<p>
  <a href="#возможности"><kbd><img src="../assets/org2-icon.svg" alt="Логотип ORG-2" width="22" valign="middle" /> ORG-2</kbd></a> &nbsp;
  <a href="https://cursor.com/docs/cli/overview"><kbd><img src="../../src/assets/modelIcons/cursor.svg" alt="Cursor CLI logo" width="16" valign="middle" /> Cursor CLI</kbd></a> &nbsp;
  <a href="https://code.claude.com/docs/en/configuration"><kbd><img src="../../src/assets/modelIcons/claude.svg" alt="Claude logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
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

## Скачать

Текущая версия сборки: v1.1.24 (2026-07-16)

Скачайте последнюю desktop app ORGII одним нажатием:

- [macOS Apple Silicon](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg)
- [Установщик Windows x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe)
- [Windows x64 MSI](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi)
- [Linux x64 AppImage](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.AppImage)
- [Linux x64 DEB](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.deb)
- [Все ресурсы последнего релиза](https://github.com/org2AI/ORG2/releases/latest)

Прямые ссылки для скачивания всегда указывают на последний релиз в GitHub.

## Разработка из исходного кода

Чтобы собрать проект или внести вклад из исходного кода:

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

Подробнее о вкладе см. [CONTRIBUTING.md](../../.github/CONTRIBUTING.md). Мы просим всех быть уважительными и эмпатичными; см. [CODE_OF_CONDUCT.md](../../.github/CODE_OF_CONDUCT.md).

## Опциональные нативные sidecars

Функции Browser Use и Computer Use зависят от опциональных нативных helpers для автоматизации браузера и автоматизации экрана macOS:

- `agent-browser` скачивается из releases `vercel-labs/agent-browser` для текущей OS/CPU.
- `peekaboo` скачивается из releases `steipete/peekaboo` на macOS.

Computer Use сейчас доступен только на macOS. Browser Use может использовать `agent-browser` на поддерживаемых платформах.

Если sidecar отсутствует, Rust build создает небольшой placeholder resource, чтобы dev-сборки могли продолжаться. Связанная возможность может откатиться к `PATH` или оставаться недоступной до запуска `pnpm run download:sidecars`.

## Сообщество

Есть вопросы, отзывы или хотите следить за развитием ORG-2? Присоединяйтесь к нам в Discord:

👉 **Discord: [discord.gg/tvWgAqhCzs](https://discord.gg/tvWgAqhCzs)**
👉 **WeChat: [https://github.com/org2AI/ORG2/issues/128]**

- **#how-to-use-org2** и **#faq** — помощь с началом работы
- **#announcement** — новости релизов и обновления
- **#lets-chat** — делитесь тем, что создаёте, и знакомьтесь с сообществом
- **#feedback** — идеи, запросы функций и сообщения об ошибках

## Лицензия

ORGII распространяется по лицензии GNU Affero General Public License v3.0 или более поздней версии (`AGPL-3.0-or-later`). Полный текст лицензии см. в [`LICENSE`](../../LICENSE).
