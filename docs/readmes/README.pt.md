<div align="center">
  <h1>ORG-2</h1>
  <p><strong>O sistema de registro de como os Agents constroem software.<br />Execute seus Agents de código — reproduza qualquer sessão, revise em equipe e rastreie cada linha até a decisão por trás dela.</strong></p>
  <p>Criado com Rust e Tauri para execução local-first com menos de 100 MB em disco. Suporta livestream e replay de trajetórias de Agents. Fácil de acompanhar e revisar.</p>
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

Responder por que um trecho de código existe — e se ele funcionou — sempre exigiu costurar vários sistemas à mão. O Jira só enxerga tickets. O Codex só enxerga as próprias sessões. O GitHub só enxerga linhas commitadas. O Amplitude só enxerga métricas. Isso era sustentável quando humanos escreviam o código. Na velocidade dos Agents não é mais: código escrito na segunda já é legado na sexta.

O ORG-2 é onde sua equipe executa seus Agents de código — um harness nativo em Rust mais lançadores para mais de 20 CLIs de Agents — e constrói esse registro automaticamente. Cada sessão vira uma trajetória que os colegas reproduzem como um vídeo: revisam como o trabalho foi realmente construído, não apenas o diff, e comentam em contexto. Sessões executadas em outras ferramentas são ingeridas e preenchidas a partir do histórico delas, de modo que o registro cobre também trabalho que nunca passou pelo aplicativo. O registro liga o que a pessoa pediu, o que o Agent entendeu e o que ele de fato fez, então qualquer linha publicada é rastreável até a sessão que a escreveu.

Não é apenas mais uma ferramenta de programação com IA; é um experimento sobre organizações humano/Agent e alinhamento em nível organizacional. O ORG-II trata os Agents como colegas persistentes e observáveis dentro de uma organização estruturada — execução reproduzível, memória entre sessões, AI blame e um runtime Rust local-first para que humanos, Agents e equipes colaborem em torno de contexto compartilhado e objetivos alinhados.

## Recursos

<table>
<tr><td width="50%" valign="middle"><h3>Harness Rust integrado</h3><p>Execute Agents nativos rápidos, personalizáveis e econômicos em tokens com suas chaves de API e assinaturas de Agents existentes.</p></td><td width="50%"><img src="../assets/feature-wall/rust-harness.gif" alt="Executar Agents com o harness Rust do ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Gerencie sessões em mais de 10 apps e CLIs</h3><p>Carregue e gerencie em um só lugar as sessões de Agent de todas as suas ferramentas. Examine o histórico, inspecione subagents e controle cada fonte sem trocar de app.</p></td><td width="50%"><img src="../assets/feature-wall/session-sources.png" alt="Gerenciar fontes de sessões de Agent de apps e CLIs no ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Monte sua equipe e revise trajetórias, não apenas PRs</h3><p>Monte sua equipe e compartilhe sessões entre dispositivos e colegas. Revise toda a trajetória do Agent, não apenas o diff resultante, e deixe comentários no contexto.</p></td><td width="50%"><img src="../assets/feature-wall/team-trajectory-review.png" alt="Gerenciar colegas e permissões de replay de trajetórias no ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Tool calls, agora como vídeos</h3><p>Reproduza o trabalho do harness Rust nativo e de mais de 15 CLI Agents. Mensagens, tool calls, edições de arquivos e saída de comandos permanecem sincronizados em uma timeline revisável.</p></td><td width="50%"><img src="../assets/feature-wall/replay.gif" alt="Reproduzir uma sessão de Agent no ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>AI blame, não apenas Git blame</h3><p>Não pare em quem alterou uma linha. Rastreie-a até as sessões de Agent, tool calls e decisões que levaram à mudança.</p></td><td width="50%"><img src="../assets/feature-wall/ai-blame.gif" alt="Rastrear mudanças de código até sessões e decisões de Agent no ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Mantenha o foco</h3><p>Veja como seu tempo é distribuído entre tarefas e sessões de Agent. Uma timeline diária mantém visíveis a duração, as mudanças de código e as prioridades.</p></td><td width="50%"><img src="../assets/feature-wall/work-diary.png" alt="Revisar o tempo gasto em tarefas e sessões de Agent no ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Workspace de desenvolvimento completo</h3><p>Use o terminal, gerencie o controle de versão, percorra o histórico do Git e revise pull requests sem sair do seu workspace de Agent.</p></td><td width="50%"><img src="../assets/feature-wall/development-workspace.gif" alt="Controle de versão, histórico do Git e revisão de código no ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Modo Design</h3><p>Inspecione páginas ao vivo no navegador WebKit nativo. Selecione um elemento e envie seu contexto exato de página diretamente ao Agent para uma correção simples.</p></td><td width="50%"><img src="../assets/feature-wall/design-mode.gif" alt="Inspecionar um elemento web com o Modo Design do ORG-II" width="100%" /></td></tr>
</table>

