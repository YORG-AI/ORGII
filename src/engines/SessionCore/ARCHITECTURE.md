# SessionCore Architecture

> Last updated: 2026-03-30

## Overview

SessionCore is the central engine for session event processing. It handles:

- Event ingestion from WebSocket/API
- Normalization to a unified format
- Storage in Jotai atoms
- Rendering via React components

## Folder Structure

```
SessionCore/
├── __tests__/           # Unit tests
├── analytics/           # Session analytics types
├── core/                # State atoms and types
│   ├── atoms/           # Jotai atoms (events, metadata, actions)
│   ├── store/           # EventStoreProxy (Rust-backed)
│   └── types.ts         # SessionEvent, ReplayMode, etc.
├── derived/             # Derived atoms (chatEvents, simulatorEvents)
├── hooks/               # Business logic hooks
│   ├── session/         # Session lifecycle (create, discover, manage)
│   ├── replay/          # Replay navigation, step state, file tracking
│   ├── cloud/           # Cloud sync utilities
│   └── useSessionStore.ts  # Main store consumption hook
├── ingestion/           # Raw data → SessionEvent conversion
│   ├── _archive/        # Legacy TS normalizer (tests only)
│   ├── rustBridge.ts    # Tauri IPC for Rust normalizer
│   └── visibilityFilters.ts  # isVisibleInChat, isVisibleInSimulator
├── rendering/           # Event UI rendering infrastructure
│   ├── props/           # Props extraction and normalization
│   ├── registry/        # Component registry (lazy loading)
│   └── types/           # UniversalEventProps types
├── storage/             # Persistence (SQLite, IndexedDB)
├── sync/                # Session synchronization
│   ├── adapters/        # Agent-specific adapters (CLI, SDE, OS)
│   ├── hooks/           # Sync hooks (WebSocket, polling, accumulators)
│   ├── utils/           # Sync utilities (ID gen, message handlers)
│   └── types/           # Sync types
├── ui/                  # UI components
│   ├── adapters/        # Context adapters (Simulator)
│   ├── blocks/          # Reusable blocks (TodoBlock, TerminalBlock)
│   ├── events/          # Per-tool event components
│   └── shared/          # Shared utilities and hooks
└── workspace/           # Workspace-scoped state
    ├── atoms/           # UI and session atoms
    └── hooks/           # useWorkspaceSession, useWorkspaceUI
```

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SESSION EVENT PIPELINE                            │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────┐     ┌──────────────────┐
  │   Tauri IPC Channel              │     │   CLI Agents     │
  │   (real-time events from Rust)   │     │   (local)        │
  └────────────────┬─────────────────┘     └────────┬─────────┘
                   │                                │
                   └────────────────┬───────────────┘
                                    ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  SYNC LAYER                                                             │
  │  sync/                                                                  │
  │                                                                         │
  │  • useSessionSync.ts        — Unified session sync orchestrator         │
  │  • useSessionChannel.ts     — Tauri IPC Channel subscription            │
  │  • SessionSyncProvider.tsx  — Mounts sync for the active session        │
  │  • adapters/                — Per-session-type event normalization      │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │
                                   ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  INGESTION LAYER — RUST SINGLE SOURCE OF TRUTH                         │
  │  Rust: src-tauri/src/event_store/ingestion/                            │
  │  TS bridge: ingestion/rustBridge.ts                                    │
  │                                                                         │
  │  processChunksRust(chunks) → SessionEvent[]                            │
  │  normalizeChunkRust(chunk, sessionId) → SessionEvent                   │
  │                                                                         │
  │  • ALL chunk normalization happens in Rust                              │
  │  • Converts ActivityChunk → SessionEvent                                │
  │  • Infers: function, displayVariant, displayStatus, activityStatus      │
  │  • Tool call merging (running + completed) via merge_tool_call_pairs    │
  │  • TS only calls Tauri IPC (no local normalization logic)               │
  │                                                                         │
  │  ⚠️ Legacy TS normalizer ARCHIVED: ingestion/_archive/chunkNormalizers.ts│
  │     Kept only for test fixtures reference                               │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │
                                   ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  CORE ATOMS                                                             │
  │  core/atoms/                                                            │
  │                                                                         │
  │  • eventsAtom         — All SessionEvents for current session           │
  │  • metadataAtom       — Session metadata (id, status, timestamps)       │
  │  • uiItemsAtom        — Transient UI state (pending approvals)          │
  │  • actions.ts         — Atom write actions (append, clear, etc.)        │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │
           ┌───────────────────────┼───────────────────────┐
           │                       │                       │
           ▼                       ▼                       ▼
  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
  │  CHAT PANEL     │   │  SIMULATOR      │   │  TRAJECTORY     │
  │                 │   │                 │   │                 │
  │  ChatHistory/   │   │  Simulator*/    │   │  Trajectory/    │
  └────────┬────────┘   └────────┬────────┘   └────────┬────────┘
           │                     │                     │
           └─────────────────────┼─────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  RENDERING LAYER                                                        │
  │  rendering/                                                             │
  │                                                                         │
  │  ┌─────────────────────────────────────────────────────────────────┐   │
  │  │  props/propsNormalizer.ts                                       │   │
  │  │  normalizeEventProps(input) → UniversalEventProps               │   │
  │  │  • Unifies props from Chat/Simulator/Trajectory formats         │   │
  │  └─────────────────────────────────────────────────────────────────┘   │
  │                                 │                                       │
  │                                 ▼                                       │
  │  ┌─────────────────────────────────────────────────────────────────┐   │
  │  │  registry/events/index.ts                                       │   │
  │  │  COMPONENT_LOADERS[uiCanonical] → React.lazy(Component)         │   │
  │  │  • Maps ui_canonical → lazy-loaded component                    │   │
  │  │  • Source of truth: Rust UiCanonical enum                       │   │
  │  └─────────────────────────────────────────────────────────────────┘   │
  │                                 │                                       │
  │                                 ▼                                       │
  │  ┌─────────────────────────────────────────────────────────────────┐   │
  │  │  ui/events/{component}/index.tsx                                │   │
  │  │  • Per-tool UI components (ShellEvent, EditFileEvent, etc.)     │   │
  │  │  • Receive UniversalEventProps                                  │   │
  │  └─────────────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────────────┘
