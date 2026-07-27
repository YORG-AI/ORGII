# View-mode and in-app Changelog retirement — architecture audit

## Acceptance criteria

- [x] Workstation and Settings are selected by the router and share one Workbench shell.
- [x] Standalone app pages use a plain route outlet without global sticky mounts or route caches.
- [x] Home/Start Page and its app-grid/sidebar state are removed from the live build and parked under `.archive/`.
- [x] The Home-only repository-drop hint, confirmation UI, Spotlight handoff state, RAM metric, and translations are removed.
- [x] ChatPanel Launchpad remains live and semantically separate from the retired Home page.
- [x] The in-app Changelog tab, release bundle, renderer, action, Spotlight entry, service method, and route adapter are removed.
- [x] The Settings dropdown keeps only a non-rendering TODO at the intended position above Tutorials for a future maintained web destination.
- [x] Persisted unknown or retired ChatPanel surface types are discarded by the general persisted-type allowlist.
- [x] The detached `/windows/*` hosts, their frontend manager methods, four Tauri commands, capability labels, and generic window builder are removed.
- [x] The detached-window-only full-page Settings shell is archived; its live `SettingsSlot` renderers and sections remain.
- [x] The unused window registry/provider and its 30-second heartbeat are removed; the storage-safe `getWindowId()` helper remains.
- [x] Global view-mode, route-tab, MainApp KeepAlive, retired navigation, and obsolete i18n dependencies have no live references.

## Retired call chains

| Chain               | Before                                                                                                                                   | Result                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Detached windows    | `/windows/welcome` or `/windows/tab` → lazy window component → window manager → one of four Tauri commands → generic Rust window builder | Entire unreachable chain removed and UI source archived.                     |
| Standalone Settings | detached tab host → full-page `Settings` shell → settings route/toolbar hooks                                                            | Host and shell archived; active Workbench `SettingsSlot` retained.           |
| Global Home         | Home route → Start Page App Grid → global view-mode atom/synchronizer → sticky MainApp/Workstation mounts                                | Home UI archived; router now owns the active shell.                          |
| In-app Changelog    | Settings/Spotlight/action → Workstation service → singleton tab atom → lazy renderer → bundled release data                              | Entire in-app path removed; a future web destination is explicitly deferred. |

## Live call chains retained

| Chain                                                                                                | Ownership                    | Reason retained                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| Session launch → `emitOpenWorkspace` → `open-workspace` event → `useWorkspaceEvents` → `openSession` | Session/workspace navigation | This is the active main-window session handoff, not detached-window creation.                   |
| Repo/workspace persistence → `getWindowId()`                                                         | Persistence                  | `sessionStorage` remains the correct isolation boundary for independent app instances.          |
| Persisted ChatPanel state → legacy migrations → persisted-type allowlist → active tab fallback       | ChatPanel persistence        | Restores supported tabs while safely dropping process-bound, unknown, or retired surface types. |

## Term-overloading decisions

| Term              | Retired meaning                                  | Live meaning                                                        | Decision                                                                                                               |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Home / Start Page | Global MainApp App Grid and route                | ChatPanel creator/Launchpad and Workstation blank state             | Retire the global meaning; keep domain-qualified live surfaces.                                                        |
| View mode         | Global `mainApp` ↔ `workStation` state machine   | Local table, diff, calendar, editor, and similar presentation modes | Remove only the global state machine.                                                                                  |
| Window            | Detached welcome/tab/workspace hosts             | Main application window and embedded/native browser windows         | Remove detached-host APIs; keep active platform windows.                                                               |
| Settings          | Full-page detached-window shell                  | `SettingsSlot` inside Workbench                                     | Archive the shell; keep its consumed renderers and sections.                                                           |
| Changelog         | Standalone route and version-level ChatPanel tab | Planned maintained web release notes                                | Remove both in-app implementations; retain only a commented dropdown insertion point and its route-label translations. |

## 10-layer audit

