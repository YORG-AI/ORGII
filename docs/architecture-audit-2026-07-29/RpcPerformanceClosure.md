# Architecture Audit — RPC Performance Closure

**Scope:** the final diff of PR #512 after rebuilding it on `develop`, limited to RPC diagnostics, CLI turn intents, async-resource ownership, bounded caches/scans, and lifecycle cleanup.
**Date:** 2026-07-29
**Auditor:** Codex implementation session

## Acceptance criteria

- The branch contains no Team Inbox, onboarding, Kanban, Canvas, or unrelated UI feature implementation.
- Tauri command registration resolves only commands present in the rebuilt branch.
- CLI submission, persistence, execution, terminal status, and reconnect projection use one durable turn-intent identity.
- Adjacent session and turn-intent writes can share one SQLite transaction.
- Async completions cannot write after a newer scope, generation, hidden-state transition, or teardown.
- Retained caches, diagnostic buffers, webviews, scans, and request coordinators have explicit bounds or weak ownership.
- Rust compilation has zero warnings; TypeScript typecheck and focused lifecycle tests pass.

## Layer 1 — Compilation correctness

- `CARGO_TARGET_DIR=/tmp/orgii-pr512-cargo-target cargo check`: passed with zero warnings.
- `pnpm typecheck`: passed.
- Focused frontend lifecycle suite: 10 files, 56 tests passed.
- `cargo test -p session_persistence turn_intents`: 12 tests passed.
- `cargo clippy --workspace --all-targets -- -D warnings` reaches unchanged
  baseline findings in `bin-gateway-chat-cli` and `orgtrack-core`; no changed
  production path emitted a `cargo check` warning.

## Layer 2 — Dead code and structural deduplication

- Removed stale Team Inbox and GitHub Star entries from the generated Tauri handler source.
- Restored the still-live OAuth plugin dependency and registration instead of leaving capability-only dead configuration.
- Sidebar roster reads now have one per-Jotai-store coordinator; concurrent consumers no longer own parallel request state.
- Existing project-list virtualization remains the single rendering owner; the unrelated non-virtual rendering fork was removed.

## Layer 3 — Naming consistency

| Term | Canonical meaning | Verdict |
| --- | --- | --- |
| `turn_intent_id` | Durable identity of one requested CLI turn across IPC, persistence, execution, and status projection | consistent |
| `generation` | Monotonic fence preventing an older async completion from committing | consistent |
| `scopeKey` | Complete local identity of a resource or coordinated request | consistent |
| `forceRefresh` | A request stronger than a cache hit or non-forced active load | consistent |

## Layer 4 — Semantic overloading

- Session runtime status and turn-intent lifecycle status remain separate dimensions.
- User submission, queued continuation, and Agent Org sources remain explicit enum variants.
- A successful IPC acceptance receipt is not treated as completed execution.
- Sidebar request scope includes external-history enablement and disabled sources; it is not inferred from page size or refresh strength.

## Layer 5 — Default branch analysis

| Branch or failure | Result |
| --- | --- |
| Repeated intent ID | Idempotently returns the existing row; cannot reassign durable run ownership |
| Illegal terminal-to-running transition | Rejected by the persistence FSM |
| Process restart with pending/running intents | Pending becomes stale; running becomes failed |
| Changed sidebar data-source scope in flight | Current request is fenced and one serialized trailing load runs |
| Hidden document | Non-critical polling/countdown retains no active timer |
| Late browser diagnostic after close | Generation/ownership guard rejects the result |
| OAuth capability at build time | Backed by the registered plugin; build does not fail capability validation |

## Layer 6 — Cross-domain concept leakage

- Generic async helpers contain no Team Inbox, project, browser, or provider presentation logic.
- SQLite turn-intent primitives remain in `session-persistence`; Tauri commands compose them through the CLI persistence boundary.
- Sidebar loader coordination is per store and does not introduce process-global UI data ownership.
- No Team Inbox modules or command registrations remain in this PR.

## Layer 7 — New developer confusion test

- Connection-scoped persistence variants are named `*_on` and document their atomic-transaction purpose.
- The compatibility alias `loadSidebarSessions` points directly to the canonical `loadSessionRoster`.
- Coordinator comments state store ownership, escalation behavior, and scope-change serialization.
- Profiling dependencies are opt-in while required production plugins remain registered.

## Layer 8 — Wire protocol and serialization

- CLI run/status payloads carry the durable turn-intent ID through acceptance and reconciliation.
- Batch status is bounded and registered once at the Tauri boundary.
- No Team Inbox DTO or command was retained.
- Existing frontend transport tests verify the current lifecycle contract; no fallback field silently substitutes a different identity.

## Layer 9 — Init parity

| Entry path | Intent persistence | Execution binding | Terminal reconciliation |
| --- | ---: | ---: | ---: |
| New CLI run | yes | yes | yes |
| Existing-session message | yes | yes | yes |
| Queued/steered message | yes | yes | yes |
| Reconnect batch status | reads latest durable intent | n/a | yes |
| Process restart | existing rows | n/a | stale/failed reconciliation |

The Tauri production build also initializes every capability-backed plugin used by the frontend, including OAuth.

## Layer 10 — Resolver symmetry

- CLI resume/account resolution preserves the current develop fallback chain while binding the same intent ID to all transports.
- Sidebar scope identity uses the same external-history enablement and disabled-source inputs for coverage, trailing-load decisions, and cache invalidation.
- Batch turn-intent projection returns the complete row shape, including `org_run_id`.

## Systematic sweeps and fixes

- Swept all async `emit_chunk`, `flush_and_broadcast`, and file-snapshot call sites after finding one dropped Future; all 12 missing awaits across ACP, app-server, and standard transports were fixed.
- Swept the generated Tauri command list after finding one missing module; stale Team Inbox and GitHub Star handlers were removed while current RPC handlers were retained.
- Swept the performance commit's visible JSX after finding unrelated UI drift; project virtualization was restored.
- Verified the final file list contains no Team Inbox, onboarding, Kanban, or Canvas paths.

**Architecture verdict: pass for the final PR #512 scope.**