```

## Canonical Name Types

There are TWO types of canonical names:

| Type                  | Purpose                         | Example                      | Source                     |
| --------------------- | ------------------------------- | ---------------------------- | -------------------------- |
| **Storage Canonical** | Persistence, exact tool name    | `str_replace_editor`, `bash` | `cli_agents/alias_map.rs`  |
| **UI Canonical**      | Component mapping, coarse group | `edit_file`, `shell`         | `UiCanonical` enum in Rust |

### Resolution Flow

```
Raw tool name (e.g., "Edit", "str_replace", "str_replace_editor")
       │
       ├─── getCliStorageCanonical() ──→ "str_replace_editor" (storage)
       │
       └─── getCliUiCanonical() ───────→ "edit_file" (UI component)
```

## Key Files

### Sync Layer (`sync/`)

| File                                 | Purpose                                        |
| ------------------------------------ | ---------------------------------------------- |
| `useSessionSync.ts`                  | Unified Tauri session sync (CLI + Rust agents) |
| `useSessionChannel.ts`               | Tauri IPC Channel subscription                 |
| `SessionSyncProvider.tsx`            | Mounts `useSessionSync` for the active session |
| `utils/activityIds.ts`               | Generate/parse event IDs                       |
| `adapters/cliAdapter.ts`             | CLI agent adapter                              |
| `adapters/createRustAgentAdapter.ts` | Factory for Rust-native agent adapters         |

### Hooks (`hooks/`)

| Folder       | Purpose                                      |
| ------------ | -------------------------------------------- |
| `session/`   | useSessionManager, useSessionCreator         |
| `replay/`    | useReplayState, useStepState, useRecentFiles |
| `hostedKey/` | useHostedKeyActivitySync                     |

### Ingestion Layer (`ingestion/`)

| File                           | Purpose                                       |
| ------------------------------ | --------------------------------------------- |
| `rustBridge.ts`                | **Main entry point** — calls Rust normalizer  |
| `visibilityFilters.ts`         | Visibility filters (isVisibleInChat, etc.)    |
| `agentMessageAdapters.ts`      | Adapt different agent message formats         |
| `_archive/chunkNormalizers.ts` | Legacy TS normalizer — kept for test fixtures |

**Normalization Pipeline (Rust)**:

```
ActivityChunk (raw)
      │
      ▼ es_process_chunks() or es_normalize_chunk()
      │
