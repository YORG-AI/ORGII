<div align="center">
  <h1>ORG-2</h1>
  <p><strong>El sistema de registro de cómo los Agents construyen el software.<br />Ejecuta tus Agents de código: reproduce cualquier sesión, revísala en equipo y rastrea cada línea hasta la decisión que la originó.</strong></p>
  <p>Construido con Rust y Tauri para ejecución local-first con menos de 100 MB en disco. Soporta livestream y replay de trayectorias de Agents. Fácil de seguir y revisar.</p>
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

Responder por qué existe un fragmento de código —y si funcionó— siempre ha implicado coser varios sistemas a mano. Jira solo ve tickets. Codex solo ve sus propias sesiones. GitHub solo ve líneas commiteadas. Amplitude solo ve métricas. Eso era sostenible cuando el código lo escribían humanos. A la velocidad de los Agents ya no lo es: el código escrito el lunes es legacy el viernes.

ORG-2 es donde tu equipo ejecuta sus Agents de código —un harness nativo en Rust más lanzadores para más de 20 CLIs de Agents— y construye ese registro automáticamente. Cada sesión se convierte en una trayectoria que tus compañeros reproducen como un vídeo: revisan cómo se construyó realmente el trabajo en lugar de solo el diff, y comentan en contexto. Las sesiones ejecutadas en otras herramientas se ingieren y se rellenan desde su historial, de modo que el registro cubre también trabajo que nunca pasó por la aplicación. El registro enlaza lo que pidió la persona, lo que entendió el Agent y lo que realmente hizo, así que cualquier línea publicada se rastrea hasta la sesión que la escribió.

No es solo otra herramienta de programación con IA; es un experimento sobre organizaciones humano/Agent y alineación a nivel de organización. ORG-II trata a los Agents como colegas persistentes y observables dentro de una organización estructurada: ejecución reproducible, memoria entre sesiones, AI blame y un runtime Rust local-first para que humanos, Agents y equipos colaboren alrededor de contexto compartido y objetivos alineados.

## Funciones

<table>
<tr>
<td width="50%" valign="middle">

### Harness de Rust integrado

Ejecuta Agents nativos rápidos, personalizables y eficientes en tokens con tus claves de API y suscripciones de Agents existentes.

</td>
<td width="50%">
  <img src="../assets/feature-wall/rust-harness.gif" alt="Ejecutar Agents con el harness de Rust de ORG-II" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Gestiona sesiones de más de 10 apps y CLIs

Carga y gestiona en un solo lugar las sesiones de Agent de todas tus herramientas. Explora el historial, inspecciona subagents y controla cada fuente sin cambiar de app.

</td>
<td width="50%">
  <img src="../assets/feature-wall/session-sources.png" alt="Gestionar fuentes de sesiones de Agent de apps y CLIs en ORG-II" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Forma equipo y revisa trayectorias, no solo PRs

Forma tu equipo y comparte sesiones entre dispositivos y compañeros. Revisa la trayectoria completa del Agent, no solo el diff resultante, y deja comentarios en contexto.

</td>
<td width="50%">
  <img src="../assets/feature-wall/team-trajectory-review.png" alt="Gestionar compañeros y permisos de replay de trayectorias en ORG-II" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Tool calls, ahora como videos

Reproduce el trabajo del harness nativo de Rust y de más de 15 CLI Agents. Mensajes, tool calls, ediciones de archivos y salida de comandos permanecen sincronizados en una timeline revisable.

</td>
<td width="50%">
  <img src="../assets/feature-wall/replay.gif" alt="Reproducir una sesión de Agent en ORG-II" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### AI blame, no solo Git blame

No te quedes en quién cambió una línea. Rastréala hasta las sesiones de Agent, los tool calls y las decisiones que provocaron el cambio.

</td>
<td width="50%">
  <img src="../assets/feature-wall/ai-blame.gif" alt="Rastrear cambios de código hasta sesiones y decisiones de Agent en ORG-II" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Mantén el rumbo

Comprueba cómo distribuyes tu tiempo entre tareas y sesiones de Agent. Una timeline diaria mantiene visibles la duración, los cambios de código y las prioridades.

</td>
<td width="50%">
  <img src="../assets/feature-wall/work-diary.png" alt="Revisar el tiempo dedicado a tareas y sesiones de Agent en ORG-II" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Espacio de desarrollo completo

