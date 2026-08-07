# WorkStation Unified Tab Pool — "Offload on Close" Resource Audit

**Date:** 2026-07-14
**Scope:** Does closing a tab in the unified WorkStation tab pool (PR #369) actually
release the resources that tab was holding?
**Close path audited:**
`closeTabAtom` / `closeActiveWorkStationTabAtom`
(`src/store/workstation/tabRegistry/atoms.ts`) →
`closeTab` / `closeAllTabs` / `closeOtherTabs` / `closeSavedTabs`
(`src/store/workstation/tabs/tabMutations.ts`), guarded by
`useCloseTabWithGuard` (`src/hooks/workStation/tabs/useCloseTabWithGuard.ts`).

---

## Executive summary

The unification's "offload on close" goal is **met for every resource that is safe to
release automatically.** Two teardown styles are in play and both are correctly wired
through the unified close path:

1. **Imperative teardown inside the close mutation** — search session cache
   (`deleteSearchTabSessionState`). Confirmed present in all four close functions.
2. **Declarative reconciliation** — a host effect watches the tab list and tears down
   its own live resource when the tab disappears (browser sessions, project drafts).
   These work because the derived slices (`browserTabsAtom`) and the reconciliation
   hosts are driven by / mounted alongside the same `workstationLayoutAtom.mainPane`
   the close path mutates.
3. **React lifecycle** — resources bound to the rendered component (native webviews via
   `useInlineWebview`, session-event subscriptions) are freed on unmount, which happens
   when a tab leaves the pool.

**The single resource NOT released on close is terminal PTY processes** — and that is a
**deliberate, load-bearing design choice** (global, `localStorage`-restored terminal
pool), not a unification regression. Auto-killing PTYs on tab close would be a risky
behavior change (it would destroy running dev servers / agent processes) and is left as
a recommendation, not implemented. Note the heavy terminal _renderer_ (xterm, ~300 KB)
**is** offloaded on close.

---

## Findings table

| Tab type                                                             | Resource held                                                                               | Freed on close?             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Recommendation                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `search`                                                             | In-memory session cache entry (query, options, result array) in `searchTabSessionCache` Map | **Yes**                     | `tabMutations.ts:95-97` (`closeTab` → `deleteSearchTabSessionState`), `:206-211` (`closeAllTabs` → `clearSearchTabSessionStates`), `:227-231` (`closeOtherTabs`), `:255-260` (`closeSavedTabs`). Live UI state is component-local `useState` (`useSearchTabContent.ts:71-89`), GC'd on unmount. Cache bounded to 20 (`searchTabSessionCache.ts:15`).                                                                                                                                                                                                                                                                                                                                         | None. Added regression test to lock the `search:` cleanup contract. |
| `browser-session`                                                    | Live native webview session in `BrowserProvider`                                            | **Yes**                     | Teardown effect 3 `useBrowserTabSync.ts:237-256` closes removed sessions. It watches `browserTabsAtom`, which is a **derived** view/writer over the browser slice of `workstationLayoutAtom.mainPane` (`browser/tabs/index.ts:249-273`), so the unified close-path mutation is reflected. Host stays mounted: in All-Tabs mode the Browser host is pre-mounted via `useAppShellDock.ts:99` (`queueVisit("browser")`) and otherwise sticky once visited (`AppShellContent.tsx:146-151,176`).                                                                                                                                                                                                  | None.                                                               |
| `url-preview`                                                        | Native Tauri webview (`useInlineWebview`)                                                   | **Yes**                     | `useInlineWebview.ts:154-160` calls `destroy()` on unmount; content unmounts when the tab leaves the pool (`UrlPreviewContent.tsx:41-55`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | None.                                                               |
| `dom-component-preview`                                              | Preview iframe                                                                              | **Yes**                     | Iframe is component-owned DOM, removed on unmount. No native/global handle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | None.                                                               |
| `terminal-content`                                                   | Captured output **string** in `tab.data`                                                    | **Yes**                     | No live resource; string is dropped with the tab (`tabMutations.ts:94`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | None.                                                               |
| `file` / `git-diff` / `source-control` / `timeline-diff` / `git-*`   | Open file content + per-repo editor cache                                                   | **Partial — by design**     | Open file content is component-local (`useFileContentManager.ts` `useState`); unmounts with the tab. The per-repo `editorCacheAtom` is **intentionally retained** and bounded (5 repos × 20 file tabs, `editorCache.ts:25-28,133-162`) and `localStorage`-persisted. No unbounded editor-model cache exists (grep clean).                                                                                                                                                                                                                                                                                                                                                                    | None. Retention is intentional and bounded.                         |
| `project-*` create surfaces (`NewProjectTabData` / work-item create) | Draft form state in `projectDraftsAtom` / `workItemDraftsAtom` Maps                         | **Yes**                     | Reconciliation effect removes drafts whose tab id is no longer live: `useProjectTabActions.ts:77-101`. Maps are bounded to 20 with FIFO eviction (`drafts.ts:17,31-59`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | None.                                                               |
| `chat-session` / `subagent-detail`                                   | Session-event subscriptions                                                                 | **Yes**                     | Subscriptions are React-hook based (`useSessionEvents`), cleaned up on unmount when the tab leaves the pool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | None.                                                               |
| `canvas-preview`                                                     | `canvasPreviewAtom` payload                                                                 | **N/A (bounded singleton)** | `canvasPreviewAtom` holds at most one `CanvasPreviewEntry` (`canvasPreviewAtom.ts:24`), shared with the chat panel and overwritten by the next canvas; not per-tab, does not accumulate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | None. Clearing it on close would fight the chat panel — do not.     |
| **`terminal`**                                                       | **PTY processes** (backend) + global `terminalSessionsAtom` + `initializedTerminalIdsAtom`  | **No — deliberate**         | The unified close path never calls `close_pty`. `killPty` is only reachable via `closeTerminalSessionAtom` (`terminal/index.ts:52-62,309-317`), which is wired to the terminal's **own** per-session kill button (`TerminalMainContent.tsx:75-82`) and the nav-sidebar recents (`globalTabsActions.ts:135-153`) — a separate surface (`navigationSidebarTabsAtom`), not the tab pool. Sessions live in a global atom (`terminal/index.ts:148-161`) persisted to `localStorage` (`terminalPersistAtom:192-210`). The renderer **is** offloaded: `shouldMountTerminalContent = isTerminalTabActive` (`EditorMainPane/index.tsx:768`) unmounts xterm when the terminal tab is no longer active. | **See recommendation R1 — do NOT auto-kill (risky).**               |

---

## Why terminal PTYs are intentionally _not_ freed (and why fixing it is risky)

- The terminal is a **single** WorkStation tab (`terminal:main`, created with
  `CODE_EDITOR_MAIN_TERMINAL_SESSION_ID`, `useWorkStationLaunchActions.ts:132-143`) that
  hosts **all** PTY sub-sessions via `TerminalCore`. There is no per-PTY WorkStation tab,
  so there is no per-session tab-close signal to reconcile against.
- Terminal sessions are explicitly documented as a **global, persistent** pool that
  survives repo switches and app reloads (`editorCache.ts:6-13`;
  `terminal/index.ts:70-141` restores them from `localStorage`). Closing the tab leaves
  the shells running exactly as VS Code keeps terminals alive when the panel is hidden.
- `useCloseTabWithGuard.ts:4-8` enumerates the teardowns that _are_ wired declaratively
  (browser session teardown, project draft cleanup) and pointedly **omits** terminals —
  a strong signal the persistence is intentional.
- Auto-killing on close would terminate long-running dev servers, watchers, and agent
  shells the user expects to persist. That is a destructive, non-obvious behavior change.

By the audit brief's own bar ("_provably leaves an orphaned PTY with no other
reference_"), the terminal does **not** qualify: the PTY always retains a live reference
via the global atom + `localStorage`, and is re-attached when the terminal tab reopens.
So it is explicitly **out of scope for a safe fix.**

---

## Recommendations (NOT implemented — need product/lifecycle decisions)

- **R1 — Terminal PTY lifecycle on terminal-tab close (risky).** If the product wants
  closing the `terminal:main` tab to also kill its PTYs, it must be an explicit, opt-in
  decision (e.g. only kill sessions with no running child process, or prompt the user),
  because it can destroy running dev servers / agents. It also contradicts the current
  `localStorage` persistence + reload-restore model, so both would have to change
  together. Left as a discussion item.

- **R2 — Browser teardown depends on host mount (low risk, defensive).** Browser session
  teardown (effect 3) only runs while the Browser host is mounted. This is reliable
  today for all _reachable_ close scenarios (All-Tabs mode pre-mounts the host; single-
  host filters can only close their own host's tabs). If future routing lets a
  `browser-session` tab be closed while the Browser host is unmounted, the session would
  leak. A close-path-imperative teardown (mirroring the search pattern) would make this
  robust regardless of host mount state, but is a larger architectural change and is not
  currently needed.

---

## What was implemented

Nothing in the runtime close path needed a fix — every safe teardown is already wired.
The one code change is **test-only, zero runtime risk**: a regression test that locks the
search session-cache cleanup across all four close mutations
(`src/store/workstation/tabs/__tests__/tabMutations.test.ts`). The search cleanup is the
only resource teardown that lives _inside_ the "pure" mutation helpers and hinges on the
fragile `search:` id prefix; the test guards it against silent regression (e.g. a future
change to the search tab id strategy).
