<div align="center">
  <h1>ORG-2</h1>
  <p><strong>IDE agentic open-source al estilo Cursor — pero construido para revisabilidad, trazabilidad y libertad creativa, no solo para programar más rápido.</strong></p>
  <p>Construido con Rust y Tauri para ejecución local-first con menos de 100 MB en disco. Soporta livestream y replay de trayectorias de Agents. Fácil de seguir y revisar.</p>
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

No es solo otra herramienta de programación con IA; es un experimento en organizaciones humano/Agent y alineación a nivel organizacional. Los Agents están mejorando, pero la colaboración, la observabilidad, la estructura y la responsabilidad compartida no avanzan al mismo ritmo — y en algunos casos empeoran. Cursor, Claude Code y herramientas similares suelen tratar a los Agents como asistentes externalizados: útiles para producir resultados, pero difíciles de auditar, coordinar, alinear o evolucionar a nivel de sistema.

ORG-II explora un modelo distinto: Agents como colegas persistentes y observables dentro de una organización estructurada. En lugar de sesiones de AI IDE sin estado y difíciles de revisar, introduce ejecución de Agents reproducible, memoria entre sesiones, AI blame y un runtime Rust local-first para que humanos, Agents y equipos colaboren alrededor de contexto compartido y objetivos alineados.

## Capacidades clave

- Sesiones de larga duración con trazas de ejecución reproducibles para auditoría, revisión y depuración.
- Agents basados en Rust que funcionan con tus API keys y suscripciones de Agents existentes.
- GUI, CLI, Terminal, Git, navegador, LSP, timeline y herramientas de base de datos.
- Memoria entre sesiones, intercambio de conocimiento entre Agents y estado compartido del Workspace.
- Ejecución consciente de recursos que puede reaccionar a CPU, RAM y disponibilidad de atención humana.
- Pruebas end-to-end de GUI impulsadas por Agent para autoevolución supervisada.
- Programación y sesiones iniciadas automáticamente para que los Agents trabajen durante la noche o continúen cuando no estás.
- Superficies de alineación organizacional para coordinar humanos, Agents, objetivos y responsabilidad (WIP).
- Colaboración de sesiones y flujos de issues de grupo mediante Supabase autohospedado (WIP).

## Descargar

Obtén la última aplicación desktop de ORGII desde la página de [Releases](https://github.com/YORG-AI/ORGII/releases). Abre la release más reciente, descarga el instalador o app bundle para tu plataforma y sigue las instrucciones del sistema operativo para instalar ORGII.

## Desarrollar desde el código fuente

Para compilar o contribuir desde el código fuente:

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

Para más detalles sobre contribución, consulta [CONTRIBUTING.md](../../CONTRIBUTING.md). Pedimos a todos actuar con respeto y empatía; consulta [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md).

## Sidecars nativos opcionales

Las funciones Browser Use y Computer Use dependen de helpers nativos opcionales para automatización del navegador y automatización de pantalla en macOS:

- `agent-browser` se descarga desde las releases de `vercel-labs/agent-browser` para el OS/CPU actual.
- `peekaboo` se descarga desde las releases de `steipete/peekaboo` en macOS.

Computer Use actualmente solo está disponible en macOS. Browser Use puede usar `agent-browser` en plataformas compatibles.

Si falta un sidecar, el build de Rust crea un pequeño recurso placeholder para que los builds de desarrollo puedan continuar. La capacidad relacionada puede volver al `PATH` o permanecer no disponible hasta ejecutar `pnpm run download:sidecars`.

## Licencia

ORGII está licenciado bajo GNU Affero General Public License v3.0 o posterior (`AGPL-3.0-or-later`). Consulta [`LICENSE`](../../LICENSE) para ver el texto completo de la licencia.
