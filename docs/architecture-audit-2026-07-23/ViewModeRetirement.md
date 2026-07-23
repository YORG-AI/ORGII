# View-mode retirement and Changelog tab — architecture audit

## Acceptance criteria

- [x] Workstation and Settings are selected by the router and share one Workbench shell.
- [x] Standalone app pages use a plain route outlet without global sticky mounts or route caches.
- [x] Home/Start Page and its app-grid/sidebar state are removed from the live build and parked under `.archive/`.
- [x] The Home-only repository-drop hint, confirmation UI, Spotlight handoff state, RAM metric, and translations are removed.
- [x] ChatPanel Launchpad remains live and semantically separate from the retired Home page.
- [x] Changelog is version-scoped, lazy-loaded, and opened through a singleton ChatPanel tab.
- [x] Changelog URL, Spotlight, and action entry points open that tab and redirect to Workstation.
- [x] The detached `/windows/*` hosts, their frontend manager methods, four Tauri commands, capability labels, and generic window builder are removed.
- [x] The detached-window-only full-page Settings shell is archived; its live `SettingsSlot` renderers and sections remain.
- [x] The unused window registry/provider and its 30-second heartbeat are removed; the storage-safe `getWindowId()` helper remains.
- [x] Global view-mode, route-tab, MainApp KeepAlive, retired navigation, and obsolete i18n dependencies have no live references.

## Retired call chains

| Chain               | Before                                                                                                                                   | Result                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Detached windows    | `/windows/welcome` or `/windows/tab` → lazy window component → window manager → one of four Tauri commands → generic Rust window builder | Entire unreachable chain removed and UI source archived.           |
| Standalone Settings | detached tab host → full-page `Settings` shell → settings route/toolbar hooks                                                            | Host and shell archived; active Workbench `SettingsSlot` retained. |
| Global Home         | Home route → Start Page App Grid → global view-mode atom/synchronizer → sticky MainApp/Workstation mounts                                | Home UI archived; router now owns the active shell.                |

## Live call chains retained

| Chain                                                                                                | Ownership                    | Reason retained                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| Session launch → `emitOpenWorkspace` → `open-workspace` event → `useWorkspaceEvents` → `openSession` | Session/workspace navigation | This is the active main-window session handoff, not detached-window creation.                      |
| Changelog URL/action → `ChangelogTabLauncher` → singleton Changelog tab atom → `ChangelogPanelView`  | ChatPanel                    | Preserves bookmarks and action entry points while presenting version-level notes in the chat pane. |
| Repo/workspace persistence → `getWindowId()`                                                         | Persistence                  | `sessionStorage` remains the correct isolation boundary for independent app instances.             |

## Term-overloading decisions

| Term              | Retired meaning                                       | Live meaning                                                        | Decision                                                                              |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Home / Start Page | Global MainApp App Grid and route                     | ChatPanel creator/Launchpad and Workstation blank state             | Retire the global meaning; keep domain-qualified live surfaces.                       |
| View mode         | Global `mainApp` ↔ `workStation` state machine        | Local table, diff, calendar, editor, and similar presentation modes | Remove only the global state machine.                                                 |
| Window            | Detached welcome/tab/workspace hosts                  | Main application window and embedded/native browser windows         | Remove detached-host APIs; keep active platform windows.                              |
| Settings          | Full-page detached-window shell                       | `SettingsSlot` inside Workbench                                     | Archive the shell; keep its consumed renderers and sections.                          |
| Changelog         | Month/day standalone page and generated git summaries | Version-level singleton ChatPanel tab                               | Delete the generated legacy presentation/data and preserve the version-level feature. |

## 10-layer audit

