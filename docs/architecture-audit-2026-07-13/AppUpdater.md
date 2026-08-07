# Architecture Audit — AppUpdater

**Scope:** `src/scaffold/AppUpdater/`, `general.autoUpdateEnabled`, and the General settings entry
**Date:** 2026-07-13
**Auditor:** Codex

## Acceptance criteria

- [x] One lifecycle owner for check, download, and install state
- [x] One scheduler for startup, interval, foreground, and online triggers
- [x] Automatic updates default on and can be disabled through persisted settings
- [x] Startup can install and relaunch; active-use checks silently pre-download
- [x] Manual checks and installs remain available when automation is disabled
- [x] Check throttling, force bypass, coalescing, cache failure semantics, progress throttling, install deduplication, and scheduler cleanup are tested
- [x] Targeted ESLint and updater Vitest suite pass

## 10-layer audit

### Layer 1 — Compilation correctness

- Targeted ESLint passes for every changed TypeScript/TSX file.
- Updater lifecycle tests pass (12/12); the settings-default test also passes.
- Full `tsc --noEmit` reaches one pre-existing error at `src/engines/ChatPanel/InputArea/components/ContextInfoButton.tsx:468` (`string | undefined` passed where `string` is required); no updater diagnostic is emitted.
- Settings UI parity remains red on the `develop` baseline because eight existing `housekeeper.*` keys are not covered by the manifest. The new `general.autoUpdateEnabled` key is covered by the General-section prefix.

### Layer 2 — Dead code and structural deduplication

- Traced automatic entry point: `AppDeferredServices` → `AppUpdater` → `AppUpdaterScheduler` → `runAutomaticUpdate` → `AppUpdaterCoordinator`.
- Traced manual entry points from Settings, Spotlight/ActionSystem, Sidebar, and ChatPanel.
- Removed parallel module-level throttle/check/install state. Jotai atoms are projections of coordinator state.
- Production updater calls now have one owner: `check`, `download`, `install`, and `downloadAndInstall` are invoked only by the coordinator.

### Layer 3 — Naming consistency

- `autoUpdateEnabled` consistently means the persisted user preference.
- `AutomaticUpdateReason` distinguishes startup, interval, foreground, and online scheduling.
- Documentation now matches the options-object API and current two-hour interval.

### Layer 4 — Semantic overloading

| Term             | Meaning                      | Verdict                                                              |
| ---------------- | ---------------------------- | -------------------------------------------------------------------- |
| update           | Tauri `Update` resource      | Keep; concrete external type                                         |
| automatic update | Configured scheduling policy | Keep; represented by `autoUpdateEnabled` and `AutomaticUpdateReason` |
| install          | Apply a downloaded package   | Keep; distinct from download and relaunch phases                     |

No conflicting domain meanings remain inside the updater module.

### Layer 5 — Default branch analysis

- `general.autoUpdateEnabled` defaults to `true` in the canonical settings registry and the derived atom also uses `true` as a defensive fallback.
- Public check defaults remain silent and throttled (`notify: false`, `force: false`).
- Download-event handling is exhaustive over Tauri's `Started | Progress | Finished` union; there is no unsafe catch-all branch.

### Layer 6 — Cross-domain leakage

- Scheduling and updater resources remain under `scaffold/AppUpdater`.
- The platform settings atom only adapts the central settings domain; it does not own updater lifecycle state.
- General Settings only binds the preference to existing design-system controls.

### Layer 7 — New-developer confusion test

- Coordinator, scheduler, and settings preference have separate purpose-based names.
- Comments explain why active-use automation downloads without installing: Windows installation can terminate the app.
- The state model and entry points are documented in the component guide.

### Layer 8 — Wire protocol and serialization

- The only persisted wire value is `general.autoUpdateEnabled: boolean`; it is validated by the canonical Zod registry and written through `updateSettingAtom`.
- The updater release request and signed package protocol remain owned by pinned `@tauri-apps/plugin-updater` 2.9.0; this change adds no custom payload or schema generation.
- Tauri's `Update` resource is closed when replaced or explicitly cleared to avoid stale native resources.

### Layer 9 — Init parity

| Entry point         | Checks setting |        Fresh check | Throttle/dedupe |  Download | Install | Relaunch |
| ------------------- | -------------: | -----------------: | --------------: | --------: | ------: | -------: |
| Startup automatic   |            Yes |                Yes |             Yes |       Yes |     Yes |      Yes |
| Two-hour interval   |            Yes |                Yes |             Yes |       Yes |      No |       No |
| Foreground / online |            Yes | If throttle allows |             Yes |       Yes |      No |       No |
| Manual check        |             No |                Yes |             Yes |        No |      No |       No |
| Manual install      |             No |     If cache empty |             Yes | If needed |     Yes |      Yes |

Manual paths intentionally ignore the automation preference so users can update on demand after disabling background behavior.

### Layer 10 — Resolver symmetry

No multi-field fallback resolver was introduced. Both schema default and atom fallback resolve the single automatic-update preference to `true`; there is no asymmetric source chain.

## Systematic sweep

- Swept all updater imports and call sites with `checkForAppUpdates`, `installAvailableAppUpdate`, `useAvailableAppUpdate`, `check`, `download`, `install`, and `downloadAndInstall`.
- No second production scheduler, updater transport caller, or install-state writer remains.
