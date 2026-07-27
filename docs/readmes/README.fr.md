<div align="center">
  <h1>ORG-2</h1>
  <p><strong>Le système de référence de la façon dont les Agents construisent les logiciels.<br />Exécutez vos Agents de code — rejouez n’importe quelle session, relisez en équipe et remontez de chaque ligne à la décision qui l’a produite.</strong></p>
  <p>Construit avec Rust et Tauri pour une exécution local-first sous 100 Mo sur disque. Prend en charge le livestream et le replay des trajectoires d’Agents. Facile à suivre et à relire.</p>
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

Répondre à la question de savoir pourquoi un morceau de code existe — et s’il a fonctionné — a toujours supposé de recoudre plusieurs systèmes à la main. Jira ne voit que des tickets. Codex ne voit que ses propres sessions. GitHub ne voit que les lignes commitées. Amplitude ne voit que des métriques. C’était tenable quand les humains écrivaient le code. À la vitesse des Agents, ça ne l’est plus : le code écrit lundi est déjà du legacy vendredi.

ORG-2 est l’endroit où votre équipe exécute ses Agents de code — un harness Rust natif et des lanceurs pour plus de 20 CLI d’Agents — et il construit ce registre automatiquement. Chaque session devient une trajectoire que vos collègues rejouent comme une vidéo : ils relisent la manière dont le travail a réellement été construit plutôt que le seul diff, et commentent en contexte. Les sessions exécutées dans d’autres outils sont ingérées et reconstituées à partir de leur historique, si bien que le registre couvre aussi du travail qui n’est jamais passé par l’application. Il relie ce que l’humain a demandé, ce que l’Agent a compris et ce qu’il a réellement fait : chaque ligne livrée remonte à la session qui l’a écrite.

Ce n’est pas juste un outil de code par IA de plus ; c’est une expérimentation sur les organisations humains/Agents et l’alignement à l’échelle de l’organisation. ORG-II traite les Agents comme des collègues persistants et observables au sein d’une organisation structurée — exécution rejouable, mémoire inter-session, AI blame et un runtime Rust local-first afin que les humains, les Agents et les équipes collaborent autour d’un contexte partagé et d’objectifs alignés.

## Fonctionnalités

<table>
<tr><td width="50%" valign="middle"><h3>Harness Rust intégré</h3><p>Exécutez des Agents natifs rapides, économes en tokens et personnalisables avec vos clés API et abonnements d’Agent existants.</p></td><td width="50%"><img src="../assets/feature-wall/rust-harness.gif" alt="Exécuter des Agents avec le harness Rust d’ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Gérez les sessions de plus de 10 apps et CLI</h3><p>Chargez et gérez au même endroit les sessions d’Agent de tous vos outils. Parcourez l’historique, inspectez les subagents et contrôlez chaque source sans changer d’app.</p></td><td width="50%"><img src="../assets/feature-wall/session-sources.png" alt="Gérer les sources de sessions d’Agent des apps et CLI dans ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Faites équipe et examinez les trajectoires, pas seulement les PR</h3><p>Formez votre équipe et partagez les sessions entre appareils et coéquipiers. Examinez la trajectoire complète de l’Agent, pas seulement le diff obtenu, et laissez des commentaires en contexte.</p></td><td width="50%"><img src="../assets/feature-wall/team-trajectory-review.png" alt="Gérer les coéquipiers et les autorisations de replay des trajectoires dans ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Les appels d’outils, maintenant en vidéo</h3><p>Rejouez le travail du harness Rust natif et de plus de 15 Agents CLI. Les messages, appels d’outils, modifications de fichiers et sorties de commandes restent synchronisés dans une timeline vérifiable.</p></td><td width="50%"><img src="../assets/feature-wall/replay.gif" alt="Rejouer une session d’Agent dans ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>AI blame, pas seulement Git blame</h3><p>Ne vous arrêtez pas à la personne qui a modifié une ligne. Remontez jusqu’aux sessions d’Agent, aux appels d’outils et aux décisions qui ont entraîné la modification.</p></td><td width="50%"><img src="../assets/feature-wall/ai-blame.gif" alt="Relier les modifications de code aux sessions et décisions d’Agent dans ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Gardez le cap</h3><p>Voyez comment votre temps se répartit entre tâches et sessions d’Agent. Une timeline d’activité quotidienne garde visibles la durée, les modifications de code et les priorités.</p></td><td width="50%"><img src="../assets/feature-wall/work-diary.png" alt="Examiner le temps consacré aux tâches et sessions d’Agent dans ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Espace de développement complet</h3><p>Utilisez le terminal, gérez le contrôle de source, parcourez l’historique Git et examinez les pull requests sans quitter votre espace de travail d’Agent.</p></td><td width="50%"><img src="../assets/feature-wall/development-workspace.gif" alt="Contrôle de source, historique Git et revue de code dans ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Mode Design</h3><p>Inspectez les pages en direct dans le navigateur WebKit natif. Sélectionnez un élément et envoyez son contexte de page exact directement à l’Agent pour une correction simple.</p></td><td width="50%"><img src="../assets/feature-wall/design-mode.gif" alt="Inspecter un élément web avec le mode Design d’ORG-II" width="100%" /></td></tr>
</table>

