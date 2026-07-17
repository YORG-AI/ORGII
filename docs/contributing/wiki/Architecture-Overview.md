# Architecture Overview

ORGII is a **Tauri v2** desktop application — a thin native shell wrapping a React frontend, with a multi-crate Rust backend handling all agent process management, file I/O, and native integrations.

## High-level structure

```
┌─────────────────────────────────────────────────────────────┐
│                     ORGII Desktop App                       │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              React Frontend  (TypeScript)            │  │
│  │                                                      │  │
│  │  scaffold/  modules/  features/  engines/            │  │
│  │  Jotai atoms · react-router · CodeMirror · xterm     │  │
│  └────────────────────────┬─────────────────────────────┘  │
│                           │  Tauri IPC (invoke / events)   │
│  ┌────────────────────────▼─────────────────────────────┐  │
│  │              Rust Backend  (Tauri v2)                │  │
│  │                                                      │  │
│  │  agent_sessions/   agent_core/   key_vault           │  │
│  │  crates/…          commands/     infrastructure/     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Native OS: file system · processes · macOS APIs            │
└─────────────────────────────────────────────────────────────┘
```

## Frontend layers

The frontend is organized into several distinct layers, each with a clear ownership boundary.

### `src/modules/` — Page-level surfaces

Full application pages mounted by the router. The two primary modules are:

- **`MainApp/`** — the left-side panel: agent config, integrations, key vault, settings, inbox, project ops.
- **`WorkStation/`** — the main workspace: code editor, terminal, diff viewer, chat, browser, database manager, canvas.

### `src/features/` — Reusable domain UI

Self-contained feature components shared across modules:

| Feature                 | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `SessionCreator`        | Multi-variant session launcher (ChatPanel, Kanban) |
| `CodeViewer`            | Read-only and diff code viewers                    |
| `ChatPanel` (engine)    | Full chat UI — history, input, threading           |
| `SessionCore` (engine)  | Session sync, ingestion, turns, rendering          |
| `TerminalCore` (engine) | xterm.js terminal with addons                      |
| `GitWorkflow` (engine)  | Git operations, diff viewing                       |
| `BrowserCore` (engine)  | Embedded webview / browser use                     |

### `src/scaffold/` — App shell

Persistent chrome that wraps every page:

- `NavigationSidebar` — left navigation
- `GlobalSpotlight` — command palette / session switcher
- `ModalSystem` — global modal registry
- `WizardSystem` — multi-step setup wizards (Key Vault, Agent, MCP, Skill, …)

### `src/api/` — Transport layer

Three transport mechanisms, each with typed wrappers:

| Transport | Location            | Used for                                                                    |
| --------- | ------------------- | --------------------------------------------------------------------------- |
| Tauri IPC | `src/api/tauri/`    | All native operations — agent commands, session queries, repo, diff, GitHub |
| HTTP REST | `src/api/http/`     | Auth, git REST, user profile                                                |
| Realtime  | `src/api/realtime/` | WebSocket (agent streaming), SSE (task execution), CodeEditor WS (LSP)      |

Tauri IPC uses a **Zod-validated RPC layer** (`src/api/tauri/rpc/`) as the standard for all new commands. Request and response shapes are validated at the boundary.

### `src/store/` — Global state

[Jotai](https://jotai.org/) atoms organized by domain. Atoms used by two or more modules live in `src/store/`. Module-local atoms live colocated in `src/modules/{Module}/store/`.

Key domains: `session/`, `ui/`, `workstation/`, `git/`, `project/`, `settings/`, `tabs/`, `user/`

### `src/hooks/` — Shared hooks

React hooks used by two or more distinct modules. Module-specific hooks live colocated.

---

## Rust backend layers

### Agent session runners (`src-tauri/src/agent_sessions/`)

The core of the backend. Each CLI agent type has its own:

- **Platform adapter** — spawns the agent process, manages its stdin/stdout/stderr.
- **Output parser** — converts raw agent output into structured events (tool calls, messages, file edits).

Supported CLI agents: Cursor, Claude Code, Codex, Copilot, Antigravity, Kiro, OpenCode.

### `crates/agent-core/`

The Rust-native agent runtime. Powers the **SDE Agent** and **OS Agent**:

- Session types, prompt sections, exec modes
- Tool implementations (file ops, git, shell, browser, computer use)
- Event store and streaming
- Built-in prompts compiled via `include_str!`

### `crates/key-vault/`

Encrypted local storage for API keys and provider accounts. Keys never leave the device.

### `crates/event-store/`

Persistent event log for agent sessions. Enables session replay, resume, and the self-evolution test harness.

### `crates/git/`, `crates/advanced-search/`, `crates/database/`

Native integrations for git operations, semantic/full-text code search, and database connectivity (SQLite via libSQL, plus adapters for Postgres, MySQL).

---

## Data flow: a message round-trip

```
User types message → SessionCreator / ChatPanel
  → Jotai session atom updated
  → Tauri IPC invoke("agent_send_message", { sessionId, content, mode })
    → Rust agent_sessions handler
      → CLI process stdin / agent-core tool executor
        → Events streamed back via Tauri event system
          → Frontend event listeners update session atoms
            → React re-renders chat + WorkStation panels
```

---

## Key design decisions

| Decision            | Rationale                                                                               |
| ------------------- | --------------------------------------------------------------------------------------- |
| Tauri over Electron | ~10× lower memory footprint; Rust safety; no Node.js in the native layer                |
| Jotai over Redux    | Fine-grained atomic subscriptions avoid over-rendering large session lists              |
| Zod RPC boundary    | Catches schema drift between TS and Rust at runtime; errors surface early in dev        |
| Per-agent parsers   | Isolates each CLI agent's quirks; new agents added without touching shared code         |
| AGPL-3.0            | Ensures hosted derivatives remain open; an OSS core is planned in `packages/orgii_core` |

---

## Further reading

- [Frontend Architecture](Frontend-Architecture) — component conventions, state patterns, i18n, logging
- [Rust Backend](Rust-Backend) — crate map, IPC conventions, resource lifecycle
- [Sessions](Sessions) — session types, dispatch categories, exec modes
