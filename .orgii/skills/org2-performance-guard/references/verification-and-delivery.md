# Performance Verification and Delivery

### 7. Verify proportionally

Always run:

- targeted unit tests for cache bounds, coalescing, invalidation, visibility, and stale-result rejection
- TypeScript typecheck and lint for changed frontend files
- Rust unit tests/checks for changed backend modules; if the shared Cargo cache is corrupt or policy-blocked, report it and use the narrowest valid independent compilation without deleting broad caches
- `git diff --check`

For rendered/background changes, also run the real Tauri surface when available:

1. Isolate primary and secondary data homes, provider roots, auth, ports, and processes.
2. Capture a baseline: raw files, cache rows/listability, active/open/pinned row, cursor/epoch, payload count, process count, CPU, and RSS as applicable.
3. Apply the raw source transition while ORG2 is already open. For compaction/rewrite/rotation, stage or produce the actual before/after artifact instead of pre-populating the final database state.
4. Assert local parsing, identity/lineage, exact row count, listability, timestamp, and sidebar behavior before cloud transport can hide the owning-boundary failure.
5. Keep an old row active/open/pinned, rescan, and assert that hydration does not resurrect a superseded sibling or hide the active row entirely.
6. Verify A upload and B download/reconnect separately, including cursor/epoch and exact appended payload counts when incremental behavior is claimed.
7. Rescan and restart once; confirm data and request/subscription/timer/process counts remain stable.
8. Measure visible idle, hidden idle, active work, and post-close/post-delete behavior.
9. Exercise account switch, endpoint switch, and direct secondary launch when relevant.
10. Confirm strict rendered E2E uses user-visible actions for the behavior under assertion.

Do not claim a performance improvement from code shape alone. State the evidence actually collected and any environment blocker.

## Review rejection rules

Reject or revise a change when any applicable answer is unknown or false:

- Who owns this background resource, and exactly when is it stopped?
- Can this timer overlap itself or continue while hidden?
- Why is polling necessary instead of invalidation?
- Can two mounted consumers issue the same request?
- Does the cache have a maximum size, freshness rule, identity key, and eviction event?
- Can an old async completion write after a newer request or identity switch?
- Does one session's update wake unrelated session views?
- Does a growing transcript/history/diff require full eager materialization?
- Does a direct secondary launch inherit primary external history or auth state?
- Which provider and raw source transition produced the evidence for each compatibility claim?
- Did the test inspect local ingest and identity before testing cloud transport?
- Did it keep the previous row active/open/pinned across rescan or only test a clean roster?
- Were family/identity keys parsed from raw artifacts, or fabricated to match the implementation?
- Did "dual-machine" testing merely replicate an already-normalized final state?
- Can a missing rendered element be skipped while the E2E still passes?

## Required delivery output

Report findings and evidence in this compact form:

| Area | Verdict | Evidence | Change or reason kept | Verification |
| --- | --- | --- | --- | --- |
| Background work | fix / keep | timer/subscription owner and cadence | exact lifecycle decision | test or measurement |
| Memory | fix / keep | retained structure and growth bound | cap/TTL/eviction | bound/eviction test |
| Scope/isolation | fix / keep | cache/request key | identity/generation guard | switch/revocation test |
| Rendering/hot path | fix / keep | subscription/allocation trace | narrowing/coalescing | render or unit evidence |

For provider ingestion, session identity, or sync work, also report:

| Provider | Raw transition | App/UI state | Topology/boundary | Expected invariant | Observed evidence |
| --- | --- | --- | --- | --- | --- |
| exact provider | actual transition | cold/live/active-row/restart | local/A-to-cloud/cloud-to-B | exact rows, identity, cursor, payload, UI | measured result or `not run` |

Use one row per materially distinct matrix cell. Shared implementation permits
shared unit coverage only at the shared boundary; each provider adapter still
needs representative raw input before claiming compatibility.

End with:

- `Performance verdict: pass` only when every applicable invariant is evidenced.
- `Performance verdict: blocked` when required real measurement, provider transition, or compilation cannot run; name the blocker and uncovered matrix cells.
- `Performance verdict: fail` when an unbounded, duplicate, hidden-active, stale-write, or cross-identity path remains.

Never promise that a skill can make regressions impossible. Enforce the gates, expose unknowns, and refuse an unsupported green verdict.