## Autres capacités

- GUI, CLI, terminal, Git, navigateur, LSP, timeline et outils de base de données.
- Mémoire inter-session, partage de connaissances entre Agents et état de workspace partagé.
- Exécution consciente des ressources, capable de réagir au CPU, à la RAM et à la disponibilité de l’attention humaine.
- Tests end-to-end de GUI alimentés par Agent pour une auto-évolution supervisée.
- Planification et sessions lancées automatiquement pour permettre aux Agents de travailler toute la nuit ou de continuer pendant votre absence.
- Surfaces d’alignement organisationnel pour coordonner humains, Agents, objectifs et responsabilité (WIP).
- Collaboration de session et workflows d’issues de groupe via Supabase auto-hébergé (WIP).

## Agents pris en charge

Utilisez le harness Rust intégré d’ORG-II ou lancez ces CLI d’Agents de code prises en charge depuis l’app de bureau.

### GUI + TUI

<p>
  <a href="#fonctionnalités"><kbd><img src="../assets/org2-icon.svg" alt="Logo ORG-2" width="22" valign="middle" /> ORG-2</kbd></a> &nbsp;
  <a href="https://cursor.com/docs/cli/overview"><kbd><img src="../../src/assets/modelIcons/cursor.svg" alt="Logo Cursor CLI" width="16" valign="middle" /> Cursor CLI</kbd></a> &nbsp;
  <a href="https://code.claude.com/docs/en/configuration"><kbd><img src="../../src/assets/modelIcons/claude-code.svg" alt="Logo Claude Code" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://developers.openai.com/codex/config-basic"><kbd><img src="../../src/assets/modelIcons/openai.svg" alt="Logo Codex" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/installation"><kbd><img src="../../src/assets/modelIcons/kiro.svg" alt="Logo Kiro CLI" width="16" valign="middle" /> Kiro CLI</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-in-the-cli"><kbd><img src="../../src/assets/modelIcons/copilot.svg" alt="Logo GitHub Copilot" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/config/"><kbd><img src="../../src/assets/modelIcons/opencode.svg" alt="Logo OpenCode" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli/getting-started"><kbd><img src="../../src/assets/modelIcons/antigravity.svg" alt="Logo Antigravity" width="16" valign="middle" /> Antigravity</kbd></a>
</p>

### TUI

