# Architecture Audit — Uncommitted Runtime Batch

**Scope:** the uncommitted Rust and TypeScript changes on `junyu/rpc-performance-closure`, including Team Inbox, setup/sign-in, GitHub Star, message dispatch/intervention, static HTML canvas, runtime caches/coordinators, webview retention, transport bindings, and shared UI ownership.
**Date:** 2026-07-27
**Auditor:** ORGII implementation session

## Layer 1 — Compilation correctness

- `pnpm typecheck`: passed.
- ESLint over every changed frontend source file: passed.
- Changed frontend tests: 33 files and 214 tests passed.
- `cargo check --workspace --all-targets`: passed.
- Affected Rust library suites (`agent_core`, `integrations`, `org2`, `project_management`, `search`, and `transport`): passed.
- `rustfmt --check` over every changed Rust file: passed.
- Repository-wide `cargo fmt --all -- --check` remains blocked by three pre-existing formatting differences in untouched files.
- `git diff --check`: passed.

## Layer 2 — Dead code and structural deduplication

- Shared list-panel, placeholder, search/sort, and folder-header implementations now have one canonical owner under `src/components`; former module paths are compatibility re-exports.
- ChatView session-side effects were moved to `useChatViewSessionLifecycle` without adding a second runtime owner.
- Benchmark, repo, project, history-rescan, sidebar-load, and file-index request duplication is handled by scoped single-flight coordinators rather than parallel local state machines.
- The transport `ts-rs` feature and checked-in bindings are contract-generation artifacts covered by transport tests. The existing global `TransportEmitter` is still not a production event source; this batch does not claim otherwise or add a second frontend listener contract.

## Layer 3 — Naming consistency

| Term | Canonical meaning | Verdict |
| --- | --- | --- |
| `scopeKey` / request key | Complete identity of a cache or in-flight request | Consistent across coordinators |
| `generation` | Invalidates stale asynchronous completions | Consistent across file, repo, sidebar, and webview lifecycles |
| `intervention` | Durable direct-user takeover of an Agent Org member | Kept distinct from message acceptance |
| `completed` | Authoritative turn finality | Reserved for `agent:turn_completed`; `agent:complete` is intermediate |
| `setupWalkthroughOutcome` | Resolved persisted onboarding state | Shared by initial load and external reload |

## Layer 4 — Semantic overloading

- Query loading, mutation loading, and refresh state remain separate.
- A successful backend message receipt no longer implies a successfully persisted direct-user intervention on the Rust path; persistence failure is returned to the caller.
- Queue hydration failure is fail-closed, while transient durable-store initialization can be retried.
- Team Inbox read state is viewer scoped; managed-cloud identity remains endpoint + authenticated user + org scoped.

## Layer 5 — Default branch analysis

| Branch or failure | Audited result |
| --- | --- |
| Team Inbox receipt changes while a page request is in flight | Completion overlays the latest receipt ref; it cannot restore stale unread state |
| Team Inbox target changes during body load | The new request key exposes loading immediately and rejects the prior completion |
| Legacy settings arrive through the external-change path | The same setup resolver used at startup derives `completed` instead of defaulting to `open` |
| Durable queue store fails to initialize | The memoized promise is cleared so a later mutation retries initialization |
| GitHub star confirmation succeeds | The focus listener is removed; later focus events do not repeat the CLI check |
| Static canvas CSS contains network, host, fixed/sticky, comment-split, or escape constructs | The authored stylesheet is rejected and the contained base theme remains |
| Agent Org direct intervention cannot persist | Rust message dispatch rejects instead of accepting a takeover that Wake can race |
| `agent:complete` arrives before turn finality | UI receives intermediate completion metadata; only `agent:turn_completed` is authoritative |

## Layer 6 — Cross-domain concept leakage

- Team Inbox storage, cloud mention transport, UI composition, and navigation remain separate owners.
- GitHub CLI/process handling stays in the integrations crate; React surfaces consume one Tauri API/controller.
- Generic cache/coordinator modules contain no UI presentation or domain-specific fallback behavior.
- Canvas sanitization and containment stay at the static-HTML rendering boundary.

## Layer 7 — New developer confusion test

- Lifecycle helpers state their owner and terminal conditions in module documentation.
- Cache keys and generation guards are explicit at their call sites.
- Compatibility re-exports make the component ownership migration discoverable without preserving duplicate implementations.
- The transport emitter's current non-production status is documented here so generated bindings are not mistaken for an activated runtime protocol.

## Layer 8 — Wire protocol and serialization

- Team Inbox Tauri DTOs, cursor ordering, viewer IDs, and tagged variants are covered by Rust serialization/behavior tests.
- Managed-cloud mention responses are Zod validated and do not accept a caller-supplied viewer identity.
- RPC output validation uses an opt-in `off` / `warn` / `throw` mode and a bounded diagnostic buffer.
- Rust transport and session-persistence bindings are generated behind optional `ts-rs` features; the large-integer mapping is explicit in `.cargo/config.toml`.

## Layer 9 — Init parity

| Entry path | Shared initialization/resolution | Verdict |
| --- | --- | --- |
| Settings startup and external file reload | `resolveSetupWalkthroughOutcome` | fixed and tested |
| Team Inbox list/count/read mutations | canonical schema + explicit viewer | pass |
| File index initial build and invalidation rebuild | same keyed cache/generation owner | pass |
| Primary and secondary ChatView | `useChatViewSessionLifecycle` with explicit surface flags | pass |
| Direct Rust user message and scheduled turn | durable intervention before execution | fixed |
| CLI transport user message | accepted receipt followed by best-effort intervention API | known parity limitation; existing behavior retained |

The CLI path cannot make receipt acceptance and intervention persistence atomic with its current backend command contract. This is a remaining design limitation, not silently classified as equivalent to the Rust path.

## Layer 10 — Resolver symmetry

- Setup outcome, Team Inbox identity, repository cache identity, and queue store ownership use the same resolver on read, refresh, mutation, and stale-completion checks.
- Project/repository mutations invalidate the same cache generation consumed by list readers.
- Static canvas body, authored styles, and wrapper containment pass through one construction boundary.

## Systematic sweep

- Searched changed runtime files for timers, animation frames, listeners, subscriptions, caches, in-flight promises, queues, scans, and disposal.
- Ran the component-boundary checker: no new violations; 16 tracked legacy violations remain.
- Checked semantic peers for setup reload, Team Inbox receipt overlay, GitHub focus rechecks, file-index invalidation, webview visibility/layout, repo/project refresh, and queue hydration.
- Reviewed changed default/error branches rather than treating search hits as findings.

## Completion verdict

Eight correctness or lifecycle issues found during this audit were fixed and covered by focused tests. The applicable portions of all 10 architecture layers were reviewed. The CLI intervention atomicity limitation and the dormant production transport emitter are explicitly retained risks; neither is newly introduced as a live production path by this batch.

**Architecture verdict: pass with the documented CLI parity limitation.**
