# Architecture Audit — Async Resource Lifecycle

**Scope:** shared async-resource state, visibility-aware polling, and the migrated TypeScript query owners.
**Date:** 2026-07-23
**Auditor:** ORGII implementation session

## Acceptance criteria

- One owner for `data / error / loading / refreshing / reload` state.
- Equal in-flight scope loads coalesce; explicit refresh starts a new generation.
- A completion from an old repo, workspace, project, filter, language, or webview cannot commit.
- Disabled and changed scopes cannot display data from the previous scope.
- Background polling pauses while hidden, never overlaps, and stops cleanly.
- Mutation/action loading remains separate from query loading.
- Caches are bounded and include the complete resource identity.
- TypeScript, focused lint, lifecycle tests, and `git diff --check` pass.

## Layer 1 — Compilation correctness

- `pnpm run typecheck`: passed.
- Focused ESLint across all changed frontend files: passed.
- Focused Vitest run: 10 files and 118 tests passed.
- `git diff --check`: passed.

## Layer 2 — Dead code and structural deduplication

- Removed the unused `useAsyncData` abstraction.
- `useAsyncResource` is now the single generic owner for request state and generation fencing.
- `useVisibilityPolledData` composes the same owner instead of maintaining a second polling-specific state machine.
- Duplicate initial-load/manual-refresh implementations were removed from the migrated hooks.

## Layer 3 — Naming consistency

| Term | Meaning | Verdict |
| --- | --- | --- |
| `scopeKey` | Complete identity of the visible resource | Explicit and consistent |
| `reload` | Load or background-revalidate, joining an equal in-flight generation | Explicit |
| `refresh` | User-requested superseding generation | Explicit |
| `loading` | Initial load or foreground refresh | Kept for consumer compatibility |
| `refreshing` | Existing data is retained during foreground refresh | Separate state, not overloaded with action progress |
| `operationLoading` / `gatewayLoading` | Explicit user mutation in progress | Correctly remains outside the query resource |

## Layer 4 — Semantic overloading

- Query state and mutation state remain separate in Stash, Gateway, Work Item, and provider flows.
- `background` controls presentation only; it does not weaken generation checks.
- `publish` means an intermediate current-scope cache value, not completion.
- `setData` is limited to optimistic/current-resource updates and cannot write while the resource is disabled.

## Layer 5 — Default branch analysis

| Condition | Result |
| --- | --- |
| `enabled === false` or `scopeKey === null` | Reset to initial data/status and supersede active work |
| Same automatic scope already in flight | Join the existing promise |
| Manual refresh | Supersede and start a new generation |
| Scope changes | Hide old data immediately and reject late completion |
| Fetch rejects | Preserve current-scope data, expose normalized error |
| Hidden document | Retain no polling timer |
| Visibility returns | Run one immediate catch-up pass |
| Poll stops during DOM dirty-check | Effect-local active fence prevents a post-teardown reload |

## Layer 6 — Cross-domain concept leakage

- `useAsyncResource`, `LatestScopedTask`, and `startVisibilityAwarePoll` contain no project, Git, LSP, provider, or webview domain imports.
- Domain fetchers own payload parsing and cache policy; the generic lifecycle layer owns only scheduling and commit eligibility.
- Tauri and HTTP command names remain at their domain call sites.

## Layer 7 — New developer confusion test

- The hook contract documents the difference between automatic load, manual refresh, background reload, and intermediate cache publish.
- A resource's visible state is derived from the current `scopeKey`; consumers do not need local cancellation refs.
- Action states are visibly named and remain local where they represent distinct user operations.

## Layer 8 — Wire protocol and serialization

- No backend command schema or wire payload was changed.
- Serialized scope keys are frontend-only coordinator identities and are parsed by the matching local fetcher.
- Scope keys include all relevant identity fields, including repo ID/path, connection/team/surface, filter, language, and webview label/depth.

## Layer 9 — Init parity

| Entry path | Resource owner | Generation guard | Error normalization |
| --- | --- | ---: | ---: |
| Automatic first load | `useAsyncResource` | yes | yes |
| Manual refresh | `useAsyncResource.refresh` | yes, superseding | yes |
| Background poll | `reload({ background: true })` | yes | yes |
| Cache then live result | `context.publish` + final return | yes | yes |
| Disabled/unmounted scope | effect cleanup | yes | n/a |

## Layer 10 — Resolver symmetry

- Every migrated resource uses the same scope value for loading, visibility, stale-result rejection, and optimistic updates.
- Cached and live values use the same resource identity.
- The commit-diff cache now includes repository identity as well as commit SHA, eliminating cross-repository collisions.

## Systematic sweep

- Searched query hooks for repeated `loading/error/data` owners and manual cancellation/request-ID patterns.
- Searched active runtime code for `setInterval`; migrated non-critical IPC polling peers.
- Kept animation clocks, debounces, durable persistence heartbeats, editor/document FSMs, user-triggered searches, and mutation progress states with their specialized owners.
- Remaining literal `setInterval` hits in the audited directories are UI clocks/simulations or domain-specific lifecycles, not duplicate query polling.

## Completion verdict

- One teardown issue found during audit was fixed: DOM dirty polling now cannot schedule a tree reload after its effect has stopped.
- Relevant architecture layers 1–10 were checked; backend init, schema migration, and resolver-chain changes were not applicable because no backend or wire contract changed.

**Architecture verdict: pass for the audited async-resource and polling scope.**
