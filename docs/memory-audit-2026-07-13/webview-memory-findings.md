# Webview Memory Audit — 2026-07-13

**Symptom:** the Tauri webview grows to 1 GB+ RAM after visiting a few sessions
(session replays).

**Verdict:** no single leak. Three compounding retention layers — (1) terminals
kept mounted forever behind `display:none`, (2) per-session replay data retained
after switch-away (one bounded cache that is never proactively evicted, plus
unbounded jotai atom-family entries), and (3) a stack of CSS-hidden keep-alive
surfaces that set a high fixed floor. A measurement bug in the built-in RAM
monitor hides the biggest contributor.

**Status legend:** `FIXED` (this batch) · `OPEN` (recommended, not yet done) ·
`INFO` (bounded / by design, documented for context).

---

## 1. Session data retained after switch-away

### 1.1 `FIXED` — EventStoreProxy snapshot cache never evicted on switch-away

- `src/engines/SessionCore/core/store/EventStoreProxy.ts:52-53` —
  `_latestSnapshots` / `_normalizedSnapshots`, capped at `SNAPSHOT_CACHE_MAX = 20`
  sessions (`:46`).
- Each entry is a **full materialized transcript**: four `SessionEvent[]` arrays
  plus an `eventsById` map. Replay scrubbing inflates it further — the turn
  window merges up to `MAX_LOADED_HISTORICAL_TURN_BODIES = 8` fully-hydrated
  turn bodies (`src/engines/SessionCore/turns/turnWindowConfig.ts:3`) into the
  snapshot before it is frozen into the cache.
- `clearSessionAtom` (`src/engines/SessionCore/core/atoms/actions.ts:253`)
  cleared payloads and turn bookkeeping on switch but **never released the
  outgoing session's snapshot**. Direct A→B switches (`loadSessionAtom`'s
  switch branch) didn't either. Only edit/reload/compact called
  `evictSession()`.
