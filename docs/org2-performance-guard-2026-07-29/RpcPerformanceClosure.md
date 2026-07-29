# Performance Guard — Runtime Profiling and Contract Gates

**Scope:** PR #568 rebuilt on current `develop`.
**Date:** 2026-07-30

## Lifecycle matrix

| Dimension | Audited behavior |
| --- | --- |
| App | Normal builds create no profiler resource. A `dhat-heap` build schedules one worker and finalizes one profiler guard at Tauri exit. |
| Document | Developer heap profiling intentionally continues across visible/hidden states so the requested measurement window is complete. No production timer is added. |
| Network | No network request, retry, subscription, or polling path is added. |
| Identity | Profiling and RPC drift diagnostics retain no account, endpoint, org, or session identity. |
| Scope | RPC drift records contain command, schema issues, and timestamp only. The buffer is process-local and capped at 200 records. |
| Session | No per-session registry or retained session payload is added. |
| Instance | Each desktop process owns its feature-gated profiler state and output path; no cross-process cache is introduced. |

## Findings and evidence

| Area | Verdict | Evidence | Change or reason kept | Verification |
| --- | --- | --- | --- | --- |
| Background work | keep | `schedule_from_env` can spawn one named thread only when `dhat-heap` is compiled; the delay is one-shot and bounded to one hour. | State transitions reject repeat scheduling; Tauri `Exit` finalizes or cancels the pending state. | `dhat_profiling` unit tests plus feature-enabled application check. |
| Memory | keep | One optional DHAT guard and `window.__orgiiRpcOutputDrift`. | Guard is dropped at exit; drift array evicts oldest records above 200. | RPC tests cover the cap and all validation modes. |
| Scope/isolation | keep | No identity-bearing cache; output path comes from the current process environment. | Profiling output and diagnostics remain process-local. | Static lifecycle trace; no account/endpoint path changed. |
| Rendering/hot path | keep | Production RPC output-validation default is `off`. | Development/CI validation is explicit; normal rendering gets no schema-parse overhead from this change. | RPC mode tests and TypeScript typecheck. |
| Wire serialization | keep | Transport adapters call serde directly instead of constructing parallel JSON objects. | One typed serialization path avoids duplicate field-remapping work and drift. | Transport tests inspect agent, text, and tool payloads. |

## Verification

- RPC output-validation Vitest: 6/6 passed.
- `cargo test -p transport --features ts-rs`: 9/9 passed.
- `cargo test -p session_persistence --features ts-rs`: 37/37 passed.
- `pnpm typecheck`, changed-file ESLint, script `bash -n`, changed-file
  rustfmt, and `cargo check -p org2 --features dhat-heap`: passed.
- Whole-workspace rustfmt reports unchanged formatting drift outside this PR.
- A real Tauri profiling run and visible/hidden/post-exit measurement were not
  repeated during this branch-history cleanup.

**Performance verdict: blocked — static ownership, bounds, tests, and compile
gates are covered, but a real feature-enabled Tauri profiling run was not
collected in this cleanup session.**
