# Frontend Engines Architecture

> Last updated: 2026-09-02

Engines (`src/engines/`) are **self-contained runtime subsystems** that power
specific tools in the editor. Each engine owns its own state, business logic,
and (optionally) UI components. They are isolated from each other by design —
cross-engine coordination happens through Jotai atoms, events, or explicit
service calls, never via direct import chains.

---

## Engine Inventory

| Engine           | Directory                   | Primary responsibility                                                               |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| **SessionCore**  | `src/engines/SessionCore/`  | Session event lifecycle — ingestion, storage, sync, and rendering                    |
| **ChatPanel**    | `src/engines/ChatPanel/`    | Conversation UI — chat history, input area, blocks, navigation                       |
| **Simulator**    | `src/engines/Simulator/`    | Visual replay of agent sessions as "apps" (code editor, browser, messages)           |
| **BrowserCore**  | `src/engines/BrowserCore/`  | Embedded browser sessions (multi-tab, history, proxy, incognito)                     |
| **TerminalCore** | `src/engines/TerminalCore/` | PTY terminal sessions with xterm.js, shell profiles, agent-linked read-only sessions |
| **DatabaseCore** | `src/engines/DatabaseCore/` | Unified database provider (SQLite, Supabase, Turso, Neon, Postgres, MySQL)           |
| **GitWorkflow**  | `src/engines/GitWorkflow/`  | GitHub diff viewer and Git suggestion cards                                          |

---

## Engine Descriptions

### SessionCore

The **central data engine**. All other engines read from its atoms.

**Owns:**

- `core/atoms/` — `eventsAtom`, `metadataAtom`, `uiItemsAtom`, write actions
- `derived/` — derived atoms: `chatEventsAtom`, `simulatorEventsAtom`
- `ingestion/` — bridge to the Rust normalizer (`rustBridge.ts`); converts raw
  `ActivityChunk` → `SessionEvent[]` via `es_process_chunks` Tauri IPC
- `sync/` — WebSocket / Tauri Channel subscription, session sync provider,
  per-session-type adapters (CLI, Rust agents)
- `rendering/` — `propsNormalizer.ts`, component registry (`COMPONENT_LOADERS`),
  per-tool event components
- `storage/` — SQLite and IndexedDB persistence
- `workspace/atoms/` — session-scoped UI atoms (`sessionAtoms.ts`, `uiAtoms.ts`)
- `hooks/session/` — session creation and discovery hooks
- `hooks/replay/` — `useStepState` and planning-indicator hooks

**Key invariant:** ALL chunk normalization happens in Rust. The TypeScript layer
only calls Tauri IPC — no local normalization logic exists in TS.

---

### ChatPanel

Renders the conversation history and composer.

**Owns:**

- `ChatHistory/` — scrollable event list
- `ChatItems/` — per-event item wrappers
- `InputArea/` — text composer, file attachments, slash commands
- `blocks/` — reusable block components (ToolCallBlock, CodeBlock, etc.)
- `hooks/` — resize, scroll, keyboard shortcut hooks
- `panels/` — auxiliary panels (context, references)
- `navigation/` — thread navigation

**Config constants** (`config.ts`):

- `MIN_WIDTH = 420`, `MAX_WIDTH = 800` (chat panel resize constraints)
- `RAPID_CLICK_THRESHOLD_MS = 300`

---

### Simulator

Replays agent sessions visually as full "apps" rather than individual event
components.

**Owns:**

- `utils/eventToDockMapping.ts` — maps `functionName` → `AppType`
- `utils/findIndexAtTime.ts` — canonical binary-search for replay cursor
- `utils/eventSegments.ts` — segment calculation for the timeline
- `utils/simulatorEventRouting.ts` — pattern-based app-type routing
- `hooks/` — `useGlobalReplay`, `useCellPlayback`, `useEventNavigation`,
  `useSimulatorEvents`, `useSimulatorSubagents`, grid layout
- `adapters/` — per-app-type simulator adapters
- `apps/` — app-type entry points (`CODE_EDITOR`, `CHANNELS`, `BROWSER`, etc.)
- `components/` — `SimulatorMainPane`, `SimulatorContentArea`
- `types/appTypes.ts` — `AppType` enum

**App-type routing:**

| AppType         | Component             | Triggered by                                                     |
| --------------- | --------------------- | ---------------------------------------------------------------- |
| `CODE_EDITOR`   | `SimulatorCodeEditor` | `read_file`, `edit_file`, `run_shell`, `code_search`, `list_dir` |
| `CHANNELS`      | `SimulatorMessages`   | `assistant`, `send_message`, `think`, `consult_agent`            |
| `BROWSER`       | `SimulatorBrowser`    | `browser_action`, `navigate_browser`, `screenshot`               |
| `DB_MANAGER`    | `SimulatorDatabase`   | `db_query`, `sql_execute`                                        |
| `STORY_MANAGER` | `SimulatorProject`    | `project_overview`                                               |
| `TRAJECTORY`    | `SimulatorTrajectory` | _(global view)_                                                  |