Usa el terminal, gestiona el control de código fuente, recorre el historial de Git y revisa pull requests sin salir de tu espacio de trabajo de Agents.

</td>
<td width="50%">
  <img src="../assets/feature-wall/development-workspace.gif" alt="Control de código fuente, historial de Git y revisión de código en ORG-II" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Modo Diseño

Inspecciona páginas en vivo en el navegador WebKit nativo. Selecciona un elemento y envía su contexto exacto de página directamente al Agent para corregirlo de forma sencilla.

</td>
<td width="50%">
  <img src="../assets/feature-wall/design-mode.gif" alt="Inspeccionar un elemento web con el Modo Diseño de ORG-II" width="100%" />
</td>
</tr>
</table>

## Más capacidades

- GUI, CLI, Terminal, Git, navegador, LSP, timeline y herramientas de base de datos.
- Memoria entre sesiones, intercambio de conocimiento entre Agents y estado compartido del Workspace.
- Ejecución consciente de recursos que puede reaccionar a CPU, RAM y disponibilidad de atención humana.
- Pruebas end-to-end de GUI impulsadas por Agent para autoevolución supervisada.
- Programación y sesiones iniciadas automáticamente para que los Agents trabajen durante la noche o continúen cuando no estás.
- Superficies de alineación organizacional para coordinar humanos, Agents, objetivos y responsabilidad (WIP).
- Colaboración de sesiones y flujos de issues de grupo mediante Supabase autohospedado (WIP).

## Agents compatibles

Usa el harness de Rust integrado de ORG-II o inicia estas CLIs de coding Agents compatibles desde la app de escritorio.

### GUI + TUI

<p>
  <a href="#harness-de-rust-integrado"><kbd><img src="../assets/org2-icon.svg" alt="Logo de ORG-2" width="22" valign="middle" /> ORG-2</kbd></a> &nbsp;
  <a href="https://cursor.com/docs/cli/overview"><kbd><img src="../../src/assets/modelIcons/cursor.svg" alt="Logo de Cursor CLI" width="16" valign="middle" /> Cursor CLI</kbd></a> &nbsp;
  <a href="https://code.claude.com/docs/en/configuration"><kbd><img src="../../src/assets/modelIcons/claude.svg" alt="Logo de Claude" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://developers.openai.com/codex/config-basic"><kbd><img src="../../src/assets/modelIcons/openai.svg" alt="Logo de Codex" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/installation"><kbd><img src="../../src/assets/modelIcons/kiro.svg" alt="Logo de Kiro CLI" width="16" valign="middle" /> Kiro CLI</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-in-the-cli"><kbd><img src="../../src/assets/modelIcons/copilot.svg" alt="Logo de GitHub Copilot" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/config/"><kbd><img src="../../src/assets/modelIcons/opencode.svg" alt="Logo de OpenCode" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli/getting-started"><kbd><img src="../../src/assets/modelIcons/antigravity.svg" alt="Logo de Antigravity" width="16" valign="middle" /> Antigravity</kbd></a>
</p>

### TUI

