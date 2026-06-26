<div align="center">
  <h1>ORG-2</h1>
  <p><strong>IDE agentic open-source no estilo Cursor — mas construído para revisabilidade, rastreabilidade e liberdade criativa, não apenas para programar mais rápido.</strong></p>
  <p>Criado com Rust e Tauri para execução local-first com menos de 100 MB em disco. Suporta livestream e replay de trajetórias de Agents. Fácil de acompanhar e revisar.</p>
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

Ele não é apenas mais uma ferramenta de programação com IA; é um experimento em organizações humano/Agent e alinhamento em nível organizacional. Agents estão ficando melhores, mas colaboração, observabilidade, estrutura e responsabilidade compartilhada não estão acompanhando — e em alguns casos estão piorando. Cursor, Claude Code e ferramentas semelhantes muitas vezes tratam Agents como assistentes terceirizados: úteis para gerar saída, mas difíceis de auditar, coordenar, alinhar ou evoluir em nível de sistema.

ORG-II explora um modelo diferente: Agents como colegas persistentes e observáveis dentro de uma organização estruturada. Em vez de sessões de AI IDE sem estado e difíceis de revisar, ele introduz execução de Agents reproduzível, memória entre sessões, AI blame e um runtime Rust local-first para que humanos, Agents e equipes colaborem em torno de contexto compartilhado e objetivos alinhados.

## Principais capacidades

- Sessões de longa duração com traces de execução reproduzíveis para auditoria, revisão e depuração.
- Agents baseados em Rust que funcionam com suas API keys e assinaturas de Agents existentes.
- GUI, CLI, Terminal, Git, navegador, LSP, timeline e ferramentas de banco de dados.
- Memória entre sessões, compartilhamento de conhecimento entre Agents e estado compartilhado do Workspace.
- Execução consciente de recursos, capaz de reagir a CPU, RAM e disponibilidade da atenção humana.
- Testes GUI end-to-end movidos por Agent para autoevolução supervisionada.
- Agendamento e sessões iniciadas automaticamente para que Agents possam rodar durante a noite ou continuar trabalhando enquanto você está ausente.
- Superfícies de alinhamento organizacional para coordenar humanos, Agents, objetivos e responsabilidade (WIP).
- Colaboração de sessões e workflows de issues em grupo via Supabase auto-hospedado (WIP).

## Download

Baixe a versão mais recente do app desktop ORGII na página de [Releases](https://github.com/YORG-AI/ORGII/releases). Abra a release mais recente, baixe o instalador ou app bundle para sua plataforma e siga as instruções do sistema operacional para instalar o ORGII.

## Desenvolver a partir do código-fonte

Para compilar ou contribuir a partir do código-fonte:

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

Para mais detalhes de contribuição, consulte [CONTRIBUTING.md](../../CONTRIBUTING.md). Pedimos que todos sejam respeitosos e empáticos; consulte [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md).

## Sidecars nativos opcionais

Os recursos Browser Use e Computer Use dependem de helpers nativos opcionais para automação de navegador e automação de tela no macOS:

- `agent-browser` é baixado das releases de `vercel-labs/agent-browser` para o OS/CPU atual.
- `peekaboo` é baixado das releases de `steipete/peekaboo` no macOS.

Computer Use atualmente está disponível apenas no macOS. Browser Use pode usar `agent-browser` em plataformas compatíveis.

Se um sidecar estiver ausente, o build Rust cria um pequeno placeholder resource para que builds de desenvolvimento possam continuar. O recurso relacionado pode voltar para o `PATH` ou permanecer indisponível até você executar `pnpm run download:sidecars`.

## Licença

ORGII é licenciado sob a GNU Affero General Public License v3.0 ou posterior (`AGPL-3.0-or-later`). Consulte [`LICENSE`](../../LICENSE) para o texto completo da licença.
