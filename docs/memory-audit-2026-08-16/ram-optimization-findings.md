# RAM Optimization Audit — 2026-08-16

**Goal:** get the idle app from the measured **~220 MB (Rust) + ~520 MB (WebContent)**
down to the target **~80 MB + ~150 MB**. This document ranks every RAM lever
found in the tree at `8ad1fedea`, with file:line evidence, by how much of that
gap it closes. It builds on `docs/memory-audit-2026-07-13/webview-memory-findings.md`
(status of that audit's `OPEN` items is in §6).

**Status legend:** `MEASURED` (observed on the live v1.2.5 build) · `CONFIRMED`
(read in code) · `LIKELY` (code shape, not yet measured).

---

## 0. Measured baseline

Release build `/Applications/ORG2.app` v1.2.5 (Aug 9), macOS 26.3, cold
launch, no interaction, sampled at 25–60 s (`ps`, `footprint`, `heap`,
`malloc_history` with `MallocStackLogging=lite`). Data dir on this machine:
`~/.orgii/sessions.db` = 3.7 GB (`events` table 2.4 GB), 526 native sessions.

| Process             | Footprint                   | Notes                                                                                                            |
| ------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `org2` (Rust main)  | **222 MB** (RSS 287–359 MB) | 169 MB `MALLOC_SMALL` + 32 MB `MALLOC_LARGE` dirty; only **5 MB reclaimable**; 93 threads; **0 child processes** |
| `WebKit.WebContent` | **521 MB**                  | **456 MB "WebKit malloc"** (JS heap + DOM), 13 MB JIT, 31 MB owned graphics + 95 MB reclaimable IOSurface        |
| `WebKit.GPU`        | 46 MB                       | fixed WKWebView cost                                                                                             |
| `WebKit.Networking` | 28 MB                       | fixed WKWebView cost                                                                                             |
| **Total**           | **~820 MB**                 | target ≈ 230 MB + GPU/Networking                                                                                 |

Two facts from the Rust side change how to read the 222 MB:

- `heap` reports only **~40 MB of live malloc nodes** (25.9 MB "non-object from
  org2"). The rest of the ~200 MB dirty heap is **freed-but-not-returned**
  memory: footprint peaked at ~270 MB (tool overhead excluded) inside the first
  minute — startup background jobs allocate, free, and macOS libmalloc keeps the
  pages dirty in its free lists (only 5 MB is marked reclaimable). So the Rust
  gap is roughly _"~40 MB live + ~130–160 MB leftover from the startup peak"_.
- One 160 MB and one exactly-80 MiB allocation are live from startup but mostly
  untouched (they don't show as dirty) — reserved capacity somewhere on the boot
  path. Worth identifying once a symbolized build exists (§7).

The startup log window shows what runs in that first minute: session-mirror
reconcile (`reconcile_native_session_mirror` → `list_all_sessions` over every
native session, `src/agent_sessions/session_directory/orgtrack_adapter.rs:32-65`),
`backfill_session_usage` (limit 20 000), `agent_live_status::hydrate_from_disk`,
codex write reconciliation, GitHub `list_prs` open+closed (2 × 100), event-store
hydration of the restored session(s), memory-consolidation tick.

---

## 1. Rust process — ranked (222 MB → ~80 MB)

### 1.1 `MEASURED` Startup peak leaves ~130+ MB of dirty free heap

Two complementary fixes; do both.

**(a) Return memory after bursts.** No `#[global_allocator]`, no trim anywhere
(grep `global_allocator|mimalloc|jemalloc|malloc_trim|MALLOC_` → 0 hits).

- Cheapest: call `libc::malloc_zone_pressure_relief(ptr::null_mut(), 0)` (macOS)
  after the startup jobs finish and after each agent turn / big Tauri command
  completes. One line, macOS-only, measurable with `footprint`.
- Structural: `mimalloc` as `#[global_allocator]` behind a cargo feature
  (`purge_delay` default 10 ms decommits freed pages promptly). A/B with
  `footprint` after (i) cold launch, (ii) a heavy agent turn.

**(b) Shrink the peak.** See 1.2, 1.4, 1.7 — each reduces what the startup
burst allocates in the first place.

### 1.2 `CONFIRMED` SQLite: 64 MB page cache per connection, no pool, 512-thread blocking pool

- `crates/database/src/db/connection.rs:56-62` — `PRAGMA cache_size = -64000`
  - `temp_store = MEMORY` on **every** connection.
- `connection.rs:189-190` — `get_connection()` does `Connection::open` per call
  (no pool despite the module doc "Database Connection Pools"). **611** call
  sites, mostly inside `spawn_blocking` (821 sites), against the main Tauri
  runtime's default **512** max blocking threads (no `Builder` configures it).
- Against a 3.7 GB `sessions.db`, any connection that scans (`events`
  aggregates, mirror reconcile, backfill, extractors) fills tens of MB of page
  cache; N concurrent ones multiply it; all of it lands in the dirty free lists
  of 1.1 when dropped.
- Fix: `cache_size = -8000` (8 MB) — writers are already serialized by
  `db::writer`, so a small reader pool (4–8) is low-risk if you want the perf
  back; and hand Tauri a runtime with `max_blocking_threads(32)` +
  `thread_stack_size(512 KiB)`.
- Related: `crates/db-browser/src/pool.rs:11,45` — 16 conns × 8 MB (128 MB
  ceiling) for the DB-browser panel; 4 + idle TTL is enough. Eviction at
  `:31-34` uses `pool.keys().next()` (arbitrary, not FIFO as commented).

### 1.3 `CONFIRMED` Both tiktoken encoders resident forever (~20–30 MB)

- `crates/agent-core/src/core/model_context/tokenizer.rs:25,29` — `cl100k_base`
  and `o200k_base` as process-lifetime `LazyLock<CoreBPE>` (each = 100k/200k
  `HashMap<Vec<u8>,usize>` + reverse maps). Counts are already sampled above
  50 KB (`:33-36`), so precision isn't the point.
- Fix: instantiate only the encoder for the active provider family; use a byte
  heuristic for non-OpenAI models.

### 1.4 `CONFIRMED` Event store: count-only cap, duplicated payloads, deep clones at 10 Hz

- Topology: `EventStoreState.stores: Mutex<HashMap<String, EventStore>>`
  (`src/agent_sessions/event_pipeline/commands/state.rs:23`), LRU 15 idle / 25
  total (`session_manager.rs:18,20`), **8000 events per session**
  (`store/helpers.rs:12`) — a count cap with **no byte budget**.
- `crates/types/src/session_event.rs:36-37,68` — each `SessionEvent` holds
  `args`/`result` `serde_json::Value` **plus** `extracted: Option<ExtractedData>`,
  a parsed copy of the same data (double storage).
- `payload_compaction.rs:6-7,58` — `compact_event_for_snapshot` (64 KB → 8 KB
  preview) runs only on the _outbound_ path (`commands/notify.rs:110,174,195`,
  `derived.rs:313`); the in-memory store keeps full bodies that already live on
  disk.
- `commands/notify.rs:166-195` — `emit_snapshot` walks **all** events every
  100 ms batch (`:21`) and deep-clones every simulator-visible one, plus 3 full
  `Vec<String>` id clones (`:176-187`), while the delta tracker (`:167`) already
  knows what changed.
- `commands/snapshot.rs:35,51`, `cache_bridge.rs:108`, `agent_core_bridge.rs:150,348`
  — `store.events().to_vec()` full clones (up to 8000 deep events) to read a
  subset / render markdown.
- `crates/agent-core/src/core/turn_executor/execute.rs:308-312` — the whole
  LLM `messages` `Vec<Value>` (3–8 MB at 200k tokens) is cloned **every
  iteration of every turn** for two transforms.
- `commands/ingestion.rs:23` — `result.events.clone()` before append.
- Fixes: byte budget next to `MAX_EVENTS`; compact at ingestion; make
  `extracted` lazily derived; cache id lists + compacted simulator set in the
  store and invalidate from the delta; project under the lock instead of
  `to_vec()`; borrowed/streamed provider payload instead of `messages.clone()`.

### 1.5 `CONFIRMED` Session / subprocess lifetimes are too long

- `crates/agent-core/src/state/unified.rs:19,99,244-300` — `AgentAppState.sessions`
  has **no count cap**, only a **1-hour** idle eviction; each `AgentSession`
  transitively holds provider clients, tool registry, prompt cache, memory
  state, wingman tickers (`session/wingman/loop_runner.rs:46,57`), a
  `DialogScheduler` worker, and MCP clients.
- MCP: shared singleton (`specialization/mcp/commands.rs:47-71`, good) but
  `mcp_list_servers` → `ensure_connected_background` (`:181-187`) **connects
  every configured stdio server** (one `node`/`npx` process each,
  `mcp/client/connect.rs:182,194-223`) and nothing ever idle-disconnects
  (`mcp/manager/lifecycle.rs:179-182,322-331`).
- LSP: `crates/lsp/src/manager.rs:77` `servers: HashMap<(root, server_id), _>`
  — spawned on file open (`src/services/lsp/LspClient.ts:71,175`), stopped only
  by explicit `stop_server`/`lsp_shutdown` (`:714,518`); no idle TTL, no cap
  (out-of-process, but rust-analyzer/tsserver are 0.3–3 GB each on the machine).
- `crates/git/src/watch/watcher.rs:145` `watchers`, `state_store.rs:15` `states`
  (full `GitStatusResponse` per repo), `debounce.rs:68,70` — all uncapped per
  repo ever opened.
- `crates/ui-indexer/src/commands.rs:19` `UiIndexState.indexes:
HashMap<PathBuf, UiIndex>` — one full component index per repo ever indexed,
  only manual `remove` (`:151`).
- `crates/agent-core/src/foundation/flow_awareness/store.rs:36` `FlowStore.sessions`
  — inner deque capped (100), outer map never pruned.
- `crates/integrations/src/proxy/server.rs:59` `PROXY_SERVERS` — one listener +
  task per cloud session, verify every teardown path releases.
- `session_runner/helpers.rs:29` `SESSION_CONTROL_LOCKS` — tiny, never pruned.
- Fixes: idle eviction 1 h → 10–15 min + live-session cap; MCP idle TTL + lazy
  per-server connect; LSP idle TTL ("no open doc for root×lang for N min") +
  live-server cap; LRU on watchers/states/UiIndex (2–4 repos); hook
  `FlowStore::clear_session` into session eviction.

### 1.6 `CONFIRMED` Channel depths and log buffers

- `crates/agent-core/src/core/tools/impls/coding/exec/registry.rs:185,248,314`
  — background-shell output tap `broadcast(512)` × `String` **per job** (retained
  even with zero receivers; durable log is on disk). → 64–128.
- `crates/agent-core/src/foundation/bus/mod.rs:60,86` — outbound bus
  `broadcast(1000)` × `OutboundMessage`. → 128.
- `crates/git/src/watch/watcher.rs:170` — `bounded(1000)` fs events with paths.
  → 256.
- `crates/agent-core/src/core/providers/cursor_native/client.rs:146,213` — two
  `unbounded_channel::<Bytes>` on the streaming path (the only unbounded ones).
  → `channel(256)`.
- `src/lib.rs:291-292`, `src/infrastructure/frontend_log.rs:14-15` — two
  `tracing_appender::non_blocking` with default `buffered_lines_limit =
128_000` (crossbeam pre-allocates the slot array). → `.buffered_lines_limit(4096)`.
  Also `lib.rs:296-304` enables `debug` for `key_vault` + `app_lib::agent_core`
  in production.
- `crates/lsp/src/codec.rs:40` `MAX_MESSAGE_BYTES = 32 MB` single-allocation
  ceiling per server. → 8 MB unless a server needs more.
- `crates/search/src/code/commands/cache.rs:52-63` — 20 × up to 10 000 matches
  with context, no byte budget, `clone()` on hit. → byte budget + `Arc`.
- `crates/search/src/file.rs:75-79` `FILE_INDEX_CACHE` — well-bounded but a
  **64 MB** floor (4 repos × 32 MB); halve if @-file search still feels fine.
- `crates/shared-state/src/screenshot_state.rs:18-19` — 20 entries / **32 MB**
  floor, every entry also on disk. → 16 MB.

### 1.7 `CONFIRMED` Startup work that could be deferred / narrowed

- `src/agent_sessions/session_directory/orgtrack_adapter.rs:32-65` —
  `reconcile_native_session_mirror` lists _every_ native session and re-upserts
  all rows on **every** launch (metadata-only rows, but the whole set at once);
  then `backfill_session_usage(limit 20 000)`. Both could be incremental
  (updated_at watermark) and run after first paint with a lower priority.
- `src/lib.rs:614-630`, `src/cli_managed_proxy.rs:82-84` + main runtime — three
  tokio multi-thread runtimes; ~93 threads at idle. Stacks are cheap (2 MB dirty
  total) but each runtime carries drivers/queues; consider running the IDE
  server + proxy on the main runtime.
- `src-tauri/src/main.rs:9-17` — external agent hooks re-exec the 113 MB
  binary as `--session-provenance-hook`; a tiny separate hook binary avoids
  paging in a large Mach-O per hook call.

### 1.8 `CONFIRMED` Binary and static tables

- Release profile is right (`src-tauri/Cargo.toml:615-624`: thin LTO, `panic =
"abort"`, `strip = true`). Only 41 MB `__TEXT` was mapped clean at idle.
- Binary is 113 MB (`__text` 68 MB, `__const` 38 MB): 1302 Tauri commands,
  41 crates, tiktoken tables, 5 tree-sitter grammars (`crates/search/Cargo.toml:35-39`,
  `crates/ui-indexer/Cargo.toml:18-19`), `chrono-tz`, sqlx (postgres+mysql) +
  rusqlite, two `reqwest` stacks (0.12 via `tauri-plugin-updater`, 0.13). Mostly
  demand-paged; run `cargo bloat --release --crates` before spending time here.

---

## 2. WebContent — ranked (521 MB → ~150 MB)

### 2.1 `MEASURED` Initial JS is 9.3 MB because the dev-only eager import leaks into production

- `src/index.tsx:183-185` — `isDev ? import(/* webpackMode: "eager" */ "@src/App") : import("@src/App")`.
  `isDev` is a runtime `const` (`:27`); webpack parses **both** arms, `eager`
  wins, and the whole `App` tree is inlined into the entry chunk. Verified on
  `build/` (Aug 14): **no App chunk exists**; `main.*.js` = 4.82 MB, `vendors.*.js`
  = 4.36 MB, executed synchronously before first paint (+351 KB CSS).
- The comment (`:174-182`) describes the old `eval-cheap-module-source-map`
  setup; `webpack.config.js:655` no longer uses it.
- Fix: two literal `import()`s under `if (process.env.NODE_ENV === "development")`
  (a folded constant), or drop the eager branch. This also lets `splitChunks`
  move App-only vendors out of the initial `vendors` chunk.

### 2.2 `CONFIRMED` Barrel leaks drag ~2 MB of heavy libs into the startup graph

Same pattern `84e8f65e2` fixed inside ChatPanel; three consumers outside it:

| Consumer wants              | Imports                                                                                | Which re-exports                                                            | Drags in                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RenameModal`               | `…/WorkstationSidebarConnector/SidebarDialogs.tsx:1` → `scaffold/ModalSystem/variants` | `variants/index.ts:13` → `ContentView` (`ContentView/index.tsx:5,9`)        | `react-syntax-highlighter` → **refractor 597 KB**                                                                                                    |
| `WorkstationToolbarTooltip` | `SidebarSettingsMenuButton.tsx:44` → `modules/WorkStation/shared`                      | `shared/index.ts` → `GitFileDiffSplit/index.tsx:30` → `features/CodeMirror` | **all CodeMirror + 10 language packs + sql-formatter ≈ 1 MB** (`features/CodeMirror/shared/languageExtensions.ts:6-18`, `SqlEditor/index.tsx:11-18`) |
| terminal sidebar rows       | `TerminalSidebarRows.tsx:14` → `engines/TerminalCore/exports`                          | `exports.ts:4` → `index.tsx:25` → `components/TerminalInteractive`          | **xterm + 6 addons incl. webgl ≈ 470 KB** (`terminalSetup.ts:1-6`)                                                                                   |

Also in the startup graph: `framer-motion` via `useSetupWalkthroughTestShortcut.ts:5`
← `GlobalShortcuts/index.tsx:4` ← `AppBootstrap.tsx:17` (137 KB);
`@supabase/supabase-js` realtime via `useOrg2CloudRealtime` ← `AppBootstrap`
(auth part is legitimately boot-critical). Fix: deep-import at the three sites,
`React.lazy` the editor/terminal/highlighter surfaces; retire
`react-syntax-highlighter` in favour of the existing `useShikiHighlight` hook
(four highlighter stacks ship today: shiki, highlight.js, refractor,
prism-react-renderer — only shiki is lazy-grammar).

### 2.3 `MEASURED` `splitChunks` emits shared modules twice; `vendors` is one 4.36 MB blob

- `webpack.config.js:398-406` (`initialVendors`, `chunks: "initial"`) and
  `:407-462` (`asyncVendors`, `chunks: "async"`) are disjoint, so a module in
  both graphs is emitted in both — verified for `react-dom` (`vendors`,
  `async-vendors.react-dom`, and `main`), `zod`, `sql-formatter`. ≈ **3.3 MB** of
  duplicate parse (refractor 597K, zod 390K, xterm 339K, sql-formatter 290K,
  react-dom 225K, @codemirror/view 202K, …). Module cache is id-keyed, so it's
  bytes + parse/compile, not double heap objects.
- No `maxSize` on `initialVendors` → all-or-nothing parse.
- Fix: `asyncVendors` → `chunks: "all"` (or merge groups); `maxSize ≈ 500 KB`.

### 2.4 `CONFIRMED` Boot-time heap: 15 i18n namespaces + ~500 eager zod schema graphs

- `src/index.tsx:238` awaits `i18nReady`, which loads **all 15 namespaces** of the
  active language (`src/i18n/index.ts:240+`; ~600 KB JSON for `en`, retained in
  i18next's store — 2–4 MB in-heap). Namespaces like `terms`, `geo`, `market`,
  `builderProfile`, `teamRuntime`, `projects` are not needed for first paint.
  → await `common` + `navigation` + `sessions`, lazy the rest.
- `src/api/tauri/rpc/schemas/*` (27 files, 392 `z.object` at module scope) +
  `src/config/settingsSchema/registry/*` (~102) are reachable from `index.tsx`
  alone; zod v4 builds a live object graph per schema. → `z.lazy()` for
  rarely-used RPC namespaces or validate at the call site.
- 246 startup-reachable SVGs (284 KB raw) become React components via
  `@svgr` (`webpack.config.js:280-303`); use `?url` for decorative art.
- `main.css` 350 KB includes both CodeMirror token sheets (`src/index.scss:15-22`);
  move them into the CodeMirror chunk.

### 2.5 `CONFIRMED` Keep-alive surfaces (fixed floor) — what's still mounted at once

- **Browser workstation: one live `WKWebView` per tab, never destroyed.**
  `src/engines/BrowserCore/index.tsx:283-295` renders `<BrowserSessionWebview>`
  for every `session`; inactive ones are staged offscreen at `x:-10000`
  (`useInlineWebviewNativeVisibility.ts:41-45`, `useWebviewCommands.ts:329-335`),
  and the tab list is persisted/restored (`BrowserContext.tsx:89,205`,
  `useBrowserState.ts:144`). Each is a WebContent process (60–150 MB+). → LRU
  (active + 2–3), destroy others and rehydrate from URL; cap the restore.
  `src/features/SessionSetup/hooks/useEmbeddedWebview.ts:208` (auto-close on
  hidden) is the template.
- Workstation app latches: `AppShell/AppShellContent.tsx:128` (AgentStation —
  new since the last audit), `:160` (Code), `:176` (Browser), `:194` (Project),
  each `hasVisited* && display:none` (`AppShell/index.tsx:101-103`,
  `hooks/useAppShellStationMode.ts:30-40`).
- WorkStation + router `<Outlet/>` are always-mounted siblings
  (`src/modules/index.tsx:404,431-434`).
- Terminals: every initialized terminal stays mounted (`engines/TerminalCore/index.tsx:314-345`;
  `initializedTerminalIdsAtom` grows unconditionally, `store/workstation/codeEditor/terminal/index.ts:367,407,442`;
  localStorage restore uncapped `:98-101,133-140,158`; scrollback 5000); chat-panel
  CLI tabs same pattern (`engines/ChatPanel/TabContent/UnifiedChatPanelTabContent.tsx:81-100`).
- `ProjectManagerContentRouter.tsx:78-89` all work-item tabs mounted;
  `modules/shared/layouts/GenericBottomPanel/index.tsx:146` all tabs mounted;
  `useTabSidebar.tsx:209-226` warm sidebars (only Benchmark sets `keepAlive:true`,
  `BenchmarkTabSidebar.tsx:332`).
- Close = hide (`src/lib.rs:1173-1184`): nothing is released when the user
  "closes" the window. → on hide, drop JS caches and discard browser webviews.
- Window: `transparent: true` + `maximized: true` + `macOSPrivateApi` +
  `NSVisualEffectView` material (`tauri.conf.json:13,23,28,29`,
  `crates/app-window/src/lib.rs:241`) → extra full-size Retina backing stores
  (the 31 MB owned graphics + 95 MB reclaimable IOSurface in WebContent, 54 MB
  IOSurface in the Rust process). → opaque-window setting; measure the delta.

### 2.6 `CONFIRMED` Runtime retention that grows with use

- `src/modules/WorkStation/CodeEditor/hooks/fileContent/cache.ts:16`
  `unsavedContentCache` — **unbounded**, two full copies of file text per edited
  file + up to 100 edit ops; never evicted by `evictMetadataCache` (`:21-37`) or
  `clearFileCache` (`:170`); only removed on revisit/save. → byte-aware cap +
  clear on repo switch.
- Persisted & parsed at boot (`getOnInit`), unbounded:
  `src/features/Org2Cloud/org2CloudSyncAtoms.ts:172` `pushCursors` (one record
  per session ever pushed, ~12 fields + frontier array) and `:196`
  `pushedMetadata`; `features/TeamCollaboration/sessionOrgTagsAtom.ts:54`;
  `store/session/tuiModeAtom.ts:15` (one localStorage key per session);
  `engines/ChatPanel/InputArea/utils/imageDraftCache.ts:42` (base64 per session);
  `hooks/files/useDocumentStorage.ts:198,364`;
  `CodeEditor/hooks/output/useOutputChannels.ts:72-80` (rewrites every channel's
  100 k-char content to sessionStorage on **every append**).
- Pinned `atomFamily`s (no `.remove()`): `workstationPrAtom.ts:47-174` (9
  families incl. ≤100 PR lists + closures), `workstationIssueAtom.ts:59,112`,
  `workstationSelectedPrAtom.ts:118,132,197`, `planApprovalAtom.ts:57`,
  `tuiModeAtom.ts:15`. → mount-gated GC as in
  `sessionScopedChatEvents.ts:78-93`; release on repo switch.
- `store/workstation/codeEditor/search/index.ts:49,125` `searchResultsAtom`
  accumulates "load more" with no total cap; `store/ui/todoAtom.ts:92`
  `sessionTodoMapAtom` never pruned on switch; `store/ui/inboxAtom.ts:84`
  `inboxDbMessagesAtom` unbounded and apparently unread.
- `scaffold/NavigationSidebar/blocks/SidebarGroup.tsx:144` — session sidebar is
  not virtualized; paging `visibleCount` only grows. Verify
  `resetScopedSectionPagination` (`sectionPagination.ts:62`) fires on every
  scope switch.
- `src/diagnostics/runtimeCounters.ts:32,43` — `durations` arrays unbounded on
  every RPC; the only drain (`createDiagnosticsUsageSnapshot`,
  `diagnostics/aggregate.ts:335`) has **no call site**.

---

## 3. Other processes

- Sidecars: exactly one `externalBin` (`org2-pm`, never spawned by the app);
  root-level `ORG2 Helper (Backend)-*` and `src-tauri/bin/*Helper (Semantic)*` are
  dead symlinks to local `node` from `scripts/setup/sidecar-symlinks.js:49-65`
  → delete. Agent CLIs are per-turn with process-group kill + boot orphan sweep
  (`src/lib.rs:522-553`). Browser automation is command-mode (no resident
  chromium). All good.
- What _does_ multiply processes: browser-tab webviews (2.5), MCP `node`
  servers (1.5), LSP servers (1.5), semantic embedder only in the `--semantic`
  build.

---

## 4. Suggested order of work

| #   | Item                                                                      | Expected win                              | Effort    |
| --- | ------------------------------------------------------------------------- | ----------------------------------------- | --------- |
| 1   | 2.1 un-eager `App` import                                                 | −4.3 MB initial JS, unblocks vendor split | tiny      |
| 2   | 2.2 three deep-import fixes + lazy surfaces                               | −2 MB initial JS                          | small     |
| 3   | 2.3 `asyncVendors: chunks:"all"` + `maxSize`                              | −3.3 MB duplicate parse                   | tiny      |
| 4   | 1.2 `cache_size -64000 → -8000`, `max_blocking_threads(32)`               | lower startup peak → less dirty heap      | tiny      |
| 5   | 1.1 `malloc_zone_pressure_relief` after startup/turns (then mimalloc A/B) | returns the ~130 MB leftover              | small     |
| 6   | 1.3 single tiktoken encoder                                               | −20–30 MB Rust                            | small     |
| 7   | 2.5 browser-tab webview LRU + terminal unmount/cap (prior §2.1)           | −60–150 MB per idle tab/terminal          | medium    |
| 8   | 1.5 idle eviction 1 h → 15 min; MCP/LSP idle TTL                          | subprocess RAM, prompt caches             | medium    |
| 9   | 2.4 i18n 3 namespaces at boot; lazy zod                                   | −2–4 MB heap, faster paint                | small     |
| 10  | 1.4 event-store byte budget / compact-at-ingest / no full-walk emit       | −10s of MB per active session, less churn | medium    |
| 11  | 2.6 `unsavedContentCache` cap; prune persisted cursors                    | stops slow growth                         | small     |
| 12  | 1.6 channel depths, log buffers, search/screenshot floors                 | −5–20 MB                                  | tiny each |
| 13  | 1.7 incremental mirror reconcile after first paint                        | lower startup peak                        | small     |

---

## 5. Already well-bounded — don't re-audit

Terminal crate (80 KB redacted snapshot, 16-slot PTY taps, watermarks);
screenshot store dual cap; LLM-history image budgets; orgtrack-core streaming
readers + SQLite-backed imported-history index; session-persistence; prompt
caches (`BoundedMap`); `file_tracker`; LSP diagnostics FIFO; auxiliary tokio
runtimes (4 + 2 workers, explicit); rustls-only single TLS stack; feature-gated
ML stack; strict CSP, no `withGlobalTauri`, no devtools in release; route-level
`React.lazy` (100 sites), all file previewers, mermaid/recharts/highlight.js/
mammoth/jszip/sucrase lazy; shiki singleton with lazy grammars; single lazy web
worker (LRU 4 sessions); object-URL revocation; ~90 % of module caches carry
`MAX_*` + eviction; streaming delta buffer; `SNAPSHOT_CACHE_MAX` now 5;
`XtermOutput` WebGL now routed through the 8-slot budget; `KeepAliveRouteOutlet`
removed; single sidebar; Source Control renders only when active; the
`physical_footprint`-based RAM monitor (`crates/perf-utils/src/app_memory.rs`)
sampling only while its panel is open.

---

## 6. Status of the 2026-07-13 audit's `OPEN` items

| Item                                             | Status                                | Evidence                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.3 turn bodies stay loaded Rust-side            | **OPEN**                              | `SessionCore/turns/loadedTurnRegistry.ts:139-147` never calls `unloadTurnBody`; `pruneLoadedTurnBodies` (`:108-126`) only for the active session |
| 1.4 estimator truncates at 5000 nodes            | **OPEN**                              | `core/store/memoryEstimation.ts:1,22`; duplicated in `hooks/perf/runtimeMemoryStats.ts:64`                                                       |
| 2.1 terminals mounted forever / uncapped restore | **OPEN**                              | `engines/TerminalCore/index.tsx:314-345`; `terminal/index.ts:98-101,367`                                                                         |
| 2.2 XtermOutput WebGL bypasses budget            | **FIXED** (`a2b68c1d7`)               | `components/XtermOutput/index.tsx:127-171`                                                                                                       |
| 2.3 over-broad TUI heuristic                     | **OPEN**                              | `TerminalDisplay/utils/ansiProcessor.ts:86`                                                                                                      |
| §3 WorkStation + Outlet both mounted             | OPEN (mechanism changed)              | `modules/index.tsx:404,431-434`                                                                                                                  |
| §3 workstation app latches                       | OPEN (5 → 4 modes + new AgentStation) | `AppShellContent.tsx:128,160,176,194`                                                                                                            |
| §3 `KeepAliveRouteOutlet max=12`                 | **FIXED** (removed)                   | `MainAppShell/index.tsx:42`                                                                                                                      |
| §3 PM work-item tabs                             | OPEN                                  | `ProjectManagerContentRouter.tsx:78-89`                                                                                                          |
| §3 Source Control overlay                        | **FIXED** (renders only when active)  | `EditorMainPane/index.tsx:461-466`; dead `opacity-0` branch at `:405-421`                                                                        |
| §3 dual sidebar                                  | **FIXED**                             | `SidebarSelector.tsx:19-37`                                                                                                                      |
| 4 `runtimeCounters` unbounded                    | OPEN (worse: no drain call site)      | `diagnostics/runtimeCounters.ts:32,43`, `aggregate.ts:335`                                                                                       |
| 4 `useGlobalFlowTracker` raw listen              | OPEN (negligible)                     | `hooks/flowAwareness/useGlobalFlowTracker.ts:71-111`                                                                                             |

RAM-monitor gaps: no row for mounted xterm instances / live WebGL contexts,
`jotai-family` maps, or keep-alive surface count
(`hooks/perf/useRuntimeRamStats.ts:161-283`).

---

## 7. How to measure (repeatable recipe)

```bash
# 1. Cold-launch baseline (release build)
open -a /Applications/ORG2.app; sleep 45
footprint -p $(pgrep -x org2)                       # Rust process categories
footprint -p <WebContent pid owned by org2>          # "WebKit malloc" = JS heap + DOM
heap $(pgrep -x org2) | head -30                     # live malloc nodes vs dirty pages

# 2. Attribute the Rust heap (needs symbols: build once with strip=false, debug=1)
MallocStackLogging=lite /path/to/org2 &
sleep 60; malloc_history $(pgrep -x org2) -allBySize | head -60
```

For the webview, use the sidebar RAM monitor
(`scaffold/NavigationSidebar/connectors/SidebarRamMonitorButton/`) — remember
the "snapshots" row is under-reported until 1.4 above is fixed — and the WebKit
heap profiler for retained size of `_latestSnapshots`, the `jotai-family` maps,
`unsavedContentCache`, and the i18next store.

---

## Fix log

### 2026-08-17 — frontend bundle break-down + leaks (branch `perf/frontend-bundle-and-leaks`)

Measured with `webpack --mode production` at HEAD before/after (same machine,
same cache namespace):

| Metric                                         | Before                                               | After                                                |
| ---------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Synchronous initial JS (`index.html` scripts)  | **8.37 MB** (`main` 4.74 + `vendors` 3.73 + runtime) | **0.98 MB** (`main` 0.32 + `vendors` 0.65 + runtime) |
| JS loaded at boot (initial + `App` import set) | ≈ 8.4 MB                                             | ≈ **5.9 MB** (−2.5 MB / −29 %)                       |
| Vendors loaded at boot                         | 3.73 MB                                              | ≈ 1.65 MB                                            |
| Modules emitted in >1 chunk                    | 1 601 modules / **9.0 MB** redundant                 | 339 modules / 1.9 MB                                 |
| Total `build/`                                 | 55 MB / 559 chunks                                   | 48 MB / 564 chunks                                   |

What changed:

- **2.1** `src/index.tsx` — the dev-only `webpackMode: "eager"` branch is now
  gated on the inline `process.env.NODE_ENV` comparison (webpack can fold it),
  so production ships `App` as an async chunk again instead of inlined into
  `main.js`.
- **2.3 root cause found and fixed** — the duplicate-vendor problem was _not_
  the `splitChunks` config: the chat-projection **worker** entry statically
  reached `rendering/registry/events/index.ts`, whose lazy renderer
  `import()`s made 2 388 files (all of ChatPanel + every vendor) part of the
  worker's chunk graph; since the worker's entry lacks `vendors`, webpack had
  to copy react-dom/xterm/CodeMirror/zod/… into every shared async chunk.
  `CONTEXT_CONFIG` + the chat-config helpers moved to
  `registry/events/contextConfig.ts` (pure data); `ActionRegistry` and
  `registryAccessors` import from it. Worker reach with async imports:
  2 388 → 62 files. `splitChunks` left unchanged.
- **2.2 barrel leaks** — deep imports at `SidebarDialogs.tsx` (`RenameModal`
  → refractor/react-syntax-highlighter gone from boot; `ContentViewModal` has
  no consumers), the four `NavigationSidebar` files that only wanted
  `WorkstationToolbarTooltip` (CodeMirror + 10 langs + sql-formatter, xterm +
  6 addons, framer-motion, virtuoso, dnd-kit gone from boot),
  `ActionSystemContext.tsx` (`GUIAgentService` deep import; the `services`
  barrel re-exported `EditorService` → @codemirror/\*),
  `editorActions.zod.ts` (`EditorService` loaded on first action invocation),
  `ModalSystem/index.tsx` and `routeGroups.tsx` (`layouts/blocks` barrel).
  `components/Message` split: the framer-motion toast renderer is now
  `MessageContainer.tsx`, `React.lazy`-loaded on the first toast; the
  `Message` API surface is unchanged.
  Still in the boot graph (deliberately): zod (settings/RPC schemas),
  supabase auth, dnd-kit/virtuoso/tanstack-virtual (ChatPanel proper),
  @tanstack/react-table (via `StatusDot` → `SettingsTable`, ~56 KB).
- **2.6 leaks**
  - `fileContent/cache.ts` `unsavedContentCache`: no longer stores the unused
    `originalContent` copy (halves the entry), tracks `dirty`, and evicts
    _clean_ entries past `MAX_UNSAVED_CONTENT_CACHE_SIZE = 32`; dirty
    (truly unsaved) entries are never evicted.
  - `diagnostics/runtimeCounters.ts`: per-operation `durations[]` replaced by
    a running sum/count (same average, O(1) memory).
  - `store/.../search/index.ts`: `searchAppendResultsAtom` enforces
    `SEARCH_MAX_RETAINED_MATCHES = 20 000` (the sidebar's documented ceiling)
    and clears `hasMore` at the cap.
  - `store/ui/todoAtom.ts`: `sessionTodoMapAtom` LRU-capped at
    `MAX_TODO_SESSION_SLOTS = 64` (never evicts the active session; slots are
    rebuilt from the event store by `useTodoSync`).
  - `useOutputChannels.ts`: channels capped at `MAX_OUTPUT_CHANNELS = 16`,
    sessionStorage mirror debounced (500 ms trailing, flushed on unmount)
    instead of re-serialising every channel on every appended line.
- **2.5 keep-alive floors**
  - Terminals (`engines/TerminalCore`): only the active pane plus the
    `MAX_WARM_INACTIVE_TERMINALS = 4` most recently active ones stay mounted
    (`terminalMountWindow.ts`); colder panes unmount (xterm + WebGL released)
    and reattach via the existing `attach_pty_stream` + serialized-buffer
    restore path. Restored-at-boot terminals no longer all instantiate.
  - Browser tabs (`engines/BrowserCore`): **deliberately left as-is.** An
    LRU on inactive tabs was prototyped (destroy cold tabs' native webviews,
    recreate from URL) but reverted: a discarded tab comes back as a full
    page reload (scroll, form input, SPA state lost; incognito sessions
    lost), which is a worse trade than the 60–150 MB per idle tab. If this
    is revisited, do it as idle-TTL + count with incognito exempt, not a
    pure count.

Left for follow-ups (not in this batch): persisted `pushCursors` /
`pushedMetadata` pruning (cloud-sync correctness — needs the dual-instance
protocol), repo-scoped workstation PR/issue atom families (small, high-risk
multi-repo surface), browser-tab webview
discarding (see 2.5 note above), chat-panel CLI terminal tabs (agent-owned, turn
lifetime), i18n namespace deferral and lazy zod schemas (2.4), the 4 MB
`App` static graph itself.

### 2026-08-17 — heavy-component boundaries (branch `perf/heavy-component-leaks`, stacked on the above)

Method: `src/test/staticImportGraph.ts` (regex import walker) run per lazy
chunk root (every dynamic-`import()` target in `src/`) reporting which heavy
packages are statically reachable. Before → after:

| Surface (chunk root)                                                 | Before                                                                                                                                         | After |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `engines/ChatPanel/events/stream/agent-message` (every chat message) | xterm, CodeMirror + langs, sql-formatter, react-syntax-highlighter, highlight.js, recharts, @a2ui, framer-motion, mammoth, jszip (1 747 files) | none  |
| `modules/MainApp/TeamInbox`                                          | xterm, CodeMirror, sql-formatter, framer-motion                                                                                                | none  |
| `modules/MainApp/Settings/SettingsSlot`                              | CodeMirror, sql-formatter                                                                                                                      | none  |
| `modules/MainApp/AgentOrgs`                                          | CodeMirror, sql-formatter                                                                                                                      | none  |
| `modules/ProjectManager/{Projects,WorkItems,LinearProjects}`         | xterm, CodeMirror, sql-formatter, framer-motion                                                                                                | none  |
| `engines/Simulator/index`                                            | xterm, CodeMirror, sql-formatter, framer-motion                                                                                                | none  |
| `modules/WorkStation/shared/index.ts` (barrel, ~80 importers)        | xterm, CodeMirror, framer-motion                                                                                                               | none  |

Root causes and fixes:

- `modules/WorkStation/shared/index.ts` re-exported `GitFileDiffSplit` (dead
  code → all of `features/CodeMirror`), the `SidebarModules` block (module
  evaluation registers the Terminal tab sidebar → xterm) and
  `QuickActionsPanel` (framer-motion). Re-exports removed with explanatory
  comments; `CodeEditor/index.tsx` imports `SidebarSlot` from
  `../shared/SidebarModules` (the import that already carried the
  registrations); `GitFileDiffSplit` deleted.
- Eager imports of on-demand views made lazy (`React.lazy` + `Suspense
fallback={null}`, matching neighbouring precedents): `SimulatorMessages` in
  `agent-message`; transcript content in `SessionRawTranscriptDialog`;
  `A2UIRenderer` (recharts/@a2ui) and `ReactArtifactRunner` (sucrase +
  embedded React runtime) in `CanvasPreviewSurface`; `SkillEditorPanel` in
  `SkillsCategoryView`; `CodeMirrorEditor` inside `MarkdownEditor`; the canvas
  "source" tab viewer in `CanvasApp`.
- Editor-only consumers deep-import `@src/features/CodeMirror/Editor` instead
  of the barrel (which also carries Diff, ConflictEditor, SqlEditor +
  sql-formatter).
- Guard: `src/app/root/__tests__/featureBoundaries.test.ts` — nine surfaces
  asserted free of the editor/terminal/highlighter/chart stacks; failures
  print the import chain.

Still statically reaching CodeMirror by design: `modules/WorkStation/index.tsx`
(the code editor), `engines/Simulator/apps/canvas/CanvasApp` only via the lazy
source viewer, and the editor-internal panes.

### 2026-08-17 — lifecycle leaks (branch `perf/frontend-lifecycle-leaks`, stacked on the above)

Two thorough lifecycle sweeps (effects without cleanup, module maps, registries
holding DOM/xterm/EditorView, xterm/webview teardown, per-session families)
found the codebase disciplined overall; the genuine defects fixed here, all
behavior-neutral:

- `SessionCore/core/store/snapshotCacheManager.ts` `subscribeSession` — the
  disposer closed over the Set it was created with and deleted the registry
  entry whenever _that_ Set emptied. After `evictSessionCache` (reload /
  manual compact / edit-message / sidebar delete all reach it while
  consumers are still mounted) a later subscriber installs a fresh Set; the
  stale disposer then unregistered the live Set, so mounted consumers stopped
  receiving pushes and pinned their last snapshot. Disposer now re-looks-up
  the current Set and only removes the entry if it is its own.
- `useSearchResults.loadMore` — the two Tauri listeners (`search-result`,
  `search-complete`) were unlistened only on the success path; a rejected
  `searchCodeStreaming` left both (each closing over the whole result set)
  registered forever and running on every later event. Released in `finally`.
- `store/workstation/codeEditor/terminal` — OSC-633 `commandDetectionMapAtom`
  (up to 200 command entries per session) was never pruned;
  `removeCommandDetectionAtom` had no callers. Now called from both
  terminal-removal paths.
- `store/workstation/tabs/editorCache.ts` — `disposeEditorCacheForSessionAtom`
  drops the `session:<id>` editor cache + active-repo pointer when a session
  is deleted (heap + localStorage blob parsed at boot); wired into the single
  dispose callback both delete paths use.
- `WorkStation/Chat/Communication/config.ts` — module-scope single-slot memo
  (`_prevBuildEvents/_prevBuildResult`) pinned the last-built session's full
  `SessionEvent[]` + `MessageEntry` trees after unmount; replaced by an
  identity-keyed `WeakMap`.
- `TerminalInteractive/terminalSetup.ts`, `XtermOutput/index.tsx` — a WebGL
  addon that threw during `loadAddon`/`activate` was never disposed while its
  budget slot was released (orphaned GL context); disposed on the throw path.
- `ChatHistory/components/TurnMetadataFooterSlot.tsx` — the family was
  touched with `sessionId ?? ""`, creating empty-session-id entries the
  loader's GC never retains/removes; split into a wrapper that only mounts
  the body with a real session id.

Noted, not changed (would alter behavior or are sub-KB):
LRU-capping `sessionWorkspaces` / `editorCacheByWorkspace` across _live_
sessions (old sessions would lose saved tab layouts), `cursorIdeTurnSummariesAtomFamily`
retention for browsed Cursor sessions (needs mount-gated GC — the sibling
reload-state cleanup is in-flight bookkeeping, not teardown),
`transcriptSourceBySession` / `cursorIdeSnapshotLastUpdatedAtBySession`
(~100 B per session, reconcile semantics attached), `updateFileTrackingAtom`
bypassing `MAX_TRACKED_REPOS` (module is unreferenced — dead code, with
`search/cacheAtom.ts`; deletion candidates), `ChatView` `hydratedSessionIdsRef`,
one-shot rAF/timeouts in `XtermOutput`/`useStrokeDraw`.