<p>
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/configuration-files.html"><kbd><img src="../../src/assets/modelIcons/kimi.svg" alt="Logo de Kimi Code CLI" width="16" valign="middle" /> Kimi Code CLI</kbd></a> &nbsp;
  <a href="https://aider.chat/docs/config.html"><kbd><img src="../../src/assets/modelIcons/aider.svg" alt="Logo de Aider" width="16" valign="middle" /> Aider</kbd></a> &nbsp;
  <a href="https://goose-docs.ai/docs/category/getting-started/"><kbd><img src="../../src/assets/modelIcons/goose.svg" alt="Logo de Goose" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual"><kbd><img src="../../src/assets/modelIcons/amp.svg" alt="Logo de Amp" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cli/cli-reference"><kbd><img src="../../src/assets/modelIcons/cline.svg" alt="Logo de Cline" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="../../src/assets/modelIcons/kilo.svg" alt="Logo de Kilo Code" width="16" valign="middle" /> Kilo Code</kbd></a> &nbsp;
  <a href="https://docs.x.ai/build/overview"><kbd><img src="../../src/assets/modelIcons/grok.svg" alt="Logo de Grok CLI" width="16" valign="middle" /> Grok CLI</kbd></a> &nbsp;
  <a href="https://docs.devin.ai/cli"><kbd><img src="../../src/assets/modelIcons/devin.svg" alt="Logo de Devin" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/user-guide/configuration"><kbd><img src="../../src/assets/modelIcons/hermes.svg" alt="Logo de Hermes" width="16" valign="middle" /> Hermes</kbd></a> &nbsp;
  <a href="https://docs.openclaw.ai/cli/config"><kbd><img src="../../src/assets/modelIcons/openclaw.svg" alt="Logo de OpenClaw" width="16" valign="middle" /> OpenClaw</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs"><kbd><img src="../../src/assets/modelIcons/infinity-agent.svg" alt="Logo de Codebuff" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/"><kbd><img src="../../src/assets/modelIcons/qwen.svg" alt="Logo de Qwen Code" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/mimocode/config-files"><kbd><img src="../../src/assets/modelIcons/xiaomimimo.svg" alt="Logo de Mimo Code" width="16" valign="middle" /> Mimo Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/cli/configuration"><kbd><img src="../../src/assets/modelIcons/continue.svg" alt="Logo de Continue" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/byok/overview"><kbd><img src="../../src/assets/modelIcons/droid.svg" alt="Logo de Droid" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://docs.mistral.ai/vibe/code/cli/install-setup"><kbd><img src="../../src/assets/modelIcons/mistral.svg" alt="Logo de Mistral Vibe" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://docs.autohand.ai/integrations/ai-model-providers"><kbd><img src="../../src/assets/modelIcons/autohand.svg" alt="Logo de Autohand" width="16" valign="middle" /> Autohand</kbd></a> &nbsp;
  <a href="https://github.com/open-horizon-labs/oh-omp"><kbd><img src="../../src/assets/modelIcons/omp.svg" alt="Logo de OMP" width="16" valign="middle" /> OMP</kbd></a> &nbsp;
  <a href="https://pi.dev/docs/latest/providers"><kbd><img src="../../src/assets/modelIcons/pi.svg" alt="Logo de Pi" width="16" valign="middle" /> Pi</kbd></a>
</p>

## Descargar

Versión actual del build: v1.1.24 (2026-07-16)

Descarga la aplicación desktop más reciente de ORGII con un clic:

- [macOS Apple Silicon](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg)
- [Instalador de Windows x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe)
- [MSI de Windows x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi)
- [AppImage de Linux x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.AppImage)
- [DEB de Linux x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.deb)
- [Todos los recursos de la última versión](https://github.com/org2AI/ORG2/releases/latest)

Los enlaces directos de descarga siempre apuntan a la última versión en GitHub.

## Desarrollar desde el código fuente

Para compilar o contribuir desde el código fuente:

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

Para más detalles sobre contribución, consulta [CONTRIBUTING.md](../../.github/CONTRIBUTING.md). Pedimos a todos actuar con respeto y empatía; consulta [CODE_OF_CONDUCT.md](../../.github/CODE_OF_CONDUCT.md).

## Sidecars nativos opcionales

Las funciones Browser Use y Computer Use dependen de helpers nativos opcionales para automatización del navegador y automatización de pantalla en macOS:

- `agent-browser` se descarga desde las releases de `vercel-labs/agent-browser` para el OS/CPU actual.
- `peekaboo` se descarga desde las releases de `steipete/peekaboo` en macOS.

Computer Use actualmente solo está disponible en macOS. Browser Use puede usar `agent-browser` en plataformas compatibles.

Si falta un sidecar, el build de Rust crea un pequeño recurso placeholder para que los builds de desarrollo puedan continuar. La capacidad relacionada puede volver al `PATH` o permanecer no disponible hasta ejecutar `pnpm run download:sidecars`.

## Comunidad

¿Tienes preguntas, comentarios o quieres seguir la evolución de ORG-2? Únete a Discord:

👉 **Discord: [discord.gg/tvWgAqhCzs](https://discord.gg/tvWgAqhCzs)**
👉 **WeChat: [https://github.com/org2AI/ORG2/issues/128]**

- **#how-to-use-org2** y **#faq** — empieza a utilizarlo
- **#announcement** — noticias de versiones y actualizaciones
- **#lets-chat** — comparte lo que estás creando y conoce a la comunidad
- **#feedback** — ideas, solicitudes de funciones e informes de errores

## Licencia

ORGII está licenciado bajo GNU Affero General Public License v3.0 o posterior (`AGPL-3.0-or-later`). Consulta [`LICENSE`](../../LICENSE) para ver el texto completo de la licencia.