## Mais capacidades

- GUI, CLI, Terminal, Git, navegador, LSP, timeline e ferramentas de banco de dados.
- Memória entre sessões, compartilhamento de conhecimento entre Agents e estado compartilhado do Workspace.
- Execução consciente de recursos, capaz de reagir a CPU, RAM e disponibilidade da atenção humana.
- Testes GUI end-to-end movidos por Agent para autoevolução supervisionada.
- Agendamento e sessões iniciadas automaticamente para que Agents possam rodar durante a noite ou continuar trabalhando enquanto você está ausente.
- Superfícies de alinhamento organizacional para coordenar humanos, Agents, objetivos e responsabilidade (WIP).
- Colaboração de sessões e workflows de issues em grupo via Supabase auto-hospedado (WIP).

## Agents compatíveis

Use o harness Rust integrado do ORG-II ou inicie estas CLIs de coding Agents compatíveis pelo app de desktop.

### GUI + TUI

<p>
  <a href="#recursos"><kbd><img src="../assets/org2-icon.svg" alt="Logo do ORG-2" width="22" valign="middle" /> ORG-2</kbd></a> &nbsp;
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

## Download

Versão atual do build: v1.1.24 (2026-07-16)

Baixe o app desktop ORGII mais recente com um clique:

- [macOS Apple Silicon](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg)
- [Instalador do Windows x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe)
- [MSI do Windows x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi)
- [AppImage do Linux x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.AppImage)
- [DEB do Linux x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.deb)
- [Todos os assets da versão mais recente](https://github.com/org2AI/ORG2/releases/latest)

Os links diretos de download sempre apontam para a versão mais recente no GitHub.

## Desenvolver a partir do código-fonte

Para compilar ou contribuir a partir do código-fonte:

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

Para mais detalhes de contribuição, consulte [CONTRIBUTING.md](../../.github/CONTRIBUTING.md). Pedimos que todos sejam respeitosos e empáticos; consulte [CODE_OF_CONDUCT.md](../../.github/CODE_OF_CONDUCT.md).

## Sidecars nativos opcionais

Os recursos Browser Use e Computer Use dependem de helpers nativos opcionais para automação de navegador e automação de tela no macOS:

- `agent-browser` é baixado das releases de `vercel-labs/agent-browser` para o OS/CPU atual.
- `peekaboo` é baixado das releases de `steipete/peekaboo` no macOS.

Computer Use atualmente está disponível apenas no macOS. Browser Use pode usar `agent-browser` em plataformas compatíveis.

Se um sidecar estiver ausente, o build Rust cria um pequeno placeholder resource para que builds de desenvolvimento possam continuar. O recurso relacionado pode voltar para o `PATH` ou permanecer indisponível até você executar `pnpm run download:sidecars`.

## Comunidade

Tem dúvidas, feedback ou quer acompanhar a evolução do ORG-2? Junte-se a nós no Discord:

👉 **Discord: [discord.gg/tvWgAqhCzs](https://discord.gg/tvWgAqhCzs)**
👉 **WeChat: [https://github.com/org2AI/ORG2/issues/128]**

- **#how-to-use-org2** e **#faq** — comece rapidamente
- **#announcement** — notícias de versões e atualizações
- **#lets-chat** — compartilhe o que está criando e conheça a comunidade
- **#feedback** — ideias, pedidos de recursos e relatórios de bugs

## Licença

ORGII é licenciado sob a GNU Affero General Public License v3.0 ou posterior (`AGPL-3.0-or-later`). Consulte [`LICENSE`](../../LICENSE) para o texto completo da licença.