- `handleSessionEvicted`
  (`src/engines/SessionCore/sync/adapters/rustAgent/eventHandlers/sessionHandlers.ts:297`)
  — fires when Rust idle-evicts a session — only reset streaming UI state; the
  JS mirror kept the snapshot even after Rust dropped it (the exact desync
  `evictSessionCache`'s doc comment warns about).

**Fix applied:** new `releaseSessionSnapshot(sessionId)` /
`releaseSessionSnapshotIfIdle(sessionId)` on `EventStoreProxy` (drop the two
snapshot maps, **keep** `_sessionListeners` so still-mounted consumers keep
receiving pushes). Wired into:

- `clearSessionAtom` (leaving a session),
- `loadSessionAtom`'s A→B switch branch,
- `handleSessionEvicted` (mirror Rust idle-eviction).

The `IfIdle` variant skips sessions whose latest snapshot is still streaming —
an active background session keeps pushing envelopes, so eviction would only
force a full-snapshot refetch on its next delta.

Switch-away releases are deferred by a 3-minute grace window
(`scheduleSessionSnapshotRelease`) and cancelled when the session becomes
active again (`switchSession` / `loadSessionAtom`), so rapid ping-ponging
between sessions keeps the instant JS-cache prime and the delta path. Rust
idle-eviction still releases immediately — the Rust copy is already gone, so
the JS mirror is pure garbage.

### 1.2 `FIXED` — session-scoped atom families never removed (unbounded)

- `src/engines/SessionCore/derived/sessionScopedChatEvents.ts` — three
  `atomFamily`s keyed by sessionId: `sessionSnapshotAtomFamily` (holds the full
  `Snapshot` as atom state), `chatEventsForSessionAtomFamily` (closure retains
  the derived `SessionEvent[]`), `sessionScopedPlanningMetaAtomFamily`.
- `jotai-family` pins every created atom in a strong `Map` until `remove()` is
  called. No code called `.remove()` or `setShouldRemove()` anywhere, so every
  subagent/group session ever rendered (Simulator grid cells, subagent strips,
  group chat, agent control palette) kept its full snapshot **for the app
  lifetime**, even after the 20-cap proxy cache evicted it. No cap at all —
  grows with every distinct session visited.

**Fix applied:** mount-gated GC. `sessionSnapshotAtomFamily`'s `onMount` cancels
any pending removal; its unmount cleanup schedules removal of all three family
entries after `SESSION_FAMILY_RETAIN_MS` (3 min). The derived families depend on
the snapshot family, so none of the three can still be mounted when the
snapshot atom unmounts; a remount within the grace period cancels the timer and
keeps the warm entry.

### 1.3 `OPEN` — turn bodies loaded during replay stay loaded in Rust

`clearLoadedTurnRegistry(sessionId)`
(`src/engines/SessionCore/turns/loadedTurnRegistry.ts:75`) deletes JS
bookkeeping only — it never calls `eventStoreProxy.unloadTurnBody`, and
`pruneLoadedTurnBodies` only runs for the _active_ session while it loads more
turns. Bodies hydrated during a replay stay resident Rust-side after switching
away. (JS-side impact is now mitigated by 1.1; the Rust store keeps its own
LRU.) Recommended: unload non-protected bodies on switch-away.

### 1.4 `OPEN` — RAM monitor under-reports large snapshots

`estimateObjectBytes` stops traversing after `MEMORY_ESTIMATION_NODE_LIMIT =
5000` nodes (`src/engines/SessionCore/core/store/memoryEstimation.ts`), so the
sidebar RAM monitor's "snapshots" row drastically under-reports replay-inflated
snapshots — the dominant cache looks small in the tool built to find it.
Recommended: sample-and-extrapolate instead of truncating.

---

## 2. Terminals: mounted forever behind `display:none`

### 2.1 `OPEN` — every initialized terminal session stays fully mounted

- `src/engines/TerminalCore/index.tsx:313-343` — renders **all** sessions in
  `initializedTerminalIdsAtom` (plus the active one) and hides inactive ones
  with `display:none`. Each wrapper holds a full xterm instance
  (`scrollback: 5000`, `src/components/TerminalInteractive/terminalSetup.ts:60`)
  plus a WebGL context. Instances are only torn down on explicit close
  (`removeTerminalSessionLocalOnly`,
  `src/store/workstation/codeEditor/terminal/index.ts:256`).
- The initialized set is **persisted to localStorage and restored without a
  cap** (`terminal/index.ts:100-103`, `:192-209`) — every previously-open
  terminal re-instantiates its xterm on app launch.
- Same pattern: chat-panel CLI terminal tabs
  (`src/engines/ChatPanel/ChatPanelShell.tsx:104-122`).

xterm disposal itself is correct (`TerminalInteractive/index.tsx:275-295`); the
leak is purely the no-unmount policy. Recommended: unmount inactive terminals
(buffer restore already exists via `SerializeAddon` + `bufferCache`), or LRU-cap
the initialized set, and cap the localStorage restore.

### 2.2 `OPEN` — `XtermOutput` WebGL contexts bypass the global budget

`src/components/XtermOutput/index.tsx:120-128` calls `new WebglAddon()`
directly, skipping `acquireWebglSlot()`/`releaseWebglSlot()`
(`src/components/TerminalInteractive/webglContextManager.ts`, cap 8; macOS hard
limit ~16/process at 10–30 MB each). Every chat-replay terminal block
(`BlockOutput.tsx:326`) and `TerminalReadOnly` creates an unbudgeted context —
replay scrolling churns them and can trigger GPU context-loss thrash.
Recommended: route through the slot manager.

### 2.3 `OPEN` — over-broad TUI heuristic multiplies xterm instances in replays

`src/components/TerminalDisplay/utils/ansiProcessor.ts:74-88` — a bare `\r` not
followed by `\n` (extremely common in shell output) classifies a block as TUI,
so `BlockOutput` mounts a full xterm+WebGL instead of the cheap `<pre>` path.
Chat history is virtualized, so this is bounded to the visible window — but
each scroll tick spins up/tears down a heavy instance, and Simulator grids
mount several panes at once. Recommended: tighten the heuristic.

---

## 3. CSS-hidden keep-alive surfaces (fixed ceiling, high floor)

All `INFO`/`OPEN` — these don't grow per visited session, but they stack:

| Surface                                                                                                                   | Where                                                                                 | Mechanism                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| WorkStation + router Outlet both mounted                                                                                  | `src/modules/index.tsx:437,486-518`                                                   | `useStickyMount` + `getViewToggleStyle` (`display:none`/`visibility:hidden`, `viewContainerTokens.ts:86-95`)            |
| All 5 workstation apps once visited (Simulator, CodeEditor, DatabaseManager, **Browser — real webviews**, ProjectManager) | `src/modules/WorkStation/AppShell/AppShellContent.tsx:125-191`                        | `hasVisited*` latches + inline `display:none`                                                                           |
| Up to 12 cached route trees                                                                                               | `src/modules/shared/layouts/MainAppShell/index.tsx:97`                                | `KeepAliveRouteOutlet max={12}` — key collapses to route _type_ (`deriveRouteCacheKey`), **not** per session (verified) |
| ProjectManager work-item tabs (all mounted)                                                                               | `ProjectManagerContentRouter.tsx:121-217`                                             | per-tab `display:none`                                                                                                  |
| Source Control keep-alive overlay                                                                                         | `EditorMainPane/index.tsx:795-819`                                                    | `useStickyMount` + `opacity-0`                                                                                          |
| Bottom-panel tabs, `keepAlive` sidebars, dual sidebar                                                                     | `BottomPanelContent.tsx:50-58`, `useTabSidebar.tsx:209-226`, `SidebarSelector.tsx:24` | bounded `display:none` sets                                                                                             |

Highest-value conversion if the floor needs lowering: `AppShellContent` app
modes (Browser webviews + Simulator are the heaviest), then the per-tab xterm
sites (§2.1), then `KeepAliveRouteOutlet max` reduction.

**Verified clean (render-only-active):** editor `TabContentRenderer` switch;
chat panel's single un-keyed `ChatView`; `ChatHistory` TanStack virtualization
(re-keyed per session); Simulator content area (one app at a time, grid ≤ 12
cells); Kanban session detail panel (keyed remount).

---

## 4. Minor / ruled out

- `OPEN` (low) — `src/diagnostics/runtimeCounters.ts:10-43`: per-call
  `durations` arrays only flush via the online diagnostics snapshot; unbounded
  growth in offline mode (tens of MB over a long session, primitives only).
- `OPEN` (negligible) — `useGlobalFlowTracker.ts:82-112` uses raw
  `listen().then(push)` instead of the race-safe `useTauriListen`; app-lifetime
  mount, so only a StrictMode/teardown race.
- **Ruled out after verification:** Tauri listeners (race-safe wrappers used
  consistently), window/document listeners, timers/rAF loops, Resize/
  Intersection/MutationObservers, zustand/emitter subscriptions, WebSocket/SSE
  teardown, object-URL revocation, screenshot cache (20 entries / 24 MB cap;
  replay screenshots resolved lazily by ID from Rust), payload registry
  (6 / 8 MB), simulator hydration registry (600 events), shiki/mermaid/syntax
  caches (size-capped), terminal buffer cache (10 × ~500 KB), terminal output
  scheduler (2 MB backlog cap per pane, unregistered on unmount).

---

## How to observe

Sidebar RAM monitor (`src/scaffold/NavigationSidebar/connectors/SidebarRamMonitorButton/`)
breaks down payloads / screenshots / snapshots / turn bodies / hydrated events /
CodeMirrors etc. Caveat: the "snapshots" row is under-reported until 1.4 is
fixed. For ground truth use the WebKit/DevTools heap profiler and compare
retained size of `_latestSnapshots` and the `jotai-family` maps before/after
visiting replays.

## Fix log

- 2026-07-13 — 1.1 and 1.2 implemented (67ce345e5): snapshot release on
  switch-away + Rust-evict mirroring; mount-gated atom-family GC.
- 2026-07-13 — deferred release: switch-away snapshot release now runs behind
  a 3-minute grace window cancelled on re-activation (rapid switch-backs stay
  warm); atom-family retain window aligned to the same 3 minutes. Everything
  else remains `OPEN`.
