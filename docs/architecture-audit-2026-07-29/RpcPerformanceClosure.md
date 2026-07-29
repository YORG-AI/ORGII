# Architecture Audit — Runtime Profiling and Contract Gates

**Scope:** PR #568 rebuilt on the current `develop`, limited to opt-in memory
profiling, RPC output-validation policy, generated Rust-to-TypeScript bindings,
and transport adapter serialization.
**Date:** 2026-07-30
**Auditor:** Codex cleanup session

## Acceptance criteria

- The PR contains one intended commit and no commits from the pre-force-push
  `develop` history.
- Normal builds do not link DHAT, replace the allocator, start a profiling
  worker, or validate RPC outputs in production.
- The opt-in DHAT lifecycle has one owner and finalizes at Tauri exit.
- RPC drift diagnostics have an explicit mode and a fixed memory bound.
- Mock and Tauri transport adapters serialize the same typed payload.
- Generated TypeScript bindings match the serialized Rust field names.
- No dependency removal, lockfile churn, missing quality-script entry, or
  unrelated product/UI code remains.

## Layer 1 — Compilation correctness

- `pnpm typecheck`: passed.
- RPC output-validation Vitest: 6/6 passed.
- `cargo test -p transport --features ts-rs`: 9/9 passed.
- `cargo test -p session_persistence --features ts-rs`: 37/37 passed.
- `cargo check -p org2 --features dhat-heap`: passed.
- Changed-file rustfmt: passed. Whole-workspace rustfmt still reports unchanged
  formatting drift outside this PR.
- The workspace still reports one unchanged `unused_mut` warning in
  `orgtrack-core`; no changed module emitted a warning.

## Layer 2 — Dead code and structural deduplication

- The Tauri and mock adapters now delegate field naming to the same serde
  definitions instead of maintaining parallel JSON maps.
- The transport emitter remains a pre-existing initialized service with no
  production emit call sites outside its crate. This PR does not claim that the
  transport events are a live product path; its tests enforce adapter/mock wire
  parity for the existing boundary.
- The replay originally removed `ali-react-table` and `clsx`; that unrelated
  dependency cleanup and its lockfile churn were removed from PR #568.
- A `check:component-boundaries` package entry whose script did not exist on
  current `develop` was also removed.

## Layer 3 — Naming consistency

| Term | Meaning | Verdict |
| --- | --- | --- |
| `dhat-heap` | Explicit developer-only Rust heap-profiling feature | consistent |
| `RpcOutputValidationMode` | Process-wide `off` / `warn` / `throw` response policy | consistent |
| `output drift` | Rust response that fails the declared frontend output schema | consistent |
| `AgentEvent` | Tagged typed payload emitted on `agent://event` | consistent |

## Layer 4 — Semantic overloading

- Profiling activation is separate from normal runtime diagnostics.
- RPC validation mode is separate from command execution success.
- Transport event `type` identifies the agent-event variant; the Tauri channel
  name identifies the event family. Neither is used as the other.

## Layer 5 — Default branch analysis

| Branch or fallback | Result |
| --- | --- |
| Normal Cargo feature set | DHAT dependency, allocator, worker, and exit hook are absent |
| Invalid or oversized start delay | Falls back to the documented 15-second delay |
| Browser global unavailable | RPC drift recording is a no-op |
| Production RPC policy | Output validation is `off` |
| Development/test RPC policy | Output validation is `warn`; explicit CI can select `throw` |
| Repeated profiler scheduling/finalization | State machine makes both idempotent |

## Layer 6 — Cross-domain concept leakage

- DHAT ownership stays in the desktop crate and is feature-gated.
- Session-persistence exports only its own `CacheStats` DTO.
- RPC policy stays at the typed invoke boundary.
- Transport payload types remain in the transport crate and do not import UI
  or session-persistence concepts.

## Layer 7 — New developer confusion test

- Profiling scripts and docs name the required feature, delay, output path, and
  shutdown requirement.
- Generated bindings make the Rust/TypeScript contract discoverable.
- Comments distinguish developer profiling from production behavior.

## Layer 8 — Wire protocol and serialization

| Boundary | Source of truth | Verification |
| --- | --- | --- |
| Agent lifecycle | `AgentEvent` serde tag/content and camel-case attributes | transport tests inspect serialized JSON |
| Text stream | `TextChunk` serde attributes | generated binding test and adapter payload test |
| Tool event | `ToolEvent` / `ToolEventType` serde attributes | generated binding test and adapter payload test |
| Cache stats | `CacheStats` serde attributes | generated binding test |
| RPC response | Procedure output Zod schema | 6-mode/failure-path Vitest cases |

Opaque tool `params` and `result` intentionally export as `unknown`; numeric
cache counters export as `number` under the repository's bounded-value
contract.

## Layer 9 — Init parity

| Entry path | Normal build | `dhat-heap` build |
| --- | --- | --- |
| Desktop startup | Existing runtime only | Installs the gated allocator and schedules one profiler start |
| Tauri exit | Existing shutdown | Finalizes the profiler once before process exit |
| Tests/other crates | No profiling initialization | No implicit initialization |

## Layer 10 — Resolver symmetry

- The profiler delay and output path each resolve from one documented
  environment variable with one fallback.
- RPC output policy has one module-level source of truth used by every
  `typedInvoke` call; set/get/reset operate on that same state.
- No multi-field account, model, workspace, or identity resolver is changed.

## Verdict

The rebuilt PR is scoped to runtime profiling and contract enforcement. The
historical branch contamination, unrelated dependency removal, broken package
script, and stale PR #512 audit claims were removed.

**Architecture verdict: pass.**