| Layer                                   | Coverage | Verdict | Evidence / reason                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness              | Covered  | blocked | Six focused files / 56 tests, targeted ESLint, and `git diff --check` pass. Full TypeScript verification remains blocked by unrelated missing `loadExternalHistorySidebarSessions` exports in `RuntimeScanningPanel.tsx` and `useDataSourceAutoScan.ts`.                                                                                       |
| 2. Dead code & structural deduplication | Covered  | fix     | Removed the Changelog tab union member, fixed ID, factory, open atom, persistence dedupe, presentation branch, display label branch, icon branch, registry entry, lazy renderer, panel, release data, service method, Action System ID/handler, Spotlight definition/fallback, and feature-only tests.                                         |
| 3. Naming consistency                   | Covered  | fix     | No live symbol named for the in-app Changelog remains. The only UI marker is `TODO(changelog-web)`, which names the planned destination rather than the retired mechanism.                                                                                                                                                                     |
| 4. Semantic overloading                 | Covered  | fix     | The table above separates retired in-app release surfaces from unrelated skill/update changelog fields and the future web release-notes concept.                                                                                                                                                                                               |
| 5. Default branch analysis              | Covered  | fix     | The exhaustive ChatPanel registry no longer has a Changelog variant. Persisted unsupported variants are removed before active-tab fallback selects the first supported tab; the retirement test also fixed an `undefined === undefined` guard that previously selected the organization ID when neither active nor organization tabs survived. |
| 6. Cross-domain concept leakage         | Covered  | fix     | ChatPanel, Workstation service, Action System, Spotlight, and bundled config no longer depend on a Changelog surface. Settings retains only the user-approved future insertion comment.                                                                                                                                                        |
| 7. New-developer clarity                | Covered  | fix     | There is no hidden route, action, service, or tab path to reconcile with the deferred web implementation.                                                                                                                                                                                                                                      |
| 8. Wire protocol & serialization        | Covered  | pass    | No wire payload changes. Persisted ChatPanel JSON now admits only the supported persisted tab-type allowlist after existing migrations.                                                                                                                                                                                                        |
| 9. Init parity                          | Covered  | pass    | All former Changelog entry points are absent: dropdown renders nothing, Spotlight exposes no command, and Action System registers no handler.                                                                                                                                                                                                  |
| 10. Resolver symmetry                   | Covered  | pass    | Changelog resolution has zero remaining variants or fallback paths. Supported persisted tabs follow one migration-then-allowlist resolver.                                                                                                                                                                                                     |

## Changelog retirement parity

| Former entry point      | Current result                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| Settings dropdown       | No rendered item; TODO remains directly above Tutorials for a future web URL.            |
| Global Spotlight        | No Changelog static action or fallback.                                                  |
| Action System           | No Changelog action ID or registered handler.                                            |
| ChatPanel registry      | No Changelog tab type, icon, label resolver, or renderer.                                |
| Persisted Changelog tab | Dropped by the supported persisted-type allowlist; another supported tab becomes active. |

## Performance-guard verdict

| Lifecycle state                  | CPU / I/O behavior                                                                                               | Retained state                           | Verdict |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------- |
| App startup / idle               | Retired window registry does not start its old heartbeat; no in-app Changelog chunk or release bundle remains.   | Stable persistence ID only               | pass    |
| Embedded webview closed          | Host-visibility interval is not scheduled.                                                                       | Current URL and hidden-handoff flag only | pass    |
| Embedded webview open            | One 500 ms visibility interval protects native/web host parity.                                                  | One native webview identity              | pass    |
| Embedded host hidden → visible   | Interval remains only for the handoff, closes the hidden native webview, then restores it when the host returns. | Bounded boolean handoff state            | pass    |
| Embedded webview manually closed | Interval returns to zero immediately.                                                                            | No active native webview                 | pass    |

The polling verdict is code-level and lifecycle-tested with fake timers: zero timers while closed, one while open/handing off, and zero after manual close. It is not presented as a measured runtime performance claim.

## Systematic sweep

Live source, route metadata, tab types, persistence, factories, atoms, presentation branches, display labels, icons, render registries, lazy imports, release data, Workstation services, Action System registrations, Spotlight actions/fallbacks, dropdown rendering, tests, and feature-specific translations were swept for the retired in-app Changelog. Remaining `changelog` terms are intentionally limited to the commented future web insertion point, its translated route label, the persisted-retirement test fixture, unrelated skill/update payload fields, ordinary prose/tests, and historical audit documentation.
