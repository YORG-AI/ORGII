# Oversized TypeScript Breakdown — Architecture Audit

## Scope

All tracked `*.ts` and `*.tsx` files that exceeded 1,000 lines on the `develop` baseline. The change is structural: public entry points remain in place while cohesive behavior moves into adjacent modules.

## Acceptance criteria

- [x] Every tracked TypeScript/TSX file is at or below 1,000 lines.
- [x] Every extracted module is wired into its production or test entry point.
- [x] Existing public exports, storage keys, command/event names, and test inventories remain available.
- [x] Full `tsc --noEmit` passes.
- [x] ESLint passes across every changed/new TypeScript file.
- [x] Affected tests pass (52 files, 597 tests).
- [x] `git diff --check` passes.
- [x] No compatibility shim or duplicate implementation was added.

## Breakdown inventory

| Original file                                 | Before | Resulting boundary                                                   | Largest resulting file | Verification                      |
| --------------------------------------------- | -----: | -------------------------------------------------------------------- | ---------------------: | --------------------------------- |
| `GitHubWorkItemsSurface.tsx`                  |  2,356 | controller, view, controls, model/query/cache, issue-detail hook     |                    788 | 7 tests + typecheck               |
| `propsDataExtractors.test.ts`                 |  2,085 | core, file, edit, shell, search, todo specs                          |                    515 | 176 tests; exact count parity     |
| `org2CloudSyncEngine.test.ts`                 |  2,024 | metadata, projects, sessions, cadence specs + fixtures               |                    784 | 69 tests; exact count parity      |
| `org2CloudSyncEngine.ts`                      |  1,750 | engine, lifecycle, session synchronization                           |                    926 | 69 tests + typecheck              |
| `pipeline.test.ts`                            |  1,344 | core, grouping, filtering specs + fixtures                           |                    555 | 56 tests; exact name/count parity |
| `WorkstationSidebarConnector/index.tsx`       |  1,248 | connector, dialogs, org-scope hook, row routing                      |                    981 | 19 tests                          |
| `SessionCreator/variants/ChatPanel/index.tsx` |  1,202 | coordinator, view, CLI configuration, presentation, types            |                    714 | 9 tests + typecheck               |
| `ChatView.tsx`                                |  1,181 | coordinator, history surface, queue/import hooks, file-change helper |                    903 | lint + adjacent tests             |
| `apiTracker.ts`                               |  1,153 | compatibility facade plus calls/HTTP/timers/push/Tauri/state/types   |                    266 | 16 tests + typecheck              |
| `RoutineWizard/index.tsx`                     |  1,150 | coordinator, draft mapping, basics/execution/output sections         |                    333 | lint + field/test-id parity       |
| `terminalOutputScheduler.test.ts`             |  1,149 | ANSI, backpressure, drain specs + harness                            |                    392 | 73 tests; exact count parity      |
| `chatPanelTabsAtom.ts`                        |  1,060 | facade, model/state, presentation/open/lifecycle atoms               |                    382 | 30 tests; 29-export parity        |
| `cliAdapter.ts`                               |  1,060 | facade, event handler, lifecycle/history/transport/streaming helpers |                    591 | 80 tests + command/event parity   |
| `SessionProvenanceHooksPanel.tsx`             |  1,054 | facade, hook-platform table, recent-signals table, source icon       |                    576 | lint + typecheck                  |
| `terminalOutputScheduler.ts`                  |  1,019 | runtime facade, queue, ANSI, ACK, state, constants, types            |                    356 | 73 tests + typecheck              |
| `CloudOrgPanelView/index.tsx`                 |  1,009 | coordinator, state hook, header, general/repo-scope tabs, types      |                    345 | 4 tests + string/test-id parity   |

## Term-overloading review

