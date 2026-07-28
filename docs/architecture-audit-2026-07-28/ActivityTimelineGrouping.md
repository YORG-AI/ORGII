# Architecture Audit — Activity timeline grouping

**Scope:** Work-item history projection, derived activity grouping, shared history rendering, localization and regression coverage.
**Date:** 2026-07-28
**Auditor:** Codex

## Acceptance criteria

- [x] Canonical history remains append-only and unmodified.
- [x] Only consecutive update events from the same actor within five minutes are grouped.
- [x] Comments and lifecycle events remain standalone chronological boundaries.
- [x] Every grouped event remains available through an expandable raw audit trail.
- [x] Stored status and priority enums resolve through product-localized labels.
- [x] Team Inbox and formal Work Item entry points inherit the same renderer.

## Term overloading

| Term                   | Meaning                                                                         | Owner                   | Verdict                      |
| ---------------------- | ------------------------------------------------------------------------------- | ----------------------- | ---------------------------- |
| `TimelineEntry`        | One canonical display projection of a persisted history event or legacy comment | `useWorkItemTimeline`   | Keep                         |
| `ActivityTimelineItem` | A render-only entry or group derived from ordered timeline entries              | `activityTimelineModel` | Keep distinct                |
| `change-group`         | Consecutive field-update events collapsed for reading, never a persisted event  | `activityTimelineModel` | Explicitly presentation-only |
| `actorId`              | Stable grouping identity; display name remains presentation metadata            | Timeline projection     | Keep separate                |

## Ten-layer audit

| Layer                                     | Coverage                                                                                                                                                                                                                                          | Verdict               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 1. Compilation correctness                | Targeted Vitest, changed-file ESLint and repository TypeScript typecheck pass.                                                                                                                                                                    | Pass                  |
| 2. Dead code and structural deduplication | `HistoryTab` delegates timeline rendering to one wired `WorkItemActivityTimeline`; the former inline renderer was removed in the same change.                                                                                                     | Pass                  |
| 3. Naming consistency                     | Persisted entries, derived items, change groups, fields and actor identity use distinct names.                                                                                                                                                    | Pass                  |
| 4. Semantic overloading                   | A grouped summary is not represented as a history event and cannot be mistaken for canonical data.                                                                                                                                                | Pass                  |
| 5. Default branches                       | Only `updated` events are eligible; comments, create/delete/restore/move, invalid timestamps, actor changes and time gaps all flush the pending group.                                                                                            | Pass                  |
| 6. Cross-domain leakage                   | Grouping stays in Work Item presentation; shared timeline primitives remain domain-neutral and persistence types remain unchanged.                                                                                                                | Pass                  |
| 7. New-developer clarity                  | The model documents grouping boundaries and exposes a discriminated union consumed exhaustively by the renderer.                                                                                                                                  | Pass                  |
| 8. Wire protocol and serialization        | No API, Tauri, cloud, database or serialized history shape changed; `actorId` and field labels exist only in the frontend projection.                                                                                                             | Not applicable / safe |
| 9. Entry-point parity                     | Team Inbox and formal Work Item both reach `HistoryTab` through the shared thread surface and therefore use the same derived grouping.                                                                                                            | Pass                  |
| 10. Resolver symmetry                     | Persisted history and legacy comments both resolve stable actor IDs; agent delegation classification prefers `actorId` and uses display-name matching only for legacy rows; status and priority old/new values follow the same localization path. | Pass                  |

## State and edge-case matrix

| Input transition                    | Derived result           | Data invariant                        |
| ----------------------------------- | ------------------------ | ------------------------------------- |
| Same actor + update + ≤5 minute gap | Append to current group  | Original entries retained in order    |
| Different actor or >5 minute gap    | Flush, begin a new run   | No cross-actor/time merge             |
| Comment or lifecycle event          | Flush, render standalone | Human communication remains prominent |
| Invalid/out-of-order timestamp      | Flush                    | Ambiguous events are never merged     |
| Expand/collapse group               | Native disclosure only   | No mutation or persistence write      |

## Systematic sweep

The ownership sweep covered both Work Item entry points, `HistoryTab`, canonical timeline projection, shared activity primitives, persisted/legacy comment identity, status/priority label dictionaries and the focused tests. No second Work Item timeline renderer or persistence-side grouping path remains.

## Completion verdict

- The feature is a pure, memoized presentation projection with no timers, polling, subscriptions, caches or background lifecycle.
- The raw audit trail remains complete and reversible from every compact summary.
- No wire, schema or persistence migration is required.