| Layer                                   | Coverage | Verdict | Evidence / reason                                                                                                                                                                                                                                    |
| --------------------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness              | Covered  | pass    | Full TypeScript verification, 4 focused test files / 11 tests, targeted ESLint, targeted Rust formatting, `cargo check -p app_window`, and full `cargo check -p org2` pass.                                                                          |
| 2. Dead code & structural deduplication | Covered  | fix     | Archived Home, detached-window, and standalone Settings UI; removed global view-mode synchronization, route-tab metadata, KeepAlive wrappers, dead window APIs/registry, stale navigation helpers, Home metrics, and obsolete i18n.                  |
| 3. Naming consistency                   | Covered  | fix     | `Workbench` describes the shared router branch; `ChangelogTabLauncher` names its side effect; `windowId` now contains only the persistence helper it exports.                                                                                        |
| 4. Semantic overloading                 | Covered  | fix     | The table above records each overloaded term and the domain-local meanings intentionally preserved.                                                                                                                                                  |
| 5. Default branch analysis              | Covered  | pass    | Workstation renders Workstation, settings render the slot in the same shell, standalone routes render `MainAppShell`, Changelog launches its tab, unknown routes use the existing error path, and retired Home/window URLs are no longer registered. |
| 6. Cross-domain concept leakage         | Covered  | fix     | Router ownership replaces shared view-mode writes. ChatPanel owns Changelog tabs, Settings owns its slot, and persistence owns the isolated window ID.                                                                                               |
| 7. New-developer clarity                | Covered  | fix     | There is no second global tab/view state machine or detached-window command stack to reconcile. `.archive/README.md` records restoration boundaries.                                                                                                 |
| 8. Wire protocol & serialization        | Covered  | pass    | Four unused Tauri commands and their capability labels were removed together; the full Rust application check validates handler consistency. Persisted duplicate Changelog tabs still normalize to one singleton.                                    |
| 9. Init parity                          | Covered  | pass    | URL, Spotlight, app action, and ChatPanel menu entry points converge on the same Changelog tab atom. Session launch retains its existing workspace event handoff.                                                                                    |
| 10. Resolver symmetry                   | Covered  | pass    | The router has one Workbench classification path; Settings has one active slot resolver; ChatPanel has one exhaustive tab-surface registry.                                                                                                          |

## Changelog entry-point parity

| Entry point                        |   Makes My Station active |           Makes chat visible | Reuses singleton | Final surface               |
| ---------------------------------- | ------------------------: | ---------------------------: | ---------------: | --------------------------- |
| ChatPanel new-tab menu             |    Already in active pane |              Already visible |              Yes | Changelog tab               |
| URL, Spotlight, or action launcher |                       Yes |                          Yes |              Yes | Workstation + Changelog tab |
| Existing tab activation            | Preserves current station | Preserves current visibility |              Yes | Changelog tab               |

## Performance-guard verdict

| Lifecycle state                    | CPU / I/O behavior                                                                                               | Retained state                           | Verdict |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------- |
| App startup / idle                 | Retired window registry no longer registers or starts its 30-second heartbeat. Changelog code remains lazy.      | Stable persistence ID only               | pass    |
| Embedded webview closed            | Host-visibility interval is not scheduled.                                                                       | Current URL and hidden-handoff flag only | pass    |
| Embedded webview open              | One 500 ms visibility interval protects native/web host parity.                                                  | One native webview identity              | pass    |
| Embedded host hidden → visible     | Interval remains only for the handoff, closes the hidden native webview, then restores it when the host returns. | Bounded boolean handoff state            | pass    |
| Embedded webview manually closed   | Interval returns to zero immediately.                                                                            | No active native webview                 | pass    |
| Changelog tab open / repeated open | One lazy chunk and one version index; subsequent opens focus the fixed-ID tab.                                   | Tab count bounded at one                 | pass    |

The polling verdict is code-level and lifecycle-tested with fake timers: zero timers while closed, one while open/handing off, and zero after manual close. It is not presented as a measured runtime performance claim.

## Systematic sweep

Live source, Rust handlers, capabilities, package manifests, route metadata, tests, comments, sidebars, navigation helpers, window routing, global drag/drop, translations, RAM accounting, and store barrels were swept for the retired Home/view-mode/window identifiers. Historical source remains only under `.archive/`. Remaining `viewMode`, `start-page`, and `launchpad` identifiers belong to active domain-local presentation modes or the ChatPanel/Workstation launch surfaces and were intentionally preserved.
