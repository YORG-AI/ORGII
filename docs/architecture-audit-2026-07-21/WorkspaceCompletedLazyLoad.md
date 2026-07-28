# Workspace completed lazy load — architecture audit

## Acceptance criteria

- GitHub Open/Closed row controls use icon-only triggers while retaining labeled menu options.
- Workspace aggregate reads active items by default and performs no Completed-bucket IPC request until Completed is expanded or selected.
- Native `completed` and GitHub `closed` items render in one workspace Completed group without changing their stored/source status.
- Project-scoped and standalone reads use the same typed active/completed partition contract.
- Deferred results cannot overwrite another workspace/source-mode load after the scope changes.
- Loading and failure states stay inside the expanded Completed section and permit retry.
- Existing project Work Items pages retain their current grouping and expansion behavior.
- Focused TypeScript/Rust tests, full TypeScript checking, targeted ESLint, formatting, and whitespace validation pass.

## Ten-layer audit

| Layer | Coverage                           | Verdict          | Evidence / reason                                                                                                                                                                              |
| ----: | ---------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | Compilation correctness            | pass             | Full `tsc --noEmit`, targeted ESLint, focused Vitest, and focused `project_management` Rust tests pass.                                                                                        |
|     2 | Dead code / structural duplication | pass             | One `WorkItemReadBucket` enum classifies both project-scoped and standalone Rust reads; one workspace view-model projection owns Closed → Completed grouping/count/filter behavior.            |
|     3 | Naming consistency                 | pass             | The wire concept is named `readBucket`, not overloaded as a UI `statusFilter`; `active` and `completed` describe read partitions rather than persisted row status.                             |
|     4 | Semantic overloading               | keep with reason | Workspace “Completed” intentionally projects native `completed` plus GitHub `closed`. Rows retain their original status, so source mutations and GitHub dropdown semantics are not overloaded. |
|     5 | Default branches                   | pass             | `WorkItemReadBucket` is an exhaustive two-variant enum with no catch-all. Omitting it explicitly preserves the existing unfiltered read path.                                                  |
|     6 | Cross-domain leakage               | pass             | Generic Rust IO knows only active/completed partitions. Workspace-specific grouping stays in the frontend workspace projection; shared/project views are opt-in and unchanged by default.      |
|     7 | New-developer clarity              | pass             | The call chain is named `readWorkspaceBucket` → `readBucket` → `WorkItemReadBucket::matches`; comments document why GitHub Closed belongs to the terminal partition.                           |
|     8 | Wire protocol / serialization      | pass             | The Tauri argument is a typed serde enum; a Rust test locks its serialized values to `"active"` and `"completed"`. Filtered calls bypass the unfiltered frontend cache.                        |
|     9 | Entry-point parity                 | pass             | Project-enriched and standalone commands both accept the same optional bucket. Null keeps all items; Active excludes both terminal statuses; Completed includes both.                          |
|    10 | Resolver symmetry                  | pass             | Native project rows and standalone rows use the same Rust enum predicate; optional Linear adapter pages use the corresponding shared frontend terminal predicate before workspace projection.  |

## Call path

`Completed section expands / Completed filter selected` → `loadCompletedWorkItems` → typed `readBucket: "completed"` for every local project and standalone scope → Rust filters rows before per-row extras/label enrichment → frontend merges by stable work-item ID → workspace view model groups `closed + completed` under Completed.

The initial local path sends `readBucket: "active"`; it does not issue the local Completed request. A request generation invalidates stale terminal responses when organization or external-source scope changes. Linear's existing project-issue API has no bucket parameter, so the opt-in Include External mode partitions its cached adapter page client-side while still deferring terminal display.

## Entry-point parity matrix

| Entry point               | No bucket             | Active bucket                                            | Completed bucket                                                                                  |
| ------------------------- | --------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Project enriched read     | Existing full read    | Excludes `completed`, `closed` before per-row enrichment | Includes only `completed`, `closed`                                                               |
| Standalone read           | Existing full read    | Excludes `completed`, `closed` before per-row enrichment | Includes only `completed`, `closed`                                                               |
| Optional Linear aggregate | Existing adapter page | Client projects non-terminal workflow states             | Client projects terminal workflow states from the adapter cache after deferred section activation |

## Scoped-out layers

No schema migration, persisted status rewrite, GitHub/Linear mutation contract, authentication flow, project-specific Work Items grouping, or remote issue pagination contract changed.