┌─────┴──────────────────────────────────────────────────┐
│  Rust: src-tauri/src/event_store/ingestion/            │
│                                                         │
│  1. normalizer.rs      — Field inference (variant, etc.)│
│  2. consolidator.rs    — Collapse duplicate chunks      │
│  3. tool_call_merger.rs — Merge running+completed pairs │
└─────────────────────────────────────────────────────────┘
      │
      ▼
SessionEvent[] → Tauri IPC → TypeScript
```

**Tool Call Merging**: When agents send `tool_call` (running, with args) followed by
`tool_result` (completed, with result), Rust's `merge_events()` and `merge_tool_call_pairs()`
merge them into a single event preserving both args and result.

### Core Atoms (`core/atoms/`)

| File          | Purpose                                    |
| ------------- | ------------------------------------------ |
| `events.ts`   | eventsAtom — all session events            |
| `metadata.ts` | Session metadata, specs                    |
| `uiItems.ts`  | Transient UI state                         |
| `actions.ts`  | Write actions (appendEvents, clearSession) |
| `context.ts`  | Filtered views (by thread)                 |

### Rendering Layer (`rendering/`)

| File                           | Purpose                       |
| ------------------------------ | ----------------------------- |
| `registry/events/index.ts`     | COMPONENT_LOADERS map         |
| `registry/initToolRegistry.ts` | Initialize Rust tool maps     |
| `registry/toolCategories.ts`   | Tool type classification      |
| `props/propsNormalizer.ts`     | Input → UniversalEventProps   |
| `props/propsDataExtractors.ts` | Tool-specific data extraction |

### UI Components (`ui/`)

| Folder    | Purpose                              |
| --------- | ------------------------------------ |
| `events/` | Per-tool event components            |
| `blocks/` | Reusable UI blocks (TodoBlock, etc.) |
| `shared/` | Shared utilities and hooks           |

## Chat History Projection Worker

Chat history has three explicit data owners:

| Layer                               | Owns                                                                         | Must not own                                           |
| ----------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| Rust EventStore / `DerivedSnapshot` | Durable events, event order, visibility, source version                      | React state, turn-collapse preferences                 |
| `ChatHistory/projection/` Worker    | Rebuildable display projection, turn grouping/collapse, stable shape digests | Persistence, turn lifecycle/FSM, send/cancel semantics |
| React main thread                   | Jotai/React state, DOM, virtualization, scroll and user interaction          | Full-history CPU projection for large sessions         |

The main entry point is `projectChatHistory()`. Both small-history main-thread execution and the module Worker call this same pure implementation. `projectChatGroups()` and `projectChatTurnPagination()` are also pure functions; their React hooks are adapters only.

Worker messages use protocol version 1 and always carry `sessionId`, `generation`, `sourceVersion`, and `requestId`. The runtime accepts a snapshot followed by contiguous deltas. A missing session, generation mismatch, or source-version gap produces `resyncRequired`; stale responses are rejected by the client before React state is committed. The Worker caches at most four sessions and explicit disposal occurs on session unmount.

Histories below 2,000 events stay on the main thread to avoid structured-clone and scheduling overhead. Larger histories use the Worker. If Worker construction, execution, or response validation fails, the UI falls back to the same pure core and records a warning without mutating EventStore state. Streaming token text remains in the existing leaf-renderer path and does not trigger a full projection for every token.

`queueWaitMs`, `computeMs`, and `inputEvents` are response telemetry. These counters contain no message text, tool arguments, or other user content. Stable group/item digests replace render-time full-array `join()` keys.

## lib/activityData vs ingestion (Rust)

These are **different layers** with different purposes:

| Aspect    | `Rust ingestion` (single source of truth) | `lib/activityData/activityNormalizers.ts` |
| --------- | ----------------------------------------- | ----------------------------------------- |
| Layer     | Ingestion (first touch)                   | General purpose (consumers)               |
| Input     | Raw ActivityChunk                         | Any activity format                       |
| Output    | SessionEvent                              | NormalizedActivity                        |
| Canonical | Storage (`str_replace_editor`)            | UI (`edit_file`)                          |
| Used by   | Sync hooks (via rustBridge)               | Chat panel, analytics                     |

**Rule**: Ingestion normalizers run ONCE at data entry (in Rust). lib/activityData is for downstream consumers who need re-normalization.

> ⚠️ **Migration Status (2026-03)**: TS `chunkNormalizers.ts` is ARCHIVED. All production
> normalization now routes through `rustBridge.ts` → Rust. The TS version is kept in
> `_archive/` for test fixture validation only.

## Workspace Atoms (`workspace/`)

Workspace atoms manage session-scoped UI state:

| File                           | Purpose                                |
| ------------------------------ | -------------------------------------- |
| `atoms/sessionAtoms.ts`        | Session state (show, doing, repo info) |
| `atoms/uiAtoms.ts`             | UI state (tabs, loading, views)        |
| `hooks/useWorkspaceSession.ts` | Session state hook                     |
| `hooks/useWorkspaceUI.ts`      | UI state hook                          |

**Prefer hooks over direct atom imports** for better encapsulation.

## Adding a New Tool

1. **Rust**: Add to `UiCanonical` enum in `tool_ui_metadata.rs`
2. **Frontend**: Add component in `ui/events/{tool_name}/`
3. **Registry**: Add lazy loader in `registry/events/index.ts`
4. **Test**: Add to `registryCompleteness.test.ts`

See `docs/shared/ui-canonical-component-mapping--0330.md` for details.

---

## Simulator Rendering Architecture

> Added: 2026-04-01

The Simulator is the primary visual replay interface for agent sessions. It renders events as "apps" (CODE_EDITOR, BROWSER, MESSAGES, etc.) rather than individual event components.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SIMULATOR MAIN PANE                                  │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  STATE LAYER (Jotai atoms)                                              │
  │                                                                         │
  │  • simulatorEventsAtom    — Filtered events visible in simulator        │
  │  • currentEventAtom       — Current replay position                     │
  │  • replayBarValueAtom     — Slider position (0-100)                     │
  │  • replayModeAtom         — "follow" | "replay"                         │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │
                                   ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  APP ROUTING                                                            │
  │  Simulator/components/SimulatorContentArea/useSimulatorContent.tsx      │
  │                                                                         │
  │  1. getAppTypeForEventSafe(currentEvent.functionName)                   │
  │     └─► Returns AppType: CODE_EDITOR, BROWSER, CHANNELS, etc.           │
  │                                                                         │
  │  2. renderApp(appType, { currentEvent, mode: "simulation" })            │
  │     └─► Looks up SIMULATOR_APP_REGISTRY[appType].component              │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │
       ┌───────────────────────────┼───────────────────────────┐
       │                           │                           │
       ▼                           ▼                           ▼
┌─────────────────┐   ┌─────────────────────┐   ┌─────────────────┐
│  CODE_EDITOR    │   │  CHANNELS (Messages)│   │  BROWSER        │
│                 │   │                     │   │                 │
│  SimulatorCode  │   │  SimulatorMessages  │   │  SimulatorBrwsr │
│  Editor         │   │                     │   │                 │
└────────┬────────┘   └─────────────────────┘   └─────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  SimulatorCodeEditor (CODE_EDITOR App)                                      │
│  Location: WorkStation/CodeEditor/SessionReplay/index.tsx                    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  EventWrapper                                                        │   │
│  │  └── WorkStationShell (consistent IDE layout)                        │   │
│  │      ├── FileSidebar (left panel)                                   │   │
│  │      │   ├── Files tab (read/write operations)                      │   │
│  │      │   ├── Terminal tab (shell commands)                          │   │
│  │      │   └── Search tab (code_search, list_dir, etc.)           │   │
│  │      │                                                               │   │
│  │      └── CodePanel (main content)                                   │   │
│  │          ├── mode="file" → SessionReplayCodeMirrorViewer / Diff     │   │
│  │          ├── mode="terminal" → TerminalContent                      │   │
│  │          └── mode="search" → SearchResultsContent                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  State Hook: useSimulatorCodeEditor                                         │
│  • Reads simulatorEventsAtom up to current replay point                     │
│  • Builds fileOperations[], shellOperations[], searchOperations[]           │
│  • Manages selectedFileOperation, selectedShellOperation, etc.              │
│  • Handles sidebar selection ↔ replay position sync                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### App Type Routing

| AppType         | Component             | Typical Events                                                   |
| --------------- | --------------------- | ---------------------------------------------------------------- |
| `CODE_EDITOR`   | `SimulatorCodeEditor` | `read_file`, `edit_file`, `run_shell`, `code_search`, `list_dir` |
| `CHANNELS`      | `SimulatorMessages`   | `assistant`, `send_message`, `think`, `consult_agent`            |
| `BROWSER`       | `SimulatorBrowser`    | `browser_action`, `navigate_browser`, `screenshot`               |
| `DB_MANAGER`    | `SimulatorDatabase`   | `db_query`, `sql_execute`                                        |
| `STORY_MANAGER` | `SimulatorProject`    | `project_overview`                                               |
| `TRAJECTORY`    | `SimulatorTrajectory` | (Global view, not event-triggered)                               |

### Key Files

| File                                                                | Purpose                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| `WorkStation/shared/simulatorRegistry/registry.ts`                  | `SIMULATOR_APP_REGISTRY` — maps AppType to component |
| `WorkStation/shared/simulatorRegistry/useSimulatorAppRenderer.tsx`  | `renderApp()` function                               |
| `Simulator/components/SimulatorContentArea/useSimulatorContent.tsx` | Resolves appType from currentEvent                   |
| `Simulator/utils/eventToDockMapping.ts`                             | `getAppTypeForEventSafe()`                           |
| `WorkStation/CodeEditor/SessionReplay/index.tsx`                    | `SimulatorCodeEditor` component                      |
| `WorkStation/CodeEditor/SessionReplay/useSimulatorCodeEditor.ts`    | IDE state management hook                            |
| `WorkStation/CodeEditor/SessionReplay/CodePanel/`                   | File/terminal/search content viewers                 |

### EventRenderer vs Simulator Apps

There are **two rendering paths** for the same event:

| Path              | Usage                     | Entry Point                      | Layout                             |
| ----------------- | ------------------------- | -------------------------------- | ---------------------------------- |
| **Simulator App** | Main pane replay          | `renderApp(appType, ...)`        | Full WorkStationShell with sidebar |
| **EventRenderer** | Chat timeline, Playground | `EventRenderer` + `variant` prop | Single event, no sidebar           |

**EventRenderer variants:**

```tsx
<EventRenderer activity={activity} variant="chat" />      // Chat bubble style
<EventRenderer activity={activity} variant="simulator" /> // Simulator content style
```

The `variant="simulator"` uses `SimulatorVariant` components that **reuse the same atomic components** as CodePanel (e.g., `SessionReplayCodeMirrorViewer`, `TerminalContent`) wrapped in `SimulatorVariantShell` for consistent headers.

### Adding a New Simulator App

1. Create app folder: `WorkStation/{AppName}/SessionReplay/`
2. Define config: `config.ts` with `defineSimulatorAppConfig<State>()`
3. Create component: `index.tsx` as default export
4. Create state hook: `useSimulator{AppName}.ts`
5. Register in `simulatorRegistry/registry.ts`:
   ```ts
   [AppType.NEW_APP]: {
     ...NEW_APP_CONFIG,
     component: LazySimulatorNewApp,
   }
   ```
6. Add routing in Rust: `getAppTypeForTool()` should return the new AppType
