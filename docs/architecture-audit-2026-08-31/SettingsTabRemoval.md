# My Station Settings tab removal architecture review

Acceptance criteria: remove the `settings` workstation tab type and all production creators/renderers; retain project settings tab types; keep editor preferences accessible through app settings; reject retired tabs when loading saved layouts; preserve other tabs and workspace selections.

| Layer                         | Coverage and result                                                                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Compilation               | Scoped ESLint and full TypeScript check pass on the isolated PR branch based on the latest `origin/develop`.                                                                                                     |
| 2 — Dead code and duplication | Removed the dedicated page, renderer, factory/creator, re-exports, type/category membership, icon branches, and unused `editorSettingsTabAtom`. Shared app-settings controls remain.                             |
| 3 — Naming                    | Updated singleton examples and shared-resource fixtures to use the supported `project-settings` type. Production references to the retired type/creator were swept.                                              |
| 4 — Semantic overloading      | The retired `settings` tab was an editor-preferences view. App settings and `project-settings` / `project-org-settings` are separate concepts and remain available.                                              |
| 5 — Defaults                  | Existing unknown-tab rejection now excludes `settings`. Existing pane composition ignores missing shared targets and selects the first surviving tab. No new renderer fallback or UI hiding predicate was added. |
| 6 — Domain boundaries         | `useAppShellActions` routes through `useAppNavigation.goToSettings`; it no longer writes a workstation tab. Preference atoms and their persisted writers are unchanged.                                          |
| 7 — Readability               | Removed stale examples of creating a Settings tab. The original control-page implementation remains in app settings, avoiding an alternate shell.                                                                |
| 8 — Serialization             | Saved-tab schema version is unchanged; the supported type set is narrowed intentionally. Raw v2/v3 fixtures prove retired records do not become runtime tabs. No IPC, backend API, or settings format changes.   |
| 9 — Initialization parity     | Both v2 recovery and v3 loading already use the same tab validator. Tests cover shared/global/session/legacy-seed partitions and repeated load/persist/load.                                                     |
| 10 — Resolver symmetry        | Intentionally skipped: no multi-field resolver or priority-chain changes.                                                                                                                                        |

Authoritative tab state is `workstationTabsStateAtom`, loaded through `loadWorkstationTabsState` from `workstation:tabs:v3:*` local-storage keys, with the existing `workstation:layout-v2` recovery path. The removed writer was `useAppShellActions.handleOpenSettings` → `createSettingsTab` → `openWorkstationTabAtom`.

The new invariant is that `settings` is neither constructible through the typed tab API nor accepted by the saved-tab validator. The app action navigates to Appearance → Code editor without changing workstation tabs or active workspace identity.

Historical handling is read-time rejection through the existing validator, followed by the ordinary persistence path. Orphan shared references continue to use the existing projection behavior and cannot recreate the retired tab. No live user storage or settings data was manually cleaned. Raw fixtures, rather than a running user's storage, were inspected and exercised.

Verification: 99 targeted tests passed, including 12 storage tests and the real navigation regression. Existing file, terminal, browser, project settings, cache, and workspace-isolation suites remain green. No Rust checks were run because no Rust or cross-layer contract changed.

Risk: an already-running frontend retaining old state may require reload. Old Settings tabs are intentionally not restored. Rollback is a source revert; editor preferences require no recovery. The UI used to recreate this tab would return, but tab metadata already omitted by a normal save need not be restored to recover preferences.