---

### BrowserCore

Provides multi-tab in-app browsing via Tauri WebViews.

**Owns:**

- `BrowserSessionWebview.tsx` — renders a single browser WebView
- `BrowserUrlInput.tsx` — URL bar with back/forward/refresh
- `hooks/` — session management, navigation, proxy
- `types.ts` — `BrowserSession`, `BrowserTabData`, `NavigationAction`

**State shape:** Each session has `sessions[]` (multi-tab), an
`activeSessionId`, and optional `useProxy` / `incognito` flags.

---

### TerminalCore

Full PTY terminal backed by xterm.js with agent integration.

**Owns:**

- `components/` — `TerminalView`, toolbar, resize handle
- `hooks/useTerminalState.ts` — session CRUD, active session, resize
- `hooks/useTerminalContextAdapter.ts` — adapts context for agent-linked sessions
- `addons/` — xterm add-ons (fit, weblinks, search)
- `types.ts` — `TerminalSession` (with `readOnly`, `agentSessionId`, `shellKind`)

**Display title priority:** `userTitle` → `sequenceTitle` → `processName` →
`name` (resolved by `getTerminalDisplayTitle(session)`).

---

### DatabaseCore

Uniform interface over heterogeneous database back-ends.

**Owns:**

- `factory.ts` — creates provider instances by type
- `providers/` — per-type adapters (SQLite via Tauri, HTTP-based for cloud DBs)
- `types.ts` — `DatabaseType`, `ConnectionStatus`, `TableInfo`, query result types
- `__tests__/` — unit tests for factory and provider utilities

**Supported providers:** `sqlite`, `supabase`, `turso`, `neon`, `postgres`,
`mysql`.

---

### GitWorkflow

Lightweight engine for Git-related UI components. Not a full state manager —
it delegates storage to Jotai atoms in `src/store/git/`.

**Owns:**

- `GitHubDiff/` — GitHub-style side-by-side diff viewer
- `GitSuggestionCards/` — AI-generated commit message / PR description cards

---

## Data Flow Between Engines

```
┌──────────────────────────────────────────────────────────────────────┐
│  Tauri IPC (Rust backend)                                            │
│  • es_process_chunks / es_normalize_chunk  (SessionCore ingestion)   │
│  • Terminal PTY commands                   (TerminalCore)            │
│  • Browser navigation / screenshot        (BrowserCore)             │
│  • Git status / diff / commit             (GitWorkflow)              │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SessionCore                                                        │
│  sync/ → ingestion/ → core/atoms/eventsAtom                         │
│                         │                                           │
│              derived/chatEventsAtom  derived/simulatorEventsAtom    │
└──────────┬──────────────┬─────────────────────┬─────────────────────┘
           │              │                     │
           ▼              ▼                     ▼
    ┌─────────────┐ ┌──────────────┐   ┌───────────────┐
    │  ChatPanel  │ │  Simulator   │   │  (Trajectory) │
    │             │ │              │   │               │
    │ reads       │ │ reads        │   │               │
    │ chatEvents  │ │ simEvents    │   │               │
    └─────────────┘ └──────────────┘   └───────────────┘

Independent engines (own Jotai atoms, no SessionCore dependency):
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐
  │  BrowserCore │  │ TerminalCore │  │ DatabaseCore │  │ GitWorkflow │
  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘
```

---

## How Engines Communicate

### Jotai Atoms (primary)

Each engine exposes atoms through its `index.ts`. Consumers import the atom
and call `useAtomValue` / `useSetAtom` in a component or hook. This is the
standard channel for reading shared state (e.g., ChatPanel reads
`chatEventsAtom` from SessionCore's derived layer).

### Tauri Commands / IPC

Engines that need data from Rust invoke Tauri commands (e.g.,
`invoke("es_process_chunks", ...)`) and write results into their own atoms.
Commands are typed via generated bindings in `src/commands/`.

### Events (rare)

Some cross-engine coordination uses a lightweight in-process event bus
(custom `EventEmitter` wrapper). This is reserved for fire-and-forget
notifications (e.g., "session ended") where the publisher should not depend on
the subscriber.

### Hook composition

When two engines need to interoperate at the hook level, one engine exports a
hook that the other engine's component tree can compose. For example,
`SessionCore` exports `useEventNavigation`, which ChatPanel composes to route
replay navigation through the canonical event atoms.

---

## Public Exports (`index.ts`)

Each engine exports only its intended public surface through `index.ts`.
Internal modules (`core/atoms/events.ts`, `rendering/registry/…`) should not
be imported by consumers directly — always go through the engine's `index.ts`
to avoid accidental coupling.

---

## Adding a New Engine

1. Create `src/engines/MyEngine/` with `index.ts`, `types.ts`, `hooks/`,
   optional `components/`.
2. Keep the engine isolated — no imports from sibling engines except via atoms
   or service calls.
3. Export the public API from `index.ts`.
4. Register any Tauri command bindings in `src/commands/`.
5. Add the engine to this document.