| Term      | Usages reviewed                                                             | Verdict                                                                                                              |
| --------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `state`   | React-local UI state, Jotai tab state, sync-engine lifecycle state          | Keep. Each extracted module now supplies domain context in its filename; no cross-domain type is shared.             |
| `session` | local desktop session, imported teammate session, cloud session metadata    | Keep. Existing qualified type/function names remain intact and wire semantics did not change.                        |
| `scope`   | GitHub repository filter, cloud organization scope, sidebar selection scope | Keep. Scope values remain owned by their existing domains; the refactor does not introduce a generic shared `Scope`. |
| `event`   | terminal output events, CLI streaming events, cloud session events          | Keep. Transport and normalization modules remain domain-specific and preserve established event names.               |

## Ten-layer audit

| Layer                                   | Coverage                                                                                                                                | Result                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness              | Full frontend typecheck and changed-file lint                                                                                           | Pass; no diagnostics or lint violations.                                                                  |
| 2. Dead code / structural deduplication | Traced every original entry point into new modules; checked facades and deleted monolithic specs                                        | Pass; no orphan extraction or duplicate implementation found.                                             |
| 3. Naming consistency                   | Reviewed new filenames, imports, and retained exports                                                                                   | Pass; module names describe their responsibility and historical public names remain stable.               |
| 4. Semantic overloading                 | Reviewed `state`, `session`, `scope`, and `event` across changed domains                                                                | No new overload introduced; domain qualification is clearer after extraction.                             |
| 5. Default branches                     | Compared moved conditionals/defaults in sync engine, CLI adapter, scheduler, tab atoms, and UI coordinators                             | Pass; branches were moved without changing fallbacks. Nullable CLI display data is normalized explicitly. |
| 6. Cross-domain leakage                 | Checked shared/dataSource, monitoring, SessionCore adapter, and UI imports                                                              | Pass; extracted modules remain adjacent to and owned by their original domain.                            |
| 7. New-developer clarity                | Reviewed entry-point size and responsibility cohesion                                                                                   | Improved; stable facades expose the prior API while implementation filenames describe the call path.      |
| 8. Wire protocol / serialization        | Compared cloud metadata, CLI command/event names, terminal ACK fields, tab storage key                                                  | Pass; payload fields, command/event strings, cursor behavior, and storage identifiers are unchanged.      |
| 9. Initialization parity                | Compared API tracker install/uninstall order, sync-engine start/stop lifecycle, scheduler register/auto-register, adapter entry methods | Pass; all historical entry points delegate through the same moved implementations.                        |
| 10. Resolver symmetry                   | Reviewed repository/source selection and cloud/session lookup paths                                                                     | No fallback-chain change. Related fields continue to use their pre-refactor sources in the same order.    |

## Default and entry-point matrices

| Domain              | Entry points retained                                                        | Initialization / fallback parity                                                                         |
| ------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| API tracking        | `enableApiTracking`, `disableApiTracking`, tracing controls, query functions | Installer order and cleanup handles remain centralized in the facade/state modules.                      |
| Org2Cloud sync      | class constructor, `start`, `stop`, singleton                                | Lifecycle timers, visibility cadence, backoff, and session cursor behavior retain the original defaults. |
| CLI synchronization | exported `cliAdapter` methods                                                | Tauri transport commands and realtime event routing remain a single adapter path.                        |
| Terminal output     | register, schedule, suspend/resume, flush, ACK helpers                       | Auto-registration, queue order, ANSI splitting, and ACK payload construction remain shared.              |
| Chat panel tabs     | historical barrel exports and atom actions                                   | Storage key, 400 ms persistence debounce, singleton/focus/close behavior remain unchanged.               |

## Residual risks

- Browser monkey-patch install/restore behavior in API tracking has limited direct test coverage.
- ChatView, RoutineWizard, SessionProvenance, and the SessionCreator view do not have full rendered component tests; their changes are mechanical extractions backed by typecheck, lint, adjacent tests, and identifier parity checks.
- Browser-specific `MessageChannel` scheduling is represented by mocked scheduler tests; production scheduling branches were moved without semantic edits.
