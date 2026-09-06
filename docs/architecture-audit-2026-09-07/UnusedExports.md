# Unused TypeScript export cleanup

## Scope and acceptance criteria

This change removes verified unused TypeScript export surfaces and unreachable declarations. It does not change persistence, IPC schemas, live UI behavior, or active resource ownership. Acceptance criteria are a passing frontend typecheck, clean lint for changed sources, unchanged emitted static module-loading order (apart from unused glyph assets), and relevant test evidence.

The source of truth for consumption is the frontend import graph, including the desktop, browser-mobile, and native-mobile entry points. The retained Knip configuration now names those three production entry points explicitly. A second, conservative analysis treated all source files, scripts, configuration, and tests as entries with entry-export analysis enabled. This prevents deleting declarations merely because a consumer is itself unreachable from the main application.

## Result

Removed **1,554 export entries** across **411 source files**: 1,006 re-export entries, 315 exported value declarations, and 233 exported type declarations. No export entries were added. This includes all 27 originally identified unused icon exports.

The corrected-entry Knip baseline contained 2731 findings; the final check contains 1293. This net finding reduction differs from the number of removed export entries because deleting unused consumers exposes further declarations. Repeated declaration passes reached zero additional candidates satisfying the conservative deletion rules.

## Removal rules

- Remove unused members from a barrel while retaining its live exports and module initialization.
- Remove unused type aliases/interfaces, named functions, and constants with side-effect-free initializers only after checking for remaining references outside their declarations.
- Check identifiers in other source/script/test/configuration files before deleting a declaration; preserve names mentioned by string selection or type queries.
- Remove orphaned private helpers and imports caused by the deletions. Retain a side-effect import when the original emitted JavaScript loaded the module at runtime.
- Remove the unused `repoCountAtom` and `hasReposAtom` plus their debug labels and barrel exports. Reference tracing terminates at their definitions and exports. Their Jotai constructors only create atom configuration objects; neither atom has a subscriber or persistence writer.
- Delete the unconsumed `ChatPanelPaddedRow` wrapper. Keep the mounted preview/typography shells unchanged.

Do not delete exported classes, effectful initializers, namespace members, default exports with uncertain ownership, test-consumed helpers, or the last runtime re-export from a module whose initialization may matter. An unused export is not sufficient evidence that its implementation or module can be deleted.

Four overlapping shim files and the Inbox `DateGroup` type are left to the existing PR #1326; this PR does not duplicate that import-path migration.

## False positives retained

- `createTauriMobileRemotePlatform` is consumed by the native-mobile entry point.
- `upsertSessionTurnIndex` participates in a string-keyed `Pick` over a namespace import; an initial candidate pass exposed this through typecheck and was corrected.
- `STATUS_COLORS`, `PRIORITY_COLORS`, and `LABEL_COLORS` remain exported through the project-management configuration barrel because the WorkItem configuration re-exports them.
- Cache constants such as `BRANCH_CACHE_CONFIG` remain in their owning modules where production helpers consume them, even when an unused outer re-export can be removed.

## Architecture coverage

| Layer                    | Coverage                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| 1 — compilation          | Full frontend typecheck and changed-source lint                                                       |
| 2 — dead code            | Knip graph, conservative all-file entries, remaining identifier references, and orphan cleanup        |
| 3 — naming               | Removed declaration documentation alongside deleted definitions; no naming migration                  |
| 4 — semantic overloading | No new terminology or domain model; broader terminology audit intentionally excluded                  |
| 5 — default branches     | No changes to branches in retained functions; wider default-policy review excluded                    |
| 6 — boundaries           | Narrow barrel surfaces without moving implementations across module boundaries                        |
| 7 — readability          | Remove unused surface area and associated stale declaration comments                                  |
| 8 — wire protocol        | No Rust, schema, serialization, persistence, or IPC shape changes; payload testing not applicable     |
| 9 — entry parity         | Desktop/browser-mobile/native-mobile analysis roots made explicit; initialization functions unchanged |
| 10 — resolver symmetry   | No retained resolver body or fallback chain changed; broader resolver audit excluded                  |

## Performance guard

| Area               | Verdict | Evidence                                                                                       | Change or reason kept                                                      | Verification                                  |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------- |
| Background work    | keep    | Deleted cache, request, and synchronization helpers have no remaining production callers       | Existing start/stop, polling, retry, and subscription paths stay unchanged | Import/reference graph, typecheck, test suite |
| Memory             | keep    | Dead cache helpers cannot allocate without callers; the two removed repo atoms have no readers | Keep active caches, bounds, eviction, and initialization                   | Cache unit tests and static call-path review  |
| Scope/isolation    | keep    | No retained request/cache key, identity switch, or endpoint resolver is edited                 | Existing scope keys and disposal behavior retained                         | Static diff and module-loading comparison     |
| Rendering/hot path | keep    | Live component/hook bodies are unchanged; only an unconsumed wrapper is deleted                | No subscription, stream, or render scheduling change                       | Frontend audit and test suite                 |

Lifecycle matrix: app start/idle/active/shutdown, visible/hidden/focus return, online/offline/retry, identity/endpoint switch, org/session removal, and primary/secondary instances retain their existing live paths. Provider ingestion, topology, and raw transcript transitions are not changed. No runtime CPU/RSS improvement or dual-machine verification is claimed.

Performance verdict: pass for the static no-live-lifecycle-change scope. Real desktop/secondary-instance execution was not performed; this is not runtime performance evidence.

## Verification approach

`node scripts/quality/check-export-cleanup.mjs origin/develop` compares TypeScript-emitted static module sources in evaluation order against the PR base. The only allowed disappearing loads are individual unused glyph assets in `src/icons.ts`. This check does not prove computed/dynamic reachability or replace typecheck/tests.

No unit tests or assertions are removed. Unused test-fixture builders may be removed under the same consumption checks. No GUI automation is used. UI evidence is not useful for export/type removal with unchanged mounted component bodies.

Verification: the full suite passed (1,534 files / 11,506 tests); the final follow-up selection passed (15 files / 134 tests); the final full typecheck passed; the final module-loading comparison passed for all 411 changed source files. The circular-dependency check passed across 6,588 modules. Exact commands, lint/hook results, and remaining Knip counts are recorded in the pull request's Verification section. Remaining Knip findings are an explicit follow-up review queue, not a claim of zero dead code.