<p>
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/configuration-files.html"><kbd><img src="../../src/assets/modelIcons/kimi.svg" alt="Logo Kimi Code CLI" width="16" valign="middle" /> Kimi Code CLI</kbd></a> &nbsp;
  <a href="https://aider.chat/docs/config.html"><kbd><img src="../../src/assets/modelIcons/aider.svg" alt="Logo Aider" width="16" valign="middle" /> Aider</kbd></a> &nbsp;
  <a href="https://goose-docs.ai/docs/category/getting-started/"><kbd><img src="../../src/assets/modelIcons/goose.svg" alt="Logo Goose" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual"><kbd><img src="../../src/assets/modelIcons/amp.svg" alt="Logo Amp" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cli/cli-reference"><kbd><img src="../../src/assets/modelIcons/cline.svg" alt="Logo Cline" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="../../src/assets/modelIcons/kilo.svg" alt="Logo Kilo Code" width="16" valign="middle" /> Kilo Code</kbd></a> &nbsp;
  <a href="https://docs.x.ai/build/overview"><kbd><img src="../../src/assets/modelIcons/grok.svg" alt="Logo Grok CLI" width="16" valign="middle" /> Grok CLI</kbd></a> &nbsp;
  <a href="https://docs.devin.ai/cli"><kbd><img src="../../src/assets/modelIcons/devin.svg" alt="Logo Devin" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/user-guide/configuration"><kbd><img src="../../src/assets/modelIcons/hermes.svg" alt="Logo Hermes" width="16" valign="middle" /> Hermes</kbd></a> &nbsp;
  <a href="https://docs.openclaw.ai/cli/config"><kbd><img src="../../src/assets/modelIcons/openclaw.svg" alt="Logo OpenClaw" width="16" valign="middle" /> OpenClaw</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs"><kbd><img src="../../src/assets/modelIcons/infinity-agent.svg" alt="Logo Codebuff" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/"><kbd><img src="../../src/assets/modelIcons/qwen.svg" alt="Logo Qwen Code" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/mimocode/config-files"><kbd><img src="../../src/assets/modelIcons/xiaomimimo.svg" alt="Logo Mimo Code" width="16" valign="middle" /> Mimo Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/cli/configuration"><kbd><img src="../../src/assets/modelIcons/continue.svg" alt="Logo Continue" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/byok/overview"><kbd><img src="../../src/assets/modelIcons/droid.svg" alt="Logo Droid" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://docs.mistral.ai/vibe/code/cli/install-setup"><kbd><img src="../../src/assets/modelIcons/mistral.svg" alt="Logo Mistral Vibe" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://docs.autohand.ai/integrations/ai-model-providers"><kbd><img src="../../src/assets/modelIcons/autohand.svg" alt="Logo Autohand" width="16" valign="middle" /> Autohand</kbd></a> &nbsp;
  <a href="https://github.com/open-horizon-labs/oh-omp"><kbd><img src="../../src/assets/modelIcons/omp.svg" alt="Logo OMP" width="16" valign="middle" /> OMP</kbd></a> &nbsp;
  <a href="https://pi.dev/docs/latest/providers"><kbd><img src="../../src/assets/modelIcons/pi.svg" alt="Logo Pi" width="16" valign="middle" /> Pi</kbd></a>
</p>

## Télécharger

Version actuelle du build : v1.1.24 (2026-07-16)

Téléchargez la dernière application desktop ORGII en un clic :

- [macOS Apple Silicon](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg)
- [Installateur Windows x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe)
- [MSI Windows x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi)
- [AppImage Linux x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.AppImage)
- [DEB Linux x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.deb)
- [Tous les assets de la dernière version](https://github.com/org2AI/ORG2/releases/latest)

Les liens de téléchargement directs pointent toujours vers la dernière version GitHub.

## Développer depuis les sources

Pour construire ou contribuer depuis les sources :

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

Pour plus de détails sur la contribution, consultez [CONTRIBUTING.md](../../CONTRIBUTING.md). Nous demandons à chacun de rester respectueux et empathique ; consultez [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md).

## Sidecars natifs optionnels

Les fonctionnalités Browser Use et Computer Use dépendent de helpers natifs optionnels pour l’automatisation du navigateur et l’automatisation d’écran sur macOS :

- `agent-browser` est téléchargé depuis les releases `vercel-labs/agent-browser` pour l’OS/CPU actuel.
- `peekaboo` est téléchargé depuis les releases `steipete/peekaboo` sur macOS.

Computer Use est actuellement disponible uniquement sur macOS. Browser Use peut utiliser `agent-browser` sur les plateformes prises en charge.

Si un sidecar est manquant, le build Rust crée une petite ressource placeholder pour permettre aux builds de développement de continuer. La capacité associée peut revenir au `PATH` ou rester indisponible jusqu’à l’exécution de `pnpm run download:sidecars`.

## Communauté

Vous avez des questions, des retours ou souhaitez suivre l’évolution d’ORG-2 ? Rejoignez-nous sur Discord :

👉 **Discord : [discord.gg/tvWgAqhCzs](https://discord.gg/tvWgAqhCzs)**
👉 **WeChat : [https://github.com/org2AI/ORG2/issues/128]**

- **#how-to-use-org2** et **#faq** — bien démarrer
- **#announcement** — actualités des versions et mises à jour
- **#lets-chat** — partagez ce que vous créez et rencontrez la communauté
- **#feedback** — idées, demandes de fonctionnalités et rapports de bugs

## Licence

ORGII est sous licence GNU Affero General Public License v3.0 ou ultérieure (`AGPL-3.0-or-later`). Consultez [`LICENSE`](../../LICENSE) pour le texte complet de la licence.
