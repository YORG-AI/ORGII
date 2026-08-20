# Architecture Audit — Dead Shared Components

**Scope:** shared component entry points and the ChatPanel debug viewer identified by orphan/export sweeps

**Date:** 2026-08-14

**Auditor:** Codex

## Acceptance criteria

- Every deleted component has no production importer, barrel export, dynamic import, string-based registry entry, or runtime resolver path.
- Tests that exist only to exercise a deleted ownership unit are removed with that unit.
- Live configuration and subcomponents sharing the same directory name remain intact.
- TypeScript, focused tests, ESLint, reference sweeps, and the production webpack build pass.

## Entry-point and ownership trace

Production reachability was checked from static imports, re-exports, lazy imports, dynamic-loader patterns, and component registries. The candidates below terminate inside their own ownership unit. `Anchor` has one historical consumer under `.archive`, which `tsconfig.json` explicitly excludes from the application build. `SoftwareIcon/config.ts` is referenced only by an assertion in `ModelIcon/config.test.ts`; no production path uses the component or map, so the assertion and dead unit are removed together.

`CompoundPill/config.ts` remains live across chat, session-creator, project, and selector surfaces. The `PropertyField` directory's dropdown, editable-field, and direction-provider modules also remain live. Only their unreachable renderer entry points are deleted.

## Deleted ownership units

| Component / unit         | Deleted scope                            | Reachability verdict                                                  |
| ------------------------ | ---------------------------------------- | --------------------------------------------------------------------- |
| `AccountActionCard`      | `components/ActionCard/Accounts/*`       | Self-references only                                                  |
| `Anchor`                 | `components/Anchor/*`                    | Archived-only caller; no production caller                            |
| `CategoryBadge`          | `components/CategoryBadge/*`             | Self-references only                                                  |
| `CompoundPill` renderer  | `components/CompoundPill/index.tsx`      | Renderer unused; shared `config.ts` retained                          |
| `ContextDropdown`        | `components/ContextDropdown/*`           | Self-references only                                                  |
| `ContextListDropdown`    | `components/ContextListDropdown/*`       | Self-references only                                                  |
| `DateRangeSelector`      | `components/DateRangeSelector/*`         | Self-references only                                                  |
| `ModelAvailabilityBadge` | `components/ModelAvailabilityBadge/*`    | Self-references only                                                  |
| `Progress`               | `components/Progress/*`                  | Unused; separate live `ProgressBar` retained                          |
| `PropertyField` wrapper  | `components/PropertyField/index.tsx`     | Wrapper unused; active subcomponents retained                         |
| `SoftwareIcon`           | `components/SoftwareIcon/*`              | No production caller; test-only assertion removed                     |
| `StarRating`             | `components/StarRating/*`                | Self-references only                                                  |
| `StatusBadge`            | `components/StatusBadge/*`               | No caller; similarly named domain badges are separate implementations |
| `Timeline`               | `components/Timeline/*`                  | Unused; Gantt timeline is a separate local component                  |
| `Upload`                 | `components/Upload/*`                    | Internal files reference only one another; no external caller         |
| `DebugJsonViewer`        | `ChatPanel/components/DebugJsonViewer/*` | Self-references only                                                  |

## False positives retained

| Candidate                     | Reason retained                                                  |
| ----------------------------- | ---------------------------------------------------------------- |
| `FlowAwarenessTest`           | Loaded by a dynamic import in `router/lazy/pages.tsx`            |
| `GlobalDragDrop`              | Loaded by a dynamic import in `app/root/AppDeferredServices.tsx` |
| `CompoundPill/config.ts`      | Imported by many production pill and composer surfaces           |
| `PropertyField` subcomponents | Imported by project/work-item property surfaces                  |
| `ProgressBar`                 | Separate component with multiple production callers              |
| Gantt `components/Timeline`   | Feature-local component imported by the Gantt chart              |

## Layer review

| Layer                            | Coverage | Result                                                                                                             |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| 1. Compilation and imports       | Covered  | Static, barrel, lazy, dynamic, and stylesheet imports were swept; production build resolves.                       |
| 2. Structure and dead code       | Covered  | Sixteen unreachable ownership units were deleted; false-positive orphans were retained.                            |
| 3. Types and naming              | Covered  | Component-owned props/types were removed only with their sole owner; live namesakes were distinguished by path.    |
| 4. Domain ownership              | Covered  | No domain owner changed; retained configs and subcomponents preserve active ownership boundaries.                  |
| 5. State transitions             | Covered  | Deleted units have no reachable state transition; no active reducer, atom, or event path changed.                  |
| 6. Persistence                   | Covered  | No schema, storage key, reader, or writer changed.                                                                 |
| 7. Error and async boundaries    | Covered  | No reachable async/error boundary was removed.                                                                     |
| 8. Wire protocol                 | Skipped  | No RPC, serialization, or protocol code is in scope.                                                               |
| 9. Initialization parity         | Skipped  | No initialization path or default changed.                                                                         |
| 10. Resolver/runtime integration | Covered  | String registries, dynamic loaders, and runtime component-map patterns were checked; no deleted unit participates. |

## Verification

- `rg` source/path and exported-symbol sweeps: no production references to deleted units.
- `madge --orphans --extensions ts,tsx --ts-config tsconfig.json src`: candidates corroborated; dynamic-import false positives reviewed manually and retained.
- `pnpm typecheck`: passed.
- `pnpm exec vitest run src/components/ModelIcon/config.test.ts`: passed (2 tests).
- ESLint on all surviving edited TypeScript files: passed.
- `pnpm build`: passed (`webpack compiled`).
- `git diff --check`: passed.

No runtime performance or bundle-size improvement is claimed: the deleted modules were already unreachable and may already have been excluded by bundling.
